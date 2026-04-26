/** Wire-format event shape — identical across every InariWatch SDK. */
export interface ErrorEvent {
  fingerprint: string;
  title: string;
  body: string;
  severity: "critical" | "error" | "warning" | "info" | "debug";
  timestamp: string;
  environment?: string;
  release?: string;
  eventType: "error" | "log";
  runtime: string;
  user?: { id: string; role?: string };
  tags?: Record<string, string>;
  git?: Record<string, string | undefined>;
  env?: Record<string, unknown>;
  request?: RequestContext;
  breadcrumbs?: Breadcrumb[];
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface RequestContext {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export interface Breadcrumb {
  timestamp: string;
  category: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface Config {
  dsn?: string;
  environment?: string;
  release?: string;
  silent?: boolean;
  /** Pre-send filter — return null to drop the event. */
  beforeSend?: (event: ErrorEvent) => ErrorEvent | null;
  /** Disable fetch/XHR auto-instrumentation. */
  disableAutoInstrument?: boolean;
  /** Custom session id for FullTrace correlation. Defaults to a per-tab UUID. */
  sessionId?: string;
}
