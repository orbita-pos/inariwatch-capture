package com.inariwatch.capture.intent;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JSON-Schema-flavored shape — mirrors the wire dialect documented in
 * {@code capture/src/intent/types.ts}. We deliberately use a plain
 * {@link Map} instead of a typed POJO so each source can emit whatever
 * subset of the dialect it produces without lockstep schema evolution.
 *
 * <p>Helper methods are static — instances are just maps the JSON
 * encoder serializes verbatim.
 */
public final class IntentShape {

    /** Hard cap on serialized shape size (10 KB) — mirrors the Node SDK. */
    public static final int MAX_SHAPE_BYTES = 10 * 1024;

    private IntentShape() {}

    public static Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "object");
        m.put("properties", new LinkedHashMap<String, Object>());
        m.put("required", new java.util.ArrayList<String>());
        return m;
    }

    public static Map<String, Object> array(Map<String, Object> items) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "array");
        m.put("items", items != null ? items : unknown());
        return m;
    }

    public static Map<String, Object> scalar(String type) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", type);
        return m;
    }

    public static Map<String, Object> scalar(String type, String format) {
        Map<String, Object> m = scalar(type);
        if (format != null && !format.isEmpty()) m.put("format", format);
        return m;
    }

    public static Map<String, Object> unknown() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("type", "unknown");
        return m;
    }

    public static Map<String, Object> ref(String name) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("$ref", name);
        m.put("_symbol", name);
        return m;
    }

    /**
     * Truncate a shape so its serialized size fits {@link #MAX_SHAPE_BYTES}.
     * Replaces nested object/array bodies with {@code {_truncated: true}}
     * starting from the deepest leaves.
     */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> capSize(Map<String, Object> shape, java.util.function.Function<Object, String> serialize) {
        if (shape == null) return null;
        String json = serialize.apply(shape);
        if (json == null || json.length() <= MAX_SHAPE_BYTES) return shape;
        for (int depth = 4; depth >= 1; depth--) {
            Map<String, Object> candidate = truncateAtDepth(shape, depth);
            String c = serialize.apply(candidate);
            if (c != null && c.length() <= MAX_SHAPE_BYTES) return candidate;
        }
        Map<String, Object> last = new LinkedHashMap<>();
        if (shape.containsKey("type")) last.put("type", shape.get("type"));
        if (shape.containsKey("_symbol")) last.put("_symbol", shape.get("_symbol"));
        last.put("_truncated", true);
        return last;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> truncateAtDepth(Map<String, Object> s, int depth) {
        if (depth <= 0) {
            Map<String, Object> out = new LinkedHashMap<>();
            if (s.containsKey("type")) out.put("type", s.get("type"));
            if (s.containsKey("_symbol")) out.put("_symbol", s.get("_symbol"));
            out.put("_truncated", true);
            return out;
        }
        Map<String, Object> out = new LinkedHashMap<>(s);
        Object props = s.get("properties");
        if (props instanceof Map) {
            Map<String, Object> next = new LinkedHashMap<>();
            for (Map.Entry<String, Object> e : ((Map<String, Object>) props).entrySet()) {
                Object v = e.getValue();
                if (v instanceof Map) next.put(e.getKey(), truncateAtDepth((Map<String, Object>) v, depth - 1));
                else next.put(e.getKey(), v);
            }
            out.put("properties", next);
        }
        Object items = s.get("items");
        if (items instanceof Map) out.put("items", truncateAtDepth((Map<String, Object>) items, depth - 1));
        return out;
    }

    /** Wire shape produced by the resolver — kept here so callers don't redeclare it. */
    public record Contract(String source, String path, Map<String, Object> shape) {
        public Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("source", source);
            m.put("path", path);
            m.put("shape", shape);
            return m;
        }
    }

    /** Resolver frame — only ``file`` is required. */
    public record Frame(String file, int line, String function) {}

    /** Convenience to build a frame without a known function. */
    public static Frame frameAt(String file, int line) {
        return new Frame(file, line, null);
    }

    /** Convenience for tests that need an immutable list. */
    public static List<String> emptyRequired() {
        return List.of();
    }
}
