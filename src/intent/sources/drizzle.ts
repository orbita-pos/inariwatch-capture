/**
 * Drizzle source — extracts a JSON-Schema-flavored shape from a
 * `pgTable("name", { columns })` (or `mysqlTable` / `sqliteTable`)
 * declaration in a `*.schema.ts` file (SKYNET §3 piece 5, Track D, part 2).
 *
 * Why: when a write fails inside a Drizzle insert/update, the LLM's most
 * useful "expected schema" is the table definition itself — not the
 * route handler's TS interface and not the Zod validator above the
 * insert. The table is the authoritative shape the database accepts.
 *
 * Strategy: pure AST walk via the `typescript` peer (already required by
 * the TS and Zod sources). We never run user code. We never type-check.
 * We never read sibling files — table-level cross-references degrade to
 * `$ref: "TableName"` like every other source in the compiler.
 *
 * Resolution for a frame `(file, symbol)`:
 *   1. parse the file and collect every `<var> = <pgTable|mysqlTable|sqliteTable>("...", { … })`
 *      declaration into a `tables` map keyed by the variable name AND
 *      by the runtime table name passed as the first arg.
 *   2. if `symbol` matches a key, walk that one.
 *   3. if `symbol` matches a function name in the file (e.g. a
 *      `createUser(input)` repository helper), look inside its body for
 *      `db.insert(<varRef>)` / `.update(<varRef>)` / `.values(<varRef>)`
 *      and walk the referenced table.
 *   4. fall back to the first declared table.
 *
 * The Drizzle column DSL is a chained call: `text("col").primaryKey().notNull()`.
 * We map the root identifier to a JSON Schema type, then collapse
 * modifiers (`.notNull()`, `.primaryKey()`, `.default(...)`,
 * `.references(...)`) into the parent table's `required` set.
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

// `pgTable`, `mysqlTable`, `sqliteTable` — and the lower-case aliases
// some teams adopt for custom dialects.
const TABLE_FACTORIES = new Set([
  "pgTable",
  "mysqlTable",
  "sqliteTable",
  "table",
])

// Drizzle column factories → JSON-Schema type/format. The full DSL has
// dozens of flavors; we cover the ones that show up in real production
// schemas. Anything else degrades to `unknown` (still useful — the LLM
// at least sees the column exists).
const COLUMN_TYPES: Record<string, IntentShape> = {
  // strings
  text: { type: "string" },
  varchar: { type: "string" },
  char: { type: "string" },
  citext: { type: "string" },
  uuid: { type: "string", format: "uuid" },
  // numerics
  integer: { type: "number" },
  smallint: { type: "number" },
  bigint: { type: "number" },
  serial: { type: "number" },
  bigserial: { type: "number" },
  smallserial: { type: "number" },
  numeric: { type: "number" },
  decimal: { type: "number" },
  real: { type: "number" },
  doublePrecision: { type: "number" },
  // booleans
  boolean: { type: "boolean" },
  // temporal
  timestamp: { type: "string", format: "date-time" },
  timestamptz: { type: "string", format: "date-time" },
  date: { type: "string", format: "date" },
  time: { type: "string", format: "time" },
  interval: { type: "string" },
  // JSON
  json: { type: "object" },
  jsonb: { type: "object" },
  // misc
  bytea: { type: "string", format: "byte" },
  inet: { type: "string", format: "ip" },
  cidr: { type: "string", format: "cidr" },
  // sqlite-specific
  blob: { type: "string", format: "byte" },
  // pgEnum
  pgEnum: { type: "string" },
}

export const drizzleSource: IntentSource = {
  name: "drizzle",

  canParse(filePath: string): boolean {
    if (!TS_EXT.test(filePath)) return false
    if (!loadTs()) return false
    // Cheap content sniff — most files don't import drizzle.
    try {
      const head = readFileSync(filePath, "utf8").slice(0, 8192)
      return /["']drizzle-orm[/"']/.test(head) || /\b(pgTable|mysqlTable|sqliteTable)\s*\(/.test(head)
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

    const env = collectDrizzle(ts, sf)
    if (env.tables.size === 0) return null

    // (1) Symbol == table variable name OR runtime table name.
    if (symbol) {
      const direct =
        env.tables.get(symbol) ??
        env.tablesByRuntimeName.get(symbol) ??
        env.tables.get(stripDecorations(symbol))
      if (direct) {
        const shape = walkTable(ts, direct, env, new Set())
        return capShapeSize(shape)
      }
      // (2) Symbol == function name → look inside body for insert/update target
      const fn = env.functions.get(symbol)
      if (fn) {
        const target = findTableTargetInFn(ts, fn)
        if (target) {
          const t = env.tables.get(target)
          if (t) {
            const shape = walkTable(ts, t, env, new Set())
            return capShapeSize(shape)
          }
        }
      }
    }

    // (3) Fallback: first declared table.
    const first = env.tables.values().next().value
    if (!first) return null
    const shape = walkTable(ts, first, env, new Set())
    return capShapeSize(shape)
  },
}

// ─── Collect tables + functions ────────────────────────────────────────────

interface DrizzleTable {
  /** local variable name */
  varName: string
  /** runtime name passed as first arg of pgTable("...", { … }) */
  runtimeName: string | null
  /** the second arg's ObjectLiteralExpression (or arrow returning one) */
  columns: Ts | null
}

interface DrizzleEnv {
  tables: Map<string, DrizzleTable>
  tablesByRuntimeName: Map<string, DrizzleTable>
  functions: Map<string, Ts>
}

function collectDrizzle(ts: Ts, sf: Ts): DrizzleEnv {
  const tables = new Map<string, DrizzleTable>()
  const tablesByRuntimeName = new Map<string, DrizzleTable>()
  const functions = new Map<string, Ts>()

  function visit(node: Ts) {
    // const users = pgTable("users", { … })
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue
        const t = parseTableCall(ts, decl.initializer)
        if (t) {
          const entry: DrizzleTable = { varName: decl.name.text, ...t }
          tables.set(decl.name.text, entry)
          if (entry.runtimeName) tablesByRuntimeName.set(entry.runtimeName, entry)
          continue
        }
        if (
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
  return { tables, tablesByRuntimeName, functions }
}

function parseTableCall(
  ts: Ts,
  expr: Ts,
): { runtimeName: string | null; columns: Ts | null } | null {
  if (!ts.isCallExpression(expr)) return null
  const callee = expr.expression
  let calleeName: string | null = null
  if (ts.isIdentifier(callee)) calleeName = callee.text
  else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name))
    calleeName = callee.name.text
  if (!calleeName || !TABLE_FACTORIES.has(calleeName)) return null

  const args: Ts[] = expr.arguments ?? []
  const first = args[0]
  const second = args[1]
  let runtimeName: string | null = null
  if (first && ts.isStringLiteral(first)) runtimeName = first.text

  // Drizzle accepts both `pgTable("u", { col: text("col") })` and
  // `pgTable("u", (t) => ({ col: t.text("col") }))`. We only need the
  // shape of the columns object, so unwrap the arrow if present.
  let columns: Ts | null = null
  if (second) {
    if (ts.isObjectLiteralExpression(second)) {
      columns = second
    } else if (ts.isArrowFunction(second) || ts.isFunctionExpression(second)) {
      const body = second.body
      if (body && ts.isObjectLiteralExpression(body)) columns = body
      else if (body && ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
        columns = body.expression
      }
    }
  }
  return { runtimeName, columns }
}

// ─── Walk a column object → IntentShape ────────────────────────────────────

function walkTable(
  ts: Ts,
  table: DrizzleTable,
  env: DrizzleEnv,
  seen: Set<string>,
): IntentShape {
  const properties: Record<string, IntentShape> = {}
  const required: string[] = []
  if (!table.columns) {
    return {
      type: "object",
      properties,
      required,
      _symbol: table.runtimeName ?? table.varName,
    }
  }
  for (const prop of table.columns.properties ?? []) {
    if (!ts.isPropertyAssignment(prop)) continue
    let key: string | null = null
    if (ts.isIdentifier(prop.name)) key = prop.name.text
    else if (ts.isStringLiteral(prop.name)) key = prop.name.text
    if (!key) continue
    const { shape, isRequired } = walkColumn(ts, prop.initializer, env, seen)
    properties[key] = shape
    if (isRequired) required.push(key)
  }
  return {
    type: "object",
    properties,
    required,
    _symbol: table.runtimeName ?? table.varName,
  }
}

interface ColumnResult {
  shape: IntentShape
  /** true when `.notNull()` and not `.default(...)` */
  isRequired: boolean
}

function walkColumn(ts: Ts, expr: Ts, env: DrizzleEnv, seen: Set<string>): ColumnResult {
  // The column expression is a chain ending in either `<typeFactory>("col", …)`
  // or `t.<typeFactory>("col", …)` (when the user took the table-callback
  // form). Modifiers `.notNull()`, `.primaryKey()`, `.default(…)`,
  // `.references(…)` are property-call links on top.
  let cur = expr
  let notNull = false
  let hasDefault = false
  let isPrimary = false

  // Unwrap modifier links to reach the type factory.
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    cur.expression.name &&
    ts.isIdentifier(cur.expression.name) &&
    ts.isCallExpression(cur.expression.expression)
  ) {
    const m = cur.expression.name.text
    if (m === "notNull") notNull = true
    else if (m === "primaryKey") {
      isPrimary = true
      notNull = true
    } else if (m === "default" || m === "defaultNow" || m === "defaultRandom" || m === "$defaultFn" || m === "$default") {
      hasDefault = true
    }
    // else: `.references(...)`, `.unique()`, `.array()`, … silently ignored
    cur = cur.expression.expression
  }

  // Now `cur` should be `<factory>("col", …)` or `t.<factory>("col", …)`.
  let factoryName: string | null = null
  if (ts.isCallExpression(cur)) {
    const callee = cur.expression
    if (ts.isIdentifier(callee)) factoryName = callee.text
    else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name))
      factoryName = callee.name.text
  }

  let shape: IntentShape = factoryName && COLUMN_TYPES[factoryName]
    ? { ...COLUMN_TYPES[factoryName] }
    : { type: "unknown" }

  // pgEnum("status", ["pending", "shipped"]) usage: the enum is invoked
  // at the column site as `statusEnum("status")` — we can't easily
  // resolve the enum members without symbol-tracking, so we leave it
  // as a plain string (see COLUMN_TYPES) and rely on the LLM to read
  // the surrounding code.

  // .array() on top → wrap in array
  if (factoryName && shape.type !== "unknown") {
    // Detect a `.array()` modifier we may have unwrapped above.
    if (sawArrayModifier(ts, expr)) {
      shape = { type: "array", items: shape }
    }
  }

  // Required = NOT NULL AND no default value, or primary key.
  const isRequired = (notNull && !hasDefault) || isPrimary
  void env
  void seen
  return { shape, isRequired }
}

function sawArrayModifier(ts: Ts, expr: Ts): boolean {
  let cur = expr
  while (
    ts.isCallExpression(cur) &&
    ts.isPropertyAccessExpression(cur.expression) &&
    cur.expression.name &&
    ts.isIdentifier(cur.expression.name)
  ) {
    if (cur.expression.name.text === "array") return true
    if (!ts.isCallExpression(cur.expression.expression)) break
    cur = cur.expression.expression
  }
  return false
}

// ─── Find db.insert(<table>) / .values(<table>) / .update(<table>) ─────────

function findTableTargetInFn(ts: Ts, fn: Ts): string | null {
  let target: string | null = null
  function visit(n: Ts) {
    if (target) return
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      ts.isIdentifier(n.expression.name) &&
      ["insert", "update", "delete", "select", "values"].includes(n.expression.name.text)
    ) {
      const arg = n.arguments?.[0]
      if (arg && ts.isIdentifier(arg)) {
        target = arg.text
        return
      }
    }
    ts.forEachChild(n, visit)
  }
  if (fn.body) ts.forEachChild(fn.body, visit)
  return target
}

function stripDecorations(name: string): string {
  return name.replace(/^[A-Z]+\s+/, "").replace(/[<>]/g, "")
}
