/**
 * #93 §4：全文索引抽取器（T2 抽取器部分–T8、RF1）。純函式，不連 DB。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, sectionize } from "@knotebook/shared";
import {
  SEARCH_EXTRACTOR_VERSION,
  SEARCH_INDEX_NOTE_MAX,
  SEARCH_INDEX_SECTIONS_MAX,
  extractSearchSections,
  searchContentHash,
} from "../../src/notes/search-text.js";
import { frag, searchDoc, type Blk } from "../search-doc.js";

const ids = (b: Blk[]) => extractSearchSections(frag(searchDoc(b))).rows.map(r => r.sectionId);
const bodyOf = (b: Blk[], sectionId: string) => extractSearchSections(frag(searchDoc(b))).rows.find(r => r.sectionId === sectionId)?.body;

describe("T2 深度（抽取器）", () => {
  // 建鏈必須包在單一 doc.transact 裡：逐筆 insert 每次各開一個 transaction、收尾成本隨深度長，整條鏈是 O(n²)
  // （CI 上單這段同步跑 52–68 s；超過 60 s 時 worker 等不到 vitest 的 onTaskUpdate RPC 回覆 → Unhandled Error、exit 1）。
  // 單一 transaction 下 20 000 層本機實測約 20 ms，樹的形狀相同。
  it("20 000 層 blockContainer 鏈 → 不拋，最深處的字出現在 body", () => {
    const doc = new Y.Doc();
    doc.transact(() => {
      const group = new Y.XmlElement("blockGroup");
      doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
      const top = new Y.XmlElement("blockContainer");
      group.insert(0, [top]);
      top.setAttribute("id", "deep");
      let parent = top;
      for (let i = 0; i < 20_000; i += 1) {
        const child = new Y.XmlElement("blockContainer");
        parent.insert(0, [child]);
        parent = child;
      }
      const leaf = new Y.XmlElement("paragraph");
      parent.insert(0, [leaf]);
      const t = new Y.XmlText();
      leaf.insert(0, [t]);
      t.insert(0, "DEEPEST");
    });
    const ex = extractSearchSections(doc.getXmlFragment(YDOC_FRAGMENT));
    expect(ex.rows).toHaveLength(1);
    expect(ex.rows[0]!.body).toContain("DEEPEST");
  });
});

describe("T3 段落對應", () => {
  const blocks: Blk[] = [
    { id: "p0", text: "foo" },
    { id: "p1", text: "bar" },
    { id: "h1", type: "heading", text: "Alpha" },
    { id: "p2", text: "alpha body" },
    { id: "h2", type: "heading", text: "Beta" },
    { id: "p3", text: "beta body" },
  ];
  it("sectionId／ord 與 sectionize 一致；各段 body 只含自己的字", () => {
    const f = frag(searchDoc(blocks));
    const ex = extractSearchSections(f);
    const outline = sectionize(f);
    expect(ex.rows.map(r => [r.sectionId, r.ord])).toEqual(outline.map((s, k) => [s.sectionId, k]));
    expect(ex.rows.map(r => r.heading)).toEqual(outline.map(s => s.heading));
    expect(bodyOf(blocks, "h1")).toBe("Alpha\nalpha body");
    expect(bodyOf(blocks, "h2")).toBe("Beta\nbeta body");
  });
  it("相鄰 block 之間恰一個分隔：『foo』『bar』兩段落不產生 foobar", () => {
    expect(bodyOf(blocks, "_top")).toBe("foo\nbar");
    expect(bodyOf(blocks, "_top")).not.toContain("foobar");
  });
  it("空段落不產生多餘分隔（R-join）；只有結構沒有字的段不入索引（R-sep）", () => {
    expect(bodyOf([{ id: "a", text: "x" }, { id: "b" }, { id: "c", text: "y" }], "_top")).toBe("x\ny");
    expect(ids([{ id: "h", type: "heading" }, { id: "p" }])).toEqual([]);
  });
  it("ord 讓跳過的段落佔號：_top 空時第一個 heading 段的 ord 是 1", () => {
    expect(extractSearchSections(frag(searchDoc([{ id: "h", type: "heading", text: "H" }]))).rows.map(r => r.ord)).toEqual([1]);
  });
});

describe("T4 走訪規則", () => {
  it("wikilink → [[標題]]（不展開子節點、非字串標題 → [[]]）；inline 不加分隔", () => {
    expect(bodyOf([{ id: "p", inline: ["see ", { wikilink: "Roadmap" }, " now"] }], "_top")).toBe("see [[Roadmap]] now");
    expect(bodyOf([{ id: "p", inline: ["x", { wikilink: 42 }] }], "_top")).toBe("x[[]]");
  });
  it("wikilink 的子節點（XmlText）不展開：只輸出 [[snapshotTitle]]", () => {
    const doc = searchDoc([{ id: "p", inline: ["a", { wikilink: "T" }, "b"] }]);
    const para = ((frag(doc).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
    const w = para.get(1) as Y.XmlElement;
    expect(w.nodeName).toBe("wikilink");
    const hidden = new Y.XmlText();
    w.insert(0, [hidden]);
    hidden.insert(0, "HIDDEN");
    const body = extractSearchSections(frag(doc)).rows[0]!.body;
    expect(body).not.toContain("HIDDEN");
    expect(body).toBe("a[[T]]b");
  });
  it("mermaid 的 code 屬性入 body；codeBlock 文字入；image 的 caption／url 不入", () => {
    const b: Blk[] = [
      { id: "p", text: "before" },
      { id: "m", type: "mermaid", attrs: { code: "graph TD; A-->MERMAIDX" } },
      { id: "c", type: "codeBlock", text: "const CODEX = 1;" },
      { id: "i", type: "image", attrs: { url: "https://example.com/URLX.png", caption: "CAPTIONX", name: "NAMEX" } },
    ];
    const body = bodyOf(b, "_top")!;
    expect(body).toBe("before\ngraph TD; A-->MERMAIDX\nconst CODEX = 1;");
    expect(body).not.toMatch(/CAPTIONX|URLX|NAMEX/);
  });
  it("巢狀 block（子 blockGroup）以分隔接在父 block 之後", () => {
    const doc = searchDoc([{ id: "p", text: "parent" }]);
    const c = frag(doc).get(0) as Y.XmlElement;
    const container = c.get(0) as Y.XmlElement;
    const inner = new Y.XmlElement("blockGroup");
    container.insert(1, [inner]);
    const nc = new Y.XmlElement("blockContainer");
    inner.insert(0, [nc]);
    nc.setAttribute("id", "child");
    const np = new Y.XmlElement("paragraph");
    nc.insert(0, [np]);
    const t = new Y.XmlText();
    np.insert(0, [t]);
    t.insert(0, "child");
    expect(extractSearchSections(frag(doc)).rows[0]!.body).toBe("parent\nchild");
  });
});

describe("T5 敵意 id（spec §4.2 第 4、5 點）", () => {
  it("重複的段落 id → 只有第一次出現的段落入索引（第二段的獨有字搜不到）", () => {
    const b: Blk[] = [
      { id: "dup", type: "heading", text: "First" },
      { id: "p1", text: "one" },
      { id: "dup", type: "heading", text: "Second" },
      { id: "p2", text: "UNIQUE2" },
    ];
    expect(ids(b)).toEqual(["dup"]);
    expect(extractSearchSections(frag(searchDoc(b))).rows.map(r => r.body).join("\n")).not.toContain("UNIQUE2");
  });
  it("RF1：id 第一次出現在**空段**、後面的非空段同 id → 後者不入（read_note_section 讀到的是前者）", () => {
    const b: Blk[] = [
      { id: "dup", type: "heading", text: "" },
      { id: "x", type: "heading", text: "Other" },
      { id: "dup", type: "heading", text: "Real" },
      { id: "p", text: "SHOULDNOTINDEX" },
    ];
    expect(ids(b)).toEqual(["x"]);
  });
  it("超長、含 /、含 NUL 的 heading id → 該段不入；_top 照入", () => {
    for (const bad of ["x".repeat(65), "a/b", "a\u0000b"]) {
      expect(ids([{ id: "p", text: "top" }, { id: bad, type: "heading", text: "H" }, { id: "q", text: "body" }]), bad).toEqual(["_top"]);
    }
  });
  it("heading block 的 id 字面是 _top → 該段不入（_top 恆為第一段）", () => {
    expect(ids([{ id: "p", text: "top" }, { id: "_top", type: "heading", text: "H" }, { id: "q", text: "body" }])).toEqual(["_top"]);
  });
  it("非 heading 的 container 與後面某段 heading 同 id → 那一段照入（它不是段落 id）", () => {
    expect(ids([{ id: "same", text: "para" }, { id: "same", type: "heading", text: "H" }, { id: "q", text: "body" }])).toEqual(["_top", "same"]);
  });
  it("任何頂層 container 的 id 為數字、空字串或缺 → 整篇 0 列、capped、indexedUnits 0（m3）", () => {
    for (const bad of [123, "", undefined]) {
      const ex = extractSearchSections(frag(searchDoc([{ id: "p", text: "ok" }, { id: bad, text: "x" }])));
      expect(ex, String(bad)).toMatchObject({ rows: [], capped: true, indexedUnits: 0 });
    }
  });
});

describe("T6 清洗", () => {
  it("文字、heading、wikilink 標題中的 NUL 與落單代理 → U+FFFD；成對代理原樣", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", inline: ["a\u0000b \uD800 \uDC00 😀 ", { wikilink: "w\u0000t" }] },
      { id: "h", type: "heading", text: "H\u0000\uDFFF" },
    ])));
    expect(ex.rows[0]!.body).toBe("a�b � � 😀 [[w�t]]");
    expect(ex.rows[1]!.heading).toBe("H��");
    expect(ex.rows[1]!.body).toBe("H��");
  });
});

describe("T7 上限", () => {
  it("body 合計 1 048 577 → indexedUnits 恰為上限、capped、其後段落不入", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", text: "x".repeat(SEARCH_INDEX_NOTE_MAX + 1) },
      { id: "h", type: "heading", text: "after" },
    ])));
    expect(ex.rows.map(r => r.sectionId)).toEqual(["_top"]);
    expect(ex.rows[0]!.body.length).toBe(SEARCH_INDEX_NOTE_MAX);
    expect(ex).toMatchObject({ indexedUnits: SEARCH_INDEX_NOTE_MAX, capped: true });
  });
  it("切點落在代理對中間時退一格；退格後剩的 1 格不給後面的段（§4.4「其後各段不入索引」）", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", text: `${"x".repeat(SEARCH_INDEX_NOTE_MAX - 1)}😀` },
      { id: "h", type: "heading", text: "a" },
    ])));
    expect(ex.rows.map(r => r.sectionId)).toEqual(["_top"]);
    expect(ex.rows[0]!.body.length).toBe(SEARCH_INDEX_NOTE_MAX - 1);
    expect(ex.capped).toBe(true);
  });
  it("某段被截成 0（只剩半個代理對的額度）→ 其後各段也不入", () => {
    const ex = extractSearchSections(frag(searchDoc([
      { id: "p", text: "x".repeat(SEARCH_INDEX_NOTE_MAX - 1) },
      { id: "h", type: "heading", text: "😀zz" },
      { id: "k", type: "heading", text: "b" },
    ])));
    expect(ex.rows.map(r => r.sectionId)).toEqual(["_top"]);
    expect(ex).toMatchObject({ indexedUnits: SEARCH_INDEX_NOTE_MAX - 1, capped: true });
  });
  it("2001 個非空段落 → 2000 列、capped；恰 2000 個 → 2000 列、不 capped", () => {
    const heads = (n: number): Blk[] => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, type: "heading", text: `h${i}` }));
    const over = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX + 1))));
    expect(over.rows).toHaveLength(SEARCH_INDEX_SECTIONS_MAX);
    expect(over.capped).toBe(true);
    expect(over.rows.at(-1)!.sectionId).toBe(`h${SEARCH_INDEX_SECTIONS_MAX - 1}`);
    const exact = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX))));
    expect(exact.rows).toHaveLength(SEARCH_INDEX_SECTIONS_MAX);
    expect(exact.capped).toBe(false);
  });
  it("heading 1001 → 存 1000；切點在代理對中間退一格（body 不截）", () => {
    const a = extractSearchSections(frag(searchDoc([{ id: "h", type: "heading", text: "h".repeat(1001) }]))).rows[0]!;
    expect(a.heading.length).toBe(1000);
    expect(a.body.length).toBe(1001);
    const b = extractSearchSections(frag(searchDoc([{ id: "h", type: "heading", text: `${"h".repeat(999)}😀` }]))).rows[0]!;
    expect(b.heading).toBe("h".repeat(999));
  });
});

describe("T8 雜湊", () => {
  const b: Blk[] = [{ id: "p", text: "same content" }];
  it("同內容同雜湊；改一個字 → 不同", () => {
    const h1 = extractSearchSections(frag(searchDoc(b))).contentHash;
    expect(extractSearchSections(frag(searchDoc(b))).contentHash).toBe(h1);
    expect(extractSearchSections(frag(searchDoc([{ id: "p", text: "same contenT" }]))).contentHash).not.toBe(h1);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });
  it("改 extractor 版本 → 不同；extractorVersion 欄等於常數", () => {
    const ex = extractSearchSections(frag(searchDoc(b)));
    expect(ex.extractorVersion).toBe(SEARCH_EXTRACTOR_VERSION);
    expect(searchContentHash(SEARCH_EXTRACTOR_VERSION, ex.rows, ex.capped)).toBe(ex.contentHash);
    expect(searchContentHash(SEARCH_EXTRACTOR_VERSION + 1, ex.rows, ex.capped)).not.toBe(ex.contentHash);
  });
  it("rows 相同、只有 capped 不同 → 雜湊不同（2000→2001 段；空筆記→含空 id container）", () => {
    const heads = (n: number): Blk[] => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, type: "heading", text: `h${i}` }));
    const exact = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX))));
    const over = extractSearchSections(frag(searchDoc(heads(SEARCH_INDEX_SECTIONS_MAX + 1))));
    expect(over.rows).toEqual(exact.rows);
    expect([exact.capped, over.capped]).toEqual([false, true]);
    expect(over.contentHash).not.toBe(exact.contentHash);
    const empty = extractSearchSections(frag(searchDoc([{ id: "p" }])));
    const badId = extractSearchSections(frag(searchDoc([{ id: "", text: "x" }])));
    expect([empty.rows, badId.rows]).toEqual([[], []]);
    expect([empty.capped, badId.capped]).toEqual([false, true]);
    expect(badId.contentHash).not.toBe(empty.contentHash);
  }, { timeout: 120_000 });
});
