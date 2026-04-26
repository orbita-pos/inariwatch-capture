/**
 * Side-effect import — call init() automatically using DSN from:
 *   - window.__INARIWATCH__.dsn
 *   - <meta name="inariwatch:dsn" content="...">
 *
 * Used as ``import "@inariwatch/capture-browser/auto"``.
 */

import { init } from "./client.js";

declare global {
  interface Window {
    __INARIWATCH__?: { dsn?: string; environment?: string; release?: string };
  }
}

function autoInit(): void {
  if (typeof window === "undefined") return;
  let dsn = window.__INARIWATCH__?.dsn;
  let environment = window.__INARIWATCH__?.environment;
  let release = window.__INARIWATCH__?.release;
  if (!dsn && typeof document !== "undefined") {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="inariwatch:dsn"]');
    if (meta) dsn = meta.content;
    const envMeta = document.querySelector<HTMLMetaElement>('meta[name="inariwatch:environment"]');
    if (envMeta) environment = envMeta.content;
    const relMeta = document.querySelector<HTMLMetaElement>('meta[name="inariwatch:release"]');
    if (relMeta) release = relMeta.content;
  }
  init({ dsn, environment, release });
}

autoInit();
