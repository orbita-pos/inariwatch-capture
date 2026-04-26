// DSN parsing + HMAC-signed transport + retry buffer.
//
// Mirrors capture/src/transport.ts at the wire level so events posted
// from Go services verify cleanly on the Next.js ingest (same HMAC
// header name, same signature format, same JSON shape).
package capture

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	maxRetryBuffer  = 30
	requestTimeout  = 10 * time.Second
	sendQueueDepth  = 256
	retrySweepDelay = 1 * time.Second
)

// ParseDSN accepts both local (http://localhost[:port]/ingest) and cloud
// (https://SECRET@host/capture/ID) DSNs. Non-local endpoints MUST use
// HTTPS; a mismatched scheme returns an empty Endpoint so the caller
// surfaces a no-op transport.
func ParseDSN(dsn string) ParsedDSN {
	u, err := url.Parse(dsn)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[inariwatch-capture] DSN parse error: %v\n", err)
		return ParsedDSN{}
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" {
		return ParsedDSN{Endpoint: dsn, IsLocal: true}
	}
	if u.Scheme != "https" {
		fmt.Fprintln(os.Stderr,
			"[inariwatch-capture] DSN must use HTTPS for non-local endpoints. Events will not be sent.")
		return ParsedDSN{}
	}
	secret := ""
	if u.User != nil {
		if p, ok := u.User.Password(); ok && p != "" {
			secret = p
		} else {
			secret = u.User.Username()
		}
	}
	u.User = nil
	if strings.HasPrefix(u.Path, "/capture/") {
		u.Path = "/api/webhooks" + u.Path
	}
	return ParsedDSN{Endpoint: u.String(), SecretKey: secret}
}

// SignPayload computes the "sha256=<hex>" signature used by the
// x-capture-signature header. Byte-identical to Node's signPayload.
func SignPayload(body []byte, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

// Transport is a minimal send-and-flush contract — the public surface
// that init() wires into the module singleton.
type Transport interface {
	Send(event ErrorEvent)
	Flush(timeoutSeconds int)
	Close()
}

// ── Local transport (pretty-print) ─────────────────────────────────

type localTransport struct{}

func newLocalTransport() Transport { return localTransport{} }

func (localTransport) Send(ev ErrorEvent) {
	color := "\x1b[36m"
	switch ev.Severity {
	case SeverityCritical:
		color = "\x1b[31m"
	case SeverityWarning:
		color = "\x1b[33m"
	}
	reset, dim, bold := "\x1b[0m", "\x1b[2m", "\x1b[1m"
	fmt.Fprintf(os.Stderr, "\n%s%s%s %s%s[%s]%s %s%s%s\n",
		dim, isoTimePart(ev.Timestamp), reset,
		color, bold, strings.ToUpper(string(ev.Severity)), reset,
		bold, ev.Title, reset)
	if ev.Body != "" && ev.Body != ev.Title {
		lines := strings.Split(ev.Body, "\n")
		max := len(lines)
		if max > 6 {
			max = 6
		}
		for _, line := range lines[1:max] {
			fmt.Fprintf(os.Stderr, "%s  %s%s\n", dim, strings.TrimSpace(line), reset)
		}
		if len(lines) > 6 {
			fmt.Fprintf(os.Stderr, "%s  ... (%d more lines)%s\n", dim, len(lines)-6, reset)
		}
	}
}

func (localTransport) Flush(int) {}
func (localTransport) Close()    {}

func isoTimePart(ts string) string {
	if i := strings.IndexByte(ts, 'T'); i >= 0 {
		rest := ts[i+1:]
		if j := strings.IndexByte(rest, '.'); j >= 0 {
			return rest[:j]
		}
		return rest
	}
	return ts
}

// ── Remote transport (HMAC + retry) ────────────────────────────────

type remoteTransport struct {
	cfg      Config
	endpoint string
	secret   string
	isLocal  bool
	client   *http.Client

	queue    chan ErrorEvent
	done     chan struct{}
	closed   chan struct{}

	retryMu sync.Mutex
	retry   []ErrorEvent

	wg sync.WaitGroup
}

// NewTransport is the factory used by Init when a DSN is set. Exposed
// so middleware tests can wire their own transports without touching
// the module singleton.
func NewTransport(cfg Config, parsed ParsedDSN) Transport {
	t := &remoteTransport{
		cfg:      cfg,
		endpoint: parsed.Endpoint,
		secret:   parsed.SecretKey,
		isLocal:  parsed.IsLocal,
		client:   &http.Client{Timeout: requestTimeout},
		queue:    make(chan ErrorEvent, sendQueueDepth),
		done:     make(chan struct{}),
		closed:   make(chan struct{}),
	}
	t.wg.Add(1)
	go t.run()
	return t
}

func (t *remoteTransport) log(msg string) {
	if t.cfg.Silent {
		return
	}
	if t.cfg.Debug {
		fmt.Fprintf(os.Stderr, "[inariwatch-capture] %s\n", msg)
	}
}

func (t *remoteTransport) sendOne(ctx context.Context, ev ErrorEvent) bool {
	body, err := json.Marshal(ev)
	if err != nil {
		t.log("serialization error: " + err.Error())
		return true // drop — retrying won't help a malformed payload.
	}
	req, err := http.NewRequestWithContext(ctx, "POST", t.endpoint, bytes.NewReader(body))
	if err != nil {
		t.log("request build: " + err.Error())
		return false
	}
	req.Header.Set("Content-Type", "application/json")
	if !t.isLocal && t.secret != "" {
		req.Header.Set("x-capture-signature", SignPayload(body, t.secret))
	}
	resp, err := t.client.Do(req)
	if err != nil {
		t.log("transport error: " + err.Error())
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		return true
	}
	if resp.StatusCode >= 400 && resp.StatusCode < 500 {
		// 4xx is a client bug — retrying won't help. Drop so one
		// malformed payload can't block the rest forever.
		t.log(fmt.Sprintf("HTTP %d: dropping event", resp.StatusCode))
		return true
	}
	t.log(fmt.Sprintf("HTTP %d: will retry", resp.StatusCode))
	return false
}

func (t *remoteTransport) enqueueRetry(ev ErrorEvent) {
	t.retryMu.Lock()
	defer t.retryMu.Unlock()
	if len(t.retry) >= maxRetryBuffer {
		return
	}
	for _, existing := range t.retry {
		if existing.Fingerprint == ev.Fingerprint {
			return // dedup
		}
	}
	t.retry = append(t.retry, ev)
}

func (t *remoteTransport) flushRetries(ctx context.Context) {
	t.retryMu.Lock()
	batch := t.retry
	t.retry = nil
	t.retryMu.Unlock()
	for i, ev := range batch {
		if !t.sendOne(ctx, ev) {
			remaining := batch[i:]
			t.retryMu.Lock()
			for _, r := range remaining {
				if len(t.retry) < maxRetryBuffer {
					t.retry = append(t.retry, r)
				}
			}
			t.retryMu.Unlock()
			return
		}
	}
}

func (t *remoteTransport) run() {
	defer t.wg.Done()
	defer close(t.closed)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sweep := time.NewTicker(retrySweepDelay)
	defer sweep.Stop()
	for {
		select {
		case <-t.done:
			return
		case ev, ok := <-t.queue:
			if !ok {
				return
			}
			if t.sendOne(ctx, ev) {
				t.flushRetries(ctx)
			} else {
				t.enqueueRetry(ev)
			}
		case <-sweep.C:
			t.flushRetries(ctx)
		}
	}
}

func (t *remoteTransport) Send(ev ErrorEvent) {
	if t.endpoint == "" {
		return
	}
	select {
	case t.queue <- ev:
	default:
		t.log("queue full, dropping event")
	}
}

func (t *remoteTransport) Flush(timeoutSeconds int) {
	if timeoutSeconds <= 0 {
		timeoutSeconds = 5
	}
	deadline := time.Now().Add(time.Duration(timeoutSeconds) * time.Second)
	for time.Now().Before(deadline) {
		if len(t.queue) == 0 {
			t.retryMu.Lock()
			empty := len(t.retry) == 0
			t.retryMu.Unlock()
			if empty {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func (t *remoteTransport) Close() {
	select {
	case <-t.closed:
		return
	default:
	}
	close(t.done)
	t.wg.Wait()
}
