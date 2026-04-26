import type { Breadcrumb, RequestContext } from "./types.js";

/**
 * Browser-side scope. Browsers are single-threaded per tab, so we don't
 * need contextvars / AsyncLocalStorage; one module-level object is fine
 * and matches the v1 SDK's behaviour. ``withScope`` is exposed for the
 * rare case (web workers, MessageChannel callbacks) that wants short-
 * lived isolation.
 */

const HEADER_REDACT_PATTERNS = [
  "token",
  "key",
  "secret",
  "auth",
  "credential",
  "password",
  "cookie",
  "session",
];

const REDACT_BODY_FIELDS = new Set([
  "password",
  "passwd",
  "pass",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_token",
  "accesstoken",
  "refresh_token",
  "refreshtoken",
  "credit_card",
  "creditcard",
  "card_number",
  "cardnumber",
  "cvv",
  "cvc",
  "ssn",
  "social_security",
  "authorization",
]);

interface ScopeData {
  user?: { id: string; role?: string };
  tags: Record<string, string>;
  request?: RequestContext;
  breadcrumbs: Breadcrumb[];
}

let current: ScopeData = { tags: {}, breadcrumbs: [] };

const MAX_BREADCRUMBS = 30;

export function setUser(id: string, role?: string): void {
  current.user = role !== undefined ? { id, role } : { id };
}

export function getUser(): ScopeData["user"] {
  return current.user;
}

export function setTag(key: string, value: string): void {
  current.tags[key] = value;
}

export function getTags(): Record<string, string> {
  return { ...current.tags };
}

export function setRequestContext(req: RequestContext): void {
  current.request = redactRequest(req);
}

export function getRequestContext(): RequestContext | undefined {
  return current.request;
}

export function addBreadcrumb(crumb: Omit<Breadcrumb, "timestamp"> & { timestamp?: string }): void {
  const filled: Breadcrumb = {
    timestamp: crumb.timestamp ?? new Date().toISOString(),
    category: crumb.category,
    message: scrubSecrets(crumb.message),
    data: crumb.data,
  };
  if (current.breadcrumbs.length >= MAX_BREADCRUMBS) {
    current.breadcrumbs.shift();
  }
  current.breadcrumbs.push(filled);
}

export function getBreadcrumbs(): Breadcrumb[] {
  return [...current.breadcrumbs];
}

export function clearBreadcrumbs(): void {
  current.breadcrumbs = [];
}

export function clearScope(): void {
  current = { tags: {}, breadcrumbs: [] };
}

export function withScope<T>(fn: () => T): T {
  const prev = current;
  current = { tags: {}, breadcrumbs: [] };
  try {
    return fn();
  } finally {
    current = prev;
  }
}

export function shouldRedactHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return HEADER_REDACT_PATTERNS.some((p) => lower.includes(p));
}

const SECRETS = [
  /bearer\s+[a-z0-9._\-]+/gi,
  /eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g,
  /sk_[a-z]+_[a-zA-Z0-9]+/g,
  /(?:postgres|mysql|mongodb|redis):\/\/[^\s]*/gi,
  /(?:password|secret|token|api_key)=[^\s&]+/gi,
];

export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRETS) out = out.replace(re, "[REDACTED]");
  return out;
}

const URL_SECRETS = /([?&])(token|key|secret|password|auth|credential)=[^&]+/gi;

export function scrubUrl(url: string): string {
  return url.replace(URL_SECRETS, "$1$2=[REDACTED]");
}

function redactRequest(req: RequestContext): RequestContext {
  const out: RequestContext = { ...req };
  if (req.headers) {
    const safeHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      safeHeaders[k] = shouldRedactHeader(k) ? "[REDACTED]" : v;
    }
    out.headers = safeHeaders;
  }
  if (req.body !== undefined) {
    out.body = redactBody(req.body);
  }
  return out;
}

export function redactBody(body: unknown): unknown {
  if (body === null || body === undefined) return body;
  if (typeof body === "string") {
    return body.length > 1024 ? body.slice(0, 1024) + "...[truncated]" : body;
  }
  if (Array.isArray(body)) return body.map(redactBody);
  if (typeof body === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      out[k] = REDACT_BODY_FIELDS.has(k.toLowerCase()) ? "[REDACTED]" : redactBody(v);
    }
    return out;
  }
  return body;
}
