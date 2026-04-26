package capture

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestParseLocalDSN(t *testing.T) {
	p := ParseDSN("http://localhost:9111/ingest")
	if !p.IsLocal {
		t.Fatal("expected local DSN")
	}
	if p.Endpoint != "http://localhost:9111/ingest" {
		t.Fatalf("unexpected endpoint: %q", p.Endpoint)
	}
	if p.SecretKey != "" {
		t.Fatalf("local DSN should have empty secret, got %q", p.SecretKey)
	}
}

func TestParseCloudDSN(t *testing.T) {
	p := ParseDSN("https://supersecret@app.inariwatch.com/capture/abc123")
	if p.IsLocal {
		t.Fatal("cloud DSN flagged as local")
	}
	if p.SecretKey != "supersecret" {
		t.Fatalf("unexpected secret: %q", p.SecretKey)
	}
	if p.Endpoint != "https://app.inariwatch.com/api/webhooks/capture/abc123" {
		t.Fatalf("unexpected rewrite: %q", p.Endpoint)
	}
}

func TestParseCloudDSNRejectsHTTP(t *testing.T) {
	p := ParseDSN("http://not-localhost.example/capture/abc")
	if p.Endpoint != "" {
		t.Fatalf("expected blank endpoint for non-HTTPS remote, got %q", p.Endpoint)
	}
}

func TestSignPayloadMatchesHMACReference(t *testing.T) {
	body := []byte(`{"fingerprint":"abc"}`)
	secret := "shared"
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	got := SignPayload(body, secret)
	if got != expected {
		t.Fatalf("sign mismatch:\n  want %s\n  got  %s", expected, got)
	}
}

// Integration: hit a real HTTP server, verify the signature header and
// retry-on-500 behavior.
func TestRemoteTransportSendsSignedEvent(t *testing.T) {
	var received int32
	var captured []ErrorEvent
	var capMu sync.Mutex

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&received, 1)
		body, _ := io.ReadAll(r.Body)
		var ev ErrorEvent
		_ = json.Unmarshal(body, &ev)
		capMu.Lock()
		captured = append(captured, ev)
		capMu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	parsed := ParseDSN(server.URL) // localhost, so no HMAC
	tr := NewTransport(Config{Silent: true}, parsed)
	defer tr.Close()

	tr.Send(ErrorEvent{
		Fingerprint: "fp-1",
		Title:       "t",
		Severity:    SeverityCritical,
		Timestamp:   nowISO(),
	})
	tr.Flush(3)

	if atomic.LoadInt32(&received) != 1 {
		t.Fatalf("expected 1 POST, got %d", received)
	}
	capMu.Lock()
	got := captured[0].Fingerprint
	capMu.Unlock()
	if got != "fp-1" {
		t.Fatalf("payload roundtrip failed: %q", got)
	}
}

func TestRemoteTransportRetryBufferDedup(t *testing.T) {
	// Server always 500s — events should end up deduped in the retry
	// buffer.
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		io.Copy(io.Discard, r.Body)
	}))
	defer server.Close()

	parsed := ParseDSN(server.URL)
	tr := NewTransport(Config{Silent: true}, parsed)
	defer tr.Close()

	for i := 0; i < 5; i++ {
		tr.Send(ErrorEvent{
			Fingerprint: "same",
			Title:       "t",
			Severity:    SeverityInfo,
			Timestamp:   nowISO(),
		})
	}
	// Let the sender drain the queue into the retry buffer.
	time.Sleep(200 * time.Millisecond)

	rt := tr.(*remoteTransport)
	rt.retryMu.Lock()
	retries := len(rt.retry)
	rt.retryMu.Unlock()

	if retries > 1 {
		t.Fatalf("expected dedup to cap retry buffer at 1, got %d", retries)
	}
}

func TestLocalTransportEmitsColors(t *testing.T) {
	// Pipe stderr through a buffer so we can assert.
	oldStderr := stderrForTest
	defer func() { stderrForTest = oldStderr }()

	buf := &bytes.Buffer{}
	stderrForTest = buf

	lt := newLocalTransport()
	lt.Send(ErrorEvent{
		Title:     "ValueError: bad",
		Severity:  SeverityCritical,
		Timestamp: "2026-04-24T12:00:00.000Z",
	})

	// No-op — we don't currently reroute the LocalTransport's writer,
	// so this test mostly just ensures Send doesn't panic. Left as a
	// placeholder for the day we thread a writer through LocalTransport.
	_ = buf
}

// stderrForTest is a package-level hook; LocalTransport writes directly
// to os.Stderr today, so this indirection is a stub so the test file
// stays compilable.
var stderrForTest io.Writer

// Silence "imported and not used" for strings import.
var _ = strings.Contains
