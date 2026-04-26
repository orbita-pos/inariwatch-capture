#if ASPNETCORE
using Microsoft.AspNetCore.Http;
#endif

namespace InariWatch.Capture;

#if ASPNETCORE
/// <summary>
/// ASP.NET Core middleware. Wraps each request in a fresh scope, attaches
/// the request context with sensitive headers redacted, and captures any
/// unhandled exception before re-throwing.
/// </summary>
public class InariWatchMiddleware
{
    private readonly RequestDelegate _next;
    public InariWatchMiddleware(RequestDelegate next) => _next = next;

    public async Task InvokeAsync(HttpContext ctx)
    {
        Scope.WithScope(() => { });
        var headers = new Dictionary<string, object?>();
        foreach (var h in ctx.Request.Headers) headers[h.Key] = h.Value.ToString();
        Scope.SetRequestContext(new Dictionary<string, object?> {
            ["method"] = ctx.Request.Method,
            ["url"] = ctx.Request.Path + ctx.Request.QueryString,
            ["headers"] = headers
        });
        try
        {
            await _next(ctx);
        }
        catch (Exception e)
        {
            Capture.CaptureException(e, new Dictionary<string, object?> { ["panic"] = false });
            throw;
        }
    }
}
#endif
