/**
 * HMAC-SHA256 signing using the Web Crypto API.
 *
 * Browsers cannot keep secrets safely, so production browser deployments
 * typically use a public, project-scoped DSN that the backend validates by
 * referer / origin instead of HMAC. We still support HMAC for environments
 * (e.g. Electron, code-signed extensions) where the secret is genuinely
 * private. The output format matches the server-side header used by every
 * other SDK: ``sha256=<hex>``.
 */
export async function signSha256Hex(payload: Uint8Array, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: { name: "SHA-256" } },
    false,
    ["sign"]
  );
  // Cast through ArrayBufferView — strict TS narrows generic Uint8Array
  // away from the `BufferSource` shape Web Crypto wants.
  const sig = await crypto.subtle.sign("HMAC", key, payload as BufferSource);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
