package com.inariwatch.capture;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.regex.Pattern;

/**
 * Fingerprint algorithm v1 — byte-identical to:
 * <ul>
 *   <li>{@code capture/src/fingerprint.ts}</li>
 *   <li>{@code capture/python/.../fingerprint.py}</li>
 *   <li>{@code capture/go/fingerprint.go}</li>
 *   <li>{@code capture/rust/src/fingerprint.rs}</li>
 *   <li>{@code web/lib/ai/fingerprint.ts}</li>
 *   <li>{@code cli/src/mcp/fingerprint.rs}</li>
 * </ul>
 *
 * <p>If you change the normalization, regenerate
 * {@code shared/fingerprint-test-vectors.json} and update every SDK in the
 * same PR. The cross-language test in this module's {@code src/test} loads
 * that file and fails CI if any vector diverges.
 */
public final class Fingerprint {

    private static final Pattern UUID = Pattern.compile(
        "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}");
    private static final Pattern ISO8601 =
        Pattern.compile("\\d{4}-\\d{2}-\\d{2}t\\d{2}:\\d{2}:\\d{2}[^\\s]*");
    private static final Pattern UNIX_EPOCH = Pattern.compile("\\b\\d{10,13}\\b");
    private static final Pattern REL_TIME =
        Pattern.compile("\\b\\d+\\s*(?:ms|seconds?|minutes?|hours?|days?)\\s*ago\\b");
    private static final Pattern HEX_ID = Pattern.compile("\\b[0-9a-f]{9,}\\b");
    private static final Pattern PATH = Pattern.compile("(?:/[\\w.\\-]+){2,}(?:\\.\\w+)?");
    private static final Pattern LINE_NO =
        Pattern.compile("(?:at line|line:?|:\\d+:\\d+)\\s*\\d+");
    private static final Pattern URL = Pattern.compile("https?://[^\\s)]+");
    private static final Pattern VERSION = Pattern.compile("v?\\d+\\.\\d+\\.\\d+[^\\s]*");
    private static final Pattern WHITESPACE = Pattern.compile("\\s+");

    private Fingerprint() {}

    /** Compute the v1 fingerprint of {@code title} + "\n" + {@code body}. */
    public static String computeErrorFingerprint(String title, String body) {
        String combined = (title + "\n" + body).toLowerCase();
        String normalized = normalize(combined);
        return sha256Hex(normalized);
    }

    private static String normalize(String text) {
        String s = text;
        s = UUID.matcher(s).replaceAll("<uuid>");
        s = ISO8601.matcher(s).replaceAll("<timestamp>");
        s = UNIX_EPOCH.matcher(s).replaceAll("<timestamp>");
        s = REL_TIME.matcher(s).replaceAll("<time_ago>");
        s = HEX_ID.matcher(s).replaceAll("<hex_id>");
        s = PATH.matcher(s).replaceAll("<path>");
        s = LINE_NO.matcher(s).replaceAll("at line <N>");
        s = URL.matcher(s).replaceAll("<url>");
        s = VERSION.matcher(s).replaceAll("<version>");
        s = WHITESPACE.matcher(s).replaceAll(" ");
        return s.trim();
    }

    private static String sha256Hex(String input) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] digest = md.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                hex.append(String.format("%02x", b));
            }
            return hex.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 not available", e);
        }
    }
}
