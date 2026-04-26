package capture

import (
	"errors"
	"testing"
)

// fakeTransport captures every event sent through it so tests can
// assert on payload shape without hitting the network.
type fakeTransport struct {
	events []ErrorEvent
}

func (f *fakeTransport) Send(ev ErrorEvent)           { f.events = append(f.events, ev) }
func (f *fakeTransport) Flush(timeoutSeconds int)     {}
func (f *fakeTransport) Close()                       {}

func newFakeClient(t *testing.T) *fakeTransport {
	t.Helper()
	ResetForTesting()
	Init(Config{Silent: true})
	fake := &fakeTransport{}
	SetTransportForTesting(fake)
	return fake
}

func TestCaptureExceptionPopulatesPayload(t *testing.T) {
	fake := newFakeClient(t)
	CaptureException(errors.New("boom"), nil)
	if len(fake.events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(fake.events))
	}
	ev := fake.events[0]
	if ev.Severity != SeverityCritical {
		t.Fatalf("wrong severity: %q", ev.Severity)
	}
	if ev.Runtime != "go" {
		t.Fatalf("runtime tag missing: %q", ev.Runtime)
	}
	if len(ev.Fingerprint) != 64 {
		t.Fatalf("bad fingerprint: %q", ev.Fingerprint)
	}
	if ev.EventType != "error" {
		t.Fatalf("bad eventType: %q", ev.EventType)
	}
}

func TestCaptureExceptionWithContext(t *testing.T) {
	fake := newFakeClient(t)
	SetUser(nil, User{ID: "u42", Role: "admin"})
	SetTag(nil, "feature", "checkout")
	AddBreadcrumb(Breadcrumb{Message: "user clicked"})

	CaptureException(errors.New("boom"), nil)

	ev := fake.events[0]
	if ev.User == nil || ev.User.ID != "u42" {
		t.Fatalf("user missing: %+v", ev.User)
	}
	if ev.Tags["feature"] != "checkout" {
		t.Fatalf("tag missing: %+v", ev.Tags)
	}
	if len(ev.Breadcrumbs) == 0 {
		t.Fatal("breadcrumbs missing")
	}
}

func TestCaptureMessage(t *testing.T) {
	fake := newFakeClient(t)
	CaptureMessage("hello", SeverityWarning)
	if fake.events[0].Severity != SeverityWarning {
		t.Fatalf("wrong severity: %q", fake.events[0].Severity)
	}
	if fake.events[0].Title != "hello" {
		t.Fatalf("wrong title: %q", fake.events[0].Title)
	}
}

func TestCaptureLogRendersMetadata(t *testing.T) {
	fake := newFakeClient(t)
	CaptureLog("DB timeout", LogError, map[string]interface{}{
		"host":       "db",
		"latency_ms": 5200,
	})
	ev := fake.events[0]
	if ev.LogLevel != LogError {
		t.Fatalf("wrong log level: %q", ev.LogLevel)
	}
	if ev.Severity != SeverityCritical {
		t.Fatalf("log error should be critical severity, got %q", ev.Severity)
	}
}

func TestBeforeSendCanDropEvent(t *testing.T) {
	ResetForTesting()
	Init(Config{
		Silent: true,
		BeforeSend: func(ev *ErrorEvent) *ErrorEvent {
			return nil
		},
	})
	fake := &fakeTransport{}
	SetTransportForTesting(fake)
	CaptureMessage("dropped", SeverityInfo)
	if len(fake.events) != 0 {
		t.Fatalf("expected 0 events, got %d", len(fake.events))
	}
}

func TestBeforeSendCanMutateEvent(t *testing.T) {
	ResetForTesting()
	Init(Config{
		Silent: true,
		BeforeSend: func(ev *ErrorEvent) *ErrorEvent {
			ev.Title = "[scrubbed]"
			return ev
		},
	})
	fake := &fakeTransport{}
	SetTransportForTesting(fake)
	CaptureMessage("orig", SeverityInfo)
	if fake.events[0].Title != "[scrubbed]" {
		t.Fatalf("beforeSend mutation lost: %q", fake.events[0].Title)
	}
}

func TestRecoverCapturesPanic(t *testing.T) {
	fake := newFakeClient(t)

	defer func() {
		if r := recover(); r == nil {
			t.Fatal("Recover did not re-raise panic")
		}
		if len(fake.events) != 1 {
			t.Fatalf("expected 1 captured panic event, got %d", len(fake.events))
		}
		if fake.events[0].Context["panic"] != true {
			t.Fatal("panic context flag missing")
		}
	}()
	defer Recover()
	panic("synthetic panic")
}

func TestUninitializedCapturesAreNoOp(t *testing.T) {
	ResetForTesting()
	// Never call Init; all APIs must be no-ops (no nil deref).
	CaptureException(errors.New("x"), nil)
	CaptureMessage("y", SeverityInfo)
	CaptureLog("z", LogInfo, nil)
	Flush(1)
}
