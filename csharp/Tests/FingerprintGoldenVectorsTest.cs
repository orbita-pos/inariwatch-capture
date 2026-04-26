using System.Text.Json;
using Xunit;

namespace InariWatch.Capture.Tests;

public class FingerprintGoldenVectorsTest
{
    private static string RepoRoot()
    {
        // capture/csharp/Tests/  ->  ../../..  =>  repo root
        var dir = AppContext.BaseDirectory;
        var pieces = new[] { "..", "..", "..", "..", ".." };
        var path = dir;
        foreach (var p in pieces) path = Path.Combine(path, p);
        return Path.GetFullPath(path);
    }

    [Fact]
    public void CrossLanguageGoldenVectors()
    {
        var file = Path.Combine(RepoRoot(), "shared", "fingerprint-test-vectors.json");
        var raw = File.ReadAllText(file);
        using var doc = JsonDocument.Parse(raw);
        var failures = new List<string>();
        int total = 0;
        foreach (var v in doc.RootElement.GetProperty("vectors").EnumerateArray())
        {
            total++;
            var got = Fingerprint.ComputeErrorFingerprint(
                v.GetProperty("title").GetString()!,
                v.GetProperty("body").GetString()!);
            var expected = v.GetProperty("expected").GetString()!;
            if (expected != got)
            {
                failures.Add($"{v.GetProperty("id").GetString()}: expected {expected} got {got}");
            }
        }
        Assert.True(total >= 20, $"expected 20+ vectors, found {total}");
        Assert.True(failures.Count == 0, string.Join("\n", failures));
    }

    [Fact]
    public void SameInputSameHash() =>
        Assert.Equal(
            Fingerprint.ComputeErrorFingerprint("Err", "stack"),
            Fingerprint.ComputeErrorFingerprint("Err", "stack"));

    [Fact]
    public void UuidNormalised() =>
        Assert.Equal(
            Fingerprint.ComputeErrorFingerprint("Err", "user 550e8400-e29b-41d4-a716-446655440000 not found"),
            Fingerprint.ComputeErrorFingerprint("Err", "user 6ba7b810-9dad-11d1-80b4-00c04fd430c8 not found"));
}
