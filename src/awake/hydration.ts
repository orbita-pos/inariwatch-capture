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

let originalConsoleError: typeof console.error | null = null
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
  installed = true

  originalConsoleError = console.error
  console.error = function (...args: unknown[]) {
    detectHydrationError(args)
    originalConsoleError!(...args)
  }
}
