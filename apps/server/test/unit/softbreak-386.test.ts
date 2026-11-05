/**
 * #386：段落內換行寫進筆記後，下一行開頭不得多一個空白；讀出 → 原樣寫回要穩定；本來就在行首的空白（網頁上打的、或修好前
 * 寫入多出來的）讀出 → 寫回也不能被吃掉。這裡在寫入管線（`parseMarkdownForNote`）與讀出（`readNoteContentFromDoc`）兩端直接驗；
 * 各條寫入路徑（REST／MCP／批次寫回／新增）的端到端在整合測試 `softbreak-write-paths.test.ts`。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[] };
type Blk = { type: string; content?: unknown; children?: Blk[] };

/** markdown → 寫入管線的 blocks（失敗丟錯）。 */
async function parse(md: string): Promise<Blk[]> {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const r = parseMarkdownForNote(s.editor, md, [], ORIGIN);
    if ("error" in r) throw new Error(r.error);
    return r.blocks as Blk[];
  } finally {
    s.close();
  }
}
/** blocks 寫進新的 Y.Doc（經真編輯器正規化）。 */
async function docWith(blocks: unknown[]): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
    s.editor.replaceBlocks(s.editor.document, blocks as any);
  } finally {
    s.close();
  }
  return doc;
}
/** 存進去之後編輯器看到的 blocks（id 拿掉）。 */
async function storedBlocks(doc: Y.Doc): Promise<unknown> {
  const s = await EditorSession.open(rt, doc);
  try {
    const strip = (bs: unknown[]): unknown[] => bs.map(b => { const { id: _id, children, ...rest } = b as { id: string; children: unknown[] }; return { ...rest, children: strip(children) }; });
    return strip(s.editor.document as unknown[]);
  } finally {
    s.close();
  }
}
async function readMd(doc: Y.Doc): Promise<string> {
  const r = await readNoteContentFromDoc(rt, doc);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
}
/** 第一個 block（或它第一個子孫）的行內文字串起來。 */
const textOf = (content: unknown): string => (Array.isArray(content) ? (content as Inline[]).map(c => c.text ?? textOf(c.content)).join("") : "");
/** 寫入 → 讀出 → 原樣寫回 → 再讀：兩次讀出逐字相同、兩次存進去的 blocks 相同。 */
async function roundTrip(md: string): Promise<{ md1: string; md2: string; b1: unknown; b2: unknown }> {
  const d1 = await docWith(await parse(md));
  const md1 = await readMd(d1);
  const d2 = await docWith(await parse(md1));
  return { md1, md2: await readMd(d2), b1: await storedBlocks(d1), b2: await storedBlocks(d2) };
}

describe("#386 寫入：段落內換行後不多空白", () => {
  // 三種寫法：軟換行、`\` 換行、行尾兩空白——BlockNote 的 markdown → HTML 一律吐 `<br>\n`。
  it.each([
    ["軟換行", "L1\nL2"],
    ["\\ 換行", "L1\\\nL2"],
    ["行尾兩空白", "L1  \nL2"],
    ["續行開頭有縮排（markdown 本來就剝掉）", "L1\\\n   L2"],
  ])("%s → 存成 L1⏎L2，讀出 L1\\⏎L2", async (_label, md) => {
    const [b] = await parse(md);
    expect(b!.type).toBe("paragraph");
    expect(textOf(b!.content)).toBe("L1\nL2");
    expect(await readMd(await docWith(await parse(md)))).toBe("L1\\\nL2\n");
  });

  it("issue 原文：行一ABC⏎行二DEF（中文、兩種換行）", async () => {
    for (const md of ["行一ABC\n行二DEF", "行一ABC\\\n行二DEF"]) {
      expect(await readMd(await docWith(await parse(md)))).toBe("行一ABC\\\n行二DEF\n");
    }
  });

  // 清單項目、表格儲存格裡 BlockNote 的 parser 不認 `\` 換行（與 #386 無關），那裡只有行內 `<br>` 寫得出換行——讀出也寫成那個形（下面「往返」）。
  it("連續兩個換行、引言、粗體跨換行、清單項目與表格裡的 <br>：都不多空白", async () => {
    expect(textOf((await parse("a\\\n\\\nb"))[0]!.content)).toBe("a\n\nb");
    expect(textOf((await parse("> L1\\\n> L2"))[0]!.content)).toBe("L1\nL2");
    expect(textOf((await parse("* L1<br>L2"))[0]!.content)).toBe("L1\nL2");
    const [bold] = await parse("**L1\\\nL2**");
    expect(bold!.content).toEqual([{ type: "text", text: "L1\nL2", styles: { bold: true } }]);
  });

  it("寫進原文的行內 <br> 後面的空白是原文的字，照留", async () => {
    expect(textOf((await parse("L1<br> L2"))[0]!.content)).toBe("L1\n L2");
    expect(textOf((await parse("L1<br>  L2"))[0]!.content)).toBe("L1\n  L2");
    expect(textOf((await parse("L1<br>L2"))[0]!.content)).toBe("L1\nL2");
  });

  // 審查 M3：原文手寫的 <pre> 裡換行有意義，`<br>` 後的 `\n` 不拿掉（換行數與修改前相同）。
  it("手寫 <pre> 裡 <br> 後的換行照留", async () => {
    const [p] = await parse("<pre>a<br>\nb</pre>");
    expect(textOf(p!.content)).toBe("a\n\n\nb");
    const [c] = await parse("<pre><code>a<br>\nb</code></pre>");
    expect(c!.type).toBe("codeBlock");
    expect(textOf(c!.content)).toBe("a\n\n\nb");
    // pre 外面的同一段照樣拿掉
    expect(textOf((await parse("<pre>x</pre>\n\nL1\nL2"))[1]!.content)).toBe("L1\nL2");
  });

  // 審查 M4：CRLF／CR 在入口換成 LF，`\r` 不再變成行尾空白。
  it.each([
    ["CRLF 軟換行", "L1\r\nL2", ["L1\nL2"]],
    ["CRLF \\ 換行", "L1\\\r\nL2", ["L1\nL2"]],
    ["CRLF 行尾兩空白", "L1  \r\nL2", ["L1\nL2"]],
    ["CRLF 兩段", "p\r\n\r\nq", ["p", "q"]],
    ["只有 CR", "p\r\rL1\rL2", ["p", "L1\nL2"]],
  ])("%s → 文字沒有多的空白", async (_label, md, texts) => {
    expect((await parse(md)).map(b => textOf(b.content))).toEqual(texts);
  });

  it("code block 裡的反斜線、換行與字面 <br> 都不受影響", async () => {
    const [b] = await parse("```\nL1\\\n L2\n```");
    expect(b!.type).toBe("codeBlock");
    expect(textOf(b!.content)).toBe("L1\\\n L2");
    const [c] = await parse("```\na<br>\nb\n```");
    expect(textOf(c!.content)).toBe("a<br>\nb");
  });
});

describe("#386 讀出 → 原樣寫回穩定", () => {
  it.each(["L1\nL2", "L1\\\nL2", "> L1\\\n> L2", "**L1\\\nL2**", "a\\\n\\\nb"])("%j：兩次讀出相同、blocks 相同", async md => {
    const r = await roundTrip(md);
    expect(r.md2).toBe(r.md1);
    expect(r.b2).toEqual(r.b1);
  });

  // 清單項目、表格儲存格、標題裡的換行讀出寫成行內 `<br>`（`\` 換行在那裡寫不回來：清單項目斷成「`a\`」＋新段落、表格整列斷掉）。
  it.each([
    ["項目符號清單", { type: "bulletListItem", content: "a\nb" }, "* a<br>b\n"],
    ["編號清單", { type: "numberedListItem", content: "a\nb" }, "1. a<br>b\n"],
    ["核取清單", { type: "checkListItem", content: "a\nb" }, "* [ ] a<br>b\n"],
    ["標題", { type: "heading", props: { level: 2 }, content: "a\nb" }, "## a<br>b\n"],
  ])("%s裡的換行 → 讀出 <br>、寫回 blocks 相同", async (_label, block, expected) => {
    const doc = await docWith([block]);
    const md1 = await readMd(doc);
    expect(md1).toBe(expected);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("表格儲存格裡的換行 → 讀出 <br>、整張表往返一致", async () => {
    const r = await roundTrip("| h |\n| - |\n| a<br>b |");
    expect(r.md1).toContain("| a<br>b");
    expect(r.md2).toBe(r.md1);
    expect(r.b2).toEqual(r.b1);
  });

  it("表頭格（th）裡的換行 → 讀出 <br>、整張表往返一致", async () => {
    const r = await roundTrip("| h1<br>h2 |\n| - |\n| a |");
    expect(r.md1).toContain("| h1<br>h2");
    expect(r.md2).toBe(r.md1);
    expect(r.b2).toEqual(r.b1);
  });

  // 行首本來就有空白（網頁上 Shift+Enter 後打了空白；或 #386 修好前寫入多出來的那一格，資料庫裡已有、不做資料修正）：
  // `\` 換行的形寫不回來（續行開頭的空白 markdown 會剝掉），所以讀出改寫成行內 `<br>`，空白在同一行、寫回照留。
  it.each([
    ["一格（修好前寫入的舊內容）", "L1\n L2", "L1<br> L2\n"],
    ["兩格", "L1\n  L2", "L1<br>  L2\n"],
    ["tab", "L1\n\tL2", "L1<br>\tL2\n"],
  ])("行首空白：%s → 讀出用 <br>，寫回 blocks 與原本相同", async (_label, text, expected) => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }]);
    const md1 = await readMd(doc);
    expect(md1).toBe(expected);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("同段兩個換行、只有一個後面行首有空白：只有那個改寫成 <br>；清單項目裡的行首空白也照留", async () => {
    const blocks = [
      { type: "paragraph", content: [{ type: "text", text: "p1\n p2\np3", styles: {} }] },
      { type: "bulletListItem", content: [{ type: "text", text: "i1\n i2", styles: {} }] },
    ];
    const doc = await docWith(blocks);
    const md1 = await readMd(doc);
    expect(md1).toBe("p1<br> p2\\\np3\n\n* i1<br> i2\n");
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("上色段落（整段 HTML 讀出）裡的行首空白也往返一致", async () => {
    const doc = await docWith([{ type: "paragraph", props: { backgroundColor: "yellow" }, content: [{ type: "text", text: "L1\n L2", styles: {} }] }]);
    const md1 = await readMd(doc);
    expect(md1).toContain("<br> L2");
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  // 審查 I1：換行佔位符要是整份 HTML（含網址）裡沒有的單一字元——舊版用重複的 ⸂、只比文字，會跟相鄰字元重疊、換進網址裡。
  // U+E000 是現在第一個候選字元，⸂ 是舊版的佔位符。
  it.each([
    ["佔位符候選字元緊接換行前（段落）", [{ type: "paragraph", content: [{ type: "text", text: "\n b", styles: {} }] }]],
    ["舊佔位符字元緊接換行前（段落）", [{ type: "paragraph", content: [{ type: "text", text: "⸂\n b⸂⸂", styles: {} }] }]],
    ["佔位符候選字元緊接換行前（清單）", [{ type: "bulletListItem", content: [{ type: "text", text: "\nb", styles: {} }] }]],
    ["文字中間有候選字元", [{ type: "paragraph", content: [{ type: "text", text: "xy\n z", styles: {} }] }]],
  ])("%s → 讀出寫回 blocks 相同", async (_label, blocks) => {
    const doc = await docWith(blocks);
    const md1 = await readMd(doc);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it.each([
    ["連結網址", "https://example.com/x\uE000\uE000\uE000\uE000y"],
    ["連結網址（舊佔位符）", "https://example.com/x⸂y"],
  ])("佔位符候選字元出現在%s、文件裡又有要改寫的換行 → 網址不變", async (_label, href) => {
    const doc = await docWith([
      { type: "bulletListItem", content: "a\nb" },
      { type: "paragraph", content: [{ type: "link", href, content: "L" }] },
    ]);
    const md1 = await readMd(doc);
    expect(md1).toContain("* a<br>b");
    expect(md1).not.toContain("x<br>y");
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
  });

  // 圖片網址裡的私用區字元匯出時本來就被百分比編碼（與換行無關）；這裡比的是「文件裡有沒有要改寫的換行」兩種情形下圖片那一行逐字相同。
  it.each([
    ["佔位符候選字元", "https://example.com/p\uE000q.png"],
    ["舊佔位符字元", "https://example.com/p\u2E02q.png"],
  ])("%s出現在圖片網址、文件裡又有要改寫的換行 → 圖片那一行與沒有換行時相同", async (_label, url) => {
    const image = { type: "image", props: { url } };
    const withBreak = await readMd(await docWith([{ type: "bulletListItem", content: "a\nb" }, image]));
    const without = await readMd(await docWith([{ type: "bulletListItem", content: "ab" }, image]));
    expect(withBreak).toContain("* a<br>b");
    const imgLine = (md: string) => md.split("\n").find(l => l.startsWith("!["))!;
    expect(imgLine(withBreak)).toBe(imgLine(without));
    expect(withBreak).not.toMatch(/%3Cbr%3E/i);
  });

  it("沒有行首空白的換行讀出不變（照舊是 \\ 換行，不出現 <br>）", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "L1\nL2", styles: {} }] }]);
    expect(await readMd(doc)).toBe("L1\\\nL2\n");
  });
});

// Willie 2026-11-05：樣式從空白開始（`<strong> b</strong>`）轉換器寫成 `** b**`，寫回變字面——讀出端把樣式開頭與結尾的空白移到
// 標記外面。字不變（每個字的樣式除了那格空白都不變）、讀出 → 寫回 → 再讀逐字相同，寫回一次之後 blocks 也穩定。
describe("樣式開頭、結尾的空白移到強調標記外面", () => {
  /** 字與每個字的樣式（空白字元的樣式不比：移出去後那格空白不帶樣式）。 */
  const glyphs = (blocks: unknown): string[] =>
    (blocks as Array<{ content: Inline[] }>).flatMap(b => (b.content ?? []).flatMap(c => [...(c.text ?? "")].map(ch => (/[ \t]/.test(ch) ? ch : `${ch}:${JSON.stringify(c.styles ?? {})}`))));
  it.each([
    ["粗體開頭空白", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { bold: true } }], "a **b**\n"],
    ["斜體開頭空白", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { italic: true } }], "a *b*\n"],
    ["刪除線開頭空白", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { strike: true } }], "a ~~b~~\n"],
    ["粗斜體開頭空白", [{ type: "text", text: "a", styles: {} }, { type: "text", text: " b", styles: { bold: true, italic: true } }], "a ***b***\n"],
    ["粗體結尾空白接字", [{ type: "text", text: "b ", styles: { bold: true } }, { type: "text", text: "c", styles: {} }], "**b** c\n"],
    // 粗體、斜體結尾的空白轉換器自己會移出去；刪除線不會（`~~b ~~`），要靠這裡
    ["刪除線結尾空白接字", [{ type: "text", text: "b ", styles: { strike: true } }, { type: "text", text: "c", styles: {} }], "~~b~~ c\n"],
    ["粗體兩頭都有空白", [{ type: "text", text: "a", styles: {} }, { type: "text", text: "  b  ", styles: { bold: true } }, { type: "text", text: "c", styles: {} }], "a  **b**  c\n"],
    ["舊內容：粗體跨換行、下一行開頭空白", [{ type: "text", text: "a\n b", styles: { bold: true } }], "**a**<br> **b**\n"],
    ["換行後接開頭空白的斜體", [{ type: "text", text: "L1\n", styles: {} }, { type: "text", text: " b", styles: { italic: true } }], "L1<br> *b*\n"],
  ])("%s", async (_label, content, expected) => {
    const doc = await docWith([{ type: "paragraph", content }]);
    const md1 = await readMd(doc);
    expect(md1).toBe(expected);
    const d2 = await docWith(await parse(md1));
    expect(await readMd(d2)).toBe(md1);
    expect(glyphs(await storedBlocks(d2))).toEqual(glyphs(await storedBlocks(doc)));
    const d3 = await docWith(await parse(await readMd(d2)));
    expect(await storedBlocks(d3)).toEqual(await storedBlocks(d2));
  });

  it("沒有邊緣空白的樣式讀出不變；行內 code 開頭的空白留在 code 裡", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "a ", styles: {} }, { type: "text", text: "b", styles: { bold: true } }, { type: "text", text: " c", styles: { code: true } }] }]);
    expect(await readMd(doc)).toBe("a **b**` c`\n");
  });
});

// Willie 筆記上經 edit_note 重現三次的實例（2026-11-05）：引言裡粗體緊接 inline code、粗體跨換行、換行後多一格空白。
describe("實例：引言裡的粗體＋inline code＋換行往返", () => {
  const B = { bold: true };
  const C = { code: true };
  const I = { italic: true };
  const TAIL = [
    { type: "text", text: "其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 ", styles: {} },
    { type: "text", text: "soft_*", styles: C },
    { type: "text", text: " 一開就是所有分支一起軟化，", styles: {} },
    { type: "text", text: "包含發版 tag", styles: B },
    { type: "text", text: "。", styles: {} },
  ];
  /** agent 寫 `**test 跟 lint 沒有 `soft_` 開關，是刻意的。**` 存成的形（code 不能同時是粗體，粗體在 code 兩側斷開）＋修好前多的那格空白。 */
  const ORIGINAL = [
    { type: "text", text: "test 跟 lint 沒有 ", styles: B },
    { type: "text", text: "soft_", styles: C },
    { type: "text", text: " 開關，是刻意的。\n", styles: B },
    { type: "text", text: " ", styles: {} },
    ...TAIL,
  ];
  /** 上面那份經修好前的讀出原樣寫回一次後存成的形：斜體吃進了字面的 `**`、`\n` 與下一個 code 的反引號（Willie 筆記現在的樣子）。 */
  const CORRUPTED = [
    { type: "text", text: "test 跟 lint 沒有", styles: B },
    { type: "text", text: " ", styles: {} },
    { type: "text", text: "soft_", styles: C },
    { type: "text", text: "* 開關，是刻意的。**\n 其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 `soft_", styles: I },
    { type: "text", text: "` 一開就是所有分支一起軟化，", styles: {} },
    { type: "text", text: "包含發版 tag", styles: B },
    { type: "text", text: "。", styles: {} },
  ];
  /** 讀出 → 寫回 → 讀出 → 寫回：兩次讀出逐字相同，寫回後的 blocks 與原本的字與樣式相同（空白的樣式不比）、第二次寫回後 blocks 不再變。 */
  async function loop(content: unknown[]) {
    const d0 = await docWith([{ type: "quote", content }]);
    const md1 = await readMd(d0);
    const d1 = await docWith(await parse(md1));
    const md2 = await readMd(d1);
    const d2 = await docWith(await parse(md2));
    return { md1, md2, b0: await storedBlocks(d0), b1: await storedBlocks(d1), b2: await storedBlocks(d2) };
  }
  const glyphs = (blocks: unknown): string[] =>
    (blocks as Array<{ content: Inline[] }>).flatMap(b => (b.content ?? []).flatMap(c => [...(c.text ?? "")].map(ch => (/[ \t]/.test(ch) ? ch : `${ch}:${JSON.stringify(c.styles ?? {})}`))));

  it("原始的形（粗體在 code 兩側、粗體跨換行、換行後一格空白）→ 讀出沒有 `** 開`，往返穩定、字與樣式不變", async () => {
    const r = await loop(ORIGINAL);
    expect(r.md1).toBe("> **test 跟 lint 沒有** `soft_` **開關，是刻意的。**<br> 其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 `soft_*` 一開就是所有分支一起軟化，**包含發版 tag**。\n");
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
    expect(r.b2).toEqual(r.b1);
  });

  it("已經走樣的形（斜體裡有字面的 ** 與反引號）→ 字面字元跳脫，往返穩定、字與樣式不變", async () => {
    const r = await loop(CORRUPTED);
    expect(r.md1).toContain("\\*\\*");
    expect(r.md1).toContain("\\`soft\\_");
    expect(r.md2).toBe(r.md1);
    // 換行後那格空白在斜體開頭，移到斜體外面（字一樣、那格空白不再是斜體）
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
    expect(r.b2).toEqual(r.b1);
  });

  it("Willie 讀到的 markdown 原樣寫回 → 之後讀出、寫回不再變（不再一輪多一個 *、不會變成清單）", async () => {
    const WILLIE = "> **test 跟 lint 沒有** `soft_`** 開關，是刻意的。**\\\n>  其他每一道預設都是硬的，需要過渡期才調軟 —— 而且 `soft_*` 一開就是所有分支一起軟化，**包含發版 tag**。\n";
    const d1 = await docWith(await parse(WILLIE));
    const md1 = await readMd(d1);
    const d2 = await docWith(await parse(md1));
    const md2 = await readMd(d2);
    expect(md2).toBe(md1);
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(d1));
    expect((await storedBlocks(d2) as Blk[]).map(b => b.type)).toEqual(["quote"]);
  });
});

describe("文字裡的 markdown 標記字元跳脫", () => {
  it.each([
    ["星號", "5 * 3 = 15，a*b*c"],
    ["反引號", "用 ` 包起來"],
    ["方括號", "[x] 與 [連結](不是)"],
    ["底線：字中不跳、字邊跳", "snake_case 與 _前後_ 與 中_文"],
    ["波浪號", "約 ~3 個、~~不是刪除線~~"],
    ["反斜線", "C:\\Users 與 a\\*b 與結尾\\"],
  ])("%s → 往返 blocks 相同", async (_label, text) => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text, styles: {} }] }]);
    const md1 = await readMd(doc);
    const d2 = await docWith(await parse(md1));
    expect(await storedBlocks(d2)).toEqual(await storedBlocks(doc));
    expect(await readMd(d2)).toBe(md1);
  });

  it("沒有標記字元的文字、字中的底線、路徑裡的反斜線讀出不變", async () => {
    const doc = await docWith([{ type: "paragraph", content: [{ type: "text", text: "snake_case C:\\Users 一般文字", styles: {} }] }]);
    expect(await readMd(doc)).toBe("snake_case C:\\Users 一般文字\n");
  });

  it("行內 code 與程式碼區塊裡的字不跳脫", async () => {
    const doc = await docWith([
      { type: "paragraph", content: [{ type: "text", text: "a*b_c", styles: { code: true } }] },
      { type: "codeBlock", content: "x * y [z]" },
    ]);
    expect(await readMd(doc)).toBe("`a*b_c`\n\n```text\nx * y [z]\n```\n");
  });
});
