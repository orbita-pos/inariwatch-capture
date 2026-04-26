package com.inariwatch.capture;

import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Per-thread scope with a process-global fallback. JVM apps will most
 * commonly call {@link #setUser}/{@link #setTag} from a request handler;
 * the values then live on the calling thread until cleared. Use
 * {@link #withScope(Runnable)} for short critical sections that need
 * isolated state.
 */
public final class Scope {
    private static final ThreadLocal<ScopeData> LOCAL = ThreadLocal.withInitial(ScopeData::new);
    private static final ScopeData GLOBAL = new ScopeData();

    static final String[] HEADER_REDACT_PATTERNS = {
        "token", "key", "secret", "auth",
        "credential", "password", "cookie", "session"
    };

    static final java.util.Set<String> REDACT_BODY_FIELDS = java.util.Set.of(
        "password", "passwd", "pass", "secret", "token",
        "api_key", "apikey", "access_token", "accesstoken",
        "refresh_token", "refreshtoken", "credit_card", "creditcard",
        "card_number", "cardnumber", "cvv", "cvc", "ssn",
        "social_security", "authorization"
    );

    private Scope() {}

    static ScopeData current() {
        ScopeData s = LOCAL.get();
        return s != null ? s : GLOBAL;
    }

    /** Sets the current user (email is dropped — only id + role survive). */
    public static void setUser(String id, String role) {
        Map<String, Object> u = new HashMap<>();
        u.put("id", id);
        if (role != null) u.put("role", role);
        current().user = u;
    }

    public static Map<String, Object> getUser() { return current().user; }

    public static void setTag(String key, String value) {
        current().tags.put(key, value);
    }

    public static Map<String, String> getTags() {
        return new HashMap<>(current().tags);
    }

    /** Sets the request context after redacting sensitive headers + body. */
    public static void setRequestContext(Map<String, Object> request) {
        current().request = redactRequest(request);
    }

    public static Map<String, Object> getRequestContext() { return current().request; }

    public static void clear() {
        ScopeData d = current();
        d.user = null;
        d.tags.clear();
        d.request = null;
    }

    /** Run {@code r} with a fresh scope, then restore. */
    public static void withScope(Runnable r) {
        ScopeData prev = current();
        ScopeData fresh = new ScopeData();
        LOCAL.set(fresh);
        try {
            r.run();
        } finally {
            LOCAL.set(prev);
        }
    }

    public static boolean shouldRedactHeader(String name) {
        String lower = name.toLowerCase();
        for (String p : HEADER_REDACT_PATTERNS) {
            if (lower.contains(p)) return true;
        }
        return false;
    }

    @SuppressWarnings("unchecked")
    public static Map<String, Object> redactRequest(Map<String, Object> req) {
        if (req == null) return null;
        Map<String, Object> out = new HashMap<>(req);
        Object headers = out.get("headers");
        if (headers instanceof Map) {
            Map<String, Object> hMap = (Map<String, Object>) headers;
            Map<String, Object> safe = new HashMap<>(hMap.size());
            for (Map.Entry<String, Object> e : hMap.entrySet()) {
                if (shouldRedactHeader(e.getKey())) safe.put(e.getKey(), "[REDACTED]");
                else safe.put(e.getKey(), e.getValue());
            }
            out.put("headers", safe);
        }
        Object body = out.get("body");
        if (body != null) out.put("body", redactBody(body));
        return out;
    }

    @SuppressWarnings("unchecked")
    public static Object redactBody(Object body) {
        if (body instanceof String s) {
            return s.length() > 1024 ? s.substring(0, 1024) + "...[truncated]" : s;
        }
        if (body instanceof Map<?, ?> raw) {
            Map<String, Object> safe = new HashMap<>();
            for (Map.Entry<?, ?> e : raw.entrySet()) {
                String k = String.valueOf(e.getKey());
                if (REDACT_BODY_FIELDS.contains(k.toLowerCase())) {
                    safe.put(k, "[REDACTED]");
                } else {
                    safe.put(k, redactBody(e.getValue()));
                }
            }
            return safe;
        }
        if (body instanceof java.util.List<?> list) {
            return list.stream().map(Scope::redactBody).toList();
        }
        return body;
    }

    static class ScopeData {
        Map<String, Object> user;
        Map<String, String> tags = new HashMap<>();
        Map<String, Object> request;
    }
}
