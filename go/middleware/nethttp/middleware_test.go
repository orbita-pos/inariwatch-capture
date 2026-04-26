package nethttp

import (
	"net/http"
	"net/http/httptest"
	"testing"

	capture "github.com/orbita-pos/inariwatch-capture-go"
)

// The test lives under middleware/nethttp/ so we exercise the public
// import path end to end. We swap in a capturing transport via the
// package-exported helpers in ``client.go`` (not re-exported for
// external users; these tests sit inside the module so they can reach
// the internals).

type recordingTransport struct{ events []capture.ErrorEvent }

func (r *recordingTransport) Send(ev capture.ErrorEvent) {
	r.events = append(r.events, ev)
}
func (r *recordingTransport) Flush(int) {}
func (r *recordingTransport) Close()    {}

func TestMiddlewareCapturesPanic(t *testing.T) {
	capture.ResetForTesting()
	capture.Init(capture.Config{Silent: true})
	fake := &recordingTransport{}
	capture.SetTransportForTesting(fake)

	handler := Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom in handler")
	}))

	req := httptest.NewRequest("GET", "/x?foo=bar", nil)
	req.Header.Set("Authorization", "Bearer abc")
	rr := httptest.NewRecorder()

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("middleware did not re-panic")
		}
		if len(fake.events) == 0 {
			t.Fatal("expected a captured panic event")
		}
		ev := fake.events[0]
		if ev.Request == nil {
			t.Fatal("request context not attached")
		}
		if ev.Request.Headers["Authorization"] != "[REDACTED]" {
			t.Fatalf("authorization leaked: %+v", ev.Request.Headers)
		}
	}()
	handler.ServeHTTP(rr, req)
}
