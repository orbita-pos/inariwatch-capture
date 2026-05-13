import { captureLog } from "../client.js"

// Patterns matching hydration error messages from major frameworks
const HYDRATION_PATTERNS: Array<{ re: RegExp; framework: string }> = [
  // React 18/19
  { re: /Hydration failed because/i, framework: "react" },
  { re: /Text content does not match server-rendered HTML/i, framework: "react" },
  { re: /There was an error while hydrating/i, framework: "react" },
  { re: /Expected server HTML to contain a matching/i, framework: "react" },
  // Next.js (wraps React errors with more context)
  { re: /hydration mismatch/i, framework: "next" },
  { re: /server rendered HTML didn't match/i, framework: "next" },
  // Vue 3
  { re: /Hydration node mismatch/i, framework: "vue" },
  { re: /Hydration completed but contains mismatches/i, framework: "vue" },
  // Nuxt
  { re: /\[nuxt\] hydration/i, framework: "nuxt" },
  // Astro
  { re: /\[astro\] hydration/i, framework: "astro" },
]

// Marker used to detect when console.error is already wrapped by this
// detector (or a hot-reloaded copy of it). Prevents double-wrap chains
// and avoids competing with other libs that do the same.
const WRAP_MARKER = "__inariwatchAwakeHydrationWrap" as const

interface MarkedConsoleError {
  (this: typeof console, ...args: unknown[]): void
  [WRAP_MARKER]?: true
}

let installed = false

function detectHydrationError(args: unknown[]): void {
  const message = args.find(a => typeof a === "string") as string | undefined
  if (!message) return

  for (const { re, framework } of HYDRATION_PATTERNS) {
    if (!re.test(message)) continue

    captureLog(
      `hydration_mismatch: ${message.slice(0, 120)}`,
      "warn",
      {
        kind: "hydration_mismatch",
        framework,
        message: message.slice(0, 500),
        url: location.href,
      },
    )
    break
  }
}

export function installHydrationDetector(): void {
  if (typeof window === "undefined") return
  if (installed) return

  const current = console.error as MarkedConsoleError
  if (current[WRAP_MARKER]) {
    // We're already in the chain (e.g., HMR reload after this module
    // re-evaluated). Don't add another layer.
    installed = true
    return
  }

  // ── Safe wrap pattern ────────────────────────────────────────────────
  // 1. Capture the CURRENT console.error (which may itself be a wrapper
  //    installed by Sentry, Datadog, or the React dev runtime). Forward
  //    to it via .apply so its `this` binding survives. The previous
  //    implementation called `originalConsoleError!(...args)` which
  //    broke `this` and lost the call chain if the wrapped fn relied on
  //    its console-bound receiver.
  // 2. Tag the new function with WRAP_MARKER so future installs detect
  //    us and skip — no double-wrap chain.
  // 3. Detect first, forward unconditionally. We never swallow the log
  //    so dev-time React warnings still surface in the user's devtools.
  const wrapped: MarkedConsoleError = function (this: typeof console, ...args: unknown[]): void {
    try {
      detectHydrationError(args)
    } catch {
      // Detector must never break console.error itself.
    }
    return current.apply(this, args)
  }
  wrapped[WRAP_MARKER] = true
  console.error = wrapped
  installed = true
}
