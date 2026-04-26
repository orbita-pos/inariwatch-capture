# InariWatch.Capture (C# / .NET)

Lightweight error capture SDK for [InariWatch](https://inariwatch.com) — .NET 8.0+.

Payload-compatible with the Node, Python, Go, Rust, and Java SDKs in this monorepo. Same DSN, same event schema, **byte-identical fingerprint algorithm** so an exception thrown in an ASP.NET Core service dedupes against the same exception thrown in any other runtime.

## Quick start

```csharp
using InariWatch.Capture;

Capture.Init(new Config {
    Dsn = Environment.GetEnvironmentVariable("INARIWATCH_DSN"),
    Environment_ = "production",
    Release = typeof(Program).Assembly.GetName().Version?.ToString(),
});

try {
    DoStuff();
} catch (Exception e) {
    Capture.CaptureException(e);
} finally {
    Capture.Flush(2);
}
```

## ASP.NET Core

```csharp
app.UseMiddleware<InariWatchMiddleware>();
```

The middleware wraps each request in `Scope.WithScope`, attaches request context (with sensitive headers redacted), and captures unhandled exceptions before they propagate to your error handler.

## Build

```
dotnet build
dotnet test
```

.NET 8 SDK required.

## Cross-SDK conformance

`Tests/FingerprintGoldenVectorsTest.cs` loads `shared/fingerprint-test-vectors.json` (at the monorepo root) and asserts byte-equivalence against every other SDK. Run with `dotnet test`.

## License

MIT.
