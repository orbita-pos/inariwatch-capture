/**
 * Keys whose VALUE should be redacted regardless of content.
 *
 * Matched case-insensitively against object keys. When the key exactly
 * equals one of these (or an HTTP header variant — Authorization/Cookie),
 * the value is replaced wholesale with `[REDACTED_VALUE]` rather than
 * scanning the value text for known patterns.
 *
 * This catches values that don't match any of our content regexes — e.g.
 * `{ password: "hunter2" }` would otherwise look like a normal short word.
 */
export const SENSITIVE_KEYS = new Set<string>([
  // Auth
  "password",
  "passwd",
  "pwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "api-key",
  "auth",
  "authorization",
  "credentials",
  "credential",
  "private_key",
  "privatekey",
  "private-key",
  "session",
  "sessionid",
  "session_id",
  "cookie",
  "set-cookie",
  // Common HTTP secret headers
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  // Cloud creds
  "aws_secret_access_key",
  "aws_access_key_id",
  "client_secret",
  "refresh_token",
  "access_token",
  "id_token",
  // Common camelCase variants (object keys often arrive un-snake-cased
  // from JS callers — the case-insensitive match below covers `apiKey`
  // already, but explicit camelCase entries here document the intent).
  "accesstoken",
  "refreshtoken",
  // Financial PII — these field names appear in checkout / payment flows
  // and must never reach the wire. Card numbers also match the
  // Luhn-validated CREDIT_CARD content regex, but adding the key names
  // catches the case where the value has been mangled (spaces, dashes
  // stripped) and the regex misses.
  "credit_card",
  "creditcard",
  "card_number",
  "cardnumber",
  "cvv",
  "cvc",
  "ssn",
  "social_security",
  "social_security_number",
])
