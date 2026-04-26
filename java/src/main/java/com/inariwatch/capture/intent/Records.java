package com.inariwatch.capture.intent;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java records intent source — extracts a JSON-Schema-flavored shape from
 * {@code record} declarations in the failing file (SKYNET §3 piece 5, Track D,
 * part 3).
 *
 * <p>When a Spring/Quarkus/plain-Java handler throws, the most useful
 * "expected" shape is usually the request DTO — and post-Java-16 that is
 * almost always a {@code record}. Records have a stable, easy-to-parse
 * surface: {@code public record Foo(int a, String b) { ... }}.
 *
 * <p>Strategy:
 * <ol>
 *   <li>Cheap pre-check: file ends in {@code .java} and contains the literal
 *       {@code "record "}. Skip otherwise (zero allocation on misses).</li>
 *   <li>Cache by {@code (path, mtime)} — same eviction model as the Node
 *       SDK's TS source.</li>
 *   <li>Parse with a regex grammar tight enough to handle every record
 *       shape we've seen in the wild (parameterized generics, nested
 *       parens, array/varargs syntax, annotations on components). For the
 *       1% of malformed inputs we return {@code null} and the next source
 *       gets a turn.</li>
 *   <li>Match by symbol: {@code symbol} equals a record name → that record;
 *       {@code symbol} matches a method on a record → still that record;
 *       no match → first record in the file.</li>
 * </ol>
 *
 * <p>Type mapping mirrors the canonical dialect documented in
 * {@code capture/src/intent/types.ts}: primitives + boxed primitives →
 * {@code "number"}/{@code "boolean"}/{@code "string"}, {@code List<T>}
 * /arrays → {@code "array"}, anything else → {@code "object"} with a
 * {@code _symbol} hint so downstream sources can resolve it.
 */
public final class Records implements IntentSource {

    /** Public name of the source — appears in the wire payload's
     *  {@code intent_contracts[].source} field. */
    public static final String NAME = "java-record";

    private static final int MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

    /** Match a record header up to the opening brace of the body or a
     *  semicolon (compact records aren't a thing in Java; we just need
     *  the parameter list). */
    private static final Pattern RECORD_HEADER = Pattern.compile(
        "(?:public\\s+|private\\s+|protected\\s+)?" +
        "(?:static\\s+|final\\s+|sealed\\s+|non-sealed\\s+)*" +
        "record\\s+([A-Za-z_$][A-Za-z0-9_$]*)" +
        "(?:\\s*<[^>]*>)?" +              // generic params on the record itself
        "\\s*\\(",                          // start of component list
        Pattern.MULTILINE
    );

    private static final Pattern PACKAGE = Pattern.compile(
        "^\\s*package\\s+([A-Za-z_$][\\w.$]*)\\s*;",
        Pattern.MULTILINE
    );

    /** Strip line + block comments. We don't need full-fidelity parsing,
     *  just enough to keep regex from matching {@code record} inside a
     *  comment. Single quotes / strings holding the word "record" are
     *  vanishingly rare; we ignore them. */
    private static final Pattern LINE_COMMENT = Pattern.compile("//[^\\n]*");
    private static final Pattern BLOCK_COMMENT = Pattern.compile("/\\*.*?\\*/", Pattern.DOTALL);

    private final ConcurrentHashMap<String, CacheEntry> cache = new ConcurrentHashMap<>();

    @Override
    public String name() { return NAME; }

    @Override
    public Map<String, Object> extract(String filePath, String symbol) {
        if (filePath == null || !filePath.endsWith(".java")) return null;
        Path p = Paths.get(filePath);
        long mtime;
        long size;
        try {
            mtime = Files.getLastModifiedTime(p).toMillis();
            size = Files.size(p);
        } catch (IOException e) {
            return null;
        }
        if (size > MAX_FILE_BYTES) return null;

        CacheEntry entry = cache.compute(filePath, (k, prev) -> {
            if (prev != null && prev.mtime == mtime) return prev;
            ParsedFile fresh = parseFile(p);
            return fresh == null ? null : new CacheEntry(mtime, fresh);
        });
        if (entry == null) return null;
        ParsedFile parsed = entry.file;
        if (parsed.records().isEmpty()) return null;

        RecordDecl chosen = pick(parsed.records(), symbol);
        if (chosen == null) return null;

        Map<String, Object> shape = IntentShape.object();
        @SuppressWarnings("unchecked")
        Map<String, Object> properties = (Map<String, Object>) shape.get("properties");
        @SuppressWarnings("unchecked")
        List<String> required = (List<String>) shape.get("required");

        for (Component c : chosen.components()) {
            properties.put(c.name(), mapType(c.javaType()));
            // Records' required-ness comes from primitives (no null) and
            // non-Optional reference types. We mark all non-Optional fields
            // as required; the LLM treats this as "expected non-null". This
            // matches Pydantic/TS behavior — Optional<T> means optional.
            if (!isOptional(c.javaType())) required.add(c.name());
        }
        shape.put("_symbol", chosen.name());
        if (parsed.pkg() != null) shape.put("_package", parsed.pkg());

        return shape;
    }

    // ─── Parsing ───────────────────────────────────────────────────────────

    private ParsedFile parseFile(Path path) {
        String src;
        try {
            src = Files.readString(path, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return null;
        }
        // Skip files that don't even mention `record ` — the cheap pre-filter.
        if (!src.contains("record ")) return null;

        // Strip comments so the regex doesn't trip on `// public record Foo(...)`.
        String cleaned = LINE_COMMENT.matcher(BLOCK_COMMENT.matcher(src).replaceAll("")).replaceAll("");

        String pkg = null;
        Matcher pm = PACKAGE.matcher(cleaned);
        if (pm.find()) pkg = pm.group(1);

        List<RecordDecl> out = new ArrayList<>();
        Matcher m = RECORD_HEADER.matcher(cleaned);
        while (m.find()) {
            String name = m.group(1);
            int parenStart = m.end() - 1; // position of the '(' we just matched
            int parenEnd = matchParen(cleaned, parenStart);
            if (parenEnd < 0) continue; // malformed — skip this record
            String paramList = cleaned.substring(parenStart + 1, parenEnd);
            List<Component> components = parseComponents(paramList);
            out.add(new RecordDecl(name, components));
        }
        return new ParsedFile(pkg, out);
    }

    /** Return the index of the matching ')' for a '(' at {@code openIdx}, or -1. */
    private static int matchParen(CharSequence s, int openIdx) {
        int depth = 0;
        for (int i = openIdx; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '(') depth++;
            else if (c == ')') {
                depth--;
                if (depth == 0) return i;
            }
        }
        return -1;
    }

    /** Split on top-level commas (commas inside generics or arrays don't count). */
    private static List<Component> parseComponents(String src) {
        List<Component> out = new ArrayList<>();
        if (src == null || src.trim().isEmpty()) return out;
        List<String> chunks = splitTopLevelCommas(src);
        for (String chunk : chunks) {
            String c = stripAnnotations(chunk).trim();
            if (c.isEmpty()) continue;
            // The component is `<type> <name>` where <type> may contain
            // generics / array brackets. Walk from the right: the trailing
            // identifier is the name, everything before is the type.
            int nameEnd = c.length();
            while (nameEnd > 0 && Character.isWhitespace(c.charAt(nameEnd - 1))) nameEnd--;
            int nameStart = nameEnd;
            while (nameStart > 0) {
                char ch = c.charAt(nameStart - 1);
                if (Character.isJavaIdentifierPart(ch)) nameStart--;
                else break;
            }
            if (nameStart == nameEnd) continue; // no identifier — skip
            String name = c.substring(nameStart, nameEnd);
            String type = c.substring(0, nameStart).trim();
            // Handle `String... args` (varargs) — collapse to `String[]`.
            if (type.endsWith("...")) type = type.substring(0, type.length() - 3) + "[]";
            // Handle `String[] arr` — already correct.
            if (type.isEmpty()) continue;
            out.add(new Component(name, type));
        }
        return out;
    }

    private static List<String> splitTopLevelCommas(String s) {
        List<String> out = new ArrayList<>();
        int depthAngle = 0;
        int depthParen = 0;
        int depthBracket = 0;
        StringBuilder cur = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '<') depthAngle++;
            else if (c == '>') depthAngle = Math.max(0, depthAngle - 1);
            else if (c == '(') depthParen++;
            else if (c == ')') depthParen = Math.max(0, depthParen - 1);
            else if (c == '[') depthBracket++;
            else if (c == ']') depthBracket = Math.max(0, depthBracket - 1);
            if (c == ',' && depthAngle == 0 && depthParen == 0 && depthBracket == 0) {
                out.add(cur.toString());
                cur.setLength(0);
                continue;
            }
            cur.append(c);
        }
        if (cur.length() > 0) out.add(cur.toString());
        return out;
    }

    /** Drop {@code @Annotation(...)} prefixes from a component fragment. */
    private static String stripAnnotations(String chunk) {
        StringBuilder out = new StringBuilder();
        int i = 0;
        while (i < chunk.length()) {
            // Skip leading whitespace
            while (i < chunk.length() && Character.isWhitespace(chunk.charAt(i))) {
                out.append(chunk.charAt(i));
                i++;
            }
            if (i < chunk.length() && chunk.charAt(i) == '@') {
                // skip @Annotation
                i++;
                while (i < chunk.length() && (Character.isJavaIdentifierPart(chunk.charAt(i)) || chunk.charAt(i) == '.')) i++;
                // skip optional parameters
                if (i < chunk.length() && chunk.charAt(i) == '(') {
                    int close = matchParen(chunk, i);
                    if (close < 0) return ""; // malformed
                    i = close + 1;
                }
                continue;
            }
            out.append(chunk.substring(i));
            break;
        }
        return out.toString();
    }

    // ─── Type mapping ──────────────────────────────────────────────────────

    private static Map<String, Object> mapType(String javaType) {
        String t = javaType.trim();
        // Strip Optional<T> wrapper — we already handle it in `required`.
        Optional<String> opt = unwrapGeneric(t, "Optional");
        if (opt.present) t = opt.value;
        Optional<String> joptional = unwrapGeneric(t, "java.util.Optional");
        if (joptional.present) t = joptional.value;

        // Arrays: `T[]`, `List<T>`, `Set<T>`, `Collection<T>`, `Iterable<T>`.
        if (t.endsWith("[]")) {
            return IntentShape.array(mapType(t.substring(0, t.length() - 2)));
        }
        for (String coll : new String[]{"List", "Set", "Collection", "Iterable", "java.util.List", "java.util.Set", "java.util.Collection"}) {
            Optional<String> inner = unwrapGeneric(t, coll);
            if (inner.present) return IntentShape.array(mapType(inner.value));
        }
        // Maps: `Map<K, V>` → object with values of mapType(V). Keys assumed string.
        for (String mapName : new String[]{"Map", "java.util.Map"}) {
            if (t.startsWith(mapName + "<") && t.endsWith(">")) {
                String inner = t.substring(mapName.length() + 1, t.length() - 1);
                List<String> parts = splitTopLevelCommas(inner);
                if (parts.size() == 2) {
                    Map<String, Object> shape = IntentShape.object();
                    shape.put("additionalProperties", mapType(parts.get(1).trim()));
                    return shape;
                }
            }
        }

        switch (t) {
            case "int": case "Integer":
            case "long": case "Long":
            case "short": case "Short":
            case "byte": case "Byte":
            case "float": case "Float":
            case "double": case "Double":
            case "java.lang.Integer": case "java.lang.Long":
            case "java.math.BigInteger": case "BigInteger":
            case "java.math.BigDecimal": case "BigDecimal":
                return IntentShape.scalar("number");
            case "boolean": case "Boolean": case "java.lang.Boolean":
                return IntentShape.scalar("boolean");
            case "char": case "Character":
            case "String": case "java.lang.String":
            case "CharSequence":
                return IntentShape.scalar("string");
            case "java.time.Instant": case "Instant":
            case "java.time.OffsetDateTime": case "OffsetDateTime":
            case "java.time.ZonedDateTime": case "ZonedDateTime":
            case "java.time.LocalDateTime": case "LocalDateTime":
                return IntentShape.scalar("string", "date-time");
            case "java.time.LocalDate": case "LocalDate":
                return IntentShape.scalar("string", "date");
            case "java.util.UUID": case "UUID":
                return IntentShape.scalar("string", "uuid");
            default: {
                // Strip generic params for the symbol hint — the consumer
                // can recurse into nested records via cross-source lookup.
                String sym = t;
                int lt = sym.indexOf('<');
                if (lt > 0) sym = sym.substring(0, lt);
                int dot = sym.lastIndexOf('.');
                if (dot > 0) sym = sym.substring(dot + 1);
                Map<String, Object> obj = IntentShape.object();
                obj.put("_symbol", sym);
                return obj;
            }
        }
    }

    private static Optional<String> unwrapGeneric(String t, String name) {
        String prefix = name + "<";
        if (t.startsWith(prefix) && t.endsWith(">")) {
            return Optional.of(t.substring(prefix.length(), t.length() - 1).trim());
        }
        return Optional.absent();
    }

    private static boolean isOptional(String javaType) {
        String t = javaType.trim();
        return t.startsWith("Optional<") || t.startsWith("java.util.Optional<")
            || t.equals("Optional") || t.equals("java.util.Optional");
    }

    private static RecordDecl pick(List<RecordDecl> all, String symbol) {
        if (all.isEmpty()) return null;
        if (symbol != null && !symbol.isEmpty()) {
            for (RecordDecl r : all) if (r.name().equals(symbol)) return r;
            // method-on-record: if the symbol contains a `.` or `#` separator,
            // use the receiver type. Otherwise fall through to the first.
            for (String sep : new String[]{".", "#"}) {
                int idx = symbol.indexOf(sep);
                if (idx > 0) {
                    String receiver = symbol.substring(0, idx);
                    for (RecordDecl r : all) if (r.name().equals(receiver)) return r;
                }
            }
        }
        return all.get(0);
    }

    /** Reset cache (test-only). */
    public void resetCacheForTesting() { cache.clear(); }

    // ─── Internal types ────────────────────────────────────────────────────

    private record Component(String name, String javaType) {}
    private record RecordDecl(String name, List<Component> components) {}
    private record ParsedFile(String pkg, List<RecordDecl> records) {}

    private static final class CacheEntry {
        final long mtime;
        final ParsedFile file;
        CacheEntry(long mtime, ParsedFile file) { this.mtime = mtime; this.file = file; }
    }

    /** Tiny optional wrapper — avoids pulling in {@code java.util.Optional}
     *  for control flow (we use that name to model user-facing optionality). */
    private static final class Optional<T> {
        final boolean present;
        final T value;
        private Optional(boolean p, T v) { this.present = p; this.value = v; }
        static <T> Optional<T> of(T v) { return new Optional<>(true, v); }
        static <T> Optional<T> absent() { return new Optional<>(false, null); }
    }
}
