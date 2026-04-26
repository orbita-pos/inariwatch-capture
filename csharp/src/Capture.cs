using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace InariWatch.Capture;

public interface ITransport
{
    void Send(ErrorEvent ev);
    void Flush(int timeoutSeconds) {}
    void Close() {}
}

public class LocalTransport : ITransport
{
    public void Send(ErrorEvent ev)
    {
        string first = (ev.Body ?? "").Split('\n', 2)[0];
        Console.Error.WriteLine($"[inariwatch-capture] {ev.Severity} — {ev.Title}");
        if (!string.IsNullOrEmpty(first) && first != ev.Title)
            Console.Error.WriteLine($"                    {first}");
    }
}

public class RemoteTransport : ITransport
{
    private static readonly HttpClient Http = new();
    private readonly Dsn _dsn;
    private readonly Queue<ErrorEvent> _retry = new();
    private readonly object _lock = new();
    private readonly HashSet<string> _seen = new();
    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    public RemoteTransport(Dsn dsn) { _dsn = dsn; }

    public void Send(ErrorEvent ev)
    {
        var batch = new List<ErrorEvent>();
        lock (_lock)
        {
            while (_retry.Count > 0) batch.Add(_retry.Dequeue());
            _seen.Clear();
        }
        batch.Add(ev);
        foreach (var e in batch)
        {
            if (!SendOne(e)) Enqueue(e);
        }
    }

    private bool SendOne(ErrorEvent ev)
    {
        try
        {
            byte[] body = JsonSerializer.SerializeToUtf8Bytes(ev, JsonOpts);
            using var content = new ByteArrayContent(body);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
            using var req = new HttpRequestMessage(HttpMethod.Post, _dsn.Url) { Content = content };
            req.Headers.Add("x-capture-project", _dsn.ProjectId);
            if (!_dsn.IsLocal)
                req.Headers.Add("x-capture-signature", "sha256=" + Hmac.SignSha256Hex(body, _dsn.Secret));
            using var resp = Http.SendAsync(req).GetAwaiter().GetResult();
            return resp.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private void Enqueue(ErrorEvent ev)
    {
        lock (_lock)
        {
            if (_seen.Contains(ev.Fingerprint)) return;
            if (_retry.Count >= 30)
            {
                var dropped = _retry.Dequeue();
                _seen.Remove(dropped.Fingerprint);
            }
            _retry.Enqueue(ev);
            _seen.Add(ev.Fingerprint);
        }
    }

    public void Flush(int timeoutSeconds)
    {
        List<ErrorEvent> snap;
        lock (_lock) snap = _retry.ToList();
        foreach (var ev in snap)
        {
            if (SendOne(ev))
            {
                lock (_lock) { _retry.TryDequeue(out _); _seen.Remove(ev.Fingerprint); }
            }
        }
    }
}

public static class Capture
{
    private static volatile ITransport? _sender;
    private static Config _config = new();
    private static volatile bool _inited;

    public static void Init(Config cfg)
    {
        _config = cfg ?? new Config();
        if (!string.IsNullOrWhiteSpace(_config.Dsn))
        {
            try
            {
                var parsed = Dsn.Parse(_config.Dsn);
                _sender = new RemoteTransport(parsed);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine($"[inariwatch-capture] DSN parse error: {e.Message} — falling back to local mode");
                _sender = new LocalTransport();
            }
        }
        else
        {
            if (!_config.Silent)
                Console.Error.WriteLine("[inariwatch-capture] Local mode — errors print to stderr. Set INARIWATCH_DSN to send to cloud.");
            _sender = new LocalTransport();
        }
        _inited = true;
    }

    public static void SetSenderForTesting(ITransport s) { _sender = s; _inited = true; }
    public static void ResetForTesting() { _sender = null; _config = new Config(); _inited = false; }

    public static void CaptureException(Exception err, Dictionary<string, object?>? extra = null)
    {
        if (!_inited || err == null || _sender == null) return;
        string title = $"{err.GetType().Name}: {err.Message}";
        string body = err.ToString();
        var ev = Base(title, body, "critical", "error");
        ev.Fingerprint = Fingerprint.ComputeErrorFingerprint(title, body);
        if (extra != null) foreach (var kv in extra) ev.Context[kv.Key] = kv.Value;
        Dispatch(ev);
    }

    public static void CaptureMessage(string message, string severity = "info")
    {
        if (!_inited || _sender == null) return;
        var ev = Base(message, message, severity, "error");
        ev.Fingerprint = Fingerprint.ComputeErrorFingerprint(message, "");
        Dispatch(ev);
    }

    public static void CaptureLog(string message, string level, Dictionary<string, object?>? metadata = null)
    {
        if (!_inited || _sender == null) return;
        var ev = Base(message, message, MapLevel(level), "log");
        ev.Fingerprint = Fingerprint.ComputeErrorFingerprint(message, "");
        if (metadata != null) foreach (var kv in metadata) ev.Metadata[kv.Key] = kv.Value;
        Dispatch(ev);
    }

    public static void Flush(int timeoutSeconds) => _sender?.Flush(timeoutSeconds);

    /// <summary>Wires AppDomain.UnhandledException + TaskScheduler.UnobservedTaskException
    /// so unhandled exceptions get captured before crashing.</summary>
    public static void InstallUnhandledExceptionHandler()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, args) =>
        {
            if (args.ExceptionObject is Exception e) CaptureException(e);
        };
        TaskScheduler.UnobservedTaskException += (_, args) =>
        {
            CaptureException(args.Exception);
            args.SetObserved();
        };
    }

    private static ErrorEvent Base(string title, string body, string severity, string eventType)
    {
        return new ErrorEvent
        {
            Title = title,
            Body = body,
            Severity = severity,
            EventType = eventType,
            Timestamp = DateTimeOffset.UtcNow.ToString("o"),
            Runtime = "csharp",
            Environment_ = _config.Environment_,
            Release = _config.Release,
            User = Scope.GetUser(),
            Tags = Scope.GetTags(),
            Request = Scope.GetRequestContext(),
            Breadcrumbs = Breadcrumbs.Get(),
            Env = new Dictionary<string, object?>
            {
                ["node"] = $"dotnet-{Environment.Version}",
                ["os"] = Environment.OSVersion.Platform.ToString(),
                ["arch"] = System.Runtime.InteropServices.RuntimeInformation.OSArchitecture.ToString(),
            },
        };
    }

    private static string MapLevel(string? level) => (level ?? "").ToLowerInvariant() switch
    {
        "critical" or "fatal" => "critical",
        "warn" or "warning" => "warning",
        "info" => "info",
        "debug" => "debug",
        _ => "error"
    };

    private static void Dispatch(ErrorEvent ev)
    {
        if (_config.BeforeSend != null)
        {
            var maybe = _config.BeforeSend(ev);
            if (maybe == null) return;
            ev = maybe;
        }
        try { _sender!.Send(ev); }
        catch (Exception e) { Console.Error.WriteLine($"[inariwatch-capture] dispatch failed: {e}"); }
    }
}
