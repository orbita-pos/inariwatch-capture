// Fingerprint algorithm v1 — byte-identical to:
//
//   - capture/src/fingerprint.ts        (Node SDK)
//   - capture/python/.../fingerprint.py (Python SDK)
//   - web/lib/ai/fingerprint.ts         (web ingest)
//   - cli/src/mcp/fingerprint.rs        (Rust CLI)
//
// If you change the normalization, regenerate
// shared/fingerprint-test-vectors.json and update every implementation
// in the same PR. fingerprint_test.go loads that file and fails CI if
// any vector diverges.
//
// Normalization steps (ORDER MATTERS for cross-language determinism):
//  1. Concatenate title + body with "\n", lowercase.
//  2. Strip UUIDs (before epochs — UUIDs contain digit sequences).
//  3. Strip ISO 8601 timestamps (lowercase t).
//  4. Strip Unix epochs (10-13 digits).
//  5. Strip relative times ("5 minutes ago").
//  6. Strip hex IDs (>8 chars).
//  7. Strip file paths (/foo/bar.ts).
//  8. Strip line numbers (at line 42, :42:10).
//  9. Strip URLs.
//  10. Strip version numbers (v1.2.3).
//  11. Collapse whitespace, trim.
//  12. SHA-256 -> lowercase hex (64 chars).
package capture

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
)

// Go's regexp package uses RE2 with Perl syntax; \b and \w are ASCII by
// default (matching Rust's regex crate sans the Unicode flag + Node's
// RegExp without /u), so no extra flag dance is needed.
var (
	reUUID    = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)
	reISO8601 = regexp.MustCompile(`\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*`)
	reEpoch   = regexp.MustCompile(`\b\d{10,13}\b`)
	reRelTime = regexp.MustCompile(`\b\d+\s*(?:ms|seconds?|minutes?|hours?|days?)\s*ago\b`)
	reHexID   = regexp.MustCompile(`\b[0-9a-f]{9,}\b`)
	rePath    = regexp.MustCompile(`(?:/[\w.\-]+){2,}(?:\.\w+)?`)
	reLineNo  = regexp.MustCompile(`(?:at line|line:?|:\d+:\d+)\s*\d+`)
	reURL     = regexp.MustCompile(`https?://[^\s)]+`)
	reVersion = regexp.MustCompile(`v?\d+\.\d+\.\d+[^\s]*`)
	reWS      = regexp.MustCompile(`\s+`)
)

func normalizeErrorText(input string) string {
	s := input
	s = reUUID.ReplaceAllString(s, "<uuid>")
	s = reISO8601.ReplaceAllString(s, "<timestamp>")
	s = reEpoch.ReplaceAllString(s, "<timestamp>")
	s = reRelTime.ReplaceAllString(s, "<time_ago>")
	s = reHexID.ReplaceAllString(s, "<hex_id>")
	s = rePath.ReplaceAllString(s, "<path>")
	s = reLineNo.ReplaceAllString(s, "at line <N>")
	s = reURL.ReplaceAllString(s, "<url>")
	s = reVersion.ReplaceAllString(s, "<version>")
	s = reWS.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// ComputeErrorFingerprint returns a deterministic 64-character hex
// SHA-256 digest for an error pattern. Same error class (regardless of
// timestamps, IDs, paths) yields the same hash.
func ComputeErrorFingerprint(title, body string) string {
	input := strings.ToLower(title + "\n" + body)
	normalized := normalizeErrorText(input)
	sum := sha256.Sum256([]byte(normalized))
	return hex.EncodeToString(sum[:])
}
