# Changelog — `@inariwatch/capture`

All notable changes to the SDK. Older releases pre-date this file —
see git history for `0.10.x` and earlier.

## 0.11.0 — 2026-05-02

### Added
- **In-process PII / secret redaction** (opt-in). Pass `redact: true` to
  `init()` or set `INARIWATCH_REDACT=true` to scrub the outgoing payload
  *inside the user's process* before it reaches the InariWatch cloud.
  Regex-based, deterministic, zero new dependencies — no ML model is
  bundled. Default pattern set covers email, phone, SSN, credit-card
  (Luhn-validated), JWT, OpenAI / Stripe / GitHub / AWS access /
  Google / Slack tokens, and sensitive object keys (`password`,
  `authorization`, `cookie`, `api_key`, …). IPv4 and the 40-char AWS
  secret shape are off by default to avoid false positives — opt in
  via `redact: { redactIPs: true }` / `redactAwsSecrets: true`.
- `RedactConfig.allowlist` (dot-path strings) lets callers exempt
  specific paths like `request.headers.user-agent` from redaction.
- `RedactConfig.customPatterns` lets callers append project-specific
  shapes (employee IDs, license keys, …).
- `RedactConfig.hashMode` emits stable FNV-1a fingerprints alongside
  the redaction tag (`[REDACTED_EMAIL:a1b2c3d4]`) so engineers can
  correlate the same redacted value across events without exposing it.
- `_meta.redact_applied: true` is set on every event the redactor
  processed, so server-side enrichment can skip paths that would
  re-derive PII.
- Public exports: `redactPayload`, `resolveRedactConfig`, types
  `RedactConfig` and `RedactPattern`.

### Performance
- Redactor adds ~0.5ms p95 to a 5KB payload (10× under the 5ms hot-path
  budget). Benchmarked in `test/redact.test.mjs`.

### Notes
- Back-compat: redaction is **off by default**. Existing installs see
  zero behavior change until they opt in.
