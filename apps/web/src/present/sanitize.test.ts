import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeSlideFragment } from "./sanitize";

function clean(html: string): HTMLDivElement {
  const host = document.createElement("div");
  host.append(sanitizeSlideFragment(html));
  return host;
}

describe("sanitizeSlideFragment: dangerous content", () => {
  it.each([
    ["<script>alert(1)</script><p>x</p>", "script"],
    ['<img src="https://e/x.png" onerror="alert(1)">', "[onerror]"],
    ["<svg><script>alert(1)</script></svg>", "svg"],
    ['<iframe src="https://e"></iframe>', "iframe"],
    ['<embed src="https://e/x">', "embed"],
    ["<template><script>alert(1)</script></template>", "template"],
    ['<p style="color:red">x</p>', "[style]"],
    ['<p class="fragment r-fit-text">x</p>', "[class]"],
    ['<p id="x">x</p>', "[id]"],
    ['<p data-id="x">x</p>', "[data-id]"],
    ['<a href="https://e" data-preview-link>x</a>', "[data-preview-link]"],
    ['<section data-src="https://e">x</section>', "[data-src]"],
    ['<p data-background-iframe="https://e">x</p>', "[data-background-iframe]"],
    ['<img src="https://e/x.png" srcset="https://e/y.png 2x">', "[srcset]"],
    ['<button formaction="https://e">x</button>', "[formaction]"],
    ['<span aria-label="x">x</span>', "[aria-label]"],
    ['<p data-foo="1">x</p>', "[data-foo]"],
  ])("%s -> no %s", (html, selector) => {
    expect(clean(html).querySelector(selector)).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ])("href of a[href=%j] is removed", (href) => {
    const a = clean(`<a href="${href.replace(/"/g, "&quot;")}">x</a>`).querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.hasAttribute("href")).toBe(false);
  });

  it.each([
    "data:image/png;base64,AAA",
    "DaTa:image/png;base64,AAA",
    " data:image/png;base64,AAA",
    "data:image/svg+xml,<svg onload=alert(1)>",
    "mailto:x@example.com",
    "ma\tilto:x@example.com", // C0 (tab) inside the scheme: browsers strip it when parsing URLs, so the removal check must strip it too (not just trim the ends)
  ])("src of img[src=%j] is removed (lowercase data: is load-bearing: DOMPurify's DATA_URI_TAGS allows it)", (src) => {
    const img = clean(`<img src="${src.replace(/"/g, "&quot;")}" alt="a">`).querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.hasAttribute("src")).toBe(false);
  });

  it("data: and mailto: src on video / audio are also removed", () => {
    const host = clean('<video src="data:video/mp4;base64,AAA"></video><audio src="mailto:x@y"></audio>');
    expect(host.querySelector("video")!.hasAttribute("src")).toBe(false);
    expect(host.querySelector("audio")!.hasAttribute("src")).toBe(false);
  });

  it("href is allowed only on a (hook)", () => {
    expect(clean('<span href="https://e">x</span>').querySelector("span")!.hasAttribute("href")).toBe(false);
  });

  it("input: type=text and no-type are removed; checkbox is kept and checked stays (the element hook runs before the attribute hook)", () => {
    const host = clean('<input type="text"><input><input type="checkbox" checked><input type=" CheckBox ">');
    const inputs = host.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute("type")).toBe("checkbox");
    expect(inputs[0].hasAttribute("checked")).toBe(true);
  });

  it("<button>x</button> keeps only the text x (KEEP_CONTENT); <svg><text>y</text></svg> loses even the text (FORBID_CONTENTS)", () => {
    const host = clean("<button>x</button><svg><text>y</text></svg>");
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toBe("x");
  });
});

describe("sanitizeSlideFragment: what is kept", () => {
  it('data-snapshot-title="Meeting: notes" keeps its value (ADD_URI_SAFE_ATTR)', () => {
    const span = clean('<span data-inline-content-type="wikilink" data-target-note-id="n1" data-snapshot-title="Meeting: notes">x</span>').querySelector("span")!;
    expect(span.getAttribute("data-snapshot-title")).toBe("Meeting: notes");
    expect(span.getAttribute("data-target-note-id")).toBe("n1");
    expect(span.getAttribute("data-inline-content-type")).toBe("wikilink");
  });

  it("#269: wikilink's data-label / data-anchor-block-id are allowlisted, values unchanged (including the colon)", () => {
    const span = clean('<span data-inline-content-type="wikilink" data-target-note-id="n1" data-label="Re: plan" data-anchor-block-id="b1">x</span>').querySelector("span")!;
    expect(span.getAttribute("data-label")).toBe("Re: plan");
    expect(span.getAttribute("data-anchor-block-id")).toBe("b1");
  });

  it("data-kn-math is kept on a div while an event handler on it is dropped", () => {
    const host = clean('<div data-kn-math="" onclick="x()">x</div>');
    const div = host.querySelector("div")!;
    expect(div.hasAttribute("data-kn-math")).toBe(true);
    expect(div.hasAttribute("onclick")).toBe(false);
  });

  it("data-kn-media, data-kn-mermaid, data-kn-code-lang, color and alignment attributes are kept; style on code/span stays stripped", () => {
    const host = clean(
      '<a href="/api/uploads/a" data-kn-media="">f</a><div data-kn-mermaid="">graph TD</div>' +
        '<pre><code data-kn-code-lang="typescript" data-language="typescript" style="color:red"><span style="color:blue">x</span></code></pre>' +
        '<p data-text-color="red" data-background-color="blue" data-text-alignment="center">x<span data-style-type="textColor" data-value="red">y</span></p>',
    );
    expect(host.querySelector("a")!.hasAttribute("data-kn-media")).toBe(true);
    expect(host.querySelector("div")!.hasAttribute("data-kn-mermaid")).toBe(true);
    const code = host.querySelector("pre > code")!;
    expect(code.getAttribute("data-kn-code-lang")).toBe("typescript");
    expect(code.hasAttribute("data-language")).toBe(false);
    expect(host.querySelector("[style]")).toBeNull();
    const p = host.querySelector("p")!;
    expect(p.getAttribute("data-text-color")).toBe("red");
    expect(p.getAttribute("data-background-color")).toBe("blue");
    expect(p.getAttribute("data-text-alignment")).toBe("center");
    expect(host.querySelector("p > span")!.getAttribute("data-value")).toBe("red");
  });

  it("custom color codes (#rrggbb) in data-text-color / data-style-type / data-value keep their original values, style is still stripped", () => {
    const host = clean(
      '<p data-text-color="#ff6600" style="color:#ff6600">a <span data-style-type="textColor" data-value="#ff6600" style="color: rgb(255, 102, 0)">x</span></p>',
    );
    const p = host.querySelector("p")!;
    const span = host.querySelector("span")!;
    expect(p.getAttribute("data-text-color")).toBe("#ff6600");
    expect(span.getAttribute("data-style-type")).toBe("textColor");
    expect(span.getAttribute("data-value")).toBe("#ff6600");
    expect(host.querySelector("[style]")).toBeNull();
  });

  it("href of http(s), mailto and relative URLs is kept; https src is kept", () => {
    const host = clean('<a href="https://e/x">1</a><a href="mailto:a@b">2</a><a href="/n/a/b">3</a><img src="https://e/i.png" alt="i">');
    expect(Array.from(host.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://e/x", "mailto:a@b", "/n/a/b"]);
    expect(host.querySelector("img")!.getAttribute("src")).toBe("https://e/i.png");
  });

  it("structure of tables, lists, details and code is kept", () => {
    const host = clean('<table><tbody><tr><td colspan="2">c</td></tr></tbody></table><ol start="3"><li>x</li></ol><details open><summary>s</summary></details><pre><code>c</code></pre>');
    expect(host.querySelector("td")!.getAttribute("colspan")).toBe("2");
    expect(host.querySelector("ol")!.getAttribute("start")).toBe("3");
    expect(host.querySelector("details")!.hasAttribute("open")).toBe(true);
    expect(host.querySelector("pre > code")).not.toBeNull();
  });

  it("also accepts a <template>'s DocumentFragment (the call shape in render.ts)", () => {
    const template = document.createElement("template");
    template.innerHTML = '<p onclick="x()">t</p>';
    const host = document.createElement("div");
    host.append(sanitizeSlideFragment(template.content));
    expect(host.innerHTML).toBe("<p>t</p>");
  });
});

describe("sanitizeSlideFragment: column rows and columns", () => {
  const ROW = '<div data-kb-columns="" style="display:flex;gap:16px"><div data-kb-column="" style="flex:1.5"><p>A</p></div><div data-kb-column="" style="flex:1"><p>B</p></div></div>';

  it("canonical row and column: style and data-kb-* of all three divs are kept", () => {
    const row = clean(ROW).querySelector("[data-kb-columns]")!;
    expect(row.getAttribute("style")).toBe("display:flex;gap:16px");
    expect(Array.from(row.querySelectorAll(":scope > [data-kb-column]")).map((col) => col.getAttribute("style"))).toEqual(["flex:1.5", "flex:1"]);
  });

  it.each(["display:flex; gap:16px", "display:flex;gap:16px;color:red"])("row style isn't canonical (%j) -> style stripped, data-kb-columns kept", (style) => {
    const row = clean(`<div data-kb-columns="" style="${style}"><div data-kb-column="" style="flex:1"><p>A</p></div></div>`).querySelector("div")!;
    expect(row.hasAttribute("data-kb-columns")).toBe(true);
    expect(row.hasAttribute("style")).toBe(false);
  });

  it.each(["flex:20", "flex:1 1 0", "flex:1.234", "flex:0.05", "flex:0"])("column style isn't canonical (%j) -> stripped", (style) => {
    const col = clean(`<div data-kb-columns="" style="display:flex;gap:16px"><div data-kb-column="" style="${style}"><p>A</p></div></div>`).querySelector("[data-kb-column]")!;
    expect(col.hasAttribute("data-kb-column")).toBe(true);
    expect(col.hasAttribute("style")).toBe(false);
  });

  it.each(['<p style="color:red">x</p>', '<span style="flex:1">x</span>', '<p data-kb-columns="" style="display:flex;gap:16px">x</p>', '<span data-kb-column="" style="flex:1">x</span>'])("style on other elements is stripped as before (%s)", (html) => {
    expect(clean(html).querySelector("[style]")).toBeNull();
  });

  it("a div without data-kb-columns / data-kb-column carrying a canonical style -> stripped", () => {
    expect(clean('<div style="display:flex;gap:16px"><p>x</p></div><div style="flex:1"><p>y</p></div>').querySelector("[style]")).toBeNull();
  });
});

describe("source guard", () => {
  it("present/sanitize.ts doesn't touch the DOMPurify default singleton's addHook / setConfig / sanitize", () => {
    const source = readFileSync(`${process.cwd()}/src/present/sanitize.ts`, "utf8")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(source).not.toMatch(/DOMPurify\.(addHook|setConfig|sanitize)\b/);
    expect(source).toMatch(/DOMPurify\(window\)/);
  });
});
