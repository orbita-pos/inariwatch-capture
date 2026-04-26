using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace InariWatch.Capture;

/// <summary>
/// Fingerprint algorithm v1 — byte-identical to:
/// <list type="bullet">
///   <item><c>capture/src/fingerprint.ts</c></item>
///   <item><c>capture/python/.../fingerprint.py</c></item>
///   <item><c>capture/go/fingerprint.go</c></item>
///   <item><c>capture/rust/src/fingerprint.rs</c></item>
///   <item><c>capture/java/.../Fingerprint.java</c></item>
/// </list>
/// If you change the normalization, regenerate
/// <c>shared/fingerprint-test-vectors.json</c> and update every SDK in the
/// same PR. The cross-language test loads that file and fails CI if any
/// vector diverges.
/// </summary>
public static class Fingerprint
{
    private static readonly Regex Uuid = new(
        @"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        RegexOptions.Compiled);
    private static readonly Regex Iso8601 = new(
        @"\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}[^\s]*",
        RegexOptions.Compiled);
    private static readonly Regex UnixEpoch = new(@"\b\d{10,13}\b", RegexOptions.Compiled);
    private static readonly Regex RelTime = new(
        @"\b\d+\s*(?:ms|seconds?|minutes?|hours?|days?)\s*ago\b",
        RegexOptions.Compiled);
    private static readonly Regex HexId = new(@"\b[0-9a-f]{9,}\b", RegexOptions.Compiled);
    private static readonly Regex Path = new(@"(?:/[\w.\-]+){2,}(?:\.\w+)?", RegexOptions.Compiled);
    private static readonly Regex LineNo = new(
        @"(?:at line|line:?|:\d+:\d+)\s*\d+", RegexOptions.Compiled);
    private static readonly Regex Url = new(@"https?://[^\s)]+", RegexOptions.Compiled);
    private static readonly Regex Version = new(@"v?\d+\.\d+\.\d+[^\s]*", RegexOptions.Compiled);
    private static readonly Regex Whitespace = new(@"\s+", RegexOptions.Compiled);

    public static string ComputeErrorFingerprint(string title, string body)
    {
        string combined = (title + "\n" + body).ToLowerInvariant();
        string normalized = Normalize(combined);
        return Sha256Hex(normalized);
    }

    private static string Normalize(string text)
    {
        string s = text;
        s = Uuid.Replace(s, "<uuid>");
        s = Iso8601.Replace(s, "<timestamp>");
        s = UnixEpoch.Replace(s, "<timestamp>");
        s = RelTime.Replace(s, "<time_ago>");
        s = HexId.Replace(s, "<hex_id>");
        s = Path.Replace(s, "<path>");
        s = LineNo.Replace(s, "at line <N>");
        s = Url.Replace(s, "<url>");
        s = Version.Replace(s, "<version>");
        s = Whitespace.Replace(s, " ");
        return s.Trim();
    }

    private static string Sha256Hex(string input)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(input));
        var sb = new StringBuilder(hash.Length * 2);
        foreach (byte b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }
}
