package com.inariwatch.capture;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

/**
 * Top-level API: {@code init}, {@code captureException}, {@code captureMessage},
 * {@code captureLog}, {@code flush}, {@code installUncaughtExceptionHandler}.
 */
public final class Capture {

    private static volatile Transport.Sender sender;
    private static volatile Config config = new Config();
    private static volatile boolean inited;

    private Capture() {}

    public static synchronized void init(Config cfg) {
        config = cfg != null ? cfg : new Config();
        if (config.dsn != null && !config.dsn.isBlank()) {
            try {
                Dsn parsed = Dsn.parse(config.dsn);
                sender = new Transport.Remote(parsed);
            } catch (Exception e) {
                System.err.println("[inariwatch-capture] DSN parse error: " + e.getMessage()
                    + " — falling back to local mode");
                sender = new Transport.Local();
            }
        } else {
            if (!config.silent) {
                System.err.println("[inariwatch-capture] Local mode — errors print to stderr. "
                    + "Set INARIWATCH_DSN to send to cloud.");
            }
            sender = new Transport.Local();
        }
        inited = true;
    }

    /** Replace the active transport — primarily for tests. */
    public static synchronized void setSenderForTesting(Transport.Sender s) {
        sender = s;
        inited = true;
    }

    public static synchronized void resetForTesting() {
        sender = null;
        config = new Config();
        inited = false;
    }

    public static void captureException(Throwable err, Map<String, Object> extra) {
        if (!inited || err == null || sender == null) return;
        String title = err.getClass().getSimpleName() + ": "
            + (err.getMessage() == null ? "" : err.getMessage());
        StringWriter sw = new StringWriter();
        err.printStackTrace(new PrintWriter(sw));
        String body = sw.toString();
        ErrorEvent ev = base(title, body, "critical", "error");
        ev.fingerprint = Fingerprint.computeErrorFingerprint(title, body);
        if (extra != null) ev.context.putAll(extra);
        dispatch(ev);
    }

    public static void captureMessage(String message, String severity) {
        if (!inited || sender == null) return;
        ErrorEvent ev = base(message, message, severity == null ? "info" : severity, "error");
        ev.fingerprint = Fingerprint.computeErrorFingerprint(message, "");
        dispatch(ev);
    }

    public static void captureLog(String message, String level, Map<String, Object> metadata) {
        if (!inited || sender == null) return;
        String sev = mapLevel(level);
        ErrorEvent ev = base(message, message, sev, "log");
        ev.fingerprint = Fingerprint.computeErrorFingerprint(message, "");
        if (metadata != null) ev.metadata.putAll(metadata);
        dispatch(ev);
    }

    public static void flush(int timeoutSeconds) {
        if (sender != null) sender.flush(timeoutSeconds);
    }

    /** Installs a {@code Thread.UncaughtExceptionHandler} that captures
     *  unhandled exceptions before delegating to the previous handler. */
    public static void installUncaughtExceptionHandler() {
        Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((t, e) -> {
            captureException(e, Map.of("thread", t.getName()));
            if (prev != null) prev.uncaughtException(t, e);
        });
    }

    private static ErrorEvent base(String title, String body, String severity, String eventType) {
        ErrorEvent ev = new ErrorEvent();
        ev.title = title;
        ev.body = body;
        ev.severity = severity;
        ev.eventType = eventType;
        ev.timestamp = Instant.now().toString();
        ev.runtime = "java";
        ev.environment = config.environment;
        ev.release = config.release;
        ev.user = Scope.getUser();
        ev.tags = Scope.getTags();
        ev.request = Scope.getRequestContext();
        ev.breadcrumbs = Breadcrumbs.get();
        ev.env = jvmEnv();
        return ev;
    }

    private static Map<String, Object> jvmEnv() {
        Map<String, Object> env = new HashMap<>();
        env.put("node", "java-" + System.getProperty("java.version"));
        env.put("os", System.getProperty("os.name"));
        env.put("arch", System.getProperty("os.arch"));
        return env;
    }

    private static String mapLevel(String level) {
        if (level == null) return "error";
        return switch (level.toLowerCase()) {
            case "critical", "fatal" -> "critical";
            case "warn", "warning" -> "warning";
            case "info" -> "info";
            case "debug" -> "debug";
            default -> "error";
        };
    }

    private static void dispatch(ErrorEvent ev) {
        if (config.beforeSend != null) {
            ev = config.beforeSend.apply(ev);
            if (ev == null) return;
        }
        try {
            sender.send(ev);
        } catch (Exception e) {
            // Never throw from inside capture.
            System.err.println("[inariwatch-capture] dispatch failed: " + e);
        }
    }
}
