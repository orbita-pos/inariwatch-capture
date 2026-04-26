/**
 * Drizzle ORM hook — patches the `execute` method on the dialect-specific
 * Database prototypes (`PgDatabase`, `MySqlDatabase`, `BaseSQLiteDatabase`).
 *
 * Drizzle is structured as a thin wrapper over a driver (pg, postgres-js,
 * mysql2, better-sqlite3, …). Every query — whether built via `db.select(...)`
 * or `db.execute(sql\`...\`)` — funnels through the dialect's
 * `Database.prototype.execute`. Patching there gets us full coverage with
 * a single hook per dialect.
 *
 * We try each `*-core` package independently — if a project uses only
 * `pg-core`, it has no `mysql-core` and we skip that dialect quietly.
 *
 * Idempotent and zero-throw on missing modules.
 */

import { recordOp } from "./graph.js"

const PATCH_MARK = Symbol.for("@inariwatch/capture.causal.drizzle.patched")

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModLoader = () => Promise<any>

interface DrizzleLoaders {
  pg?: ModLoader
  mysql?: ModLoader
  sqlite?: ModLoader
}

// Indirect via variables so TypeScript doesn't resolve these subpaths at
// compile time — drizzle is an optional peer.
const DEFAULT_LOADERS: DrizzleLoaders = {
  pg: () => {
    const pkg = "drizzle-orm/pg-core"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return import(/* webpackIgnore: true */ pkg) as any
  },
  mysql: () => {
    const pkg = "drizzle-orm/mysql-core"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return import(/* webpackIgnore: true */ pkg) as any
  },
  sqlite: () => {
    const pkg = "drizzle-orm/sqlite-core"
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return import(/* webpackIgnore: true */ pkg) as any
  },
}

/**
 * Patch every available drizzle dialect's `Database.prototype.execute`.
 * Returns `true` if at least one prototype was newly patched.
 */
export async function installDrizzleHook(
  loaders: DrizzleLoaders = DEFAULT_LOADERS,
): Promise<boolean> {
  let patched = false
  patched =
    (await tryPatch(loaders.pg, ["PgDatabase"], "drizzle.pg")) || patched
  patched =
    (await tryPatch(loaders.mysql, ["MySqlDatabase"], "drizzle.mysql")) ||
    patched
  patched =
    (await tryPatch(
      loaders.sqlite,
      ["BaseSQLiteDatabase", "SQLiteDatabase"],
      "drizzle.sqlite",
    )) || patched
  return patched
}

async function tryPatch(
  loader: ModLoader | undefined,
  classNames: string[],
  opPrefix: string,
): Promise<boolean> {
  if (!loader) return false
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any
  try {
    mod = await loader()
  } catch {
    return false
  }
  if (!mod) return false
  const target = mod.default ?? mod
  let patched = false
  for (const name of classNames) {
    const klass = target[name]
    if (klass?.prototype) {
      patched = patchExecute(klass.prototype, opPrefix) || patched
    }
  }
  return patched
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function patchExecute(proto: any, opPrefix: string): boolean {
  if (proto[PATCH_MARK]) return false
  const original = proto.execute
  if (typeof original !== "function") return false

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  proto.execute = function patchedExecute(this: unknown, query: any) {
    const sql = extractDrizzleSql(query)
    const handle = recordOp(`${opPrefix}.execute`, {
      sql: truncate(sql, 500),
    })
    const start = Date.now()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let result: any
    try {
      result = original.call(this, query)
    } catch (err) {
      handle.end({ durationMs: Date.now() - start, error: err })
      throw err
    }
    if (result && typeof result.then === "function") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return result.then(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (v: any) => {
          handle.end({ durationMs: Date.now() - start })
          return v
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err: any) => {
          handle.end({ durationMs: Date.now() - start, error: err })
          throw err
        },
      )
    }
    handle.end({ durationMs: Date.now() - start })
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

function extractDrizzleSql(query: unknown): string {
  if (!query) return "<unknown>"
  if (typeof query === "string") return query
  if (typeof query === "object") {
    const obj = query as Record<string, unknown>
    // SQL chunks built via `sql\`...\`` expose `.sql` getter or `.queryChunks`.
    if (typeof obj.sql === "string") return obj.sql
    if (typeof obj.text === "string") return obj.text
    if (typeof obj.toQuery === "function") {
      try {
        const built = (obj.toQuery as () => unknown)()
        if (built && typeof built === "object") {
          const s = (built as Record<string, unknown>).sql
          if (typeof s === "string") return s
        }
      } catch {
        // best-effort
      }
    }
  }
  return "<unknown>"
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, n) + "…"
}

// ─── Test helpers ──────────────────────────────────────────────────────────

export const __DRIZZLE_PATCH_MARK_FOR_TESTING: symbol = PATCH_MARK
