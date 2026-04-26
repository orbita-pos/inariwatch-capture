/**
 * ioredis hook — patches `Redis.prototype.sendCommand` to record a graph
 * node for every Redis command.
 *
 * `sendCommand` is the single funnel for every public method on ioredis
 * (`client.get(key)`, `client.set(key, val)`, `client.pipeline().exec()` —
 * pipelines flush through individual sendCommand calls). Patching it gets
 * full driver coverage with one hook.
 *
 * Idempotent (Symbol mark on the prototype). Driver missing → returns
 * `false` silently. Never throws.
 *
 * The recorded op uses the lowercase command name (`redis.get`, `redis.set`,
 * `redis.hset`, …) so downstream filtering matches the same op-name shape
 * used by pg/prisma/drizzle hooks.
 */

import { recordOp } from "./graph.js"
import { findDataFromIds, tagValue } from "./data-flow.js"

const PATCH_MARK = Symbol.for("@inariwatch/capture.causal.redis.patched")

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModLoader = () => Promise<any>

const DEFAULT_LOADER: ModLoader = () => {
  // Indirect via a variable so TypeScript doesn't try to resolve the
  // module at compile time — `ioredis` is an optional peer.
  const pkg = "ioredis"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import(/* webpackIgnore: true */ pkg) as any
}

/**
 * Patch ioredis `Redis.prototype.sendCommand`. Returns `true` when newly
 * patched, `false` when missing or already patched.
 */
export async function installRedisHook(
  loader: ModLoader = DEFAULT_LOADER,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any
  try {
    mod = await loader()
  } catch {
    return false
  }
  // ioredis ships CJS default + ESM named — interop both.
  const Redis = mod?.Redis ?? mod?.default?.Redis ?? mod?.default ?? mod
  if (!Redis?.prototype) return false
  return patchSendCommand(Redis.prototype)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchSendCommand(proto: any): boolean {
  if (proto[PATCH_MARK]) return false
  const original = proto.sendCommand
  if (typeof original !== "function") return false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.sendCommand = function patchedSendCommand(this: unknown, command: any) {
    const name = extractCommandName(command)
    const args = extractCommandArgs(command)
    const handle = recordOp(`redis.${name.toLowerCase()}`, {
      args: truncateArgs(args),
    })
    const start = Date.now()

    // Stitch data-flow edges if any arg traces back to a tagged value.
    const dataFrom = findDataFromIds(args)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any
    try {
      result = original.call(this, command)
    } catch (err) {
      handle.end({ durationMs: Date.now() - start, error: err, dataFrom })
      throw err
    }

    // ioredis sendCommand returns a Command object with a `.promise`. We
    // attach to that promise (preferred) or to the result directly when it
    // is already a thenable.
    const promise = result?.promise ?? result
    if (promise && typeof promise.then === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      promise.then(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (value: any) => {
          // Tag value so downstream ops can stitch their own data-flow edges.
          if (handle.id && value && typeof value === "object") tagValue(value, handle.id)
          handle.end({ durationMs: Date.now() - start, dataFrom })
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err: any) => {
          handle.end({ durationMs: Date.now() - start, error: err, dataFrom })
        },
      )
    } else {
      // Sync return — record now (ioredis virtually always returns async,
      // but custom mocks/test doubles may not).
      handle.end({ durationMs: Date.now() - start, dataFrom })
    }
    return result
  }

  Object.defineProperty(proto, PATCH_MARK, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  return true
}

function extractCommandName(command: unknown): string {
  if (!command || typeof command !== "object") return "unknown"
  const obj = command as Record<string, unknown>
  if (typeof obj.name === "string") return obj.name
  return "unknown"
}

function extractCommandArgs(command: unknown): unknown[] {
  if (!command || typeof command !== "object") return []
  const obj = command as Record<string, unknown>
  if (Array.isArray(obj.args)) return obj.args
  return []
}

function truncateArgs(args: unknown[]): string {
  let out = ""
  for (let i = 0; i < args.length && out.length < 200; i++) {
    const arg = args[i]
    out +=
      (i > 0 ? " " : "") +
      (typeof arg === "string"
        ? truncate(arg, 50)
        : typeof arg === "number" || typeof arg === "boolean"
          ? String(arg)
          : "<obj>")
  }
  return truncate(out, 200)
}

function truncate(s: string, n: number): string {
  if (!s) return s
  return s.length <= n ? s : s.slice(0, n) + "…"
}

export const __REDIS_PATCH_MARK_FOR_TESTING: symbol = PATCH_MARK
