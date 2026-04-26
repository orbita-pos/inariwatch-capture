using Xunit;

namespace InariWatch.Capture.Tests;

public class ScopeTest
{
    [Fact]
    public void SetUserDoesNotIncludeEmail()
    {
        Scope.Clear();
        Scope.SetUser("u1", "admin");
        var u = Scope.GetUser()!;
        Assert.Equal("u1", u["id"]);
        Assert.Equal("admin", u["role"]);
        Assert.False(u.ContainsKey("email"));
    }

    [Fact]
    public void RedactRequestScrubsHeaders()
    {
        var headers = new Dictionary<string, object?>
        {
            ["Authorization"] = "Bearer abc",
            ["X-Auth-Token"] = "leak",
            ["Accept"] = "application/json",
        };
        var req = new Dictionary<string, object?>
        {
            ["method"] = "POST",
            ["url"] = "/x",
            ["headers"] = headers,
        };
        Scope.SetRequestContext(req);
        var stored = Scope.GetRequestContext()!;
        var safe = (Dictionary<string, object?>)stored["headers"]!;
        Assert.Equal("[REDACTED]", safe["Authorization"]);
        Assert.Equal("[REDACTED]", safe["X-Auth-Token"]);
        Assert.Equal("application/json", safe["Accept"]);
    }

    [Fact]
    public void BreadcrumbRingCapsAt30()
    {
        Breadcrumbs.Clear();
        for (int i = 0; i < 50; i++) Breadcrumbs.Add("test", $"crumb-{i}");
        var c = Breadcrumbs.Get();
        Assert.Equal(30, c.Count);
        Assert.Equal("crumb-20", c[0]["message"]);
        Assert.Equal("crumb-49", c[29]["message"]);
    }

    [Fact]
    public void BreadcrumbsScrubBearerTokens()
    {
        Breadcrumbs.Clear();
        Breadcrumbs.Add("http", "GET /x with Authorization: Bearer abcdef");
        var msg = (string)Breadcrumbs.Get()[0]["message"]!;
        Assert.Contains("[REDACTED]", msg);
    }
}
