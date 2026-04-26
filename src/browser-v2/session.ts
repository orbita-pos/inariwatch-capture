/**
 * FullTrace session id management.
 *
 * Each browser tab gets a UUID at SDK init time (or reuses one from
 * sessionStorage when running across SPA navigations). The id is sent
 * as ``X-IW-Session-Id`` on every fetch / XHR so the backend can correlate
 * front-end errors to their downstream API calls.
 */

const STORAGE_KEY = "__inariwatch_session_id__";
let sessionId: string | null = null;

export function ensureSessionId(override?: string): string {
  if (sessionId) return sessionId;
  if (override) {
    sessionId = override;
    return sessionId;
  }
  try {
    if (typeof sessionStorage !== "undefined") {
      const existing = sessionStorage.getItem(STORAGE_KEY);
      if (existing) {
        sessionId = existing;
        return existing;
      }
    }
  } catch {
    // Storage may be blocked (private mode, third-party iframe).
  }
  sessionId = generateUuid();
  try {
    if (typeof sessionStorage !== "undefined") {
      sessionStorage.setItem(STORAGE_KEY, sessionId);
    }
  } catch {
    /* swallow */
  }
  return sessionId;
}

export function getSessionId(): string | null {
  return sessionId;
}

export function resetSessionIdForTesting(): void {
  sessionId = null;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* swallow */
  }
}

function generateUuid(): string {
  // Use a wide alias that exposes both methods, so TS doesn't narrow the
  // remaining branches to ``never`` after the ``in`` check.
  type CryptoLike = {
    randomUUID?: () => string;
    getRandomValues: <T extends ArrayBufferView | null>(array: T) => T;
  };
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (!c) throw new Error("Web Crypto unavailable");
  if (c.randomUUID) return c.randomUUID();

  // Fallback — RFC 4122 v4 from getRandomValues.
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
