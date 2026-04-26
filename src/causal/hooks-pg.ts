/**
 * `pg` driver hook — patches Client.prototype.query and Pool.prototype.query
 * to record a causal-graph node for every query.
 *
 * Both Promise and callback APIs are supported:
 *   client.query("SELECT 1")               → returns Promise → wrap .then
 *   client.query("SELECT 1", [], cb)       → wrap cb to record on completion
 *
 * Idempotent: a second install on the same prototype is a no-op (we mark
 * the prototype with a Symbol). Survives re-imports of `pg` because
 * Node caches modules.
 *
 * Driver missing: install resolves to `false` silently. Never throws.
 *
 * Test seam: `loader` lets tests pass a fake `pg` module. Default loader
 * dynamic-imports the real package.
 */

import { recordOp } from "./graph.js"
import { findDataFromIds } from "./data-flow.js"

const PATCH_MARK = Symbol.for("@inariwatch/capture.causal.pg.patched")

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModLoader = () => Promise<any>

const DEFAULT_LOADER: ModLoader = () => {
  // Indirect via a variable so TypeScript doesn't try to resolve the
  // module at compile time — `pg` is an optional peer.
  const pkg = "pg"
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return import(/* webpackIgnore: true */ pkg) as any
}

/**
 * Patch `pg`'s `Client.prototype.query` and `Pool.prototype.query`. Returns
 * `true` if at least one prototype was newly patched, `false` otherwise
 * (driver missing or already patched).
 */
export async function installPgHook(loader: ModLoader = DEFAULT_LOADER): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pg: any
  try {
    pg = await loader()
  } catch {
    return false
  }
  // pg ships both ESM and CJS — interop default if present.
  const mod = pg?.default ?? pg
  if (!mod) return false

  let patched = false
  if (mod.Client?.prototype) {
    patched = patchQuery(mod.Client.prototype, "client") || patched
  }
  if (mod.Pool?.prototype) {
    patched = patchQuery(mod.Pool.prototype, "pool") || patched
  }
  return patched
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchQuery(proto: any, label: "client" | "pool"): boolean {
  if (proto[PATCH_MARK]) return false
  const original = proto.query
  if (typeof original !== "function") return false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.query = function patchedQuery(this: unknown, ...args: any[]) {
    const sql = extractSql(args[0])
    const handle = recordOp(`pg.${label}.query`, {
      sql: truncate(sql, 500),
    })
    const start = Date.now()
    // Stitch data-flow edges from any tainted value passed in args
    // (e.g. parameters array, or a `{ text, values }` object).
    const dataFrom = findDataFromIds(args)

    // Callback API: pg.query(text, [params,] callback). Wrap the callback
    // so we can record completion accurately. We MUST return whatever
    // pg returns (some pg versions return a Submittable; others undefined).
    const lastIdx = args.length - 1
    const cb = lastIdx >= 0 ? args[lastIdx] : undefined
    if (typeof cb === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      args[lastIdx] = function wrappedCb(this: unknown, err: any, res: any) {
        if (err) {
          handle.end({ durationMs: Date.now() - start, error: err, dataFrom })
        } else {
          handle.end({
            durationMs: Date.now() - start,
            attrs: { rowCount: res?.rowCount ?? null },
            dataFrom,
          })
        }
        // eslint-disable-next-line prefer-rest-params, @typescript-eslint/no-explicit-any
        return cb.apply(this, arguments as any)
      }
      try {
        return original.apply(this, args)
      } catch (err) {
        handle.end({ durationMs: Date.now() - start, error: err, dataFrom })
        throw err
      }
    }

    // Promise / Submittable API.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any
    try {
      result = original.apply(this, args)
    } catch (err) {
      handle.end({ durationMs: Date.now() - start, error: err, dataFrom })
      throw err
    }
    if (result && typeof result.then === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result.then(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (v: any) => {
          handle.end({
            durationMs: Date.now() - start,
            attrs: { rowCount: v?.rowCount ?? null },
            dataFrom,
          })
          return v
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err: any) => {
          handle.end({ durationMs: Date.now() - start, error: err, dataFrom })
          throw err
        },
      )
    }
    // Sync return (rare) — record now.
    handle.end({ durationMs: Date.now() - start, dataFrom })
    return result
  }
  // Defining via property descriptor lets us survive `Object.freeze` on
  // some test mocks that don't allow direct assignment.
  Object.defineProperty(proto, PATCH_MARK, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  })
  return true
}

function extractSql(arg: unknown): string {
  if (typeof arg === "string") return arg
  if (arg && typeof arg === "object") {
    const obj = arg as Record<string, unknown>
    if (typeof obj.text === "string") return obj.text
    if (typeof obj.name === "string") return `(prepared:${obj.name})`
  }
  return "<unknown>"
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + "…"
}

// ─── Test helpers ──────────────────────────────────────────────────────────

export const __PG_PATCH_MARK_FOR_TESTING: symbol = PATCH_MARK
