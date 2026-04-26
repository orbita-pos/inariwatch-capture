/**
 * Parses `https://SECRET@host/capture/ID` (and `http://...` for localhost).
 *
 * Returns the same shape every other SDK uses: { url, secret, projectId, isLocal }.
 * The path is normalised to `/api/webhooks/capture/ID` server-side.
 */
export interface ParsedDsn {
  url: string;
  secret: string;
  projectId: string;
  isLocal: boolean;
}

export function parseDsn(dsn: string): ParsedDsn {
  let s = dsn.trim();
  let scheme: "http" | "https";
  if (s.startsWith("https://")) {
    scheme = "https";
    s = s.slice(8);
  } else if (s.startsWith("http://")) {
    scheme = "http";
    s = s.slice(7);
  } else {
    throw new Error(`invalid DSN url: ${dsn}`);
  }

  const at = s.indexOf("@");
  if (at < 0) throw new Error("DSN missing secret");
  const secret = s.slice(0, at);
  if (!secret) throw new Error("DSN missing secret");
  const hostPath = s.slice(at + 1);

  const slash = hostPath.indexOf("/");
  const host = slash < 0 ? hostPath : hostPath.slice(0, slash);
  let path = slash < 0 ? "/" : hostPath.slice(slash);

  const colon = host.indexOf(":");
  const hostOnly = colon < 0 ? host : host.slice(0, colon);
  const isLocal = hostOnly === "localhost" || hostOnly === "127.0.0.1";

  if (scheme === "http" && !isLocal) {
    throw new Error("DSN must use HTTPS unless host is localhost");
  }

  let projectId: string;
  if (path.startsWith("/capture/")) {
    projectId = path.slice("/capture/".length).replace(/\/+$/, "");
    path = `/api/webhooks/capture/${projectId}`;
  } else if (path.startsWith("/api/webhooks/capture/")) {
    projectId = path.slice("/api/webhooks/capture/".length).replace(/\/+$/, "");
  } else {
    throw new Error(`invalid DSN path: ${path}`);
  }
  if (!projectId) throw new Error("DSN missing project id");

  return {
    url: `${scheme}://${host}${path}`,
    secret,
    projectId,
    isLocal,
  };
}
