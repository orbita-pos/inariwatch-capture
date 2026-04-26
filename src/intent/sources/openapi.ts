/**
 * OpenAPI source — extracts request-body / parameter schema from an
 * `openapi.json` / `openapi.yaml` / `swagger.json` discovered at the
 * project root or under `docs/` (SKYNET §3 piece 5, Track D, part 2).
 *
 * Why this matters: the LLM seeing `evidence.request.body` is half the
 * picture — the other half is "what did the API contract say it should
 * be". For teams that maintain an OpenAPI document, that contract is
 * authoritative, more accurate than the TS types (which lie about
 * runtime shape), and trivially indexed.
 *
 * Strategy:
 *   1. Walk up from the failing file to a project root (package.json
 *      marker). Cache the resolved spec path per root.
 *   2. Look for spec files in this priority order:
 *        ./openapi.json, ./openapi.yaml, ./openapi.yml,
 *        ./swagger.json, ./swagger.yaml, ./swagger.yml,
 *        ./docs/openapi.{json,yaml,yml}, ./docs/swagger.{json,yaml,yml}
 *   3. Parse the spec — JSON via the runtime, YAML via an optional peer
 *      (`yaml` then `js-yaml`). If neither peer is installed and the
 *      spec is YAML, we silently skip the source.
 *   4. Build two indexes: by `operationId` and by `path` (with
 *      Next.js-style `[param]` <-> OpenAPI `{param}` normalization).
 *   5. Resolve in this order:
 *        a. `symbol` matches an `operationId`
 *        b. `filePath` maps to an OpenAPI path (Next.js app-router
 *           convention)
 *        c. fall through to `null`
 *   6. Return the operation's request-body JSON schema (preferring
 *      `application/json`); fall back to merged path/query parameter
 *      schemas for GET-style operations.
 *
 * The source is best-effort and degradation-safe: any failure (no spec,
 * unparseable YAML, malformed schema) returns `null`, the compiler asks
 * the next source.
 */

import type { IntentShape, IntentSource } from "../types.js"
import { capShapeSize } from "../types.js"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import { createRequire } from "node:module"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySpec = any

// ─── Optional YAML peer ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type YamlMod = { parse?: (s: string) => any; load?: (s: string) => any } | null
let cachedYaml: YamlMod = null
let triedYaml = false

function loadYaml(): YamlMod {
  if (triedYaml) return cachedYaml
  triedYaml = true
  const req = createRequire(import.meta.url)
  for (const name of ["yaml", "js-yaml"]) {
    try {
      const mod = req(name) as YamlMod
      if (mod && (typeof mod.parse === "function" || typeof mod.load === "function")) {
        cachedYaml = mod
        return cachedYaml
      }
    } catch {
      // try next
    }
  }
  cachedYaml = null
  return cachedYaml
}

function parseYaml(text: string): AnySpec | null {
  const mod = loadYaml()
  if (!mod) return null
  try {
    if (typeof mod.parse === "function") return mod.parse(text)
    if (typeof mod.load === "function") return mod.load(text)
  } catch {
    return null
  }
  return null
}

// ─── Spec discovery + caching ──────────────────────────────────────────────

const SPEC_NAMES = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
] as const

const DOC_SUBDIRS = ["", "docs", "doc", "api"] as const

interface ParsedSpec {
  /** spec file mtime when last parsed — invalidates the cache */
  mtimeMs: number
  /** map from operationId → operation (with method + path attached) */
  byOperationId: Map<string, IndexedOp>
  /** map from normalized path → list of operations for that path (any method) */
  byPath: Map<string, IndexedOp[]>
}

interface IndexedOp {
  method: string
  path: string
  op: AnySpec
  spec: AnySpec
}

// project root → resolved spec path | null (negative cache)
const rootToSpec = new Map<string, string | null>()
// spec path → parsed spec
const specCache = new Map<string, ParsedSpec>()

function findProjectRoot(start: string): string | null {
  let cur = resolve(start)
  // If `start` is a file, step up to its directory.
  try {
    if (statSync(cur).isFile()) cur = dirname(cur)
  } catch {
    // path doesn't exist — try its parent anyway
    cur = dirname(cur)
  }
  // Walk up until we find a package.json or hit the filesystem root.
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(cur, "package.json"))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

function findSpecPath(root: string): string | null {
  const cached = rootToSpec.get(root)
  if (cached !== undefined) return cached
  for (const sub of DOC_SUBDIRS) {
    for (const name of SPEC_NAMES) {
      const p = sub ? join(root, sub, name) : join(root, name)
      if (existsSync(p)) {
        rootToSpec.set(root, p)
        return p
      }
    }
  }
  rootToSpec.set(root, null)
  return null
}

function loadSpec(specPath: string): ParsedSpec | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(specPath).mtimeMs
  } catch {
    return null
  }
  const cached = specCache.get(specPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached

  let text: string
  try {
    text = readFileSync(specPath, "utf8")
  } catch {
    return null
  }

  let spec: AnySpec | null = null
  if (specPath.endsWith(".json")) {
    try {
      spec = JSON.parse(text)
    } catch {
      spec = null
    }
  } else {
    spec = parseYaml(text)
  }
  if (!spec || typeof spec !== "object") return null

  const indexed = indexSpec(spec)
  const parsed: ParsedSpec = { mtimeMs, ...indexed }
  specCache.set(specPath, parsed)
  return parsed
}

function indexSpec(spec: AnySpec): {
  byOperationId: Map<string, IndexedOp>
  byPath: Map<string, IndexedOp[]>
} {
  const byOperationId = new Map<string, IndexedOp>()
  const byPath = new Map<string, IndexedOp[]>()
  const paths = (spec && spec.paths) || {}
  if (typeof paths !== "object") return { byOperationId, byPath }

  const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace"]

  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, AnySpec>)) {
    if (!pathItem || typeof pathItem !== "object") continue
    const normalized = normalizePath(pathKey)
    for (const method of HTTP_METHODS) {
      const op = (pathItem as AnySpec)[method]
      if (!op || typeof op !== "object") continue
      const indexed: IndexedOp = { method, path: pathKey, op, spec }
      if (typeof op.operationId === "string" && op.operationId.length > 0) {
        byOperationId.set(op.operationId, indexed)
      }
      const list = byPath.get(normalized) ?? []
      list.push(indexed)
      byPath.set(normalized, list)
    }
  }
  return { byOperationId, byPath }
}

// `/users/{id}` → `/users/:id`. Also accept Express-style `/users/:id`.
function normalizePath(p: string): string {
  return p.replace(/\{([^}]+)\}/g, ":$1").toLowerCase()
}

// ─── File path → OpenAPI path inference ────────────────────────────────────

// Next.js app router: `app/api/users/[id]/route.ts` → `/api/users/:id`
// Plain Next.js pages: `pages/api/users/[id].ts` → `/api/users/:id`
// Express-ish: `routes/users/:id.ts` → `/users/:id`
function inferPathFromFile(filePath: string): string | null {
  const norm = filePath.replace(/\\/g, "/")
  const segs = norm.split("/")
  // Find the deepest "app" or "pages" or "routes" anchor
  const anchors = ["app", "pages", "routes", "src/app", "src/pages", "src/routes"]
  let startIdx = -1
  for (let i = segs.length - 1; i >= 0; i--) {
    if (anchors.includes(segs[i])) {
      startIdx = i + 1
      break
    }
  }
  if (startIdx === -1) return null
  let parts = segs.slice(startIdx)
  if (parts.length === 0) return null
  // Drop the trailing file (`route.ts`, `index.ts`, or `users.ts`).
  const last = parts[parts.length - 1]
  if (/^(route|index|page|handler)\.[cm]?[tj]sx?$/.test(last)) {
    parts = parts.slice(0, -1)
  } else if (/\.[cm]?[tj]sx?$/.test(last)) {
    parts[parts.length - 1] = last.replace(/\.[cm]?[tj]sx?$/, "")
  }
  // Strip Next.js route groups `(group)` and convert `[id]` → `:id`,
  // `[...slug]` → `:slug`, `[[...optional]]` → `:optional`.
  parts = parts
    .filter((s) => !(/^\(.+\)$/.test(s)))
    .map((s) =>
      s
        .replace(/^\[\[\.\.\.([^\]]+)\]\]$/, ":$1")
        .replace(/^\[\.\.\.([^\]]+)\]$/, ":$1")
        .replace(/^\[([^\]]+)\]$/, ":$1"),
    )
    .filter(Boolean)
  if (parts.length === 0) return null
  return "/" + parts.join("/")
}

// Match an inferred path against a normalized OpenAPI path. Both are
// already lowercased and `:param`-form. We accept any-name matching for
// param segments (`/users/:id` matches `/users/:userId`).
function pathsMatch(inferred: string, openapi: string): boolean {
  if (inferred === openapi) return true
  const a = inferred.split("/")
  const b = openapi.split("/")
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue
    if (a[i].startsWith(":") && b[i].startsWith(":")) continue
    return false
  }
  return true
}

// ─── Operation → IntentShape ───────────────────────────────────────────────

function operationToShape(op: IndexedOp): IntentShape | null {
  // Prefer a JSON requestBody.
  const body = op.op.requestBody
  if (body && typeof body === "object") {
    const resolvedBody = derefIfNeeded(body, op.spec)
    const content = resolvedBody?.content
    if (content && typeof content === "object") {
      const json =
        content["application/json"] ??
        content["application/*+json"] ??
        Object.values(content)[0]
      const schema = json && typeof json === "object" ? json.schema : undefined
      if (schema) {
        const shape = jsonSchemaToShape(schema, op.spec, new Set())
        shape._symbol = op.op.operationId || `${op.method.toUpperCase()} ${op.path}`
        return shape
      }
    }
  }

  // Otherwise fold path/query parameters into a synthetic object.
  const params: AnySpec[] = Array.isArray(op.op.parameters) ? op.op.parameters : []
  if (params.length === 0) return null
  const properties: Record<string, IntentShape> = {}
  const required: string[] = []
  for (const raw of params) {
    const p = derefIfNeeded(raw, op.spec)
    if (!p || typeof p !== "object" || typeof p.name !== "string") continue
    const child = p.schema
      ? jsonSchemaToShape(p.schema, op.spec, new Set())
      : { type: "string" as const }
    properties[p.name] = child
    if (p.required) required.push(p.name)
  }
  if (Object.keys(properties).length === 0) return null
  return {
    type: "object",
    properties,
    required,
    _symbol: op.op.operationId || `${op.method.toUpperCase()} ${op.path}`,
  }
}

function derefIfNeeded(node: AnySpec, spec: AnySpec): AnySpec {
  if (!node || typeof node !== "object") return node
  if (typeof node.$ref !== "string") return node
  const ref = node.$ref
  if (!ref.startsWith("#/")) return node
  const segments = ref.slice(2).split("/")
  let cur: AnySpec = spec
  for (const seg of segments) {
    if (cur == null) return node
    cur = cur[decodePointer(seg)]
  }
  return cur ?? node
}

function decodePointer(seg: string): string {
  return seg.replace(/~1/g, "/").replace(/~0/g, "~")
}

// JSON Schema → IntentShape. We support the OpenAPI 3.0/3.1 subset we
// see in the wild: type, properties/required, items, enum, format, $ref,
// oneOf/anyOf collapsed to enum-of-types. Unknown shapes become
// `{ type: "unknown" }`.
function jsonSchemaToShape(
  schemaIn: AnySpec,
  spec: AnySpec,
  seen: Set<string>,
): IntentShape {
  if (!schemaIn || typeof schemaIn !== "object") return { type: "unknown" }
  let schema = schemaIn

  // $ref: dereference, but guard recursion.
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref
    if (seen.has(ref)) return { $ref: ref, _symbol: refSymbol(ref) }
    const next = new Set(seen)
    next.add(ref)
    const derefd = derefIfNeeded(schema, spec)
    if (derefd === schema) return { $ref: ref, _symbol: refSymbol(ref) }
    const out = jsonSchemaToShape(derefd, spec, next)
    if (!out._symbol) out._symbol = refSymbol(ref)
    return out
  }

  // oneOf / anyOf — collapse to enum-of-types like the TS source.
  const variants =
    (Array.isArray(schema.oneOf) && schema.oneOf) ||
    (Array.isArray(schema.anyOf) && schema.anyOf) ||
    null
  if (variants) {
    const parts = variants.map((v: AnySpec) => jsonSchemaToShape(v, spec, seen))
    if (parts.every((p: IntentShape) => p.enum && p.enum.length === 1)) {
      return { enum: parts.flatMap((p: IntentShape) => p.enum!) }
    }
    return { enum: parts.map((p: IntentShape) => p.type ?? "unknown") }
  }

  // allOf — merge properties.
  if (Array.isArray(schema.allOf)) {
    const merged: IntentShape = { type: "object", properties: {}, required: [] }
    const reqSet = new Set<string>()
    for (const part of schema.allOf) {
      const child = jsonSchemaToShape(part, spec, seen)
      if (child.type === "object" && child.properties) {
        Object.assign(merged.properties!, child.properties)
        for (const r of child.required ?? []) reqSet.add(r)
      }
    }
    merged.required = Array.from(reqSet)
    return merged
  }

  if (Array.isArray(schema.enum)) {
    return { enum: [...schema.enum] }
  }

  const type = schema.type
  if (type === "object" || (!type && schema.properties)) {
    const properties: Record<string, IntentShape> = {}
    const required: string[] = Array.isArray(schema.required) ? [...schema.required] : []
    if (schema.properties && typeof schema.properties === "object") {
      for (const [k, v] of Object.entries(schema.properties as Record<string, AnySpec>)) {
        properties[k] = jsonSchemaToShape(v, spec, seen)
      }
    }
    const out: IntentShape = { type: "object", properties, required }
    if (typeof schema.description === "string") out.description = schema.description
    return out
  }

  if (type === "array") {
    return {
      type: "array",
      items: schema.items ? jsonSchemaToShape(schema.items, spec, seen) : { type: "unknown" },
    }
  }

  if (type === "string" || type === "number" || type === "integer" || type === "boolean" || type === "null") {
    const out: IntentShape = {
      type: type === "integer" ? "number" : (type as IntentShape["type"]),
    }
    if (typeof schema.format === "string") out.format = schema.format
    if (typeof schema.description === "string") out.description = schema.description
    return out
  }

  // Last resort.
  return { type: "unknown" }
}

function refSymbol(ref: string): string {
  const slash = ref.lastIndexOf("/")
  return slash >= 0 ? ref.slice(slash + 1) : ref
}

// ─── Source ────────────────────────────────────────────────────────────────

export const openapiSource: IntentSource = {
  name: "openapi",

  canParse(filePath: string): boolean {
    if (!filePath) return false
    const root = findProjectRoot(filePath)
    if (!root) return false
    const spec = findSpecPath(root)
    if (!spec) return false
    // YAML specs only parse if the optional peer is installed.
    if (spec.endsWith(".json")) return true
    return loadYaml() !== null
  },

  extract(filePath: string, symbol: string | null): IntentShape | null {
    const root = findProjectRoot(filePath)
    if (!root) return null
    const specPath = findSpecPath(root)
    if (!specPath) return null
    const parsed = loadSpec(specPath)
    if (!parsed) return null

    // (1) Direct operationId match.
    if (symbol) {
      const direct = parsed.byOperationId.get(symbol)
      if (direct) {
        const shape = operationToShape(direct)
        if (shape) return capShapeSize(shape)
      }
    }

    // (2) Infer the URL path from the file location.
    const inferred = inferPathFromFile(filePath)
    if (inferred) {
      const norm = normalizePath(inferred)
      const exact = parsed.byPath.get(norm)
      const candidates = exact ?? findFuzzyPath(parsed.byPath, norm)
      if (candidates && candidates.length > 0) {
        // Prefer the method whose name appears in `symbol` (e.g.
        // "POST handler" → POST). Otherwise pick the first non-GET
        // (usually the body-bearing one), then fall through to GET.
        const op = pickBestOp(candidates, symbol)
        const shape = operationToShape(op)
        if (shape) return capShapeSize(shape)
      }
    }

    return null
  },
}

function findFuzzyPath(byPath: Map<string, IndexedOp[]>, target: string): IndexedOp[] | null {
  // Try suffix match: an inferred `/api/users/:id` should also match
  // an OpenAPI spec that documents `/users/{id}` (no `/api` prefix).
  for (const [k, v] of byPath) {
    if (target.endsWith(k) || k.endsWith(target)) {
      if (pathsMatch(target, k) || pathsMatch(k, target) || endsWithMatch(target, k) || endsWithMatch(k, target)) {
        return v
      }
    }
  }
  return null
}

function endsWithMatch(a: string, b: string): boolean {
  // Compare segment-wise from the right.
  const aSeg = a.split("/").filter(Boolean).reverse()
  const bSeg = b.split("/").filter(Boolean).reverse()
  const len = Math.min(aSeg.length, bSeg.length)
  if (len === 0) return false
  for (let i = 0; i < len; i++) {
    const x = aSeg[i]
    const y = bSeg[i]
    if (x === y) continue
    if (x.startsWith(":") && y.startsWith(":")) continue
    return false
  }
  return true
}

function pickBestOp(ops: IndexedOp[], symbol: string | null): IndexedOp {
  if (symbol) {
    const upper = symbol.toUpperCase()
    for (const op of ops) {
      if (upper.includes(op.method.toUpperCase())) return op
    }
  }
  // Body-bearing methods first.
  const order = ["post", "put", "patch", "delete", "get", "head", "options", "trace"]
  ops.sort((a, b) => order.indexOf(a.method) - order.indexOf(b.method))
  return ops[0]
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export function __resetOpenapiCacheForTesting(): void {
  rootToSpec.clear()
  specCache.clear()
  // Also forget the YAML peer probe so tests can re-run cleanly.
  triedYaml = false
  cachedYaml = null
}

// `sep` is imported for cross-platform path tests; reference it once so
// `tsc --noEmit` doesn't flag unused.
void sep
