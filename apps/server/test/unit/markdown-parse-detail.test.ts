import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { syntaxCheckRoot } from "@knotebook/shared";
import { DROPPED_SELECTOR, DROPPED_TAGS, hasDroppedElement, parseMarkdownForNote } from "../../src/notes/editing/markdown.js";

/** 探索測試 E：`parseMarkdownForNote` 的失敗成因（`detail`），與「會被丟掉的元素不論在哪都整筆拒絕」（審查裁示）。 */
const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
async function parse(md: string) {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    return parseMarkdownForNote(s.editor, md, [], "http://localhost");
  } finally {
    s.close();
  }
}
const DROPPED = { error: "unsupported_block", detail: "dropped_element" };

describe("parse 失敗成因", () => {
  it("事件屬性 → unsupported_block／event_attr；編輯器內部 HTML → editor_internal", async () => {
    expect(await parse("<img src=x onerror=alert(1)>")).toEqual({ error: "unsupported_block", detail: "event_attr" });
    expect(await parse('<div data-content-type="paragraph">x</div>')).toEqual({ error: "unsupported_block", detail: "editor_internal" });
  });
  it("<script>／<style>／<iframe>／<object>／<noscript>／<title>／<template>：整篇只有它們 → dropped_element（不是 empty_content）", async () => {
    for (const md of ["<script>alert(1)</script>", "<style>p{}</style>", '<iframe src="https://x"></iframe>', '<object data="x"></object>', "<noscript>hello</noscript>", "<title>hello</title>", "<template>hello</template>"]) expect(await parse(md), md).toEqual(DROPPED);
  });
  it("混在其他內容裡、行內、清單或並排欄裡也整筆拒絕（不靜默拿掉，連同裡面的字）", async () => {
    const cases = [
      "para\n\n<script>alert(1)</script>",
      "<style>p{}</style>\n\npara",
      'text <iframe src="https://x"></iframe> more',
      "- item <script>x</script>",
      "para <noscript>hello</noscript>",
      "para <title>hello</title>",
      "> quote <template>hello</template>",
      '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\na <object data="x"></object>\n\n</div>\n<div data-kb-column style="flex:1">\n\nb\n\n</div>\n</div>\n',
    ];
    for (const md of cases) expect(await parse(md), md).toEqual(DROPPED);
  });
  it("HTML 註解裡、code 裡的 <script> 不算；<embed> 會 parse 成 file block、不拒絕", async () => {
    expect(await parse("<!-- <script>x</script> -->")).toEqual({ error: "empty_content" }); // R5
    for (const md of ["para <!-- <script>x</script> -->", "`<script>x</script>`", "```html\n<script>x</script>\n```"]) expect("error" in (await parse(md)), md).toBe(false);
    // 這個 parser 不認 `\<` 跳脫：`\<script>` 照樣是元素（以前悄悄丟掉、留下反斜線），現在整筆拒絕
    expect(await parse("\\<script>x")).toEqual(DROPPED);
    const embed = await parse('<embed src="https://example.com/a.pdf">');
    expect("error" in embed).toBe(false);
    if (!("error" in embed)) expect(embed.blocks.map(b => b.type)).toEqual(["file"]);
  });
  it("未閉合 <!-- 吞掉一切 → empty_content／unclosed_comment（吞進去的 <script> 不算）；真的空 → empty_content 無 detail", async () => {
    expect(await parse("<!-- open")).toEqual({ error: "empty_content", detail: "unclosed_comment" });
    expect(await parse("<!-- open <script>x</script>")).toEqual({ error: "empty_content", detail: "unclosed_comment" });
    expect(await parse("   ")).toEqual({ error: "empty_content" });
  });
});

describe("字串預篩不改變結果（審查 F6）", () => {
  // 預篩只是捷徑：每一形都拿「直接建 DOM 查 DROPPED_SELECTOR」對照，兩者必須相同
  const inputs = [
    "<p><script>x</script></p>", "<p><SCRIPT>x</SCRIPT></p>", "<p><ScRiPt src=x></p>", "<p><Title>t</Title></p>", "<TEMPLATE>t</TEMPLATE>", "<p><NoScript>n</NoScript></p>",
    "<p><svg><script>x</script></svg></p>", "<p><svg><style>x</style></svg></p>", "<p><svg><title>x</title></svg></p>", "<p><math><style>x</style></math></p>",
    "<p><code>&lt;script&gt;x&lt;/script&gt;</code></p>", "<pre><code>&lt;style&gt;&lt;/style&gt;</code></pre>", "<p>&amp;lt;script&amp;gt;</p>",
    "<p><script-x>hi</script-x></p>", "<p><scripted>hi</scripted></p>", "<p><x-title>hi</x-title></p>", "<!-- <script>x</script> --><p>a</p>", "<p>text &lt;script</p>",
    "<p>plain</p>", "",
  ];
  it("預篩後的判斷與直接查 DOM 逐形相同；大小寫、SVG／MathML 裡的元素命中；行內 code、code block、跳脫字、註解、自訂元素不命中", () => {
    const direct = (html: string) => syntaxCheckRoot(html).querySelector(DROPPED_SELECTOR) !== null;
    for (const html of inputs) expect(hasDroppedElement(html), html).toBe(direct(html));
    expect(inputs.filter(hasDroppedElement)).toEqual(inputs.slice(0, 10));
  });
  it("清單只有一份：selector 涵蓋 DROPPED_TAGS 全部", () => {
    expect(DROPPED_SELECTOR.split(", ")).toEqual([...DROPPED_TAGS]);
    for (const t of DROPPED_TAGS) expect(hasDroppedElement(`<p>a <${t}>b</${t}></p>`), t).toBe(true);
  });
});
