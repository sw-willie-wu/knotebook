// #222：MCP／REST 讀寫筆記的文字色／底色。
// 寫入：解析後逐一檢查色值，收編輯器內建的 10 種色名與不透明色碼（色碼正規化成小寫 `#rrggbb`），其他整筆拒絕（`unsupported_color`）。
// 讀取：有顏色的頂層節點輸出成寫入端認得的 HTML，其餘維持 `blocksToMarkdownLossy` 原樣。
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { COLUMNS_OPEN_TAG, PALETTE_COLORS, blocksToNoteMarkdown, columnOpenTag, normalizeNoteColors } from "@knotebook/shared";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";
const notes = [{ id: "11111111-1111-4111-8111-111111111111", title: "A", slug: "a", groupId: null, ownerHandle: "alice" }];
type Ed = EditorSession["editor"];

// ⚠ 同 editing-markdown.test.ts：每一處 open 都 `try/finally close()`（lease 不變量）。
const withSession = async <T>(fn: (ed: Ed) => T, doc = new Y.Doc()): Promise<T> => {
  const s = await EditorSession.open(rt, doc);
  try {
    return fn(s.editor);
  } finally {
    s.close();
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
type AnyBlocks = any[];
/** 把 blocks 寫進一份新的 Y.Doc（經真編輯器正規化），回傳那份 doc。 */
const docWith = async (blocks: AnyBlocks): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  await withSession(ed => {
    ed.replaceBlocks(ed.document, blocks);
  }, doc);
  return doc;
};
/** 讀路徑匯出（等同 MCP read_note_section／REST /content 整篇形的 markdown）。 */
const readMd = async (doc: Y.Doc): Promise<string> => {
  const r = await readNoteContentFromDoc(rt, doc);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
};
/** 去掉 id 的 block JSON（比結構與顏色用）。 */
const shape = (blocks: unknown): string => JSON.stringify(blocks, (k, v) => (k === "id" ? undefined : v));
const parse = (ed: Ed, md: string) => {
  const r = parseMarkdownForNote(ed, md, notes, ORIGIN);
  if ("error" in r) throw new Error(r.error);
  return r.blocks;
};

describe("PALETTE_COLORS", () => {
  it("恰好是編輯器內建的 10 種色名", () => {
    expect([...PALETTE_COLORS]).toEqual(["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"]);
  });
});

describe("寫入：parseMarkdownForNote 只收內建色名與色碼", () => {
  it.each(PALETTE_COLORS.filter(c => c !== "default"))("%s：行內字色／底色、整段、表格儲存格都收", async c => {
    await withSession(ed => {
      const md =
        `a <span style="color:${c}">t</span> <span style="background-color:${c}">b</span>\n\n` +
        `<p data-background-color="${c}" data-text-color="${c}">para</p>\n\n` +
        `<table><tr><td data-background-color="${c}" data-text-color="${c}">cell</td></tr></table>`;
      const blocks = parse(ed, md);
      const json = shape(blocks);
      expect(json).toContain(`"textColor":"${c}"`);
      expect(json).toContain(`"backgroundColor":"${c}"`);
      expect(blocks.map(b => b.type)).toEqual(["paragraph", "paragraph", "table"]);
    });
  });

  // docs/ai-editing.md 的寫法表逐列：標題、清單項、引言、<th> 也吃同一組 data-*。
  it("標題／清單項／引言／<th> 上的 data-* 都成為 block／儲存格顏色", async () => {
    await withSession(ed => {
      const blocks = parse(
        ed,
        `<h3 data-text-color="red">h</h3>\n\n<ul><li data-background-color="blue">u</li></ul>\n\n<ol><li data-text-color="green">o</li></ol>\n\n` +
          `<blockquote data-text-color="pink">q</blockquote>\n\n<table><tr><th data-background-color="gray">t</th></tr><tr><td>d</td></tr></table>`
      );
      expect(blocks.map(b => [b.type, (b.props as Record<string, unknown>).textColor, (b.props as Record<string, unknown>).backgroundColor])).toEqual([
        ["heading", "red", "default"],
        ["bulletListItem", "default", "blue"],
        ["numberedListItem", "green", "default"],
        ["quote", "pink", "default"],
        ["table", "default", undefined],
      ]);
      expect(shape(blocks[4])).toContain(`"backgroundColor":"gray"`);
    });
  });

  // 同一張寫法表的色碼列：每種元素各一個 `#ff6600` 的 data-*（與上一案同組元素），收下後存成 "#ff6600"。
  it.each([
    ["p", `<p data-text-color="#ff6600">x</p>`, "paragraph", "textColor"],
    ["h3", `<h3 data-text-color="#ff6600">x</h3>`, "heading", "textColor"],
    ["ul > li", `<ul><li data-background-color="#ff6600">x</li></ul>`, "bulletListItem", "backgroundColor"],
    ["ol > li", `<ol><li data-text-color="#ff6600">x</li></ol>`, "numberedListItem", "textColor"],
    ["blockquote", `<blockquote data-text-color="#ff6600">x</blockquote>`, "quote", "textColor"],
  ])("寫法表的色碼列：%s 上的 data-* #ff6600 收成 \"#ff6600\"", async (_name, md, type, prop) => {
    await withSession(ed => {
      const blocks = parse(ed, md);
      expect(blocks[0]!.type).toBe(type);
      expect((blocks[0]!.props as Record<string, unknown>)[prop]).toBe("#ff6600");
    });
  });

  it.each([
    ["td", `<table><tr><td data-background-color="#ff6600">c</td></tr></table>`],
    ["th", `<table><tr><th data-background-color="#ff6600">t</th></tr><tr><td>d</td></tr></table>`],
  ])("寫法表的色碼列：表格 %s 上的 data-* #ff6600 收成 \"#ff6600\"", async (_name, md) => {
    await withSession(ed => {
      expect(shape(parse(ed, md))).toContain(`"backgroundColor":"#ff6600"`);
    });
  });

  it("default 也收（data-* 寫 default ＝ 沒有顏色）", async () => {
    await withSession(ed => {
      expect(() => parse(ed, `<p data-background-color="default" data-text-color="default">x</p>`)).not.toThrow();
    });
  });

  it("CSS 色名大小寫會被 DOM 正規化成小寫——`color:RED` 收成 red", async () => {
    await withSession(ed => {
      expect(shape(parse(ed, `<p><span style="color:RED">x</span></p>`))).toContain(`"textColor":"red"`);
    });
  });

  it.each([
    ["行內 #hex", `a <span style="color:#ff6600">x</span>`, `"textColor":"#ff6600"`],
    ["行內 rgb()", `a <span style="color:rgb(255, 0, 0)">x</span>`, `"textColor":"#ff0000"`],
    ["整段 style 底色 #hex", `<p style="background-color:#ffeeaa">x</p>`, `"backgroundColor":"#ffeeaa"`],
    ["表格儲存格 data-*（短形 #f00 正規化）", `<table><tr><td data-background-color="#f00">c</td></tr></table>`, `"backgroundColor":"#ff0000"`],
    ["表格儲存格內的行內色", `<table><tr><td><span style="color:rgb(1,2,3)">c</span></td></tr></table>`, `"textColor":"#010203"`],
    ["連結文字的行內色", `[<span style="color:#123456">x</span>](https://example.com)`, `"textColor":"#123456"`],
    ["巢狀清單深處", `- a\n  - b\n    - <span style="color:#abcdef">c</span>`, `"textColor":"#abcdef"`],
  ])("%s → 收下並正規化成小寫 #rrggbb", async (_name, md, expected) => {
    await withSession(ed => {
      expect(shape(parse(ed, md))).toContain(expected);
    });
  });

  it.each([
    ["行內 CSS 合法但不在色盤的名稱", `a <span style="background-color:chartreuse">x</span>`],
    ["整段 data-* 未知名稱", `<p data-text-color="crimson">x</p>`],
    ["整段 data-* 大小寫不符（data-* 不會被正規化）", `<p data-background-color="Red">x</p>`],
    ["行內 CSS 色名", `a <span style="color:tomato">x</span>`],
    ["整段 style 底色 transparent", `<p style="background-color:transparent">x</p>`],
    ["表格儲存格 data-* 色名", `<table><tr><td data-background-color="tomato">c</td></tr></table>`],
    ["表格儲存格內帶 alpha 的行內色", `<table><tr><td><span style="color:rgb(0 0 0 / 50%)">c</span></td></tr></table>`],
    ["連結文字的半透明色碼", `[<span style="color:#ff660080">x</span>](https://example.com)`],
    ["巢狀清單深處 var()", `- a\n  - b\n    - <span style="color:var(--x)">c</span>`],
  ])("%s → unsupported_color（整筆拒絕）", async (_name, md) => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });

  // docs/ai-editing.md「Colors」逐字宣稱：這兩種寫法被接受但顏色靜默丟失（上游 parser 不認）。
  // 哪天上游開始認它們，這一案會紅，文件那句就要改。
  it("行內 <span data-text-color> 與 <mark> 不是顏色：文字留下、顏色靜默丟失（不報錯）", async () => {
    await withSession(ed => {
      const json = shape(parse(ed, `a <span data-text-color="red">x</span> <mark>y</mark> <span data-background-color="blue">z</span>`));
      expect(json).toContain(`"content":[{"type":"text","text":"a x y z","styles":{}}]`);
      expect(json).not.toMatch(/"(textColor|backgroundColor)":"(?!default)/);
    });
  });

  it("一筆裡只要有一個壞色值就整筆拒絕（其餘合法也一樣）", async () => {
    await withSession(ed => {
      const md = `ok <span style="color:red">r</span>\n\n<p data-text-color="blue">b</p>\n\nbad <span style="color:#ff660080">x</span>`;
      expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });

  // parse → 正規化的端到端：style 形走 CSSOM 改寫、data-* 形是原字串，兩條都要落成小寫 #rrggbb 或整筆拒絕。
  it.each([
    ["#ff6600ff", "#ff6600"],
    ["rgba(1, 2, 3, 1)", "#010203"],
    ["hsla(0,100%,50%,1)", "#ff0000"],
    ["rgb(0 0 0 / 100%)", "#000000"],
    ["hwb(0 0% 0%)", "#ff0000"],
    ["#ff6600 !important", "#ff6600"],
    ["hsl(30, 50%, 33%)", "#7e542a"],
  ])("style 形 color:%s 收成 %s", async (input, stored) => {
    await withSession(ed => {
      expect(shape(parse(ed, `<p><span style="color:${input}">x</span></p>`))).toContain(`"textColor":"${stored}"`);
    });
  });

  it.each(["#ff660080", "rgb(0 0 0 / 50%)", "tomato", "oklch(0.7 0.1 30)", "color(srgb 1 0 0)"])("style 形 color:%s → unsupported_color", async input => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, `<p><span style="color:${input}">x</span></p>`, notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });

  it("data-* 形的短 hex、大寫 hex 收成小寫 #rrggbb", async () => {
    await withSession(ed => {
      expect(shape(parse(ed, `<p data-text-color="#F60">x</p>`))).toContain(`"textColor":"#ff6600"`);
      expect(shape(parse(ed, `<p data-background-color="#FFEEAA">x</p>`))).toContain(`"backgroundColor":"#ffeeaa"`);
    });
  });
});

describe("normalizeNoteColors：逐一走訪、不遞迴", () => {
  it("全合法回 null，不合法回該值", () => {
    expect(normalizeNoteColors([{ type: "paragraph", props: { textColor: "red" }, content: [{ type: "text", text: "x", styles: { backgroundColor: "blue" } }], children: [] }])).toBeNull();
    expect(normalizeNoteColors([{ type: "paragraph", props: {}, content: [{ type: "text", text: "x", styles: { textColor: "tomato" } }], children: [] }])).toBe("tomato");
  });

  it("合法的色碼就地變成小寫 #rrggbb", () => {
    const blocks = [{ type: "paragraph", props: {}, content: [{ type: "text", text: "x", styles: { textColor: "#fff" } }], children: [] }];
    expect(normalizeNoteColors(blocks)).toBeNull();
    expect(blocks[0]!.content[0]!.styles.textColor).toBe("#ffffff");
  });

  it("非字串色值（型別錯）也算不合法", () => {
    expect(normalizeNoteColors([{ type: "paragraph", props: { backgroundColor: 3 }, content: [], children: [] }])).toBe("3");
  });

  it("10 萬層巢狀不會爆堆疊，且找得到最深處的壞值", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 合成測資
    const root: any = { type: "paragraph", props: {}, content: [], children: [] };
    let cur = root;
    for (let i = 0; i < 100_000; i++) {
      const next = { type: "paragraph", props: {}, content: [], children: [] };
      cur.children.push(next);
      cur = next;
    }
    cur.content = [{ type: "text", text: "deep", styles: { textColor: "rgb(0, 0, 0)" } }];
    expect(normalizeNoteColors([root])).toBeNull();
    expect(cur.content[0].styles.textColor).toBe("#000000");
    cur.content[0].styles.textColor = "tomato";
    expect(normalizeNoteColors([root])).toBe("tomato");
  });

  it("表格：儲存格 props 與儲存格內的行內樣式都看", () => {
    const table = (cell: unknown) => [{ type: "table", props: { textColor: "default" }, content: { type: "tableContent", rows: [{ cells: [cell] }] }, children: [] }];
    expect(normalizeNoteColors(table({ type: "tableCell", props: { backgroundColor: "nope" }, content: [] }))).toBe("nope");
    expect(normalizeNoteColors(table({ type: "tableCell", props: {}, content: [{ type: "text", text: "c", styles: { textColor: "#1" } }] }))).toBe("#1");
    expect(normalizeNoteColors(table([{ type: "text", text: "c", styles: { backgroundColor: "tomato" } }]))).toBe("tomato"); // 舊形：cell 直接是 inline 陣列
    expect(normalizeNoteColors(table({ type: "tableCell", props: { backgroundColor: "red" }, content: [] }))).toBeNull();
  });

  it("並排：欄內段落的壞色值也找得到", () => {
    const row = (styles: Record<string, unknown>) => [{ type: "columnList", props: {}, content: undefined, children: [
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", props: {}, content: [{ type: "text", text: "a", styles: {} }], children: [] }] },
      { type: "column", props: { width: 1 }, children: [{ type: "paragraph", props: {}, content: [{ type: "text", text: "b", styles }], children: [] }] },
    ] }];
    expect(normalizeNoteColors(row({ textColor: "tomato" }))).toBe("tomato");
    expect(normalizeNoteColors(row({ textColor: "red" }))).toBeNull();
    const ok = row({ textColor: "#F00" });
    expect(normalizeNoteColors(ok)).toBeNull();
    expect(JSON.stringify(ok)).toContain(`"textColor":"#ff0000"`);
  });
});

describe("讀取：blocksToNoteMarkdown", () => {
  it("沒有任何顏色 → 與 blocksToMarkdownLossy 位元組相同", async () => {
    const doc = await docWith([
      { type: "heading", props: { level: 2 }, content: "T" },
      { type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, { type: "text", text: "b", styles: { bold: true } }] },
      { type: "bulletListItem", content: "x", children: [{ type: "bulletListItem", content: "y" }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["1", "2"] }] } },
      { type: "codeBlock", props: { language: "js" }, content: "a\n\nb" },
    ]);
    await withSession(ed => {
      expect(blocksToNoteMarkdown(ed, ed.document)).toBe(ed.blocksToMarkdownLossy(ed.document));
    }, doc);
  });

  it("行內字色 → markdown 段落裡的 <span style=\"color:NAME\">（段落本身維持 markdown）", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, { type: "text", text: "red", styles: { textColor: "red" } }, { type: "text", text: " b", styles: {} }] }]);
    expect(await readMd(doc)).toBe(`a <span style="color:red">red</span> b\n`);
  });

  it("行內字色＋底色 → 合併成同一個 span", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "red", backgroundColor: "yellow" } }] }]);
    expect(await readMd(doc)).toBe(`<span style="color:red;background-color:yellow">x</span>\n`);
  });

  it("只有底色 → <span style=\"background-color:NAME\">", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { backgroundColor: "green" } }] }]);
    expect(await readMd(doc)).toBe(`<span style="background-color:green">x</span>\n`);
  });

  it("整段顏色 → data-* 屬性（不帶 rgb 的 style）", async () => {
    const doc = await docWith([{ type: "paragraph", props: { textColor: "red", backgroundColor: "blue" }, content: "x" }]);
    expect(await readMd(doc)).toBe(`<p data-background-color="blue" data-text-color="red">x</p>\n`);
  });

  it("存成小寫 #rrggbb 的色碼讀出照原值（行內 span、整段 data-*、儲存格 data-*、字色＋底色合成）", async () => {
    const inline = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "#ff6600" } }] }]);
    expect(await readMd(inline)).toBe(`<span style="color:#ff6600">x</span>\n`);
    const block = await docWith([{ type: "paragraph", props: { textColor: "#ff6600" }, content: "x" }]);
    expect(await readMd(block)).toBe(`<p data-text-color="#ff6600">x</p>\n`);
    const cell = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: "a", props: { backgroundColor: "#ff6600" } }, "b"] }] } }]);
    expect(await readMd(cell)).toBe(`<table><tr><td data-background-color="#ff6600">a</td><td>b</td></tr></table>\n`);
    const both = await docWith([{ type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "#ff6600", backgroundColor: "#00ff00" } }] }]);
    expect(await readMd(both)).toBe(`<span style="color:#ff6600;background-color:#00ff00">x</span>\n`);
  });

  it("色碼讀出的 markdown 原樣 parse 回去，再讀一致、色碼不變", async () => {
    const doc = await docWith([
      { type: "paragraph", content: [{ type: "text", text: "a", styles: { textColor: "#ff6600", backgroundColor: "#00ff00" } }] },
      { type: "paragraph", props: { backgroundColor: "#123456" }, content: "b" },
      { type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: "c", props: { textColor: "#abcdef" } }, "d"] }] } },
    ]);
    const md1 = await readMd(doc);
    const blocks = await withSession(ed => parse(ed, md1));
    for (const c of ["#ff6600", "#00ff00", "#123456", "#abcdef"]) expect(shape(blocks)).toContain(`"${c}"`);
    expect(await readMd(await docWith(blocks))).toBe(md1);
  });

  it("混合：無色段落維持 markdown，有色段落是 HTML，之間空一行", async () => {
    const doc = await docWith([
      { type: "heading", props: { level: 1 }, content: "T" },
      { type: "paragraph", props: { backgroundColor: "yellow" }, content: "hi" },
      { type: "paragraph", content: [{ type: "text", text: "plain ", styles: {} }, { type: "text", text: "b", styles: { bold: true } }] },
    ]);
    expect(await readMd(doc)).toBe(`# T\n\n<p data-background-color="yellow">hi</p>\n\nplain **b**\n`);
  });

  it("表格：沒上色維持 GFM；任何一格上色 → HTML <table>，儲存格帶 data-*", async () => {
    const plain = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }] } }]);
    expect(await readMd(plain)).toContain("| ---");
    const colored = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: "a", props: { backgroundColor: "red" } }, "b"] }] } }]);
    const md = await readMd(colored);
    expect(md).not.toContain("| ---");
    expect(md).toMatch(/^<table>/);
    expect(md).toBe(`<table><tr><td data-background-color="red">a</td><td>b</td></tr></table>\n`); // 沒有 tbody／儲存格內 <p>／colspan=1 雜訊
  });

  it("不帶編輯器內部雜訊（class、rgb style、data-editable、target）", async () => {
    const doc = await docWith([
      { type: "bulletListItem", props: { textColor: "red" }, content: [{ type: "link", href: "https://e.com", content: [{ type: "text", text: "l", styles: { textColor: "blue" } }] }] },
    ]);
    const md = await readMd(doc);
    expect(md).not.toMatch(/class|rgb\(|data-editable|data-style-type|target=|classname/);
    expect(md).toContain(`<a href="https://e.com">`);
  });

  it("行內 span 裡的文字（<、&、emoji 代理對）原樣往返", async () => {
    const text = "a < b & c 😀";
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: { textColor: "red" } }] }]);
    const md = await readMd(doc);
    expect(md).toBe(`<span style="color:red">${text}</span>\n`);
    expect(shape(await withSession(ed => parse(ed, md)))).toContain(`"text":"${text}","styles":{"textColor":"red"}`);
  });

  it("跳脫：整段 HTML（block 顏色）裡的 <、& 用字元參照（HTML 區塊會解）", async () => {
    const doc = await docWith([{ type: "paragraph", props: { textColor: "red" }, content: "a<b&c" }]);
    const md = await readMd(doc);
    expect(md).toBe(`<p data-text-color="red">a&lt;b&amp;c</p>\n`);
    expect(shape(await withSession(ed => parse(ed, md)))).toContain(`"text":"a<b&c"`);
  });

  it("既有的非色盤色值（#222 之前寫進去的；編輯器本來就不顯示）讀出時當成沒有顏色，寫回不會被拒", async () => {
    const doc = await docWith([
      { type: "paragraph", props: { textColor: "#FF6600" }, content: [{ type: "text", text: "x", styles: { backgroundColor: "rgb(1, 2, 3)" } }] },
      { type: "paragraph", props: { backgroundColor: "chartreuse", textColor: "red" }, content: [{ type: "text", text: "y", styles: { textColor: "nope", backgroundColor: "blue" } }] },
    ]);
    const md = await readMd(doc);
    expect(md).toBe(`x\n\n<p data-text-color="red"><span style="background-color:blue">y</span></p>\n`);
    await withSession(ed => expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).not.toHaveProperty("error"));
  });

  it("檔案 block 的底色不帶出（它本來就被匯出成連結，HTML 也還原不回檔案 block）", async () => {
    const doc = await docWith([{ type: "file", props: { url: "http://localhost/api/uploads/x.pdf", backgroundColor: "red", name: "f" } }]);
    await withSession(ed => expect(blocksToNoteMarkdown(ed, ed.document)).toBe(ed.blocksToMarkdownLossy(ed.document)), doc);
  });

  it("行內顏色在清單項、標題、無色表格的儲存格裡都留在 markdown 裡", async () => {
    const doc = await docWith([
      { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "h ", styles: {} }, { type: "text", text: "red", styles: { textColor: "red" } }] },
      { type: "bulletListItem", content: "a" },
      { type: "bulletListItem", content: [{ type: "text", text: "b ", styles: {} }, { type: "text", text: "late", styles: { textColor: "red" } }] },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["x", { type: "tableCell", content: [{ type: "text", text: "hi", styles: { backgroundColor: "yellow" } }] }] }] } },
    ]);
    const md = await readMd(doc);
    expect(md).toContain(`## h <span style="color:red">red</span>\n`);
    expect(md).toContain(`* a\n* b <span style="color:red">late</span>\n`);
    expect(md).toMatch(/\| x +\| <span style="background-color:yellow">hi<\/span> *\|/);
    expect(md).not.toMatch(/<(p|ul|li|table|h2)[ >]/);
  });

  it("粗體／連結包住或混在有色文字旁：span 放在強調／連結外面，強調分隔符不會從內側貼著 span", async () => {
    const doc = await docWith([
      { type: "paragraph", content: [{ type: "text", text: "x ", styles: {} }, { type: "text", text: "a", styles: { bold: true } }, { type: "text", text: "b", styles: { bold: true, textColor: "red" } }, { type: "text", text: "c", styles: {} }, { type: "link", href: "https://e.com", content: [{ type: "text", text: "l", styles: { textColor: "blue" } }] }, { type: "text", text: " ", styles: {} }, { type: "text", text: "plain", styles: { bold: true } }] },
    ]);
    expect(await readMd(doc)).toBe(`x **a**<span style="color:red">**b**</span>c<span style="color:blue">[l](https://e.com)</span> **plain**\n`);
  });

  // ⚠ 行內顏色留在 markdown 裡的代價：span 裡的文字與沒上色的文字**同一套**轉換——BlockNote 的 HTML → markdown
  //   不跳脫看起來像 markdown／HTML 的字面文字（`**x**`、`<x>`），而它的 markdown 解析器只認一部分反斜線跳脫
  //   （`\*` 會解、`\<` 與 `\&` 不會）、不解字元參照（`&lt;` 原樣留成文字；實測）——所以沒有一種寫法能讓
  //   「字面上的 `<x>`」在 markdown 段落裡往返。這一案釘的是「與無色文字同一套」，不是「無損」。
  it("有色文字裡像 markdown 的字面文字，與同一段沒上色時的輸出相同（同一套 lossy 規則）", async () => {
    const text = "*no* [y](z) <x>";
    const colored = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: { textColor: "red" } }] }]);
    const plain = await docWith([{ type: "paragraph", content: text }]);
    expect(await readMd(colored)).toBe(`<span style="color:red">${(await readMd(plain)).trimEnd()}</span>\n`);
  });

  // docs/known-limitations.md 逐字宣稱：引用成字面文字的顏色標記讀出時不跳脫，所以寫回時 #hex 與色盤名都會變成真的顏色。
  it("字面文字裡的顏色標記讀出不跳脫——#hex 與色盤名寫回都變真顏色", async () => {
    const hexMd = await readMd(await docWith([{ type: "paragraph", content: `quote <span style="color:#ff0000">x</span>` }]));
    expect(hexMd).toBe(`quote <span style="color:#ff0000">x</span>\n`);
    expect(shape(await withSession(ed => parse(ed, hexMd)))).toContain('"textColor":"#ff0000"');
    const namedMd = await readMd(await docWith([{ type: "paragraph", content: `quote <span style="color:red">x</span>` }]));
    expect(shape(await withSession(ed => parse(ed, namedMd)))).toContain(`"textColor":"red"`);
  });

  it("文件裡已經有佔位字元（⸀／⸁）時退回整段 HTML，仍可往返", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "⸀0⸁ ", styles: {} }, { type: "text", text: "r", styles: { textColor: "red" } }] }]);
    const md = await readMd(doc);
    expect(md).toBe(`<p>⸀0⸁ <span style="color:red">r</span></p>\n`);
    const doc2 = await docWith(await withSession(ed => parse(ed, md)));
    expect(await readMd(doc2)).toBe(md);
  });

  it("I1：沒有文字的有色 block（空段落、空清單項）當成沒有顏色——讀出與 #222 之前位元組相同", async () => {
    const doc = await docWith([
      { type: "paragraph", content: "a" },
      { type: "paragraph", props: { backgroundColor: "red" } },
      { type: "bulletListItem", props: { backgroundColor: "blue" } },
      { type: "bulletListItem", content: "b" },
      { type: "paragraph", content: "c" },
    ]);
    const md1 = await readMd(doc);
    // #222 之前的輸出＝blocksToMarkdownLossy（空的有色 block 本來就讀不出顏色）。
    expect(md1).toBe(await withSession(ed => ed.blocksToMarkdownLossy(ed.document), doc));
    expect(md1).not.toContain("data-");
    // ⚠ 這份的往返本身不一致（空段落寫回被丟），但那是 #222 之前就有的 markdown 行為：無色的空段落一樣。
  });

  // #222：空儲存格與空段落不同——解析器保留 `<td data-background-color="red"></td>`，所以它的顏色要帶出。
  it("I2：空的有色表格儲存格保留顏色、往返一致", async () => {
    const doc = await docWith([{ type: "table", content: { type: "tableContent", rows: [{ cells: [{ type: "tableCell", content: [], props: { backgroundColor: "red" } }, "b"] }] } }]);
    const md1 = await readMd(doc);
    expect(md1).toBe(`<table><tr><td data-background-color="red"></td><td>b</td></tr></table>\n`);
    const blocks = await withSession(ed => parse(ed, md1));
    expect(shape(blocks)).toContain(`"backgroundColor":"red"`);
    expect(await readMd(await docWith(blocks))).toBe(md1);
  });

  // #222：沒有文字的媒體 block（無 caption 的圖片）有內容，底色要帶出。
  it("無 caption 的有色圖片保留底色、往返一致", async () => {
    const doc = await docWith([{ type: "image", props: { url: "http://localhost/api/uploads/x.png", backgroundColor: "red" } }]);
    const md1 = await readMd(doc);
    expect(md1).toContain(`data-background-color="red"`);
    expect(await readMd(await docWith(await withSession(ed => parse(ed, md1))))).toBe(md1);
  });

  it("I1：有色清單裡的空清單項不帶顏色屬性（帶了寫回會被丟，往返不一致）", async () => {
    const doc = await docWith([
      { type: "bulletListItem", props: { backgroundColor: "blue" }, content: "x" },
      { type: "bulletListItem", props: { backgroundColor: "red" } },
    ]);
    const md1 = await readMd(doc);
    expect(md1).not.toContain(`data-background-color="red"`);
    const doc2 = await docWith(await withSession(ed => parse(ed, md1)));
    expect(await readMd(doc2)).toBe(md1);
  });

  it("有色 HTML 區塊內不會出現空行（空行會截斷 markdown 的 HTML 區塊）", async () => {
    const doc = await docWith([
      { type: "toggleListItem", props: { textColor: "red" }, content: "t", children: [{ type: "codeBlock", props: { language: "js" }, content: "a\n\nb" }] },
    ]);
    const md = await readMd(doc);
    expect(md.trimEnd()).not.toMatch(/\n\s*\n/);
  });
});

describe("讀 → 原樣寫回 → 再讀：一致且顏色不流失", () => {
  const fixture = [
    { type: "heading", props: { level: 2, textColor: "blue" }, content: "H" },
    { type: "paragraph", content: [{ type: "text", text: "plain & ", styles: {} }, { type: "text", text: "b", styles: { bold: true, textColor: "red" } }, { type: "text", text: "u", styles: { underline: true, backgroundColor: "pink" } }, { type: "link", href: "https://e.com", content: [{ type: "text", text: "lnk", styles: { textColor: "purple" } }] }, { type: "text", text: " 😀 a<b&c", styles: { textColor: "gray", backgroundColor: "orange" } }] },
    { type: "paragraph", props: { textColor: "brown", backgroundColor: "yellow", textAlignment: "center" }, content: "**lit** <x> line1\nline2" },
    { type: "bulletListItem", content: "u1" },
    { type: "bulletListItem", props: { backgroundColor: "green" }, content: "u2", children: [{ type: "numberedListItem", props: { textColor: "red" }, content: "n" }] },
    { type: "bulletListItem", content: "u3" },
    { type: "numberedListItem", props: { start: 3, textColor: "green" }, content: "three" },
    { type: "checkListItem", props: { checked: true, backgroundColor: "blue" }, content: "c" },
    { type: "quote", props: { textColor: "red" }, content: "q" },
    { type: "heading", props: { level: 3, isToggleable: true, backgroundColor: "orange" }, content: "tog", children: [{ type: "paragraph", content: "kid" }] },
    { type: "paragraph", props: { textColor: "red" }, content: "parent", children: [{ type: "paragraph", content: "flattened child" }] },
    { type: "table", props: { textColor: "blue" }, content: { type: "tableContent", headerRows: 1, rows: [{ cells: ["h1", "h2"] }, { cells: [{ type: "tableCell", content: [{ type: "text", text: "r", styles: { textColor: "red" } }] }, { type: "tableCell", content: "t", props: { textColor: "green", backgroundColor: "gray" } }] }] } },
    { type: "table", content: { type: "tableContent", rows: [{ cells: ["plain", "table"] }] } },
    { type: "image", props: { url: "http://localhost/api/uploads/x.png", backgroundColor: "red", caption: "cap" } },
    { type: "codeBlock", props: { language: "js" }, content: "a\n\nb" },
    { type: "bulletListItem", content: [{ type: "text", text: "b ", styles: {} }, { type: "text", text: "late", styles: { textColor: "red" } }, { type: "text", text: " *x* [a](b)", styles: {} }] },
    { type: "paragraph", content: [{ type: "text", text: "a", styles: { bold: true } }, { type: "text", text: "b*_", styles: { bold: true, italic: true, textColor: "red" } }, { type: "text", text: "c", styles: { bold: true } }, { type: "text", text: "d", styles: {} }] },
    { type: "table", content: { type: "tableContent", rows: [{ cells: ["x", { type: "tableCell", content: [{ type: "text", text: "hi", styles: { backgroundColor: "yellow" } }] }] }] } },
    { type: "heading", props: { level: 2 }, content: [{ type: "text", text: "h ", styles: {} }, { type: "text", text: "red", styles: { textColor: "red" } }] },
    { type: "paragraph", content: "end" },
  ];

  it("read1 === read2，且第二份文件的顏色與第一份寫回的一致", async () => {
    const doc1 = await docWith(fixture);
    const md1 = await readMd(doc1);
    const blocks1 = await withSession(ed => parse(ed, md1));
    const doc2 = await docWith(blocks1);
    const md2 = await readMd(doc2);
    expect(md2).toBe(md1);
    // 顏色真的寫進去了（不是兩邊都丟光才相等）
    for (const c of ["blue", "red", "pink", "purple", "gray", "orange", "brown", "yellow", "green"]) expect(shape(blocks1)).toContain(`"${c}"`);
    // 第一輪寫回後的結構與第二輪寫回一致（顏色不流失、不漂移）
    const blocks2 = await withSession(ed => parse(ed, md2));
    expect(shape(blocks2)).toBe(shape(blocks1));
  });

  it("原始文件的每一個顏色都在 read1 寫回後的文件裡（扣掉已知的 lossy：巢狀子段落被攤平）", async () => {
    const doc1 = await docWith(fixture);
    const orig = await withSession(ed => ed.document, doc1);
    const back = await withSession(ed => parse(ed, md1Of(ed)), doc1);
    const colorsOf = (bs: unknown) => (shape(bs).match(/"(textColor|backgroundColor)":"(?!default)[a-z]+"/g) ?? []).sort();
    expect(colorsOf(back)).toEqual(colorsOf(orig));
  });
});

const md1Of = (ed: Ed) => blocksToNoteMarkdown(ed, ed.document);

describe("並排", () => {
  // 逐字形由 note-markdown-goldens 釘住；這裡只看讀出是 div 形、兩欄文字各在一處。
  it("含列的 blocks 讀成並排的 div 形", async () => {
    const md = await withSession(ed => {
      const blocks = [{
        id: "r", type: "columnList", children: [
          { id: "rc0", type: "column", props: { width: 1 }, children: [{ id: "ra", type: "paragraph", content: "左" }] },
          { id: "rc1", type: "column", props: { width: 1 }, children: [{ id: "rb", type: "paragraph", content: "右" }] },
        ],
      }];
      ed.replaceBlocks(ed.document, blocks as never);
      return blocksToNoteMarkdown(ed, ed.document);
    });
    expect(md.split("\n")[0]).toBe(COLUMNS_OPEN_TAG);
    expect(md.split(columnOpenTag(1)).length - 1).toBe(2);
    expect(md.split("左").length - 1).toBe(1);
    expect(md.split("右").length - 1).toBe(1);
  });
});
