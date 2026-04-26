package capture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestSameInputSameHash(t *testing.T) {
	a := ComputeErrorFingerprint("TypeError: x is null", "at UserProfile.tsx:42")
	b := ComputeErrorFingerprint("TypeError: x is null", "at UserProfile.tsx:42")
	if a != b {
		t.Fatalf("expected identical hashes, got %q vs %q", a, b)
	}
	if len(a) != 64 {
		t.Fatalf("expected 64-char hex, got %d", len(a))
	}
}

func TestDifferentTimestampsSameHash(t *testing.T) {
	a := ComputeErrorFingerprint("Error at 2024-01-15T10:30:00Z", "deploy failed")
	b := ComputeErrorFingerprint("Error at 2026-03-24T15:00:00Z", "deploy failed")
	if a != b {
		t.Fatalf("timestamp in title should not affect fingerprint: %q vs %q", a, b)
	}
}

func TestDifferentUUIDsSameHash(t *testing.T) {
	a := ComputeErrorFingerprint("Failed for user a1b2c3d4-e5f6-7890-abcd-ef1234567890", "")
	b := ComputeErrorFingerprint("Failed for user 11111111-2222-3333-4444-555555555555", "")
	if a != b {
		t.Fatalf("UUIDs should be normalized: %q vs %q", a, b)
	}
}

func TestDifferentLineNumbersSameHash(t *testing.T) {
	a := ComputeErrorFingerprint("TypeError", "at line 42 in render()")
	b := ComputeErrorFingerprint("TypeError", "at line 999 in render()")
	if a != b {
		t.Fatalf("line numbers should be normalized: %q vs %q", a, b)
	}
}

func TestEmptyInputStable(t *testing.T) {
	a := ComputeErrorFingerprint("", "")
	b := ComputeErrorFingerprint("", "")
	if a != b || len(a) != 64 {
		t.Fatalf("empty fingerprint should be stable 64-char, got %q / %q", a, b)
	}
}

func TestDifferentErrorsDifferentHash(t *testing.T) {
	a := ComputeErrorFingerprint("TypeError: x is null", "")
	b := ComputeErrorFingerprint("SyntaxError: unexpected token", "")
	if a == b {
		t.Fatalf("different errors should produce different hashes: %q", a)
	}
}

// TestCrossLanguageGoldenVectors validates every vector in
// shared/fingerprint-test-vectors.json. If this fails the Go
// implementation has diverged from Node/Rust/Python/web.
func TestCrossLanguageGoldenVectors(t *testing.T) {
	// capture/go/fingerprint_test.go -> capture/go -> capture -> repo-root
	_, thisFile, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve test file path")
	}
	repoRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	vectorsPath := filepath.Join(repoRoot, "shared", "fingerprint-test-vectors.json")

	data, err := os.ReadFile(vectorsPath)
	if err != nil {
		t.Skipf("cross-language vectors not found at %s: %v", vectorsPath, err)
	}

	var payload struct {
		Vectors []struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			Body     string `json:"body"`
			Expected string `json:"expected"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(payload.Vectors) == 0 {
		t.Fatal("no vectors found")
	}

	var failures []string
	for _, v := range payload.Vectors {
		actual := ComputeErrorFingerprint(v.Title, v.Body)
		if actual != v.Expected {
			failures = append(failures,
				"  ["+v.ID+"] expected="+v.Expected+" actual="+actual)
		}
	}

	if len(failures) > 0 {
		t.Fatalf("fingerprint mismatch vs shared vectors — Go SDK has diverged:\n%s",
			joinLines(failures))
	}
}

func joinLines(xs []string) string {
	out := ""
	for i, s := range xs {
		if i > 0 {
			out += "\n"
		}
		out += s
	}
	return out
}
