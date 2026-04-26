package capture

import (
	"context"
	"sync"
	"testing"
)

func TestSetUserStripsEmail(t *testing.T) {
	ClearScope(nil)
	SetUser(nil, User{ID: "u1", Role: "admin"})
	got := GetUser(nil)
	if got == nil || got.ID != "u1" || got.Role != "admin" {
		t.Fatalf("unexpected user: %+v", got)
	}
}

func TestSetTagAccumulates(t *testing.T) {
	ClearScope(nil)
	SetTag(nil, "feature", "checkout")
	SetTag(nil, "env", "prod")
	tags := GetTags(nil)
	if tags["feature"] != "checkout" || tags["env"] != "prod" {
		t.Fatalf("unexpected tags: %+v", tags)
	}
}

func TestSetRequestContextRedactsHeaders(t *testing.T) {
	ClearScope(nil)
	SetRequestContext(nil, RequestContext{
		Method: "POST",
		URL:    "/x",
		Headers: map[string]string{
			"Content-Type":  "application/json",
			"Authorization": "Bearer abc",
			"X-API-Key":     "secret",
		},
	})
	rc := GetRequestContext(nil)
	if rc == nil {
		t.Fatal("nil request context")
	}
	if rc.Headers["Content-Type"] != "application/json" {
		t.Fatalf("plain header mangled: %q", rc.Headers["Content-Type"])
	}
	if rc.Headers["Authorization"] != "[REDACTED]" {
		t.Fatalf("authorization not redacted: %q", rc.Headers["Authorization"])
	}
	if rc.Headers["X-API-Key"] != "[REDACTED]" {
		t.Fatalf("api key not redacted: %q", rc.Headers["X-API-Key"])
	}
}

func TestSetRequestContextRedactsBody(t *testing.T) {
	ClearScope(nil)
	SetRequestContext(nil, RequestContext{
		Method: "POST",
		URL:    "/login",
		Body: map[string]interface{}{
			"username": "alice",
			"password": "hunter2",
			"token":    "xxx",
		},
	})
	body := GetRequestContext(nil).Body.(map[string]interface{})
	if body["username"] != "alice" {
		t.Fatalf("username mangled: %v", body["username"])
	}
	if body["password"] != "[REDACTED]" || body["token"] != "[REDACTED]" {
		t.Fatalf("secret body fields leaked: %+v", body)
	}
}

func TestWithScopeIsolation(t *testing.T) {
	ClearScope(nil)
	SetTag(nil, "outer", "1")

	ctx := WithScope(context.Background())
	SetTag(ctx, "inner", "2")

	// Inner ctx sees only "inner"; global still has "outer".
	inner := GetTags(ctx)
	if inner["inner"] != "2" {
		t.Fatalf("inner tag missing: %+v", inner)
	}
	if inner["outer"] != "" {
		t.Fatalf("outer tag leaked into inner scope: %+v", inner)
	}

	global := GetTags(nil)
	if global["outer"] != "1" {
		t.Fatalf("global scope clobbered: %+v", global)
	}
}

func TestScopeIsolationAcrossGoroutines(t *testing.T) {
	ClearScope(nil)
	var wg sync.WaitGroup
	results := make(map[string]string)
	var mu sync.Mutex

	for _, id := range []string{"a", "b", "c"} {
		id := id
		wg.Add(1)
		go func() {
			defer wg.Done()
			ctx := WithScope(context.Background())
			SetUser(ctx, User{ID: id})
			// Small yield to interleave.
			for i := 0; i < 10; i++ {
				if u := GetUser(ctx); u != nil && u.ID != id {
					t.Errorf("goroutine %s saw user id %q", id, u.ID)
					return
				}
			}
			mu.Lock()
			results[id] = GetUser(ctx).ID
			mu.Unlock()
		}()
	}
	wg.Wait()
	for k, v := range results {
		if k != v {
			t.Fatalf("scope leak: goroutine %s saw %q", k, v)
		}
	}
}
