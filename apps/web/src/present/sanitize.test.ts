import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sanitizeSlideFragment } from "./sanitize";

function clean(html: string): HTMLDivElement {
  const host = document.createElement("div");
  host.append(sanitizeSlideFragment(html));
  return host;
}

describe("sanitizeSlideFragment：危險內容（spec §13.1）", () => {
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
  ])("%s → 不存在 %s", (html, selector) => {
    expect(clean(html).querySelector(selector)).toBeNull();
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    '\u0001javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
  ])("a[href=%j] 的 href 被刪", (href) => {
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
  ])("img[src=%j] 的 src 被刪（小寫 data: 承重：DOMPurify 的 DATA_URI_TAGS 放行它，§2.13-3／-8）", (src) => {
    const img = clean(`<img src="${src.replace(/"/g, "&quot;")}" alt="a">`).querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.hasAttribute("src")).toBe(false);
  });

  it("video／audio 的 data: 與 mailto: src 也被刪", () => {
    const host = clean('<video src="data:video/mp4;base64,AAA"></video><audio src="mailto:x@y"></audio>');
    expect(host.querySelector("video")!.hasAttribute("src")).toBe(false);
    expect(host.querySelector("audio")!.hasAttribute("src")).toBe(false);
  });

  it("href 只准在 a 上（§5.4-3 hook）", () => {
    expect(clean('<span href="https://e">x</span>').querySelector("span")!.hasAttribute("href")).toBe(false);
  });

  it("input：type=text、沒有 type 的都刪；checkbox 保留且 checked 仍在（元素 hook 先於屬性 hook，§2.13-6）", () => {
    const host = clean('<input type="text"><input><input type="checkbox" checked><input type=" CheckBox ">');
    const inputs = host.querySelectorAll("input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].getAttribute("type")).toBe("checkbox");
    expect(inputs[0].hasAttribute("checked")).toBe(true);
  });

  it("<button>x</button> 只剩文字 x（KEEP_CONTENT）；<svg><text>y</text></svg> 連文字刪（FORBID_CONTENTS）", () => {
    const host = clean("<button>x</button><svg><text>y</text></svg>");
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toBe("x");
  });
});

describe("sanitizeSlideFragment：要留下的（spec §13.1）", () => {
  it('data-snapshot-title="Meeting: notes" 保留原值（ADD_URI_SAFE_ATTR，§2.13-2）', () => {
    const span = clean('<span data-inline-content-type="wikilink" data-target-note-id="n1" data-snapshot-title="Meeting: notes">x</span>').querySelector("span")!;
    expect(span.getAttribute("data-snapshot-title")).toBe("Meeting: notes");
    expect(span.getAttribute("data-target-note-id")).toBe("n1");
    expect(span.getAttribute("data-inline-content-type")).toBe("wikilink");
  });

  it("data-kn-media、data-kn-mermaid、顏色與對齊屬性保留", () => {
    const host = clean(
      '<a href="/api/uploads/a" data-kn-media="">f</a><div data-kn-mermaid="">graph TD</div>' +
        '<p data-text-color="red" data-background-color="blue" data-text-alignment="center">x<span data-style-type="textColor" data-value="red">y</span></p>',
    );
    expect(host.querySelector("a")!.hasAttribute("data-kn-media")).toBe(true);
    expect(host.querySelector("div")!.hasAttribute("data-kn-mermaid")).toBe(true);
    const p = host.querySelector("p")!;
    expect(p.getAttribute("data-text-color")).toBe("red");
    expect(p.getAttribute("data-background-color")).toBe("blue");
    expect(p.getAttribute("data-text-alignment")).toBe("center");
    expect(host.querySelector("span")!.getAttribute("data-value")).toBe("red");
  });

  it("http(s)、mailto、相對網址的 href 保留；https src 保留", () => {
    const host = clean('<a href="https://e/x">1</a><a href="mailto:a@b">2</a><a href="/n/a/b">3</a><img src="https://e/i.png" alt="i">');
    expect(Array.from(host.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://e/x", "mailto:a@b", "/n/a/b"]);
    expect(host.querySelector("img")!.getAttribute("src")).toBe("https://e/i.png");
  });

  it("表格、清單、details、code 的結構保留", () => {
    const host = clean('<table><tbody><tr><td colspan="2">c</td></tr></tbody></table><ol start="3"><li>x</li></ol><details open><summary>s</summary></details><pre><code>c</code></pre>');
    expect(host.querySelector("td")!.getAttribute("colspan")).toBe("2");
    expect(host.querySelector("ol")!.getAttribute("start")).toBe("3");
    expect(host.querySelector("details")!.hasAttribute("open")).toBe(true);
    expect(host.querySelector("pre > code")).not.toBeNull();
  });

  it("也吃 <template> 的 DocumentFragment（render.ts 的呼叫形）", () => {
    const template = document.createElement("template");
    template.innerHTML = '<p onclick="x()">t</p>';
    const host = document.createElement("div");
    host.append(sanitizeSlideFragment(template.content));
    expect(host.innerHTML).toBe("<p>t</p>");
  });
});

describe("源碼守衛（spec §5.4-3 末段）", () => {
  it("present/sanitize.ts 不碰 DOMPurify 預設單例的 addHook／setConfig／sanitize", () => {
    const source = readFileSync(`${process.cwd()}/src/present/sanitize.ts`, "utf8")
      .split(/\r?\n/)
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    expect(source).not.toMatch(/DOMPurify\.(addHook|setConfig|sanitize)\b/);
    expect(source).toMatch(/DOMPurify\(window\)/);
  });
});
