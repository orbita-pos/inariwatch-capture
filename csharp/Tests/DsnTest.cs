using Xunit;

namespace InariWatch.Capture.Tests;

public class DsnTest
{
    [Fact]
    public void ParsesLocalDsn()
    {
        var d = Dsn.Parse("http://devsecret@localhost:3000/capture/abc");
        Assert.True(d.IsLocal);
        Assert.Equal("abc", d.ProjectId);
        Assert.Equal("devsecret", d.Secret);
        Assert.EndsWith("/api/webhooks/capture/abc", d.Url);
    }

    [Fact]
    public void ParsesCloudDsn()
    {
        var d = Dsn.Parse("https://prodsecret@app.inariwatch.com/capture/proj42");
        Assert.False(d.IsLocal);
        Assert.Equal("proj42", d.ProjectId);
        Assert.StartsWith("https://", d.Url);
    }

    [Fact]
    public void HttpRequiresLocalhost() =>
        Assert.Throws<ArgumentException>(() => Dsn.Parse("http://secret@example.com/capture/abc"));

    [Fact]
    public void RejectsMissingSecret() =>
        Assert.Throws<ArgumentException>(() => Dsn.Parse("https://app.inariwatch.com/capture/abc"));

    [Fact]
    public void HmacMatchesKnownReference() =>
        Assert.Equal(
            "88aab3ede8d3adf94d26ab90d3bafd4a2083070c3bcce9c014ee04a443847c0b",
            Hmac.SignSha256Hex(System.Text.Encoding.UTF8.GetBytes("hello"), "secret"));
}
