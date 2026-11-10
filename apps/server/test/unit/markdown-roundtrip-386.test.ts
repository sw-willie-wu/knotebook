/**
 * #386：讀出 → 寫回往返的其餘破口——收合清單／收合標題的文字（I-1）、有顏色的粗斜體邊緣空白（I-2）、
 * 換行後與區塊開頭的區塊標記、跳脫規則的邊界（M-a／M-b）、表格欄寬（M-e）。共用的寫入／讀出路徑同 `softbreak-386.test.ts`。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();

type Inline = { type: string; text?: string; styles?: Record<string, unknown>; content?: Inline[] };
type Blk = { type: string; content?: unknown; children?: Blk[]; props?: Record<string, unknown> };

async function parse(md: string): Promise<Blk[]> {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const r = parseMarkdownForNote(s.editor, md, [], "http://localhost");
    if ("error" in r) throw new Error(r.error);
    return r.blocks as Blk[];
  } finally {
    s.close();
  }
}
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
async function stored(doc: Y.Doc): Promise<Blk[]> {
  const s = await EditorSession.open(rt, doc);
  try {
    const strip = (bs: unknown[]): Blk[] => bs.map(b => { const { id: _id, children, ...rest } = b as { id: string; children: unknown[] }; return { ...rest, children: strip(children) } as Blk; });
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
/** 每個 block 的行內內容：逐字附上樣式（空白字元的樣式不比——移出樣式外的空白不再帶樣式）。 */
const glyphs = (blocks: Blk[]): string[][] =>
  blocks.map(b => (Array.isArray(b.content) ? (b.content as Inline[]) : []).flatMap(c => [...(c.text ?? "")].map(ch => (/[ \t]/.test(ch) ? ch : `${ch}:${JSON.stringify(c.styles ?? {})}`))));
/** 讀出 → 寫回 → 讀出 → 寫回。 */
async function loop(blocks: unknown[]) {
  const d0 = await docWith(blocks);
  const md1 = await readMd(d0);
  const d1 = await docWith(await parse(md1));
  const md2 = await readMd(d1);
  const d2 = await docWith(await parse(md2));
  return { md1, md2, b0: await stored(d0), b1: await stored(d1), b2: await stored(d2) };
}
const T = (text: string, styles: Record<string, unknown> = {}) => ({ type: "text", text, styles });
const P = (...content: unknown[]) => ({ type: "paragraph", content });

describe("I-1 收合清單、收合標題的文字也跳脫", () => {
  it("收合清單項目 `**x** and `c`` → 寫回仍是字面（不變粗體、不變 code）", async () => {
    const r = await loop([{ type: "toggleListItem", content: [T("**x** and `c`")] }]);
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
  });
  it("收合標題 `**x**` → 寫回仍是字面", async () => {
    const r = await loop([{ type: "heading", props: { level: 2, isToggleable: true }, content: [T("**x**")] }]);
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
  });
});

describe("I-2 有顏色的粗斜體，邊緣空白也移到標記外面", () => {
  it.each([
    ["紅色粗體開頭空白", [P(T("x"), T(" a", { bold: true, textColor: "red" }))]],
    ["底色斜體兩頭空白", [P(T("x"), T(" a ", { italic: true, backgroundColor: "yellow" }), T("y"))]],
    ["換行後接紅色粗體開頭空白", [P(T("L1\n"), T(" b", { bold: true, textColor: "red" }))]],
  ])("%s → 讀出沒有 `** a**`／`* a*`，往返字與樣式不變", async (_l, blocks) => {
    const r = await loop(blocks);
    expect(r.md1).not.toMatch(/\*\* |\* a/);
    expect(r.md2).toBe(r.md1);
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
    expect(r.b2).toEqual(r.b1);
  });
});

describe("I-4a 換行後那一行以區塊標記開頭 → 寫成 <br>，不斷段", () => {
  it.each([
    ["- b"], ["+ b"], ["1. b"], ["2) b"], ["# b"], ["> b"], ["---"], ["==="], ["| x |"], [":-|-"], ["(注意)"],
  ])("段落 a⏎%s", async next => {
    const r = await loop([P(T(`a\n${next}`))]);
    expect(r.md1).toContain("a<br>");
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it.each([["- b"], ["# b"], ["> b"]])("引言 a⏎%s", async next => {
    const r = await loop([{ type: "quote", content: [T(`a\n${next}`)] }]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  // 換行後接字面的 `<div>` 這類 HTML 標籤修不了：`<` 不跳脫（#379），寫回時那是真的標籤，會把段落斷開（known-limitations 已寫）。
  it("換行後接一般文字（非標點開頭）照舊是 \\ 換行", async () => {
    const doc = await docWith([P(T("a\nb 2024 年"))]);
    expect(await readMd(doc)).toBe("a\\\nb 2024 年\n");
  });
});

describe("I-4b 區塊開頭的標記字元跳脫", () => {
  it.each([
    ["# x", "\\# x\n"],
    ["###### x", "\\###### x\n"],
    ["> x", "\\> x\n"],
    [">x", "\\>x\n"],
    ["- x", "\\- x\n"],
    ["+ x", "\\+ x\n"],
    ["1. x", "1\\. x\n"],
    ["12) x", "12\\) x\n"],
    ["---", "\\---\n"],
    ["- - -", "\\- - -\n"],
  ])("段落開頭 %j → 讀出 %j，寫回仍是同一段文字", async (text, expected) => {
    const r = await loop([P(T(text))]);
    expect(r.md1).toBe(expected);
    expect(r.b1).toEqual(r.b0);
  });
  it.each([["-1 度"], ["#tag"], ["1.5 倍"], ["+1"], ["2024. 年"]])("parser 不認的 %j 不跳脫", async text => {
    const r = await loop([P(T(text))]);
    if (text === "2024. 年") {
      // 數字＋`.`＋空白是編號清單：要跳
      expect(r.md1).toBe("2024\\. 年\n");
    } else {
      expect(r.md1).toBe(`${text}\n`);
    }
    expect(r.b1).toEqual(r.b0);
  });
  it("段落第一段文字後接空白開頭的粗體（`-` ＋ 粗體 ` x`）也跳", async () => {
    const r = await loop([P(T("-"), T(" x", { bold: true }))]);
    expect(r.md1).toBe("\\- **x**\n");
    expect(glyphs(r.b1)).toEqual(glyphs(r.b0));
  });
  it.each([["x #"], ["x ##"], ["a # b #"]])("標題結尾 %j 的 # 不被剝", async text => {
    const r = await loop([{ type: "heading", props: { level: 2 }, content: [T(text)] }]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it.each([["> x"], ["- x"], ["# x"], ["1. x"]])("引言文字開頭 %j 不被剝、不變巢狀", async text => {
    const r = await loop([{ type: "quote", content: [T(text)] }]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("清單項目、標題開頭的 # 不跳（那裡只當行內文字）", async () => {
    const doc = await docWith([{ type: "bulletListItem", content: [T("# x")] }, { type: "heading", props: { level: 3 }, content: [T("- x")] }]);
    expect(await readMd(doc)).toBe("* # x\n\n### - x\n");
  });
});

/** 行內文字（去掉開頭的空白：段落開頭的空白寫回本來就會掉，見 known-limitations）。 */
const lead = (bs: Blk[]): string => (Array.isArray(bs[0]?.content) ? (bs[0]!.content as Inline[]).map(c => c.text ?? "").join("") : "").replace(/^\s+/, "");

describe("前導空白之後的區塊標記也跳", () => {
  it.each([[" # x"], ["  - x"], [" ---"], ["   1. x"], [" # x"], ["\t+ x"], [" > x"]])("段落 %j → 寫回仍是一段、字不變（開頭空白除外）", async text => {
    const r = await loop([P(T("lead")), P(T(text))]);
    expect(r.b1.map(b => b.type)).toEqual(["paragraph", "paragraph"]);
    expect(lead(r.b1.slice(1))).toBe(text.replace(/^\s+/, ""));
    // 開頭空白在第一次寫回時掉了（known-limitations），之後就穩定
    expect(r.b2).toEqual(r.b1);
  });
  it.each([[" # x"], ["  - x"], [" ---"], ["   1. x"]])("第一段（整份開頭會被剝空白）%j → 寫回仍是段落", async text => {
    const r = await loop([P(T(text))]);
    expect(r.b1.map(b => b.type)).toEqual(["paragraph"]);
    expect(lead(r.b1)).toBe(text.replace(/^\s+/, ""));
  });
  it("引言文字 \" - x\" → 寫回仍是引言、不變巢狀清單", async () => {
    const r = await loop([{ type: "quote", content: [T(" - x")] }]);
    expect(r.b1.map(b => b.type)).toEqual(["quote"]);
    expect(lead(r.b1)).toBe("- x");
  });
});

describe("清單項目底下的子段落也套用區塊開頭跳脫", () => {
  it.each([["- c"], ["# c"], ["> c"], ["1. c"]])("收合清單項目 t 的子段落 %j → 寫回子段落文字不變", async text => {
    const r = await loop([{ type: "toggleListItem", content: [T("t")], children: [P(T(text))] }]);
    const kids = r.b1[0]!.children ?? [];
    expect(kids.map(b => b.type)).toEqual(["paragraph"]);
    expect(lead(kids)).toBe(text);
  });
  it("項目符號清單底下的子段落 \"- c\" → 不變巢狀清單", async () => {
    const r = await loop([{ type: "bulletListItem", content: [T("t")], children: [P(T("- c"))] }]);
    const all = [...r.b1, ...r.b1.flatMap(b => b.children ?? [])];
    expect(all.filter(b => b.type === "bulletListItem")).toHaveLength(1);
    expect(all.some(b => b.type === "paragraph" && lead([b]) === "- c")).toBe(true);
  });
  it("項目自己的文字開頭的 - 不跳（只當行內文字）", async () => {
    expect(await readMd(await docWith([{ type: "toggleListItem", content: [T("- t")] }]))).toBe("* - t\n");
  });
});

describe("段落開頭／結尾的換行", () => {
  it.each([
    ["開頭", "\nx", "<br>x"],
    ["結尾", "a\n", "a<br>"],
    ["只有換行", "\n", "<br>"],
    ["兩頭", "\na\n", "<br>a<br>"],
    ["結尾兩個", "a\n\n", "a\\\n<br>"],
  ])("%s %j → 讀出 %j、寫回相同", async (_l, text, expected) => {
    const r = await loop([P(T(text)), P(T("z"))]);
    expect(r.md1).toBe(`${expected}\n\nz\n`);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("整篇只有一個「只有換行」的段落 → 寫回不是 empty_content", async () => {
    const r = await loop([P(T("\n"))]);
    expect(r.md1).toBe("<br>\n");
    expect(r.b1).toEqual(r.b0);
  });
});

describe("M-a 跳脫規則的邊界", () => {
  it.each([
    ["兩個反斜線", [P(T("a\\\\b"))]],
    ["反斜線結尾接粗體", [P(T("a\\"), T("b", { bold: true }))]],
    ["波浪號結尾接刪除線", [P(T("a~"), T("b", { strike: true }))]],
  ])("%s → 往返 blocks 相同", async (_l, blocks) => {
    const r = await loop(blocks);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("表格儲存格 `a\\|b` → 往返相同", async () => {
    const table = { type: "table", content: { type: "tableContent", rows: [{ cells: ["h"] }, { cells: ["a\\|b"] }] } };
    const r = await loop([table]);
    expect(r.b1).toEqual(r.b0);
    expect(r.md2).toBe(r.md1);
  });
  it("「約 ~3 個」讀出不變（單一 ~ 不跳）", async () => {
    expect(await readMd(await docWith([P(T("約 ~3 個"))]))).toBe("約 ~3 個\n");
  });
});

describe("M-b `_` 的字中判準與 parser 相同（\\w：英數字與 `_`）", () => {
  it("a__b、snake_case、x_1 讀出不變，往返相同", async () => {
    const r = await loop([P(T("a__b snake_case x_1"))]);
    expect(r.md1).toBe("a__b snake_case x_1\n");
    expect(r.b1).toEqual(r.b0);
  });
});

describe("M-e 含 <br> 的儲存格那一列與其他列等寬", () => {
  it("表格每一列的長度相同", async () => {
    const table = { type: "table", content: { type: "tableContent", rows: [{ cells: ["head", "h2"] }, { cells: ["a\nb", "x"] }, { cells: ["c", "y"] }] } };
    const md = await readMd(await docWith([table]));
    const lines = md.trimEnd().split("\n");
    expect(md).toContain("a<br>b");
    expect(new Set(lines.map(l => l.length)).size).toBe(1);
  });
});
