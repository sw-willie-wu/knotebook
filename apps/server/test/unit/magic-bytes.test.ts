import { describe, it, expect } from "vitest";
import { detectImageMimeType, detectRasterImageMimeType } from "../../src/uploads/magic-bytes.js";
import { validateSvgXml } from "../../src/uploads/svg.js";
import { echoablePrefix, undeclaredPrefixMessage } from "../../src/routes/uploads.js";

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF87A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61, 0x01, 0x00]);
const GIF89A_BYTES = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_BYTES = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("detectImageMimeType (magic bytes)", () => {
  it("PNG signature -> image/png", () => {
    expect(detectImageMimeType(PNG_BYTES)).toBe("image/png");
  });

  it("JPEG signature -> image/jpeg", () => {
    expect(detectImageMimeType(JPEG_BYTES)).toBe("image/jpeg");
  });

  it("GIF87a signature -> image/gif", () => {
    expect(detectImageMimeType(GIF87A_BYTES)).toBe("image/gif");
  });

  it("GIF89a signature -> image/gif", () => {
    expect(detectImageMimeType(GIF89A_BYTES)).toBe("image/gif");
  });

  it("WEBP signature (RIFF + WEBP at offset 8) -> image/webp", () => {
    expect(detectImageMimeType(WEBP_BYTES)).toBe("image/webp");
  });

  it("disguise: plain text content, even if the caller claims an image extension/Content-Type -> null (only the bytes are trusted)", () => {
    const fakeImageClaim = { filename: "totally-a.png", contentType: "image/png" };
    const bytes = enc("<html>not an image at all</html>");
    expect(detectImageMimeType(bytes)).toBe(null);
    // fakeImageClaim above is documentation only: the function signature doesn't accept such metadata, which is exactly what this test
    // verifies: the detection result is independent of any external claim.
    void fakeImageClaim;
  });

  it("truncated header: only the first 3 bytes of the PNG signature -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x89, 0x50, 0x4e]))).toBe(null);
  });

  it("truncated header: only the RIFF prefix of WEBP, shorter than offset 8 + WEBP -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x00]))).toBe(null);
  });

  it("empty buffer -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([]))).toBe(null);
  });

  it("RIFF container that is not WEBP (e.g. AVI: offset 8 is AVI, not WEBP) -> null", () => {
    const aviLike = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0x00, 0x01, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20]);
    expect(detectImageMimeType(aviLike)).toBe(null);
  });

  it("GIF88a (version byte is '8', not a valid '7'/'9') -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x38, 0x61]))).toBe(null);
  });

  it("GIF89b (suffix byte is 'b', not a valid 'a') -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x62]))).toBe(null);
  });

  it("JPEG first 2 bytes match but the 3rd byte is not FF -> null", () => {
    expect(detectImageMimeType(Uint8Array.from([0xff, 0xd8, 0x00, 0x00]))).toBe(null);
  });
});

describe("detectImageMimeType (SVG XML content validation, #389)", () => {
  it.each([
    ["minimal self-closing", '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["single-quoted xmlns", "<svg xmlns='http://www.w3.org/2000/svg'><rect width='10' height='10'/></svg>"],
    ["viewBox-only without explicit width/height", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450"><rect width="800" height="450"/></svg>'],
    ["leading/trailing whitespace and comments", '  <!-- lead -->\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>\n<!-- tail --> '],
    ["xml declaration + DOCTYPE", '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10"/></svg>'],
    ["prefixed svg namespace", '<s:svg xmlns:s="http://www.w3.org/2000/svg"><s:rect width="1" height="1"/></s:svg>'],
    ["embedded style with @keyframes and child combinator >", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><style>@keyframes pulse { from { opacity: 0; } to { opacity: 1; } } svg > rect { animation: pulse 1s infinite; }</style><rect width="20" height="20"/></svg>'],
    ["CDATA inside style", '<svg xmlns="http://www.w3.org/2000/svg"><style><![CDATA[g > path { fill: #000; } /* a < b & c */]]></style></svg>'],
    ["predefined and numeric entity references", '<svg xmlns="http://www.w3.org/2000/svg"><text title="a &amp; b">1 &lt; 2 &#65; &#x42;</text></svg>'],
    ["active SVG elements (not stripped at upload; neutralized by <img> + CSP sandbox)", '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script><foreignObject width="10" height="10"><body xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="alert(1)"/></body></foreignObject><image href="https://evil.example/a.png"/></svg>'],
    ["DOCTYPE with internal entity declaration (accepted without expanding)", '<!DOCTYPE svg [<!ENTITY x "hello">]><svg xmlns="http://www.w3.org/2000/svg"><text>&x;</text></svg>'],
  ])("valid SVG (%s) -> image/svg+xml", (_label, xml) => {
    expect(detectImageMimeType(enc(xml))).toBe("image/svg+xml");
  });

  it("UTF-8 BOM before <?xml?> -> image/svg+xml", () => {
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf]);
    const body = enc('<?xml version="1.0" encoding="utf-8"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    const combined = new Uint8Array(bom.length + body.length);
    combined.set(bom, 0);
    combined.set(body, bom.length);
    expect(detectImageMimeType(combined)).toBe("image/svg+xml");
  });

  it.each([
    ["HTML root", "<html><body><svg/></body></html>"],
    ["script root", "<script>alert(1)</script>"],
    ["uppercase SVG root (XML is case-sensitive)", '<SVG xmlns="http://www.w3.org/2000/svg"/>'],
    ["missing xmlns (renders broken when served as image/svg+xml)", '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'],
    ["legacy Illustrator entity xmlns (entities are not expanded; rejected with 415)", '<!DOCTYPE svg [<!ENTITY ns_svg "http://www.w3.org/2000/svg">]><svg xmlns="&ns_svg;"><rect width="10" height="10"/></svg>'],
    ["wrong root namespace (XHTML)", '<svg xmlns="http://www.w3.org/1999/xhtml"/>'],
    ["prefixed svg without matching xmlns", '<s:svg xmlns:s="http://www.w3.org/1999/xhtml"/>'],
    ["prefixed svg with unbound prefix", "<s:svg/>"],
    ["unclosed child tag", '<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>'],
    ["mismatched end tag", '<svg xmlns="http://www.w3.org/2000/svg"><g></rect></svg>'],
    ["unclosed root", '<svg xmlns="http://www.w3.org/2000/svg"><rect/>'],
    ["unquoted attribute", '<svg xmlns="http://www.w3.org/2000/svg" width=10/>'],
    ["duplicate attribute", '<svg xmlns="http://www.w3.org/2000/svg" width="10" width="20"/>'],
    ["missing whitespace between attributes", '<svg xmlns="http://www.w3.org/2000/svg" width="10"height="20"/>'],
    ["bare ampersand in text", '<svg xmlns="http://www.w3.org/2000/svg">a & b</svg>'],
    ["undeclared entity", '<svg xmlns="http://www.w3.org/2000/svg">&unknown;</svg>'],
    ["NUL numeric char reference", '<svg xmlns="http://www.w3.org/2000/svg">&#0;</svg>'],
    ["double hyphen inside comment", '<svg xmlns="http://www.w3.org/2000/svg"><!-- bad -- comment --></svg>'],
    ["triple hyphen closing comment", '<svg xmlns="http://www.w3.org/2000/svg"><!-- bad ---></svg>'],
    ["unescaped ]]> in text", '<svg xmlns="http://www.w3.org/2000/svg">a ]]> b</svg>'],
    ["trailing text after root", '<svg xmlns="http://www.w3.org/2000/svg"/>trailing'],
    ["two root elements", '<svg xmlns="http://www.w3.org/2000/svg"/><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["XML declaration after whitespace", '  <?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["invalid XML declaration", '<?xml version="2.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ["NUL byte inside SVG", '<svg xmlns="http://www.w3.org/2000/svg">\x00</svg>'],
    ["plain text mentioning <svg>", 'not xml <svg xmlns="http://www.w3.org/2000/svg"></svg>'],
    ["unclosed CDATA", '<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[oops</svg>'],
  ])("invalid XML / non-SVG (%s) -> null", (_label, xml) => {
    expect(detectImageMimeType(enc(xml))).toBe(null);
  });

  it("invalid UTF-8 bytes -> null", () => {
    const prefix = enc('<svg xmlns="http://www.w3.org/2000/svg">');
    const suffix = enc("</svg>");
    const invalidUtf8 = new Uint8Array(prefix.length + 2 + suffix.length);
    invalidUtf8.set(prefix, 0);
    invalidUtf8.set([0xff, 0xfe], prefix.length);
    invalidUtf8.set(suffix, prefix.length + 2);
    expect(detectImageMimeType(invalidUtf8)).toBe(null);
  });

  it("validateSvgXml distinguishes missing_xmlns on well-formed SVG from malformed XML or wrong namespaces", () => {
    expect(validateSvgXml(enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toBe("valid");
    expect(validateSvgXml(enc('<svg viewBox="0 0 10 10"><rect/></svg>'))).toBe("missing_xmlns");
    expect(validateSvgXml(enc("<s:svg><s:rect/></s:svg>"))).toBe("missing_xmlns");
    expect(validateSvgXml(enc("<svg><rect></svg>"))).toBe("invalid");
    expect(validateSvgXml(enc('<svg xmlns="http://www.w3.org/1999/xhtml"/>'))).toBe("invalid");
  });

  describe("namespace prefix binding", () => {
    const NS = 'xmlns="http://www.w3.org/2000/svg"';
    const XLINK = 'xmlns:xlink="http://www.w3.org/1999/xlink"';
    const check = (xml: string) => {
      const detail: { prefix?: string } = {};
      return { result: validateSvgXml(enc(xml), detail), prefix: detail.prefix };
    };

    it.each([
      ["xlink declared on the root", `<svg ${NS} ${XLINK}><use xlink:href="#r"/></svg>`],
      ["xlink declared on the element itself", `<svg ${NS}><use ${XLINK} xlink:href="#r"/></svg>`],
      ["xlink declared on an ancestor", `<svg ${NS}><g ${XLINK}><g><use xlink:href="#r"/></g></g></svg>`],
      ["prefixed element declared on its own tag", `<svg ${NS}><x:a xmlns:x="urn:x"/></svg>`],
      ["xml:lang and xml:space need no declaration", `<svg ${NS} xml:lang="en"><text xml:space="preserve">a</text></svg>`],
    ])("bound prefix is valid (%s)", (_label, xml) => {
      expect(check(xml).result).toBe("valid");
    });

    it("unbound element prefix is refused and named", () => {
      expect(check(`<svg ${NS}><x:a/></svg>`)).toEqual({ result: "undeclared_prefix", prefix: "x" });
    });

    it("unbound attribute prefix is refused and named", () => {
      expect(check(`<svg ${NS}><use xlink:href="#r"/></svg>`)).toEqual({ result: "undeclared_prefix", prefix: "xlink" });
      expect(check(`<svg ${NS} xlink:title="t"/>`)).toEqual({ result: "undeclared_prefix", prefix: "xlink" });
    });

    it("a prefix declared on a sibling or a closed element does not leak", () => {
      expect(check(`<svg ${NS}><g ${XLINK}/><use xlink:href="#r"/></svg>`).result).toBe("undeclared_prefix");
      expect(check(`<svg ${NS}><g ${XLINK}><rect/></g><use xlink:href="#r"/></svg>`).result).toBe("undeclared_prefix");
    });

    it("malformed prefixed names and declarations are invalid", () => {
      expect(check(`<svg ${NS}><:a/></svg>`).result).toBe("invalid");
      expect(check(`<svg ${NS}><a:/></svg>`).result).toBe("invalid");
      expect(check(`<svg ${NS} xmlns:x=""/>`).result).toBe("invalid");
    });

    it("the reserved xmlns prefix on an element is invalid, not undeclared", () => {
      expect(check(`<svg ${NS}><xmlns:a/></svg>`).result).toBe("invalid");
    });

    it("missing root xmlns is still reported as missing_xmlns", () => {
      expect(check(`<svg><use xlink:href="#r"/></svg>`).result).toBe("missing_xmlns");
    });
  });

  it("large SVG parses in linear time (no quadratic DOM cost)", () => {
    const big = enc(`<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="1" height="1"/>'.repeat(50_000)}</svg>`);
    const start = performance.now();
    expect(detectImageMimeType(big)).toBe("image/svg+xml");
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("echoablePrefix (untrusted prefix echoed in the 415 message)", () => {
  it("caps a huge prefix and strips bidi/format characters", () => {
    const huge = echoablePrefix("a".repeat(5_000_000));
    expect(huge).toBe(`${"a".repeat(64)}…`);
    expect(echoablePrefix("x\u061Cy\u202Ez\u2066w\u2069")).toBe("xyzw");
    expect(echoablePrefix("xlink")).toBe("xlink");
  });

  it("a prefix with nothing visible left falls back to wording without the prefix", () => {
    expect(undeclaredPrefixMessage("\u200C\u061C")).toBe("SVG files must declare every namespace prefix they use.");
    expect(undeclaredPrefixMessage("xlink")).toContain('the prefix "xlink"');
  });
});

describe("detectRasterImageMimeType (raster-only callers: avatars and provider icons)", () => {
  it("accepts PNG, JPEG, GIF and WebP, and always rejects valid SVG", () => {
    expect(detectRasterImageMimeType(PNG_BYTES)).toBe("image/png");
    expect(detectRasterImageMimeType(JPEG_BYTES)).toBe("image/jpeg");
    expect(detectRasterImageMimeType(GIF89A_BYTES)).toBe("image/gif");
    expect(detectRasterImageMimeType(WEBP_BYTES)).toBe("image/webp");
    expect(detectRasterImageMimeType(enc('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toBe(null);
  });
});
