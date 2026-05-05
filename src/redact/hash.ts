/**
 * Fast non-cryptographic 32-bit hash (FNV-1a).
 *
 * Used by the redactor's `hashMode` option to produce stable per-value
 * suffixes ("[REDACTED_EMAIL:a1b2c3d4]") so log readers can correlate the
 * same redacted value across events without exposing the original text.
 *
 * Crypto strength is intentionally NOT required — these labels are
 * debugging aids, not authentication tokens. SHA-256 in the hot path
 * would blow the 5ms p95 budget for 5KB payloads.
 */

export function fnv1a32(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}
