package com.inariwatch.capture;

import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Process-wide breadcrumb ring buffer (30 slots). Mirrors the Node /
 * Python / Go SDK behaviour.
 */
public final class Breadcrumbs {
    private static final int MAX = 30;

    private static final Pattern[] SECRETS = new Pattern[] {
        Pattern.compile("(?i)bearer\\s+[a-z0-9._\\-]+"),
        Pattern.compile("eyJ[a-zA-Z0-9_\\-]+\\.[a-zA-Z0-9_\\-]+\\.[a-zA-Z0-9_\\-]+"),
        Pattern.compile("sk_[a-z]+_[a-zA-Z0-9]+"),
        Pattern.compile("(?i)(?:postgres|mysql|mongodb|redis)://[^\\s]*"),
        Pattern.compile("(?i)(?:password|secret|token|api_key)=[^\\s&]+")
    };

    private static final Pattern[] URL_SECRETS = new Pattern[] {
        Pattern.compile("(?i)([?&])(token|key|secret|password|auth|credential)=[^&]+")
    };

    private static final List<Map<String, Object>> RING = new ArrayList<>();

    private Breadcrumbs() {}

    public static synchronized void add(String category, String message) {
        addWithData(category, message, new HashMap<>());
    }

    public static synchronized void addWithData(String category, String message, Map<String, Object> data) {
        Map<String, Object> crumb = new HashMap<>();
        crumb.put("timestamp", Instant.now().toString());
        crumb.put("category", category);
        crumb.put("message", scrubSecrets(message));
        crumb.put("data", data);
        if (RING.size() >= MAX) RING.remove(0);
        RING.add(crumb);
    }

    public static synchronized List<Map<String, Object>> get() {
        return new ArrayList<>(RING);
    }

    public static synchronized void clear() { RING.clear(); }

    public static String scrubSecrets(String text) {
        if (text == null) return null;
        String out = text;
        for (Pattern p : SECRETS) out = p.matcher(out).replaceAll("[REDACTED]");
        return out;
    }

    public static String scrubUrl(String url) {
        if (url == null) return null;
        String out = url;
        for (Pattern p : URL_SECRETS) out = p.matcher(out).replaceAll("$1$2=[REDACTED]");
        return out;
    }
}
