import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../../src/http/security-headers.js";

/**
 * issue #101: CSP and the security headers sent with it.
 *
 * These pin shapes that break without any other test going red; users would hit them:
 *
 * - **the script-src hash drifts from the HTML actually sent** -> the inline script that prevents the dark-mode first-paint flash
 *   is blocked by the CSP, and every page open flashes white. So the hash is **derived from the HTML about to be sent**
 *   (not computed once at startup, let alone a hard-coded constant); the first test below pins that.
 * - **a directive is loosened** (e.g. someone adds `'unsafe-inline'` to script-src to make something work) -> the defence silently
 *   stops working. Values are pinned one by one.
 * - **a directive is tightened** (img/media) -> shipped features silently turn into broken images: external images are embedded by URL, and
 *   audio/video/file blocks can embed external URLs besides same-origin uploads. The mermaid policy in `apps/web/src/lib/mermaid.ts` also lets diagrams reference remote images.
 *
 * Expected values are deliberately **not derived from the code under test**: the hash is computed here with node:crypto as an oracle.
 */

/** Independent oracle: CSP's `'sha256-...'` is the base64-encoded sha256 of the script element's text. */
function sha256Base64(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64");
}

function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();
}

const INLINE_A = 'document.documentElement.classList.add("dark");';
const INLINE_B = 'document.documentElement.setAttribute("data-accent", "teal");';

function htmlWith(...scripts: string[]): string {
  const tags = scripts.map((s) => `<script>${s}</script>`).join("\n");
  return `<!doctype html><html><head>${tags}</head><body><div id="root"></div></body></html>`;
}

describe("securityHeaders (issue #101)", () => {
  it("script-src hash is derived from **the current HTML** - changing an inline script changes the hash", () => {
    const cspA = securityHeaders(htmlWith(INLINE_A))["content-security-policy"]!;
    const cspB = securityHeaders(htmlWith(INLINE_B))["content-security-policy"]!;

    expect(directive(cspA, "script-src")).toContain(`'sha256-${sha256Base64(INLINE_A)}'`);
    expect(directive(cspB, "script-src")).toContain(`'sha256-${sha256Base64(INLINE_B)}'`);
    // The same script's hash must not appear in the other policy: that would mean the hash is a hard-coded constant,
    // the failure shape of "index.html changed but the hash did not -> white flash on first paint".
    expect(directive(cspB, "script-src")).not.toContain(sha256Base64(INLINE_A));
  });

  it("external scripts do not count - only inline scripts that will execute go into the hash list", () => {
    const html = `<!doctype html><head><script type="module" src="/assets/main.js"></script>${
      `<script>${INLINE_A}</script>`
    }</head>`;
    const scriptSrc = directive(securityHeaders(html)["content-security-policy"]!, "script-src")!;

    expect(scriptSrc).toContain(`'sha256-${sha256Base64(INLINE_A)}'`);
    // An external chunk is covered by `'self'`; hashing its **path string** would add a hash that is never used (harmless but misleading)
    // and, worse, suggest the wrong mental model that scripts with src need hashing too.
    expect(scriptSrc.match(/sha256-/g) ?? []).toHaveLength(1);
  });

  it("a CRLF inline script is hashed on its **LF-normalised** content (the HTML parser normalises newlines first)", () => {
    // A Windows checkout of `index.html` has CRLF, and the hash of the raw string differs from the browser's: the HTML parsing spec
    // normalises CR/CRLF to LF before tokenising, so the script element's textContent has LF only. Without normalising, the anti-flash
    // script is blocked every time (white flash on every page open in dark mode) while every server-side test stays green.
    const lf = 'var a = 1;\nvar b = 2;\n';
    const expected = `'sha256-${sha256Base64(lf)}'`;

    for (const [label, source] of [
      ["CRLF", 'var a = 1;\r\nvar b = 2;\r\n'],
      ["單獨 CR（舊 Mac 行尾）", 'var a = 1;\rvar b = 2;\r'],
      ["LF", lf],
    ] as const) {
      const csp = securityHeaders(htmlWith(source))["content-security-policy"]!;
      expect(directive(csp, "script-src"), `${label} 的 hash 與 LF 版不一致`).toContain(expected);
    }
  });

  it("the policy is pinned directive by directive: what should be tight stays tight, **and what should be loose may not be tightened**", () => {
    const csp = securityHeaders(htmlWith(INLINE_A))["content-security-policy"]!;

    // The tightened half: the main XSS line and old attack surface.
    expect(directive(csp, "default-src")).toBe("'self'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "form-action")).toBe("'self'");
    // The collab WebSocket is same-origin (`collabUrl()` derives from window.location), so `'self'` covers it.
    expect(directive(csp, "connect-src")).toBe("'self'");
    expect(directive(csp, "font-src")).toBe("'self' data:");

    // script-src must not contain `'unsafe-inline'`/`'unsafe-eval'`: with a hash they are unnecessary, and adding one defeats the whole directive
    // (with a hash browsers ignore `'unsafe-inline'` but not `'unsafe-eval'`, and both are the most common loosening "to make something work").
    expect(directive(csp, "script-src")).not.toContain("unsafe-");

    // style-src's `'unsafe-inline'` cannot be avoided: shiki token colours, mermaid's SVG output and BlockNote floating layers all inject inline styles.
    // External stylesheets are at least blocked.
    expect(directive(csp, "style-src")).toBe("'self' 'unsafe-inline'");

    // The loosened half (#101): tightening would silently turn shipped features into broken images.
    // img: external images are embedded by URL (the image block's Embed tab, dragging an image from a web page, mermaid's
    // `A@{ img: ... }`). media: audio/video blocks can embed external URLs; uploads are same-origin and need no blob:/data: (no previews from object URLs).
    // **http: must stay**: `isSafeMediaUrl` in `packages/shared/src/note-schema-config.ts` lets both http and https through, and the `docs/self-hosting.md` topology (a)
    // is a plain-http trusted-LAN deployment. With only https:, `http://intranet/logo.png` in a LAN self-hoster's existing notes would
    // silently become a broken image (https deployments already block these as mixed content, so only http deployments are affected).
    expect(directive(csp, "img-src")).toBe("'self' data: blob: http: https:");
    expect(directive(csp, "media-src")).toBe("'self' http: https:");
    expect(directive(csp, "media-src")).not.toMatch(/blob:|data:/);
    // The file preview frames this site's own PDFs: frames fall back to default-src 'self', so neither may be set.
    expect(directive(csp, "frame-src")).toBeUndefined();
    expect(directive(csp, "child-src")).toBeUndefined();
  });

  it("the other two headers sent with it: nosniff and no-referrer (the latter lets external images load without leaking which note is being viewed)", () => {
    const headers = securityHeaders(htmlWith(INLINE_A));

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });
});
