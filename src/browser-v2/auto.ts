/**
 * Side-effect import — call init() automatically using config from:
 *   - window.__INARIWATCH__  (full Config object: dsn, environment, release,
 *                             silent, beforeSend, disableAutoInstrument, sessionId)
 *   - <meta name="inariwatch:dsn" content="...">
 *   - <meta name="inariwatch:environment" content="...">
 *   - <meta name="inariwatch:release" content="...">
 *
 * Used as `import "@inariwatch/capture/browser"` (the canonical browser
 * subpath since 0.11.1) or `import "@inariwatch/capture/browser-v2/auto"`
 * (the explicit alias).
 *
 * window.__INARIWATCH__ takes precedence over <meta> tags. Meta tags are
 * the script-tag-only escape hatch when there's no module bundler in
 * play and inline JS is restricted by CSP.
 */

import { init } from "./client.js";
import type { Config } from "./types.js";

declare global {
  interface Window {
    __INARIWATCH__?: Config;
  }
}

function autoInit(): void {
  if (typeof window === "undefined") return;
  const windowConfig = window.__INARIWATCH__ ?? {};
  const merged: Config = { ...windowConfig };
  if (typeof document !== "undefined") {
    if (!merged.dsn) {
      const meta = document.querySelector<HTMLMetaElement>('meta[name="inariwatch:dsn"]');
      if (meta) merged.dsn = meta.content;
    }
    if (!merged.environment) {
      const envMeta = document.querySelector<HTMLMetaElement>('meta[name="inariwatch:environment"]');
      if (envMeta) merged.environment = envMeta.content;
    }
    if (!merged.release) {
      const relMeta = document.querySelector<HTMLMetaElement>('meta[name="inariwatch:release"]');
      if (relMeta) merged.release = relMeta.content;
    }
  }
  init(merged);
}

autoInit();
