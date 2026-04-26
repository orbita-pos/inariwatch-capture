using System.Security.Cryptography;
using System.Text;

namespace InariWatch.Capture;

public static class Hmac
{
    /// <summary>
    /// HMAC-SHA256(payload, secret) -> lowercase hex. Matches the Node /
    /// Python / Go / Rust / Java SDKs byte-for-byte.
    /// </summary>
    public static string SignSha256Hex(byte[] payload, string secret)
    {
        using var mac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        byte[] sig = mac.ComputeHash(payload);
        var sb = new StringBuilder(sig.Length * 2);
        foreach (byte b in sig) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }
}
