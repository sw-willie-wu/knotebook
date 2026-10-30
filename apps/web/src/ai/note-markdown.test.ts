// 站內 AI 送出的 markdown（spec §11.2 第 2 段、§11.6、§13.1）：與 server 讀路徑對同一份 blocks 逐位元組相同。
// golden 與 server `note-markdown-goldens.test.ts` 共用；輸入一律先過筆記頁 schema 的編輯器，拿 `ed.document` 去序列化（H7）。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { aiMarkdownOf } from "./note-markdown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組（repo 慣例）
type AnyPartial = PartialBlock<any, any, any>;
type GoldenCase = { id: string; roundTrip: string; blocks: AnyPartial[]; markdown: string };
// web 的 vitest 下 `import.meta.url` 不是 file: 網址，改從 apps/web 根目錄算（同 columns-css.guard.test.ts）。
const goldens = JSON.parse(readFileSync(`${process.cwd()}/../../packages/shared/test-fixtures/note-markdown-goldens.json`, "utf8")) as {
  cases: GoldenCase[];
};

const documentOf = (blocks: AnyPartial[]) => BlockNoteEditor.create({ schema: noteSchema, initialContent: blocks }).document;
const NOTE_ID = "11111111-1111-4111-8111-111111111111";

// W6 用：照 HTML 片段序列化演算法自己走 DOM、以瀏覽器的屬性跳脫（含 `<`／`>`）拼字串，不沿用產品碼的 regex。
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["style", "script", "xmp", "iframe", "noembed", "noframes", "plaintext", "noscript"]);
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/ /g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;");
function browserInnerHTML(node: Node): string {
  const kids = node instanceof HTMLTemplateElement ? node.content.childNodes : node.childNodes;
  let out = "";
  for (const n of Array.from(kids)) {
    if (n.nodeType === Node.TEXT_NODE) {
      const parent = (node as Element).localName;
      out += RAW_TEXT.has(parent) ? (n as Text).data : escText((n as Text).data);
    } else if (n.nodeType === Node.COMMENT_NODE) {
      out += `<!--${(n as Comment).data}-->`;
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      const el = n as Element;
      out += `<${el.localName}${Array.from(el.attributes).map((a) => ` ${a.name}="${escAttr(a.value)}"`).join("")}>`;
      if (!VOID.has(el.localName)) out += `${browserInnerHTML(el)}</${el.localName}>`;
    }
  }
  return out;
}

describe("aiMarkdownOf", () => {
  it("golden 不是空的（共用檔讀得到）", () => {
    expect(goldens.cases.length).toBeGreaterThan(20);
  });

  it.each(goldens.cases.map((c) => [c.id, c] as const))("W1 %s：與 server 讀出逐位元組相同", (_id, c) => {
    const md = aiMarkdownOf(documentOf(c.blocks), () => undefined);
    expect(md, `${c.id} 實際：${JSON.stringify(md)}`).toBe(c.markdown);
  });

  it("W2 跳脫一次：wikilink 的顯示文字只跳脫一次", () => {
    const blocks = documentOf([
      { type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: NOTE_ID, label: "[Draft]" } }] } as AnyPartial,
    ]);
    const md = aiMarkdownOf(blocks, () => undefined);
    expect(md).toContain(`[\\[Draft\\]](/notes/${NOTE_ID})`);
    expect(md).not.toContain("\\\\\\[");
  });

  it("W3 字色一併帶上（§11.6 附帶行為改變）", () => {
    const blocks = documentOf([
      { type: "paragraph", content: [{ type: "text", text: "red", styles: { textColor: "red" } }, { type: "text", text: " plain", styles: {} }] },
    ]);
    expect(aiMarkdownOf(blocks, () => undefined)).toContain('<span style="color:red">');
  });

  it("W4 單例可重用：同一份輸入連呼叫兩次結果相同", () => {
    const c = goldens.cases.find((x) => x.id === "G1-cols-spec")!;
    const blocks = documentOf(c.blocks);
    const first = aiMarkdownOf(blocks, () => undefined);
    expect(aiMarkdownOf(blocks, () => undefined)).toBe(first);
    expect(first).toBe(c.markdown);
  });

  it("W5 媒體網址守衛（issue #43）：javascript: 網址送出成 about:blank", () => {
    const blocks = documentOf([{ type: "image", props: { url: "javascript:alert(1)", name: "x", previewWidth: 300 } }]);
    const md = aiMarkdownOf(blocks, () => undefined);
    expect(md).not.toContain("javascript:");
    expect(md).toContain("about:blank");
  });

  it("W6 瀏覽器的屬性序列化（`<`／`>` 寫成 &lt;／&gt;，Chromium／Firefox／WebKit 實測）下全部 golden 仍相同", () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML")!;
    const original = (el: Element) => desc.get!.call(el) as string;
    Object.defineProperty(Element.prototype, "innerHTML", { ...desc, get(this: Element) { return browserInnerHTML(this); } });
    try {
      const probe = document.createElement("div");
      probe.innerHTML = '<img alt="<c>">';
      expect(probe.innerHTML).toBe('<img alt="&lt;c&gt;">'); // 模擬真的生效
      // 模擬器保真：屬性值沒有 `<`／`>` 時與 jsdom 逐字相同。
      probe.innerHTML = '<p data-x="a&quot;b&amp;">x &amp; "y"   &lt;z&gt;</p><table><tbody><tr><td colwidth="120,">a</td></tr></tbody></table><img src="/u"><br><pre><code>a\nb</code></pre><!--c--><style>a<b</style>';
      expect(browserInnerHTML(probe)).toBe(original(probe));
      for (const c of goldens.cases) expect(aiMarkdownOf(documentOf(c.blocks), () => undefined), c.id).toBe(c.markdown);
    } finally {
      Object.defineProperty(Element.prototype, "innerHTML", desc);
    }
  });

  it("titleOf：label 空的 wikilink 送出現行標題", () => {
    const blocks = documentOf([
      { type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: NOTE_ID, snapshotTitle: "Old" } }] } as AnyPartial,
    ]);
    expect(aiMarkdownOf(blocks, (id) => (id === NOTE_ID ? "Now" : undefined))).toBe(`[Now](/notes/${NOTE_ID})\n`);
  });
});
