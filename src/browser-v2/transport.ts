import { signSha256Hex } from "./hmac.js";
import type { ParsedDsn } from "./dsn.js";
import type { ErrorEvent } from "./types.js";

export interface Transport {
  send(event: ErrorEvent): void | Promise<void>;
  flush(timeoutMs?: number): Promise<void>;
}

/** Pretty-prints to console — used when no DSN is configured. */
export class LocalTransport implements Transport {
  send(event: ErrorEvent): void {
    const first = event.body.split("\n", 1)[0] ?? "";
    // Use console.error so errors land in the right place in browser DevTools.
    // eslint-disable-next-line no-console
    console.error(`[inariwatch-capture] ${event.severity} — ${event.title}`);
    if (first && first !== event.title) {
      // eslint-disable-next-line no-console
      console.error(`                    ${first}`);
    }
  }
  async flush(): Promise<void> {}
}

/**
 * Beacon-friendly remote transport. Tries `navigator.sendBeacon` first
 * (best for unload events) and falls back to `fetch` with `keepalive: true`
 * which is the modern equivalent for live pages.
 *
 * Bounded retry buffer: 30 events deduped by fingerprint.
 */
export class RemoteTransport implements Transport {
  private retry: ErrorEvent[] = [];
  private seen = new Set<string>();

  constructor(private parsed: ParsedDsn) {}

  async send(event: ErrorEvent): Promise<void> {
    const batch = this.retry.splice(0, this.retry.length);
    this.seen.clear();
    batch.push(event);
    for (const ev of batch) {
      const ok = await this.sendOne(ev);
      if (!ok) this.enqueue(ev);
    }
  }

  private async sendOne(ev: ErrorEvent): Promise<boolean> {
    try {
      const json = JSON.stringify(ev);
      const body = new TextEncoder().encode(json);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-capture-project": this.parsed.projectId,
      };
      if (!this.parsed.isLocal) {
        headers["x-capture-signature"] = `sha256=${await signSha256Hex(body, this.parsed.secret)}`;
      }

      // sendBeacon ignores headers, so prefer fetch when we need HMAC.
      // For local DSNs without HMAC we can use sendBeacon for unload safety.
      if (this.parsed.isLocal && typeof navigator !== "undefined" && "sendBeacon" in navigator) {
        const blob = new Blob([json], { type: "application/json" });
        const beaconOk = navigator.sendBeacon(this.parsed.url, blob);
        if (beaconOk) return true;
      }

      const resp = await fetch(this.parsed.url, {
        method: "POST",
        headers,
        body,
        keepalive: true,
        credentials: "omit",
        mode: "cors",
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  private enqueue(ev: ErrorEvent) {
    if (this.seen.has(ev.fingerprint)) return;
    if (this.retry.length >= 30) {
      const dropped = this.retry.shift();
      if (dropped) this.seen.delete(dropped.fingerprint);
    }
    this.retry.push(ev);
    this.seen.add(ev.fingerprint);
  }

  async flush(): Promise<void> {
    const snap = [...this.retry];
    for (const ev of snap) {
      const ok = await this.sendOne(ev);
      if (ok) {
        const idx = this.retry.indexOf(ev);
        if (idx >= 0) this.retry.splice(idx, 1);
        this.seen.delete(ev.fingerprint);
      }
    }
  }
}
