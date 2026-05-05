/**
 * Regex bank for in-process PII / secret redaction.
 *
 * Each entry describes WHAT it matches and WHAT label replaces a match.
 * Patterns must be `g` (global) — the redactor relies on `String#replace`
 * with a global regex to scrub every occurrence in one pass.
 *
 * False-positive notes (per S6 design):
 *   - IPv4 detection is opt-in (`redactIPs` flag) — many users want IPs
 *     visible for debugging.
 *   - AWS secret detection is opt-in (`redactAwsSecrets` flag) — the 40-char
 *     [A-Za-z0-9/+] shape collides with base64 blobs and long file paths.
 *
 * NEW patterns must keep the `g` flag and a stable label so server-side
 * dedup of redacted events doesn't churn.
 */

import { isLuhnValid } from "./luhn.js"

export interface Pattern {
  /** Stable label used both for `[REDACTED_<LABEL>]` and the hash-mode form. */
  label: string
  /** Regex (must have `g` flag). */
  regex: RegExp
  /**
   * Optional post-match validator. Returning `false` skips this match
   * (no replacement). Lets us pair a coarse regex with semantic checks
   * like Luhn for credit cards.
   */
  validate?: (match: string) => boolean
}

/**
 * Default pattern set — applied unless a `customPatterns` override is given.
 *
 * Order matters: more specific patterns run first so a stripe key isn't
 * also matched as a generic secret-shaped string.
 */
export const DEFAULT_PATTERNS: Pattern[] = [
  // ── Tokens / API keys (high specificity, run first) ─────────────────
  {
    label: "JWT",
    // Three base64url-ish segments separated by `.`. The `eyJ` prefix
    // anchors against the JSON header `{"alg":...}` that base64-encodes
    // to `eyJ`. Avoids matching arbitrary dotted strings.
    regex: /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g,
  },
  {
    label: "STRIPE_KEY",
    regex: /sk_(?:test|live)_[0-9A-Za-z]{16,}/g,
  },
  {
    label: "STRIPE_PUB_KEY",
    regex: /pk_(?:test|live)_[0-9A-Za-z]{16,}/g,
  },
  {
    label: "GITHUB_TOKEN",
    // gh{p,o,u,s,r}_<36+ chars> — covers personal access, OAuth, user-to-server,
    // server-to-server, refresh.
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/g,
  },
  {
    label: "AWS_ACCESS_KEY",
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    label: "OPENAI_KEY",
    // sk-proj-..., sk-...
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    label: "SLACK_TOKEN",
    regex: /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    label: "GOOGLE_API_KEY",
    regex: /AIza[0-9A-Za-z_-]{35}/g,
  },

  // ── PII shapes ──────────────────────────────────────────────────────
  {
    label: "EMAIL",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    label: "SSN",
    // US SSN — the dash-separated form. Bare 9-digit runs are too prone
    // to false positives (timestamps, IDs).
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    label: "CREDIT_CARD",
    // 13-19 digits, optionally separated by spaces/dashes.
    // Validated below by Luhn — without that, this would scoop up most
    // long numeric runs in logs.
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    validate: (m) => isLuhnValid(m.replace(/[ -]/g, "")),
  },
  {
    label: "PHONE",
    // E.164 + common separators (US/intl). Anchored to require:
    //   - optional leading + and country code
    //   - a separator before the local number
    //   - at least 7 digits total
    // The leading non-word boundary keeps us from scooping the trailing
    // digits of unrelated long ID strings.
    regex: /(?:(?<![\w@+])\+\d{1,3}[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b/g,
  },
]

/**
 * Optional patterns — opt-in via RedactConfig flags.
 */
export const IPV4_PATTERN: Pattern = {
  label: "IP",
  regex: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
}

/**
 * AWS secret shape: 40 chars [A-Za-z0-9/+]. Caller must provide a
 * context-aware validator that only redacts when the surrounding text
 * mentions "secret"/"key"/"token" — bare 40-char base64 runs are very
 * common in unrelated log lines.
 */
export const AWS_SECRET_PATTERN: Pattern = {
  label: "AWS_SECRET",
  regex: /[A-Za-z0-9/+]{40}/g,
  // Validator is set in index.ts because it needs the surrounding-text
  // window which is a string-level concept, not a per-match one.
}
