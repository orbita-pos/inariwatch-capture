import { addBreadcrumb, scrubUrl } from "./scope.js";
import { ensureSessionId } from "./session.js";

/**
 * Wrap window.fetch and XMLHttpRequest so:
 *   - every call becomes a breadcrumb (URL scrubbed of secrets)
 *   - every outbound request gains the X-IW-Session-Id header for FullTrace
 *
 * Idempotent: a second install() is a no-op so SPA route changes don't
 * stack interceptors.
 */

let fetchInstalled = false;
let xhrInstalled = false;

export function installFetchWrap(): void {
  if (fetchInstalled || typeof window === "undefined" || !window.fetch) return;
  fetchInstalled = true;
  const original = window.fetch.bind(window);
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const sessionId = ensureSessionId();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-iw-session-id")) headers.set("x-iw-session-id", sessionId);
    const start = Date.now();
    try {
      const resp = await original(input, { ...init, headers });
      addBreadcrumb({
        category: "fetch",
        message: `${method} ${scrubUrl(url)}`,
        data: { status: resp.status, durationMs: Date.now() - start },
      });
      return resp;
    } catch (err) {
      addBreadcrumb({
        category: "fetch",
        message: `${method} ${scrubUrl(url)} failed`,
        data: { error: String(err), durationMs: Date.now() - start },
      });
      throw err;
    }
  };
}

export function installXhrWrap(): void {
  if (xhrInstalled || typeof XMLHttpRequest === "undefined") return;
  xhrInstalled = true;
  const Open = XMLHttpRequest.prototype.open;
  const Send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    user?: string | null,
    password?: string | null
  ) {
    (this as XMLHttpRequest & { __iwMethod?: string; __iwUrl?: string }).__iwMethod = method;
    (this as XMLHttpRequest & { __iwMethod?: string; __iwUrl?: string }).__iwUrl =
      typeof url === "string" ? url : url.href;
    return Open.call(this, method, url as string, async ?? true, user, password);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    const self = this as XMLHttpRequest & { __iwMethod?: string; __iwUrl?: string };
    try {
      this.setRequestHeader("X-IW-Session-Id", ensureSessionId());
    } catch {
      // setRequestHeader throws if open() wasn't called — let send() raise its own error.
    }
    const start = Date.now();
    this.addEventListener("loadend", () => {
      addBreadcrumb({
        category: "xhr",
        message: `${self.__iwMethod ?? "?"} ${scrubUrl(self.__iwUrl ?? "")}`,
        data: { status: this.status, durationMs: Date.now() - start },
      });
    });
    return Send.call(this, body ?? null);
  };
}

export function uninstallForTesting(): void {
  fetchInstalled = false;
  xhrInstalled = false;
}
