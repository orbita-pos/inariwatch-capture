/**
 * SDK-side fleet bloom — read-only deserialize + has().
 *
 * MUST stay byte-identical to web/lib/fleet-bloom/bloom.ts. Wire format
 * pinned by both sides' tests; a regression in either is caught locally.
 *
 * Spec: CAPTURE_V2_IMPLEMENTATION.md Q5.4.
 *
 * Why a copy and not a shared package:
 *   - Server side uses node:crypto natively; SDK side must work in any
 *     Node 18+ environment (also browser via webcrypto, but bloom is
 *     server-process only for now).
 *   - Avoids an import cycle: web/lib/fleet-bloom imports bloom; SDK also
 *     imports bloom; if shared, the package would have to ship both for
 *     web and end users which adds friction.
 *   - The math is ~50 LoC and changes monthly at most.
 */

import { createHash } from "node:crypto"

const BLOOM_MAGIC = Buffer.from("IWBL", "utf8")
const BLOOM_VERSION = 1
const HEADER_LEN = 16

export interface BloomFilter {
  m: number
  k: number
  count: number
  bits: Buffer
}

export function deserialize(buf: Buffer): BloomFilter {
  if (buf.length < HEADER_LEN) throw new Error("bloom: buffer too short for header")
  if (!buf.subarray(0, 4).equals(BLOOM_MAGIC)) throw new Error("bloom: bad magic")
  const version = buf[4]
  if (version !== BLOOM_VERSION) throw new Error(`bloom: unsupported version ${version}`)
  const k = buf[5]!
  const m = buf.readUInt32LE(8)
  const count = buf.readUInt32LE(12)
  const expectedBytes = Math.ceil(m / 8)
  const bits = Buffer.alloc(expectedBytes)
  buf.copy(bits, 0, HEADER_LEN, HEADER_LEN + expectedBytes)
  return { m, k, count, bits }
}

function hashIndices(item: string, m: number, k: number): number[] {
  const digest = createHash("sha256").update(item, "utf8").digest()
  const out: number[] = []
  for (let i = 0; i < k; i++) {
    let word: number
    if (i < 8) {
      word = digest.readUInt32LE(i * 4)
    } else {
      const more = createHash("sha256").update(item, "utf8").update(Buffer.from([i])).digest()
      word = more.readUInt32LE((i - 8) * 4)
    }
    out.push(word % m)
  }
  return out
}

export function has(bloom: BloomFilter, item: string): boolean {
  const positions = hashIndices(item, bloom.m, bloom.k)
  for (const pos of positions) {
    const byte = pos >>> 3
    const bit = pos & 7
    if ((bloom.bits[byte] & (1 << bit)) === 0) return false
  }
  return true
}
