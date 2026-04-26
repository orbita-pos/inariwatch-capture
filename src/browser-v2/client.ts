import { installFetchWrap, installXhrWrap } from "./auto-instrument.js";
import { parseDsn } from "./dsn.js";
import { computeErrorFingerprint } from "./fingerprint.js";
import {
  addBreadcrumb,
  clearScope,
  getBreadcrumbs,
  getRequestContext,
  getTags,
  getUser,
} from "./scope.js";
import { ensureSessionId } from "./session.js";
import { LocalTransport, RemoteTransport, type Transport } from "./transport.js";
import type { Config, ErrorEvent } from "./types.js";

let transport: Transport | null = null;
let config: Config = {};
let inited = false;

export function init(cfg: Config = {}): void {
  config = cfg;
  ensureSessionId(cfg.sessionId);

  if (cfg.dsn) {
    try {
      const parsed = parseDsn(cfg.dsn);
      transport = new RemoteTransport(parsed);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[inariwatch-capture] DSN parse error: ${(err as Error).message} — local mode`);
      transport = new LocalTransport();
    }
  } else {
    if (!cfg.silent && typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.info(
        "[inariwatch-capture] Local mode — errors print to console. Set dsn to send to cloud."
      );
    }
    transport = new LocalTransport();
  }

  if (!cfg.disableAutoInstrument) {
    installFetchWrap();
    installXhrWrap();
  }
  inited = true;
}

export function setTransportForTesting(t: Transport): void {
  transport = t;
  inited = true;
}

export function resetForTesting(): void {
  transport = null;
  config = {};
  inited = false;
  clearScope();
}

export async function captureException(
  err: unknown,
  extra?: Record<string, unknown>
): Promise<void> {
  if (!inited || !transport) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const title = `${e.name}: ${e.message}`;
  const body = e.stack ?? title;
  const ev = await base(title, body, "critical", "error");
  if (extra) ev.context = { ...ev.context, ...extra };
  await dispatch(ev);
}

export async function captureMessage(
  message: string,
  severity: ErrorEvent["severity"] = "info"
): Promise<void> {
  if (!inited || !transport) return;
  const ev = await base(message, message, severity, "error");
  await dispatch(ev);
}

export async function captureLog(
  message: string,
  level: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  if (!inited || !transport) return;
  const sev = mapLevel(level);
  const ev = await base(message, message, sev, "log");
  if (metadata) ev.metadata = { ...ev.metadata, ...metadata };
  await dispatch(ev);
}

export async function flush(timeoutMs?: number): Promise<void> {
  if (transport) await transport.flush(timeoutMs);
}

async function base(
  title: string,
  body: string,
  severity: ErrorEvent["severity"],
  eventType: ErrorEvent["eventType"]
): Promise<ErrorEvent> {
  const ev: ErrorEvent = {
    fingerprint: await computeErrorFingerprint(title, body),
    title,
    body,
    severity,
    timestamp: new Date().toISOString(),
    environment: config.environment,
    release: config.release,
    eventType,
    runtime: "browser",
    user: getUser(),
    tags: getTags(),
    request: getRequestContext(),
    breadcrumbs: getBreadcrumbs(),
    env: browserEnv(),
    context: {},
    metadata: {},
  };
  return ev;
}

function browserEnv(): Record<string, unknown> {
  const env: Record<string, unknown> = {};
  if (typeof navigator !== "undefined") {
    env["userAgent"] = navigator.userAgent;
    env["language"] = navigator.language;
    env["online"] = navigator.onLine;
  }
  if (typeof window !== "undefined" && window.location) {
    env["origin"] = window.location.origin;
    env["pathname"] = window.location.pathname;
  }
  return env;
}

function mapLevel(level: string): ErrorEvent["severity"] {
  switch (level.toLowerCase()) {
    case "critical":
    case "fatal":
      return "critical";
    case "warn":
    case "warning":
      return "warning";
    case "info":
      return "info";
    case "debug":
      return "debug";
    default:
      return "error";
  }
}

async function dispatch(ev: ErrorEvent): Promise<void> {
  if (config.beforeSend) {
    const out = config.beforeSend(ev);
    if (!out) return;
    ev = out;
  }
  try {
    await transport!.send(ev);
  } catch (e) {
    // Never throw from inside capture.
    // eslint-disable-next-line no-console
    console.error(`[inariwatch-capture] dispatch failed: ${e}`);
  }
}

// Re-export for the test harness.
export { addBreadcrumb };
