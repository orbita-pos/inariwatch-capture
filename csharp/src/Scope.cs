namespace InariWatch.Capture;

/// <summary>
/// Per-async-context scope using AsyncLocal so each request gets its own
/// state. Mirrors Node SDK's AsyncLocalStorage and Python's contextvars.
/// </summary>
public static class Scope
{
    private static readonly AsyncLocal<ScopeData?> Current = new();

    private static readonly string[] HeaderRedactPatterns = {
        "token", "key", "secret", "auth",
        "credential", "password", "cookie", "session"
    };

    private static readonly HashSet<string> RedactBodyFields = new(StringComparer.OrdinalIgnoreCase) {
        "password", "passwd", "pass", "secret", "token",
        "api_key", "apiKey", "access_token", "accessToken",
        "refresh_token", "refreshToken", "credit_card", "creditCard",
        "card_number", "cardNumber", "cvv", "cvc", "ssn",
        "social_security", "authorization"
    };

    private static ScopeData Get()
    {
        var s = Current.Value;
        if (s != null) return s;
        s = new ScopeData();
        Current.Value = s;
        return s;
    }

    public static void SetUser(string id, string? role = null)
    {
        var u = new Dictionary<string, object> { ["id"] = id };
        if (role != null) u["role"] = role;
        Get().User = u;
    }

    public static Dictionary<string, object>? GetUser() => Current.Value?.User;

    public static void SetTag(string key, string value) => Get().Tags[key] = value;

    public static Dictionary<string, string> GetTags() =>
        new(Current.Value?.Tags ?? new Dictionary<string, string>());

    public static void SetRequestContext(Dictionary<string, object?> req) =>
        Get().Request = RedactRequest(req);

    public static Dictionary<string, object?>? GetRequestContext() => Current.Value?.Request;

    public static void Clear()
    {
        var s = Current.Value;
        if (s == null) return;
        s.User = null;
        s.Tags.Clear();
        s.Request = null;
    }

    public static void WithScope(Action body)
    {
        var prev = Current.Value;
        Current.Value = new ScopeData();
        try { body(); }
        finally { Current.Value = prev; }
    }

    public static bool ShouldRedactHeader(string name)
    {
        string lower = name.ToLowerInvariant();
        foreach (string p in HeaderRedactPatterns)
            if (lower.Contains(p)) return true;
        return false;
    }

    public static Dictionary<string, object?> RedactRequest(Dictionary<string, object?> req)
    {
        var copy = new Dictionary<string, object?>(req);
        if (copy.TryGetValue("headers", out var h) && h is Dictionary<string, object?> hMap)
        {
            var safe = new Dictionary<string, object?>(hMap.Count);
            foreach (var kv in hMap)
                safe[kv.Key] = ShouldRedactHeader(kv.Key) ? "[REDACTED]" : kv.Value;
            copy["headers"] = safe;
        }
        if (copy.TryGetValue("body", out var b) && b != null)
            copy["body"] = RedactBody(b);
        return copy;
    }

    public static object? RedactBody(object? body)
    {
        switch (body)
        {
            case null: return null;
            case string s:
                return s.Length > 1024 ? s[..1024] + "...[truncated]" : s;
            case Dictionary<string, object?> map:
                var safe = new Dictionary<string, object?>();
                foreach (var kv in map)
                {
                    safe[kv.Key] = RedactBodyFields.Contains(kv.Key)
                        ? "[REDACTED]"
                        : RedactBody(kv.Value);
                }
                return safe;
            case System.Collections.IEnumerable list when body is not string:
                var arr = new List<object?>();
                foreach (var item in list) arr.Add(RedactBody(item));
                return arr;
            default:
                return body;
        }
    }

    internal class ScopeData
    {
        public Dictionary<string, object>? User;
        public Dictionary<string, string> Tags = new();
        public Dictionary<string, object?>? Request;
    }
}
