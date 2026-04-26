/**
 * Ed25519 client signing for Payload v2 (Track A piece 17, SDK side).
 *
 * Each install gets its own keypair, generated lazily on first sign and
 * persisted to `~/.inariwatch/keypair.json`. The public key is reported to
 * the server inside every signed event (`signature.signer_pubkey`). The
 * server can verify without a separate handshake — first event IS the
 * handshake.
 *
 * Protocol — byte-identical to `web/lib/services/eap-verify-local.ts`
 * (`verifyEd25519Signature`):
 *
 *   digest    = SHA-256(receipt_id_hex_utf8_bytes)
 *   signature = Ed25519.sign(private_key, digest)
 *
 * `receipt_id` is the Merkle root over the canonical evidence pack
 * (computed in payload-v2.ts). The pre-hash domain-separates the signing
 * input from arbitrary message contents — same trick the EAP server uses.
 *
 * Edge / Browser fallback:
 *   - `node:crypto` and the filesystem are unavailable. Signing skips and
 *     `signPayload` returns null. Caller MUST handle null and fall back to
 *     v1 wire format (server only enforces signatures for `schema_version: 2.0`).
 *
 * Zero deps. Native `node:crypto` only.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto"

const KEY_DIR = ".inariwatch"
const KEY_FILE = "keypair.json"

interface PersistedKeypair {
  /** PEM-encoded Ed25519 private key (PKCS#8). */
  private_key_pem: string
  /** Hex of the 32-byte raw public key. */
  public_key_hex: string
  /** First 16 hex chars of SHA-256(public_key_bytes). */
  pub_key_id: string
  /** ISO 8601 — when the keypair was generated. */
  created_at: string
  /** Allow forward migrations without breaking old installs. */
  version: 1
}

export interface SDKKeypair {
  /** PEM-encoded private key — kept in memory only. */
  privateKey: KeyObject
  publicKeyHex: string
  pubKeyId: string
}

let cachedKeypair: SDKKeypair | null = null

/**
 * Returns the active keypair, loading from disk or generating + persisting
 * a fresh one on first call. Throws on environments without `node:crypto` —
 * caller in `client.ts` catches and falls back to v1 transport.
 */
export function getOrCreateKeypair(opts: { keyPath?: string } = {}): SDKKeypair {
  if (cachedKeypair) return cachedKeypair

  const keyPath = opts.keyPath ?? defaultKeyPath()
  const persisted = loadKeypair(keyPath)
  if (persisted) {
    cachedKeypair = persistedToActive(persisted)
    return cachedKeypair
  }

  const fresh = generateKeypair()
  saveKeypair(keyPath, freshToPersisted(fresh))
  cachedKeypair = fresh
  return fresh
}

function defaultKeyPath(): string {
  return join(homedir(), KEY_DIR, KEY_FILE)
}

function loadKeypair(path: string): PersistedKeypair | null {
  try {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedKeypair>
    if (
      typeof parsed.private_key_pem !== "string" ||
      typeof parsed.public_key_hex !== "string" ||
      parsed.public_key_hex.length !== 64 ||
      typeof parsed.pub_key_id !== "string" ||
      parsed.pub_key_id.length !== 16 ||
      parsed.version !== 1
    ) {
      return null
    }
    return parsed as PersistedKeypair
  } catch {
    return null
  }
}

function saveKeypair(path: string, kp: PersistedKeypair): void {
  const dir = path.replace(/[\\\/][^\\\/]+$/, "")
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Directory exists or unwritable — let the writeFileSync fail loudly.
  }
  writeFileSync(path, JSON.stringify(kp, null, 2), "utf8")
  // Best-effort restrictive perms — POSIX only. Windows ignores 0o600.
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600)
    } catch {
      // Permissions failure is non-fatal — file is still per-user under $HOME.
    }
  }
}

function generateKeypair(): SDKKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  // Raw 32-byte pubkey → hex. JWK gives us base64url of the raw bytes via `x`.
  const jwk = publicKey.export({ format: "jwk" }) as { x?: string }
  if (!jwk.x) throw new Error("Ed25519 keypair generated without JWK x field")
  const pubBytes = Buffer.from(jwk.x, "base64url")
  if (pubBytes.length !== 32) {
    throw new Error(`Ed25519 pubkey unexpected length: ${pubBytes.length}`)
  }
  const publicKeyHex = pubBytes.toString("hex")
  const pubKeyId = createHash("sha256").update(pubBytes).digest("hex").slice(0, 16)
  return { privateKey, publicKeyHex, pubKeyId }
}

function persistedToActive(kp: PersistedKeypair): SDKKeypair {
  const privateKey = createPrivateKey({ key: kp.private_key_pem, format: "pem" })
  return {
    privateKey,
    publicKeyHex: kp.public_key_hex,
    pubKeyId: kp.pub_key_id,
  }
}

function freshToPersisted(active: SDKKeypair): PersistedKeypair {
  // Re-derive PEM from the in-memory KeyObject so we don't need to plumb
  // the original PEM through.
  const pem = active.privateKey
    .export({ format: "pem", type: "pkcs8" })
    .toString()
  return {
    private_key_pem: pem,
    public_key_hex: active.publicKeyHex,
    pub_key_id: active.pubKeyId,
    created_at: new Date().toISOString(),
    version: 1,
  }
}

/**
 * Sign a Merkle root with the install keypair. Returns 128-char hex signature.
 *
 * Protocol:  sig = Ed25519.sign(privateKey, SHA-256(receiptId.utf8))
 *
 * `receiptId` is the 64-char hex Merkle root of the canonical evidence pack.
 * The SHA-256 pre-hash matches the EAP server's signing layer so the same
 * `verifyEd25519Signature` function on the server validates SDK signatures
 * with no protocol fork.
 */
export function signReceiptId(receiptIdHex: string, kp: SDKKeypair): string {
  const digest = createHash("sha256").update(receiptIdHex, "utf8").digest()
  // Ed25519 in node:crypto: pass `null` algorithm — the curve is baked into the key.
  const sig = cryptoSign(null, digest, kp.privateKey)
  return sig.toString("hex")
}

/**
 * Verify a signature locally — used by tests so we don't have to import
 * server code. Mirrors `verifyEd25519Signature` exactly.
 */
export function verifyReceiptIdSignature(
  receiptIdHex: string,
  signatureHex: string,
  publicKeyHex: string,
): boolean {
  if (
    signatureHex.length !== 128 ||
    publicKeyHex.length !== 64 ||
    !/^[0-9a-f]+$/i.test(signatureHex) ||
    !/^[0-9a-f]+$/i.test(publicKeyHex)
  ) {
    return false
  }
  const digest = createHash("sha256").update(receiptIdHex, "utf8").digest()
  const pubBytes = Buffer.from(publicKeyHex, "hex")
  const keyObj = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: pubBytes.toString("base64url") },
    format: "jwk",
  })
  try {
    return cryptoVerify(null, digest, keyObj, Buffer.from(signatureHex, "hex"))
  } catch {
    return false
  }
}

/** Test-only: clears the in-process cached keypair so tests can swap key paths. */
export function __resetSigningCacheForTesting(): void {
  cachedKeypair = null
}

/**
 * Test-only: produce an ephemeral keypair without touching disk or the
 * module-level cache. Lets multiple peers coexist in one process (e.g. the
 * 3-node gossip e2e test in `test/p2p-e2e.test.mjs`).
 */
export function __createInMemoryKeypair(): SDKKeypair {
  return generateKeypair()
}
