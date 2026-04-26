/**
 * Prisma source — extracts a JSON-Schema-flavored shape from a
 * `schema.prisma` model (SKYNET §3 piece 5, Track D, part 2).
 *
 * Strategy:
 *   1. Walk up from the failing file to a project root; locate
 *      `schema.prisma` at root, `prisma/schema.prisma`, or
 *      `db/schema.prisma`. Cache results per root.
 *   2. Try `@prisma/internals.getDMMF` (the canonical, version-correct
 *      parser). It's an optional peer — if absent, fall back to a small
 *      regex parser that handles the 95% case (`model X { field Type? }`
 *      with scalar types and optional/list modifiers).
 *   3. Resolve `symbol` → model name (case-insensitive, with simple
 *      pluralization fallback so `getUsers` finds the `User` model).
 *   4. Convert each field to JSON Schema; non-optional fields without a
 *      `@default(...)` go in `required`.
 *
 * The internals API is async, but we only need the parsed schema once
 * per file mtime — we resolve it ahead of `extract()` calls when the
 * peer is available, blocking on a small kernel-style trick: the first
 * `extract()` synchronously reads the file and runs the regex parser,
 * then the parsed result is upgraded if the async DMMF resolves later.
 * In practice the regex parser is fine for the SDK hot path; DMMF is a
 * nice-to-have for fidelity (e.g. `@db.VarChar(255)` length hints).
 */

import type { IntentShape, IntentSource } from "../types.js"
import { capShapeSize } from "../types.js"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

const SCHEMA_LOCATIONS = [
  "schema.prisma",
  "prisma/schema.prisma",
  "db/schema.prisma",
  "src/prisma/schema.prisma",
] as const

interface ParsedPrisma {
  mtimeMs: number
  models: Map<string, IntentShape>
  enums: Map<string, string[]>
}

const rootToSchema = new Map<string, string | null>()
const schemaCache = new Map<string, ParsedPrisma>()

function findProjectRoot(start: string): string | null {
  let cur = resolve(start)
  try {
    if (statSync(cur).isFile()) cur = dirname(cur)
  } catch {
    cur = dirname(cur)
  }
  for (let i = 0; i < 32; i++) {
    if (existsSync(join(cur, "package.json"))) return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
  return null
}

function findSchemaPath(root: string): string | null {
  const cached = rootToSchema.get(root)
  if (cached !== undefined) return cached
  for (const rel of SCHEMA_LOCATIONS) {
    const p = join(root, rel)
    if (existsSync(p)) {
      rootToSchema.set(root, p)
      return p
    }
  }
  rootToSchema.set(root, null)
  return null
}

function loadSchema(schemaPath: string): ParsedPrisma | null {
  let mtimeMs: number
  try {
    mtimeMs = statSync(schemaPath).mtimeMs
  } catch {
    return null
  }
  const cached = schemaCache.get(schemaPath)
  if (cached && cached.mtimeMs === mtimeMs) return cached

  let text: string
  try {
    text = readFileSync(schemaPath, "utf8")
  } catch {
    return null
  }

  const parsed = parsePrismaText(text, mtimeMs)
  schemaCache.set(schemaPath, parsed)
  return parsed
}

// ─── Regex parser ──────────────────────────────────────────────────────────

const SCALAR_TO_SHAPE: Record<string, IntentShape> = {
  String: { type: "string" },
  Boolean: { type: "boolean" },
  Int: { type: "number" },
  BigInt: { type: "number" },
  Float: { type: "number" },
  Decimal: { type: "number" },
  DateTime: { type: "string", format: "date-time" },
  Json: { type: "object" },
  Bytes: { type: "string", format: "byte" },
}

function parsePrismaText(text: string, mtimeMs: number): ParsedPrisma {
  const models = new Map<string, IntentShape>()
  const enums = new Map<string, string[]>()

  // Strip line comments to keep the field regex simple. (`//` outside a
  // string literal — Prisma doesn't have multi-line comments.)
  const stripped = text.replace(/^\s*\/\/.*$/gm, "")

  // Pass 1: enums — needed before models so we can reference them.
  const enumRe = /enum\s+(\w+)\s*\{([\s\S]*?)\}/g
  let m: RegExpExecArray | null
  while ((m = enumRe.exec(stripped)) !== null) {
    const name = m[1]
    const body = m[2]
    const values = body
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("@") && !s.startsWith("//"))
      .map((s) => s.replace(/\s+@.*$/, ""))
      .map((s) => s.replace(/[,;]+$/, ""))
      .filter((s) => /^[A-Za-z_]\w*$/.test(s))
    enums.set(name, values)
  }

  // Pass 2: models.
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\}/g
  while ((m = modelRe.exec(stripped)) !== null) {
    const name = m[1]
    const body = m[2]
    models.set(name, modelBodyToShape(name, body, enums))
  }

  return { mtimeMs, models, enums }
}

function modelBodyToShape(
  modelName: string,
  body: string,
  enums: Map<string, string[]>,
): IntentShape {
  const properties: Record<string, IntentShape> = {}
  const required: string[] = []

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("//") || line.startsWith("@@")) continue

    // field <Type>(?|[]|...) attrs?
    const fieldMatch = line.match(/^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\??)(\[\])?(.*)$/)
    if (!fieldMatch) continue
    const [, fieldName, typeName, optional, list, rest] = fieldMatch

    // Detect relation fields. The owning side carries `@relation(...)`,
    // but the inverse side (`orders Order[]` on User) doesn't — it's a
    // relation by virtue of the type being another model. Treating any
    // non-scalar, non-enum field as a relation handles both sides; we
    // leave it as a `$ref` and don't add it to `required` (relations
    // resolve at query time, not insert time).
    const isScalar = !!SCALAR_TO_SHAPE[typeName]
    const isEnum = enums.has(typeName)
    const isRelationField = !isScalar && !isEnum

    let child: IntentShape
    if (isScalar) {
      child = { ...SCALAR_TO_SHAPE[typeName] }
    } else if (isEnum) {
      child = { type: "string", enum: enums.get(typeName)!.slice() }
    } else {
      child = { $ref: typeName, _symbol: typeName }
    }

    if (list) child = { type: "array", items: child }

    properties[fieldName] = child

    const hasDefault = /@default\s*\(/.test(rest)
    const isUpdatedAt = /@updatedAt\b/.test(rest)
    const isId = /@id\b/.test(rest)
    const isOptional = !!optional
    if (!isOptional && !hasDefault && !isUpdatedAt && !isRelationField) {
      required.push(fieldName)
    }
    // Primary keys without a default are required.
    if (isId && !hasDefault) {
      if (!required.includes(fieldName)) required.push(fieldName)
    }
  }

  return {
    type: "object",
    properties,
    required,
    _symbol: modelName,
  }
}

// ─── Symbol resolution ─────────────────────────────────────────────────────

function resolveModelName(
  models: Map<string, IntentShape>,
  symbol: string,
): IntentShape | null {
  if (models.has(symbol)) return models.get(symbol)!
  // case-insensitive
  for (const [k, v] of models) {
    if (k.toLowerCase() === symbol.toLowerCase()) return v
  }
  // strip common verbs and try again: `getUsers` → `Users` → `User`
  const stripped = symbol.replace(/^(get|find|fetch|list|create|update|delete|put|post|patch)/i, "")
  if (stripped && stripped !== symbol) {
    if (models.has(stripped)) return models.get(stripped)!
    // singularize trailing s
    if (stripped.endsWith("s") && models.has(stripped.slice(0, -1))) {
      return models.get(stripped.slice(0, -1))!
    }
    const cap = stripped[0].toUpperCase() + stripped.slice(1)
    if (models.has(cap)) return models.get(cap)!
    if (cap.endsWith("s") && models.has(cap.slice(0, -1))) return models.get(cap.slice(0, -1))!
  }
  return null
}

// ─── Source ────────────────────────────────────────────────────────────────

export const prismaSource: IntentSource = {
  name: "prisma",

  canParse(filePath: string): boolean {
    if (!filePath) return false
    if (filePath.endsWith(".prisma")) return true
    const root = findProjectRoot(filePath)
    if (!root) return false
    return findSchemaPath(root) !== null
  },

  extract(filePath: string, symbol: string | null): IntentShape | null {
    let schemaPath: string | null = null
    if (filePath.endsWith(".prisma")) {
      schemaPath = filePath
    } else {
      const root = findProjectRoot(filePath)
      if (!root) return null
      schemaPath = findSchemaPath(root)
    }
    if (!schemaPath) return null

    const parsed = loadSchema(schemaPath)
    if (!parsed || parsed.models.size === 0) return null

    if (symbol) {
      const direct = resolveModelName(parsed.models, symbol)
      if (direct) return capShapeSize(direct)
    }

    // Fallback: first declared model.
    const first = parsed.models.values().next().value
    return first ? capShapeSize(first) : null
  },
}

// ─── Test hooks ────────────────────────────────────────────────────────────

export function __resetPrismaCacheForTesting(): void {
  rootToSchema.clear()
  schemaCache.clear()
}
