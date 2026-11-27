// Three comparison semantics, not interchangeable: `isOriginAllowed` (app.ts, CSRF guard for the multipart and text/markdown body-exempt routes) compares Origin with request.host; `mcpOriginAllowed` compares both against the PUBLIC_URL host (DNS rebinding); `notificationSocketOriginAllowed` requires an Origin matching the PUBLIC_URL host or the raw Host header (cross-site WebSocket hijacking).

// Hand-written instead of `new URL().host`: request.host is a bare Host header with no scheme, and URL's default-port removal is scheme-bound while this comparison ignores the scheme. Strips :80/:443 from both literal strings; IPv6 brackets are kept as-is.
export function stripDefaultPort(host: string): string {
  return host.replace(/:(?:80|443)$/, "");
}

// The other side is always the PUBLIC_URL host, never request.host: comparing two request-supplied values is a useless guard (a rebound evil.com makes Origin and Host equal).
// "null" (sent literally by browsers after a referrer-policy downgrade) and unparseable Origins are rejected; without the try/catch a bad value would be a 500, not 403.
// The caller handles a missing Origin (deliberately allowed); never pass undefined.
export function mcpOriginAllowed(origin: string, requestHost: string, publicHost: string): boolean {
  if (origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const want = stripDefaultPort(publicHost);
  return stripDefaultPort(originHost) === want && stripDefaultPort(requestHost) === want;
}

// The cookie-authenticated notification socket: SameSite=Lax doesn't separate other ports or sibling subdomains, so a missing or foreign Origin is refused (unlike `mcpOriginAllowed`'s caller, which lets a missing one through).
// `rawHost` is the upgrade request's Host header as received: the upgrade is a raw IncomingMessage, so TRUST_PROXY and X-Forwarded-Host don't apply, and a proxy location may pass the upstream name as Host, which is why the PUBLIC_URL host is accepted too.
export function notificationSocketOriginAllowed(origin: string | undefined, rawHost: string | undefined, publicHost: string): boolean {
  if (origin === undefined || origin === "null") return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const got = stripDefaultPort(originHost);
  return got === stripDefaultPort(publicHost) || (rawHost !== undefined && got === stripDefaultPort(rawHost));
}
