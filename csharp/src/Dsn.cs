namespace InariWatch.Capture;

/// <summary>
/// Parsed DSN. Identical wire-format to the Node SDK: secret extracted
/// from the user-info, path normalised so {/capture/ID} -> {/api/webhooks/capture/ID},
/// and localhost DSNs are flagged so callers can skip TLS + HMAC.
/// </summary>
public sealed record Dsn(string Url, string Secret, string ProjectId, bool IsLocal)
{
    public static Dsn Parse(string dsn)
    {
        string s = dsn.Trim();
        bool https;
        if (s.StartsWith("https://", StringComparison.Ordinal))
        {
            https = true;
            s = s[8..];
        }
        else if (s.StartsWith("http://", StringComparison.Ordinal))
        {
            https = false;
            s = s[7..];
        }
        else
        {
            throw new ArgumentException($"invalid DSN url: {dsn}");
        }

        int at = s.IndexOf('@');
        if (at < 0) throw new ArgumentException("DSN missing secret");
        string secret = s[..at];
        if (secret.Length == 0) throw new ArgumentException("DSN missing secret");
        string hostPath = s[(at + 1)..];

        int slash = hostPath.IndexOf('/');
        string host = slash < 0 ? hostPath : hostPath[..slash];
        string path = slash < 0 ? "/" : hostPath[slash..];

        int colon = host.IndexOf(':');
        string hostOnly = colon < 0 ? host : host[..colon];
        bool isLocal = hostOnly == "localhost" || hostOnly == "127.0.0.1";

        if (!https && !isLocal)
            throw new ArgumentException("DSN must use HTTPS unless host is localhost");

        string projectId;
        if (path.StartsWith("/capture/"))
        {
            projectId = path["/capture/".Length..].TrimEnd('/');
            path = "/api/webhooks/capture/" + projectId;
        }
        else if (path.StartsWith("/api/webhooks/capture/"))
        {
            projectId = path["/api/webhooks/capture/".Length..].TrimEnd('/');
        }
        else
        {
            throw new ArgumentException($"invalid DSN path: {path}");
        }
        if (projectId.Length == 0) throw new ArgumentException("DSN missing project id");

        string url = (https ? "https://" : "http://") + host + path;
        return new Dsn(url, secret, projectId, isLocal);
    }
}
