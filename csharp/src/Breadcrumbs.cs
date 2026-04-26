using System.Text.RegularExpressions;

namespace InariWatch.Capture;

public static class Breadcrumbs
{
    private const int Max = 30;
    private static readonly object Lock = new();
    private static readonly List<Dictionary<string, object?>> Ring = new();

    private static readonly Regex[] Secrets = {
        new(@"(?i)bearer\s+[a-z0-9._\-]+", RegexOptions.Compiled),
        new(@"eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+", RegexOptions.Compiled),
        new(@"sk_[a-z]+_[a-zA-Z0-9]+", RegexOptions.Compiled),
        new(@"(?i)(?:postgres|mysql|mongodb|redis)://[^\s]*", RegexOptions.Compiled),
        new(@"(?i)(?:password|secret|token|api_key)=[^\s&]+", RegexOptions.Compiled),
    };

    public static void Add(string category, string message)
        => AddWithData(category, message, new Dictionary<string, object?>());

    public static void AddWithData(string category, string message, Dictionary<string, object?> data)
    {
        var crumb = new Dictionary<string, object?>
        {
            ["timestamp"] = DateTimeOffset.UtcNow.ToString("o"),
            ["category"] = category,
            ["message"] = ScrubSecrets(message),
            ["data"] = data,
        };
        lock (Lock)
        {
            if (Ring.Count >= Max) Ring.RemoveAt(0);
            Ring.Add(crumb);
        }
    }

    public static List<Dictionary<string, object?>> Get()
    {
        lock (Lock) return new List<Dictionary<string, object?>>(Ring);
    }

    public static void Clear()
    {
        lock (Lock) Ring.Clear();
    }

    public static string ScrubSecrets(string text)
    {
        if (string.IsNullOrEmpty(text)) return text;
        string s = text;
        foreach (var p in Secrets) s = p.Replace(s, "[REDACTED]");
        return s;
    }
}
