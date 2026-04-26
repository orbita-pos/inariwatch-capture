package com.inariwatch.capture;

/**
 * Parsed DSN. Mirrors the Node SDK's transport.ts: secret extracted from
 * the user-info component, path normalised so {@code /capture/ID} becomes
 * {@code /api/webhooks/capture/ID}, and localhost DSNs are flagged so the
 * caller can skip TLS + HMAC.
 */
public final class Dsn {
    public final String url;
    public final String secret;
    public final String projectId;
    public final boolean isLocal;

    private Dsn(String url, String secret, String projectId, boolean isLocal) {
        this.url = url;
        this.secret = secret;
        this.projectId = projectId;
        this.isLocal = isLocal;
    }

    public static Dsn parse(String dsn) {
        String s = dsn.trim();
        boolean https;
        if (s.startsWith("https://")) {
            https = true;
            s = s.substring(8);
        } else if (s.startsWith("http://")) {
            https = false;
            s = s.substring(7);
        } else {
            throw new IllegalArgumentException("invalid DSN url: " + dsn);
        }

        int at = s.indexOf('@');
        if (at < 0) {
            throw new IllegalArgumentException("DSN missing secret");
        }
        String secret = s.substring(0, at);
        if (secret.isEmpty()) {
            throw new IllegalArgumentException("DSN missing secret");
        }
        String hostPath = s.substring(at + 1);

        int slash = hostPath.indexOf('/');
        String host = slash < 0 ? hostPath : hostPath.substring(0, slash);
        String path = slash < 0 ? "/" : hostPath.substring(slash);

        int colon = host.indexOf(':');
        String hostOnly = colon < 0 ? host : host.substring(0, colon);
        boolean isLocal = hostOnly.equals("localhost") || hostOnly.equals("127.0.0.1");

        if (!https && !isLocal) {
            throw new IllegalArgumentException("DSN must use HTTPS unless host is localhost");
        }

        String projectId;
        if (path.startsWith("/capture/")) {
            projectId = path.substring("/capture/".length()).replaceAll("/+$", "");
            path = "/api/webhooks/capture/" + projectId;
        } else if (path.startsWith("/api/webhooks/capture/")) {
            projectId = path.substring("/api/webhooks/capture/".length()).replaceAll("/+$", "");
        } else {
            throw new IllegalArgumentException("invalid DSN path: " + path);
        }
        if (projectId.isEmpty()) {
            throw new IllegalArgumentException("DSN missing project id");
        }

        String url = (https ? "https://" : "http://") + host + path;
        return new Dsn(url, secret, projectId, isLocal);
    }
}
