using Xunit;

namespace InariWatch.Capture.Tests;

public class CaptureTest
{
    private class Recording : ITransport
    {
        public List<ErrorEvent> Events = new();
        public void Send(ErrorEvent ev) => Events.Add(ev);
    }

    private Recording Fresh()
    {
        Capture.ResetForTesting();
        Capture.Init(new Config { Silent = true, Environment_ = "test" });
        var r = new Recording();
        Capture.SetSenderForTesting(r);
        return r;
    }

    [Fact]
    public void CapturesRuntimeAndFingerprint()
    {
        var r = Fresh();
        Capture.CaptureException(new InvalidOperationException("boom"));
        Assert.Single(r.Events);
        var ev = r.Events[0];
        Assert.Equal("csharp", ev.Runtime);
        Assert.Equal("error", ev.EventType);
        Assert.Equal(64, ev.Fingerprint.Length);
        Assert.Contains("boom", ev.Title);
    }

    [Fact]
    public void CaptureMessageRecordsSeverity()
    {
        var r = Fresh();
        Capture.CaptureMessage("disk almost full", "warning");
        Assert.Equal("warning", r.Events[0].Severity);
    }

    [Fact]
    public void BeforeSendCanDropEvent()
    {
        Capture.ResetForTesting();
        var r = new Recording();
        Capture.Init(new Config { Silent = true, BeforeSend = _ => null });
        Capture.SetSenderForTesting(r);
        Capture.CaptureException(new InvalidOperationException("nope"));
        Assert.Empty(r.Events);
    }

    [Fact]
    public void UninitializedIsNoOp()
    {
        Capture.ResetForTesting();
        // Must not throw.
        Capture.CaptureException(new InvalidOperationException("ignored"));
    }
}
