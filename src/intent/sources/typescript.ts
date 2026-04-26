/**
 * TypeScript source — extracts shape from `interface`/`type` declarations
 * and function-parameter type annotations.
 *
 * Strategy: single-file AST walk via the TypeScript compiler API. We
 * intentionally do NOT build a `Program` (which would type-check the whole
 * world and take seconds) — extraction runs in the SDK hot-path on a user
 * machine, so we trade fidelity for cost. Cross-file imports degrade to
 * `$ref: "TypeName"` rather than failing.
 *
 * Peer dep: `typescript`. If absent, `canParse` returns `false` and the
 * source is silently skipped — same contract every other source follows.
 *
 * Resolution order for a frame `(file, symbol)`:
 *   1. find function/method declaration named `symbol` in `file`
 *   2. take its first parameter's type annotation
 *   3. resolve that type (interface, alias, generic args, etc.) in-file
 *   4. when symbol is null, fall back to the first exported function
 */

import type { IntentShape, IntentSource } from "../types.js"
import { capShapeSize } from "../types.js"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"

// We type the TS module loosely (`any`) because importing it as a value
// would force consumers to install `typescript`. A type-only import is
// cheap and we resolve to the runtime module via createRequire so it
// works under ESM (the SDK ships as `"type": "module"`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ts = any

let cachedTs: Ts | null = null
let triedLoad = false

function loadTs(): Ts | null {
  if (triedLoad) return cachedTs
  triedLoad = true
  try {
    // createRequire lets us synchronously require('typescript') from an
    // ESM context without bundlers trying to inline it. Falls back to
    // null when the peer isn't installed.
    const req = createRequire(import.meta.url)
    cachedTs = req("typescript") as Ts
  } catch {
    cachedTs = null
  }
  return cachedTs
}

const TS_EXT = /\.(ts|tsx|mts|cts)$/

export const typescriptSource: IntentSource = {
  name: "ts",

  canParse(filePath: string): boolean {
    if (!TS_EXT.test(filePath)) return false
    return loadTs() !== null
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

    const env = collectDeclarations(ts, sf)

    // Find the target function: explicit symbol → fallback to first
    // exported function-like declaration.
    const targetFn = symbol
      ? env.functions.get(symbol) ?? env.functions.get(stripDecorations(symbol)) ?? null
      : firstExportedFn(env.functions)

    if (!targetFn) {
      // Maybe `symbol` is a type/interface name itself (e.g. user passed
      // a DTO type as the contract anchor).
      if (symbol) {
        const direct = env.types.get(symbol)
        if (direct) {
          const shape = resolveTypeNode(ts, direct, env, new Set())
          shape._symbol = symbol
          return capShapeSize(shape)
        }
      }
      return null
    }

    const param = targetFn.parameters?.[0]
    if (!param || !param.type) return null

    const shape = resolveTypeNode(ts, param.type, env, new Set())
    shape._symbol = symbolNameOf(ts, param.type) ?? undefined
    return capShapeSize(shape)
  },
}

// ─── Declaration table ─────────────────────────────────────────────────────

interface DeclEnv {
  /** function name → FunctionDeclaration / MethodDeclaration / ArrowFunction-bound VariableDecl */
  functions: Map<string, Ts>
  /** type/interface name → TypeNode-equivalent (interface body or alias's right-hand side) */
  types: Map<string, Ts>
}

function collectDeclarations(ts: Ts, sf: Ts): DeclEnv {
  const functions = new Map<string, Ts>()
  const types = new Map<string, Ts>()

  function visit(node: Ts) {
    // function foo(...) { ... }
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node)
    }
    // export const foo = (...) => ...   /  function expression
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          ts.isIdentifier(decl.name) &&
          decl.initializer &&
          (ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer))
        ) {
          functions.set(decl.name.text, decl.initializer)
        }
      }
    }
    // class Foo { method(...) {} }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      for (const member of node.members ?? []) {
        if (
          (ts.isMethodDeclaration(member) ||
            ts.isConstructorDeclaration(member)) &&
          member.name &&
          ts.isIdentifier(member.name)
        ) {
          functions.set(member.name.text, member)
        }
      }
    }
    // interface Foo { ... }
    if (ts.isInterfaceDeclaration(node)) {
      types.set(node.name.text, node)
    }
    // type Foo = ...
    if (ts.isTypeAliasDeclaration(node)) {
      types.set(node.name.text, node.type)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return { functions, types }
}

function firstExportedFn(map: Map<string, Ts>): Ts | null {
  for (const [, decl] of map) {
    const mods = decl.modifiers ?? []
    if (mods.some((m: Ts) => m.kind && isExportKind(m.kind))) return decl
  }
  // No explicit export → return first declaration. Better than nothing.
  for (const [, decl] of map) return decl
  return null
}

function isExportKind(kind: number): boolean {
  // SyntaxKind.ExportKeyword = 95 (varies between TS versions; both
  // current and historical IDs are accepted to keep the source forward
  // compatible without pinning typescript).
  return kind === 95 || kind === 93 || kind === 94
}

function stripDecorations(name: string): string {
  // "POST handler" → "handler", "<anonymous>" → ""
  return name.replace(/^[A-Z]+\s+/, "").replace(/[<>]/g, "")
}

// ─── Type resolution ───────────────────────────────────────────────────────

const PRIMITIVE_KIND_TO_TYPE: Record<string, IntentShape["type"]> = {
  StringKeyword: "string",
  NumberKeyword: "number",
  BooleanKeyword: "boolean",
  NullKeyword: "null",
  AnyKeyword: "any",
  UnknownKeyword: "unknown",
  BigIntKeyword: "number",
  VoidKeyword: "null",
  UndefinedKeyword: "null",
  NeverKeyword: "any",
  ObjectKeyword: "object",
}

function resolveTypeNode(
  ts: Ts,
  node: Ts,
  env: DeclEnv,
  seen: Set<string>,
): IntentShape {
  // Primitives — match by SyntaxKind name (works across TS versions)
  const kindName = ts.SyntaxKind?.[node.kind]
  if (kindName && PRIMITIVE_KIND_TO_TYPE[kindName]) {
    return { type: PRIMITIVE_KIND_TO_TYPE[kindName] }
  }

  // type X = "a" | "b" | ...  — string/number literals union
  if (ts.isLiteralTypeNode(node)) {
    const lit = node.literal
    if (lit && (ts.isStringLiteral(lit) || ts.isNumericLiteral(lit))) {
      return { enum: [coerceLiteral(ts, lit)] }
    }
    if (lit && (lit.kind === ts.SyntaxKind.TrueKeyword || lit.kind === ts.SyntaxKind.FalseKeyword)) {
      return { type: "boolean", enum: [lit.kind === ts.SyntaxKind.TrueKeyword] }
    }
  }

  // T[]  —  array
  if (ts.isArrayTypeNode(node)) {
    return { type: "array", items: resolveTypeNode(ts, node.elementType, env, seen) }
  }

  // Array<T>  —  array via generic
  if (ts.isTypeReferenceNode(node)) {
    const refName = textOfTypeName(ts, node.typeName)
    if (refName === "Array" && node.typeArguments?.length === 1) {
      return { type: "array", items: resolveTypeNode(ts, node.typeArguments[0], env, seen) }
    }
    if (refName === "Date") return { type: "string", format: "date-time" }
    if (refName === "Promise" && node.typeArguments?.length === 1) {
      return resolveTypeNode(ts, node.typeArguments[0], env, seen)
    }
    if (refName === "Record" && node.typeArguments?.length === 2) {
      return {
        type: "object",
        properties: {},
        items: resolveTypeNode(ts, node.typeArguments[1], env, seen),
      }
    }
    // Cycle guard: if the name is already on the resolution stack we'd
    // recurse forever (think `interface Tree { children: Tree[] }`).
    if (seen.has(refName)) return { $ref: refName, _symbol: refName }
    const decl = env.types.get(refName)
    if (decl) {
      const next = new Set(seen)
      next.add(refName)
      const out = resolveTypeNode(ts, decl, env, next)
      if (!out._symbol) out._symbol = refName
      return out
    }
    // Cross-file or unknown — degrade to ref.
    return { $ref: refName, _symbol: refName }
  }

  // interface X { a: number; b?: string } — interface body
  if (ts.isInterfaceDeclaration(node)) {
    return resolveMembers(ts, node.members ?? [], env, seen)
  }

  // type X = { a: number; b?: string } — type literal
  if (ts.isTypeLiteralNode(node)) {
    return resolveMembers(ts, node.members ?? [], env, seen)
  }

  // A | B | C  — union
  if (ts.isUnionTypeNode(node)) {
    const parts = (node.types ?? []).map((t: Ts) => resolveTypeNode(ts, t, env, seen))
    // Collapse string-literal unions to enum.
    if (parts.every((p: IntentShape) => p.enum && p.enum.length === 1)) {
      return { enum: parts.flatMap((p: IntentShape) => p.enum!) }
    }
    return { enum: parts.map(narrowForEnum) }
  }

  // A & B  — intersection (we merge object props naively)
  if (ts.isIntersectionTypeNode(node)) {
    const parts = (node.types ?? []).map((t: Ts) => resolveTypeNode(ts, t, env, seen))
    return mergeObjects(parts)
  }

  return { type: "unknown" }
}

function resolveMembers(
  ts: Ts,
  members: Ts[],
  env: DeclEnv,
  seen: Set<string>,
): IntentShape {
  const properties: Record<string, IntentShape> = {}
  const required: string[] = []
  for (const m of members) {
    if (!m.name || !ts.isIdentifier(m.name)) continue
    if (!ts.isPropertySignature(m) && !ts.isMethodSignature(m)) continue
    const key = m.name.text
    const child = m.type ? resolveTypeNode(ts, m.type, env, seen) : { type: "unknown" as const }
    properties[key] = child
    if (!m.questionToken) required.push(key)
  }
  return { type: "object", properties, required }
}

function mergeObjects(parts: IntentShape[]): IntentShape {
  const out: IntentShape = { type: "object", properties: {}, required: [] }
  const reqSet = new Set<string>()
  for (const p of parts) {
    if (p.type === "object" && p.properties) {
      Object.assign(out.properties!, p.properties)
      for (const r of p.required ?? []) reqSet.add(r)
    }
  }
  out.required = Array.from(reqSet)
  return out
}

function narrowForEnum(s: IntentShape): unknown {
  if (s.enum && s.enum.length === 1) return s.enum[0]
  return s.type ?? "unknown"
}

function textOfTypeName(ts: Ts, n: Ts): string {
  if (ts.isIdentifier(n)) return n.text
  if (ts.isQualifiedName(n)) return `${textOfTypeName(ts, n.left)}.${n.right.text}`
  return ""
}

function symbolNameOf(ts: Ts, typeNode: Ts): string | null {
  if (ts.isTypeReferenceNode(typeNode)) return textOfTypeName(ts, typeNode.typeName) || null
  return null
}

function coerceLiteral(ts: Ts, lit: Ts): unknown {
  if (ts.isStringLiteral(lit)) return lit.text
  if (ts.isNumericLiteral(lit)) return Number(lit.text)
  return null
}
