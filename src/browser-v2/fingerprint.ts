// Fingerprint algorithm v1 — byte-identical to:
//   capture/src/fingerprint.ts        (Node SDK)
//   capture/python/.../fingerprint.py (Python SDK)
//   capture/go/fingerprint.go         (Go SDK)
//   capture/rust/src/fingerprint.rs   (Rust SDK)
//   capture/java/.../Fingerprint.java (Java SDK)
//   capture/csharp/src/Fingerprint.cs (C# SDK)
//   web/lib/ai/fingerprint.ts         (web ingest)
//   cli/src/mcp/fingerprint.rs        (Rust CLI)
//
// If you change the normalization, regenerate
// shared/fingerprint-test-vectors.json and update every implementation in
// the same PR. tests/fingerprint.test.mjs loads that file and fails if any
// vector diverges.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO8601 = /\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*/g;
const UNIX_EPOCH = /\b\d{10,13}\b/g;
const REL_TIME = /\b\d+\s*(?:ms|seconds?|minutes?|hours?|days?)\s*ago\b/g;
const HEX_ID = /\b[0-9a-f]{9,}\b/g;
const PATH = /(?:\/[\w.\-]+){2,}(?:\.\w+)?/g;
const LINE_NO = /(?:at line|line:?|:\d+:\d+)\s*\d+/g;
const URL_RE = /https?:\/\/[^\s)]+/g;
const VERSION = /v?\d+\.\d+\.\d+[^\s]*/g;
const WHITESPACE = /\s+/g;

function normalize(text: string): string {
  let s = text;
  s = s.replace(UUID, "<uuid>");
  s = s.replace(ISO8601, "<timestamp>");
  s = s.replace(UNIX_EPOCH, "<timestamp>");
  s = s.replace(REL_TIME, "<time_ago>");
  s = s.replace(HEX_ID, "<hex_id>");
  s = s.replace(PATH, "<path>");
  s = s.replace(LINE_NO, "at line <N>");
  s = s.replace(URL_RE, "<url>");
  s = s.replace(VERSION, "<version>");
  return s.replace(WHITESPACE, " ").trim();
}

async function sha256Hex(input: string): Promise<string> {
  // Web Crypto API (works in browsers and Node 16+).
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const arr = Array.from(new Uint8Array(buf));
  return arr.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function computeErrorFingerprint(title: string, body: string): Promise<string> {
  const combined = `${title}\n${body}`.toLowerCase();
  const normalized = normalize(combined);
  return sha256Hex(normalized);
}
