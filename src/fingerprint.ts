// Fingerprint algorithm v1 — must stay in sync with:
//   web/lib/ai/fingerprint.ts
//   cli/src/mcp/fingerprint.rs
//
// Normalization steps (ORDER MATTERS for cross-language determinism):
//   1. Concatenate title + body, lowercase
//   2. Strip UUIDs (before epochs — UUIDs contain digit sequences)
//   3. Strip ISO 8601 timestamps (lowercase t)
//   4. Strip Unix epochs (10+ digits)
//   5. Strip relative times ("5 minutes ago")
//   6. Strip hex IDs (>8 chars)
//   7. Strip file paths (/foo/bar.ts)
//   8. Strip line numbers (at line 42, :42:10)
//   9. Strip URLs
//  10. Strip version numbers (v1.2.3)
//  11. Collapse whitespace, trim
//  12. SHA-256 → hex string (64 chars)

let cryptoModule: typeof import("crypto") | null = null

async function getNodeCrypto(): Promise<typeof import("crypto") | null> {
  if (cryptoModule) return cryptoModule
  try {
    cryptoModule = await import("crypto")
    return cryptoModule
  } catch {
    return null
  }
}

function normalizeErrorText(input: string): string {
  let s = input

  // 2. UUIDs (before epochs — UUIDs contain digit sequences that epoch regex would eat)
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")

  // 3. ISO 8601 timestamps (lowercase t — input is already lowercased)
  s = s.replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*/g, "<timestamp>")

  // 4. Unix epochs (10-13 digits)
  s = s.replace(/\b\d{10,13}\b/g, "<timestamp>")

  // 5. Relative times
  s = s.replace(/\b\d+\s*(ms|seconds?|minutes?|hours?|days?)\s*ago\b/g, "<time_ago>")

  // 6. Hex IDs (>8 chars)
  s = s.replace(/\b[0-9a-f]{9,}\b/g, "<hex_id>")

  // 7. File paths
  s = s.replace(/(?:\/[\w.\-]+){2,}(?:\.\w+)?/g, "<path>")

  // 8. Line numbers
  s = s.replace(/(?:at line|line:?|:\d+:\d+)\s*\d+/g, "at line <N>")

  // 9. URLs
  s = s.replace(/https?:\/\/[^\s)]+/g, "<url>")

  // 10. Version numbers
  s = s.replace(/v?\d+\.\d+\.\d+[^\s]*/g, "<version>")

  // 11. Collapse whitespace
  return s.replace(/\s+/g, " ").trim()
}

async function sha256Hex(input: string): Promise<string> {
  // Try Node.js crypto first (fastest, synchronous)
  const nodeCrypto = await getNodeCrypto()
  if (nodeCrypto?.createHash) {
    return nodeCrypto.createHash("sha256").update(input, "utf8").digest("hex")
  }

  // Fallback: Web Crypto API (edge runtimes)
  const encoder = new TextEncoder()
  const data = encoder.encode(input)
  const hashBuffer = await crypto.subtle.digest("SHA-256", data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("")
}

export async function computeErrorFingerprint(title: string, body: string): Promise<string> {
  const input = `${title}\n${body}`.toLowerCase()
  const normalized = normalizeErrorText(input)
  return sha256Hex(normalized)
}
