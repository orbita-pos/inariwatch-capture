package com.inariwatch.capture.intent;

import java.util.Map;

/**
 * Source of intent contracts — mirrors the {@code IntentSource} interface
 * in {@code capture/src/intent/types.ts}. Each source resolves a single
 * resolver frame to a single shape, returning {@code null} when it can't.
 *
 * <p>Implementations MUST be pure, cheap on misses, and cache hits by
 * {@code (filePath, mtime)}. The compiler runs sources in declared order
 * and stops at the first non-null result for each frame.
 */
public interface IntentSource {

    /** Stable identifier — appears in the wire payload's {@code source} field. */
    String name();

    /**
     * Extract a shape for the given frame.
     *
     * @param filePath absolute or repo-relative path of the file the frame
     *                 points at
     * @param symbol   the function/class/method name in the frame, or
     *                 {@code null} when unknown
     * @return JSON-Schema-flavoured shape, or {@code null} if this source
     *         can't resolve the frame
     */
    Map<String, Object> extract(String filePath, String symbol);
}
