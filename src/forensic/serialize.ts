import type { ForensicValue, ForensicOptions } from "./types.js"

/**
 * Bounded serializer used by BOTH the inspector fallback (when we get a
 * RemoteObject preview) and the eventual fork path (when we receive raw
 * JS values from the N-API bridge). Keeps output stable across paths.
 */

interface Budget {
  remainingBytes: number
  maxDepth: number
}

/** Truncate a string to byte budget and mark with an ellipsis. */
function truncateString(s: string, budget: Budget): { out: string; truncated: boolean } {
  if (s.length <= budget.remainingBytes) {
    budget.remainingBytes -= s.length
    return { out: s, truncated: false }
  }
  const out = s.slice(0, Math.max(0, budget.remainingBytes - 1)) + "…"
  budget.remainingBytes = 0
  return { out, truncated: true }
}

function reprPrimitive(value: unknown, budget: Budget): { repr: string; truncated: boolean; kind: string } {
  if (value === null) return { repr: "null", truncated: false, kind: "null" }
  const t = typeof value
  if (t === "undefined") return { repr: "undefined", truncated: false, kind: "undefined" }
  if (t === "string") {
    const { out, truncated } = truncateString(JSON.stringify(value), budget)
    return { repr: out, truncated, kind: "string" }
  }
  if (t === "number" || t === "boolean" || t === "bigint") {
    const s = t === "bigint" ? `${(value as bigint).toString()}n` : String(value)
    const { out, truncated } = truncateString(s, budget)
    return { repr: out, truncated, kind: t }
  }
  if (t === "symbol") {
    const { out, truncated } = truncateString((value as symbol).toString(), budget)
    return { repr: out, truncated, kind: "symbol" }
  }
  if (t === "function") {
    const name = (value as { name?: string }).name || "<anonymous>"
    const { out, truncated } = truncateString(`[Function: ${name}]`, budget)
    return { repr: out, truncated, kind: "function" }
  }
  return { repr: "", truncated: false, kind: "unknown" }
}

function reprObject(value: object, depth: number, budget: Budget, seen: WeakSet<object>): { repr: string; truncated: boolean; kind: string } {
  if (seen.has(value)) {
    const { out, truncated } = truncateString("[Circular]", budget)
    return { repr: out, truncated, kind: "object" }
  }
  seen.add(value)

  if (value instanceof Error) {
    const { out, truncated } = truncateString(`${value.name}: ${value.message}`, budget)
    return { repr: out, truncated, kind: "error" }
  }

  if (value instanceof Date) {
    const { out, truncated } = truncateString(value.toISOString(), budget)
    return { repr: out, truncated, kind: "object:Date" }
  }

  if (value instanceof RegExp) {
    const { out, truncated } = truncateString(value.toString(), budget)
    return { repr: out, truncated, kind: "object:RegExp" }
  }

  if (typeof (value as { then?: unknown }).then === "function") {
    const { out, truncated } = truncateString("[Promise]", budget)
    return { repr: out, truncated, kind: "promise" }
  }

  if (depth >= budget.maxDepth) {
    const ctor = (value.constructor && value.constructor.name) || "Object"
    const { out, truncated } = truncateString(`[${ctor}]`, budget)
    return { repr: out, truncated: true, kind: `object:${ctor}` }
  }

  if (Array.isArray(value)) {
    const parts: string[] = []
    let truncated = false
    for (let i = 0; i < value.length; i++) {
      if (budget.remainingBytes <= 3) {
        truncated = true
        break
      }
      const child = reprAny(value[i], depth + 1, budget, seen)
      parts.push(child.repr)
      if (child.truncated) truncated = true
    }
    const body = parts.join(",")
    return { repr: `[${body}${truncated ? ",…" : ""}]`, truncated, kind: "array" }
  }

  const ctor = (value.constructor && value.constructor.name) || "Object"
  const entries: string[] = []
  let truncated = false
  const keys = Object.keys(value as Record<string, unknown>)
  for (const key of keys) {
    if (budget.remainingBytes <= 3) {
      truncated = true
      break
    }
    const keyJson = JSON.stringify(key)
    const child = reprAny((value as Record<string, unknown>)[key], depth + 1, budget, seen)
    entries.push(`${keyJson}:${child.repr}`)
    if (child.truncated) truncated = true
  }
  const body = entries.join(",")
  return { repr: `{${body}${truncated ? ",…" : ""}}`, truncated, kind: `object:${ctor}` }
}

function reprAny(value: unknown, depth: number, budget: Budget, seen: WeakSet<object>): { repr: string; truncated: boolean; kind: string } {
  if (value === null || typeof value !== "object") {
    return reprPrimitive(value, budget)
  }
  return reprObject(value, depth, budget, seen)
}

export function serializeValue(name: string, value: unknown, opts: Required<ForensicOptions>): ForensicValue {
  const budget: Budget = { remainingBytes: opts.maxValueBytes, maxDepth: opts.maxValueDepth }
  const seen = new WeakSet<object>()
  const { repr, truncated, kind } = reprAny(value, 0, budget, seen)
  const out: ForensicValue = { name, repr, kind }
  if (truncated) out.truncated = true
  return out
}
