package capture

import (
	"strings"
	"testing"
)

func TestBreadcrumbRingCapsAt30(t *testing.T) {
	ClearBreadcrumbs()
	for i := 0; i < 50; i++ {
		AddBreadcrumb(Breadcrumb{Message: "step"})
	}
	if got := len(GetBreadcrumbs()); got != 30 {
		t.Fatalf("expected 30 breadcrumbs, got %d", got)
	}
}

func TestBreadcrumbScrubsBearerToken(t *testing.T) {
	ClearBreadcrumbs()
	AddBreadcrumb(Breadcrumb{Message: "Authorization: Bearer abc123xyz890"})
	got := GetBreadcrumbs()[0].Message
	if strings.Contains(got, "Bearer abc") {
		t.Fatalf("bearer token leaked: %q", got)
	}
	if !strings.Contains(got, "[REDACTED]") {
		t.Fatalf("expected redaction marker, got: %q", got)
	}
}

func TestBreadcrumbScrubsJWT(t *testing.T) {
	ClearBreadcrumbs()
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.abcdefghijklmnop12345678"
	AddBreadcrumb(Breadcrumb{Message: "token=" + jwt})
	if strings.Contains(GetBreadcrumbs()[0].Message, jwt) {
		t.Fatal("JWT leaked through scrub")
	}
}

func TestScrubURLRedactsQueryParams(t *testing.T) {
	got := ScrubURL("https://api.example.com/x?token=abc&name=alice&api_key=xxx")
	if strings.Contains(got, "abc") || strings.Contains(got, "xxx") {
		t.Fatalf("secret leaked: %q", got)
	}
	if !strings.Contains(got, "name=alice") {
		t.Fatalf("non-sensitive param lost: %q", got)
	}
}

func TestBreadcrumbDefaults(t *testing.T) {
	ClearBreadcrumbs()
	AddBreadcrumb(Breadcrumb{Message: "hello"})
	b := GetBreadcrumbs()[0]
	if b.Category != "custom" {
		t.Fatalf("default category: %q", b.Category)
	}
	if b.Level != "info" {
		t.Fatalf("default level: %q", b.Level)
	}
	if b.Timestamp == "" {
		t.Fatal("timestamp not auto-filled")
	}
}

func TestBreadcrumbMessageTruncated(t *testing.T) {
	ClearBreadcrumbs()
	AddBreadcrumb(Breadcrumb{Message: strings.Repeat("x", 500)})
	if got := len(GetBreadcrumbs()[0].Message); got > 200 {
		t.Fatalf("message not truncated: len=%d", got)
	}
}
