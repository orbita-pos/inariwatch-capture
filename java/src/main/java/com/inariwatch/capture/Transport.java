package com.inariwatch.capture;

import com.fasterxml.jackson.databind.ObjectMapper;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

import java.io.IOException;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

/**
 * HTTP transport with HMAC-SHA256 signing + a bounded retry buffer
 * (30 entries, dedup by fingerprint). Mirrors the Node SDK's
 * transport.ts wire format byte-for-byte.
 */
public class Transport {
    private static final MediaType JSON = MediaType.parse("application/json");
    private static final ObjectMapper MAPPER = new ObjectMapper();

    public interface Sender {
        void send(ErrorEvent event);
        default void flush(int timeoutSeconds) {}
        default void close() {}
    }

    /** Pretty-prints to stderr. Used when no DSN is configured. */
    public static class Local implements Sender {
        @Override
        public void send(ErrorEvent event) {
            String first = event.body == null ? "" : event.body.split("\n", 2)[0];
            System.err.println("[inariwatch-capture] " + event.severity + " — " + event.title);
            if (!first.isEmpty() && !first.equals(event.title)) {
                System.err.println("                    " + first);
            }
        }
    }

    /** HTTP transport. */
    public static class Remote implements Sender {
        private final Dsn dsn;
        private final OkHttpClient http;
        private final ConcurrentLinkedQueue<ErrorEvent> retry = new ConcurrentLinkedQueue<>();
        private final Map<String, Boolean> seen = Collections.synchronizedMap(new LinkedHashMap<>());

        public Remote(Dsn dsn) {
            this.dsn = dsn;
            this.http = new OkHttpClient.Builder()
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(10, TimeUnit.SECONDS)
                .build();
        }

        @Override
        public void send(ErrorEvent event) {
            // Drain any buffered events first, then the new one.
            ConcurrentLinkedQueue<ErrorEvent> batch = new ConcurrentLinkedQueue<>(retry);
            retry.clear();
            batch.add(event);
            for (ErrorEvent ev : batch) {
                if (!sendOne(ev)) {
                    enqueue(ev);
                }
            }
        }

        private boolean sendOne(ErrorEvent ev) {
            try {
                byte[] body = MAPPER.writeValueAsBytes(ev);
                Request.Builder rb = new Request.Builder()
                    .url(dsn.url)
                    .header("content-type", "application/json")
                    .header("x-capture-project", dsn.projectId)
                    .post(RequestBody.create(body, JSON));
                if (!dsn.isLocal) {
                    rb.header("x-capture-signature", "sha256=" + Hmac.signSha256Hex(body, dsn.secret));
                }
                try (Response r = http.newCall(rb.build()).execute()) {
                    return r.isSuccessful();
                }
            } catch (IOException e) {
                return false;
            }
        }

        private void enqueue(ErrorEvent ev) {
            if (seen.containsKey(ev.fingerprint)) return;
            if (retry.size() >= 30) {
                ErrorEvent dropped = retry.poll();
                if (dropped != null) seen.remove(dropped.fingerprint);
            }
            retry.add(ev);
            seen.put(ev.fingerprint, true);
        }

        @Override
        public void flush(int timeoutSeconds) {
            // Best-effort drain — block briefly per attempt.
            for (ErrorEvent ev : new ConcurrentLinkedQueue<>(retry)) {
                if (sendOne(ev)) {
                    retry.remove(ev);
                    seen.remove(ev.fingerprint);
                }
            }
        }
    }
}
