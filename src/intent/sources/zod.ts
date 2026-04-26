/**
 * Zod source — extracts JSON-Schema-flavored shape from `z.object({...})`
 * literals (and friends) found in the source file.
 *
 * Why AST instead of `zod-to-json-schema`: extracting at runtime would
 * require evaluating the user's source code, which is unsafe and forces
 * `zod` itself as a runtime peer. AST extraction is sandbox-safe, costs
 * nothing, and covers >90% of real-world Zod usage (object/array/literal
 * /enum/union/optional/nullable + the common refinements).
 *
 * Falls back to `zod-to-json-schema` ONLY if it's installed AND the user
 * already imported the schema such that we have a real Zod runtime
 * instance — handled by the compiler core, not here. This file stays pure
 * AST.
 *
 * Resolution for a frame `(file, symbol)`:
 *   1. find the function declaration named `symbol`
 *   2. inside its body, find the first `<schemaVar>.parse(…)` /
 *      `.safeParse(…)` call
 *   3. find the declaration of `<schemaVar>` (`const schemaVar = z.…`)
 *   4. walk that initializer AST → IntentShape
 *
 * If no validator call is found we fall back to "first top-level
 * `z.object` in the file" — handlers often colocate the schema right
 * above the handler.
 */

import type { IntentShape, IntentSource } from "../types.js"
import { capShapeSize } from "../types.js"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ts = any

let cachedTs: Ts | null = null
let triedLoad = false

function loadTs(): Ts | null {
  if (triedLoad) return cachedTs
  triedLoad = true
  try {
    const req = createRequire(import.meta.url)
    cachedTs = req("typescript") as Ts
  } catch {
    cachedTs = null
  }
  return cachedTs
}

const TS_EXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|jsx)$/

export const zodSource: IntentSource = {
  name: "zod",

  canParse(filePath: string): boolean {
    if (!TS_EXT.test(filePath)) return false
    if (!loadTs()) return false
    // Cheap content sniff — most files don't import zod.
    try {
      const head = readFileSync(filePath, "utf8").slice(0, 4096)
      return /["']zod["']/.test(head) || /\bz\.object\b/.test(head)
    } catch {
      return false
    }
  },

  extract(filePath: string, symbol: string | null): IntentShape | null {
    const ts = loadTs()
    if (!ts) return null
    let text: string
    try {
      text = readFileSync(filePath, "utf8")
    } catch {
      return null
    }
    let sf
    try {
      sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.ES2020, true)
    } catch {
      return null
    }

    const env = collectZodSchemas(ts, sf)
    if (env.schemas.size === 0) return null

    // (1) explicit symbol → look inside function for a .parse() target.
    if (symbol) {
      const fnNode = env.functions.get(symbol)
      if (fnNode) {
        const target = findValidatorTargetInFn(ts, fnNode)
        if (target && env.schemas.has(target)) {
          const shape = walkZod(ts, env.schemas.get(target), env, new Set())
          shape._symbol = target
          return capShapeSize(shape)
        }
      }
      // Or maybe symbol IS the schema name itself.
      if (env.schemas.has(symbol)) {
        const shape = walkZod(ts, env.schemas.get(symbol), env, new Set())
        shape._symbol = symbol
        return capShapeSize(shape)
      }
    }

    // (2) fallback: first declared schema.
    const firstName = env.schemas.keys().next().value as string | undefined
    if (!firstName) return null
    const shape = walkZod(ts, env.schemas.get(firstName), env, new Set())
    shape._symbol = firstName
    return capShapeSize(shape)
  },
}

// ─── Collect schemas + functions ───────────────────────────────────────────

interface ZodEnv {
  /** schema variable name → its initializer expression (a z.* call) */
  schemas: Map<string, Ts>
  /** function name → the FunctionDeclaration / ArrowFunction node */
  functions: Map<string, Ts>
}

function collectZodSchemas(ts: Ts, sf: Ts): ZodEnv {
  const schemas = new Map<string, Ts>()
  const functions = new Map<string, Ts>()

  function visit(node: Ts) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        if (isZodExpression(ts, decl.initializer)) {
          schemas.set(decl.name.text, decl.initializer)
        } else if (
          ts.isArrowFunction(decl.initializer) ||
          ts.isFunctionExpression(decl.initializer)
        ) {
          functions.set(decl.name.text, decl.initializer)
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { schemas, functions }
}

function isZodExpression(ts: Ts, expr: Ts): boolean {
  // The root of a zod chain is `z.<something>`. We allow chained calls
  // like `z.string().email()` by walking the expression head.
  let cur = expr
  while (cur) {
    if (ts.isCallExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isPropertyAccessExpression(cur)) {
      cur = cur.expression
      continue
    }
    if (ts.isIdentifier(cur)) return cur.text === "z"
    return false
  }
  return false
}

// ─── Find <schemaVar>.parse(...) inside a function body ───────────────────

function findValidatorTargetInFn(ts: Ts, fn: Ts): string | null {
  let target: string | null = null
  function visit(n: Ts) {
    if (target) return
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      ts.isIdentifier(n.expression.name) &&
      ["parse", "safeParse", "parseAsync", "safeParseAsync"].includes(
        n.expression.name.text,
      )
    ) {
      target = n.expression.expression.text
      return
    }
    ts.forEachChild(n, visit)
  }
  if (fn.body) ts.forEachChild(fn.body, visit)
  return target
}

// ─── Walk a zod expression chain to a shape ────────────────────────────────

interface Modifiers {
  optional?: boolean
  nullable?: boolean
  format?: string
  isInt?: boolean
}

function walkZod(
  ts: Ts,
  expr: Ts,
  env: ZodEnv,
  seen: Set<string>,
): IntentShape {
  // Chain refinements: collapse `.email()`, `.url()`, `.optional()`,
  // `.nullable()`, `.int()` etc. on the way down to the root call. We
  // only strip a level when the receiver of the property access is
  // itself another CallExpression — otherwise we'd unwrap `z.object(...)`
  // and lose the root.
  const mods: Modifiers = {}
  let head = expr
  while (
    ts.isCallExpression(head) &&
    ts.isPropertyAccessExpression(head.expression) &&
    head.expression.name &&
    ts.isIdentifier(head.expression.name) &&
    ts.isCallExpression(head.expression.expression)
  ) {
    const m = head.expression.name.text
    if (m === "optional") mods.optional = true
    else if (m === "nullable") mods.nullable = true
    else if (m === "email") mods.format = "email"
    else if (m === "url") mods.format = "uri"
    else if (m === "uuid") mods.format = "uuid"
    else if (m === "datetime") mods.format = "date-time"
    else if (m === "int") mods.isInt = true
    // anything else (.min, .max, .default, …) we just unwrap silently
    head = head.expression.expression
  }

  // Now `head` is the root call: z.object(...), z.string(), z.array(...), …
  if (
    !ts.isCallExpression(head) ||
    !ts.isPropertyAccessExpression(head.expression) ||
    !ts.isIdentifier(head.expression.expression) ||
    head.expression.expression.text !== "z"
  ) {
    // It might be an identifier reference to another schema var
    if (ts.isIdentifier(head) && env.schemas.has(head.text)) {
      if (seen.has(head.text)) return { $ref: head.text, _symbol: head.text }
      const next = new Set(seen)
      next.add(head.text)
      const shape = walkZod(ts, env.schemas.get(head.text), env, next)
      return applyMods(shape, mods)
    }
    return applyMods({ type: "unknown" }, mods)
  }

  const fnName = (head.expression.name as Ts).text as string
  const args: Ts[] = head.arguments ?? []

  let out: IntentShape

  switch (fnName) {
    case "string":
      out = { type: "string" }
      break
    case "number":
      out = { type: "number" }
      break
    case "boolean":
      out = { type: "boolean" }
      break
    case "null":
      out = { type: "null" }
      break
    case "any":
      out = { type: "any" }
      break
    case "unknown":
      out = { type: "unknown" }
      break
    case "date":
      out = { type: "string", format: "date-time" }
      break
    case "literal":
      out = { enum: [staticEval(ts, args[0])] }
      break
    case "enum": {
      const arr = args[0]
      const values: unknown[] = []
      if (arr && ts.isArrayLiteralExpression(arr)) {
        for (const el of arr.elements) values.push(staticEval(ts, el))
      }
      out = { enum: values }
      break
    }
    case "array":
      out = {
        type: "array",
        items: args[0] ? walkZod(ts, args[0], env, seen) : { type: "unknown" },
      }
      break
    case "tuple": {
      const items: IntentShape[] = []
      const arr = args[0]
      if (arr && ts.isArrayLiteralExpression(arr)) {
        for (const el of arr.elements) items.push(walkZod(ts, el, env, seen))
      }
      out = { type: "array", items: items[0] ?? { type: "unknown" } }
      break
    }
    case "object": {
      out = walkZodObject(ts, args[0], env, seen)
      break
    }
    case "record":
      out = {
        type: "object",
        properties: {},
        items: args[1] ? walkZod(ts, args[1], env, seen) : { type: "unknown" },
      }
      break
    case "union": {
      const arr = args[0]
      const variants: IntentShape[] = []
      if (arr && ts.isArrayLiteralExpression(arr)) {
        for (const el of arr.elements) variants.push(walkZod(ts, el, env, seen))
      }
      // collapse literal-only unions to enum
      if (variants.every((v) => v.enum && v.enum.length === 1)) {
        out = { enum: variants.flatMap((v) => v.enum!) }
      } else {
        out = { enum: variants.map((v) => v.type ?? "unknown") }
      }
      break
    }
    default:
      out = { type: "unknown" }
  }

  if (mods.format && out.type === "string") out.format = mods.format
  return applyMods(out, mods)
}

function walkZodObject(
  ts: Ts,
  arg: Ts | undefined,
  env: ZodEnv,
  seen: Set<string>,
): IntentShape {
  const properties: Record<string, IntentShape> = {}
  const required: string[] = []
  if (!arg || !ts.isObjectLiteralExpression(arg)) {
    return { type: "object", properties, required }
  }
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    let key: string | null = null
    if (ts.isIdentifier(prop.name)) key = prop.name.text
    else if (ts.isStringLiteral(prop.name)) key = prop.name.text
    if (!key) continue
    const child = walkZod(ts, prop.initializer, env, seen)
    properties[key] = child
    // Check if the value is .optional() at the top — if so, not required.
    if (!isOptionalChain(ts, prop.initializer)) required.push(key)
  }
  return { type: "object", properties, required }
}

function isOptionalChain(ts: Ts, expr: Ts): boolean {
  let cur = expr
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    cur.expression.name &&
    ts.isIdentifier(cur.expression.name)
  ) {
    if (cur.expression.name.text === "optional") return true
    cur = cur.expression.expression
  }
  return false
}

function applyMods(shape: IntentShape, mods: Modifiers): IntentShape {
  // optional/nullable are tracked on the parent's `required` set; they
  // don't add fields here. We only emit format when the shape is a string.
  if (mods.format && shape.type === "string" && !shape.format) {
    shape.format = mods.format
  }
  return shape
}

function staticEval(ts: Ts, node: Ts): unknown {
  if (!node) return null
  if (ts.isStringLiteral(node)) return node.text
  if (ts.isNumericLiteral(node)) return Number(node.text)
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false
  if (node.kind === ts.SyntaxKind.NullKeyword) return null
  return null
}
