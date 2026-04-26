using System.Text.Json.Serialization;

namespace InariWatch.Capture;

public class ErrorEvent
{
    [JsonPropertyName("fingerprint")] public string Fingerprint { get; set; } = "";
    [JsonPropertyName("title")] public string Title { get; set; } = "";
    [JsonPropertyName("body")] public string Body { get; set; } = "";
    [JsonPropertyName("severity")] public string Severity { get; set; } = "error";
    [JsonPropertyName("timestamp")] public string Timestamp { get; set; } = "";
    [JsonPropertyName("environment")] public string? Environment_ { get; set; }
    [JsonPropertyName("release")] public string? Release { get; set; }
    [JsonPropertyName("eventType")] public string EventType { get; set; } = "error";
    [JsonPropertyName("runtime")] public string Runtime { get; set; } = "csharp";

    [JsonPropertyName("user"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object>? User { get; set; }

    [JsonPropertyName("tags")]
    public Dictionary<string, string> Tags { get; set; } = new();

    [JsonPropertyName("git"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Git { get; set; }

    [JsonPropertyName("env"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Env { get; set; }

    [JsonPropertyName("request"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public Dictionary<string, object?>? Request { get; set; }

    [JsonPropertyName("breadcrumbs")]
    public List<Dictionary<string, object?>> Breadcrumbs { get; set; } = new();

    [JsonPropertyName("context")]
    public Dictionary<string, object?> Context { get; set; } = new();

    [JsonPropertyName("metadata")]
    public Dictionary<string, object?> Metadata { get; set; } = new();
}

public class Config
{
    public string? Dsn { get; set; }
    public string? Environment_ { get; set; }
    public string? Release { get; set; }
    public bool Silent { get; set; }
    public Func<ErrorEvent, ErrorEvent?>? BeforeSend { get; set; }
}
