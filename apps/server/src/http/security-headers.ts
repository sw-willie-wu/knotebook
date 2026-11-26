import { createHash } from "node:crypto";

// Hashes derive from the HTML actually sent, never hardcoded: index.html has a synchronous inline script (dark-mode first paint), and a CSP block would show as a white flash on every load with no test failing.

// ⚠ An attribute value containing ">" ends the match early, so the real script body goes unhashed and CSP blocks it (fails closed; e2e/tests/09-csp.spec.ts catches it). Don't add attributes containing ">" to index.html script tags.
const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi;

// Hash over LF-normalized text: the HTML parser converts CR/CRLF to LF before the browser hashes textContent. A CRLF checkout of index.html otherwise yields a script-src-elem violation.
function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(INLINE_SCRIPT)].map((match) => {
    const source = match[1]!.replace(/\r\n?/g, "\n");
    return `'sha256-${createHash("sha256").update(source, "utf8").digest("base64")}'`;
  });
}

// The loose half is deliberate: external images and audio/video by URL are supported features a tighter CSP would silently break, and CSP can't tell a pasted image from an injected `themeCSS: url(…)`. Only a self-hosted image proxy would allow both.
const STATIC_DIRECTIVES: readonly (readonly [string, string])[] = [
  ["default-src", "'self'"],
  ["style-src", "'self' 'unsafe-inline'"],
  // Both http: and https: (apps/web/src/lib/media-url.ts allows both; plain-http LAN deployments would otherwise lose images).
  ["img-src", "'self' data: blob: http: https:"],
  // Uploaded audio/video plays from its same-origin URL; the client makes no blob: or data: previews, so neither is allowed.
  ["media-src", "'self' http: https:"],
  ["font-src", "'self' data:"],
  // Collab WebSocket is same-origin; AI providers are called server-side.
  ["connect-src", "'self'"],
  ["object-src", "'none'"],
  ["base-uri", "'self'"],
  ["frame-ancestors", "'none'"],
  ["form-action", "'self'"],
];

export function securityHeaders(html: string): Record<string, string> {
  const directives = [
    `script-src ${["'self'", ...inlineScriptHashes(html)].join(" ")}`,
    ...STATIC_DIRECTIVES.map(([name, value]) => `${name} ${value}`),
  ];
  return {
    "content-security-policy": directives.join("; "),
    "x-content-type-options": "nosniff",
    // Keeps external hosts from seeing which note the reader is on.
    "referrer-policy": "no-referrer",
  };
}
