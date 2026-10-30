import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { MAX_BLOCKS, parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";
const GID = "99999999-9999-4999-8999-999999999999";
/** 寫入者的可見清單（#269：帶 slug／groupId／ownerHandle，站內網址比對用）。 */
const notes = [
  { id: "11111111-1111-4111-8111-111111111111", title: "A", slug: "a", groupId: null, ownerHandle: "alice" },
  { id: "22222222-2222-4222-8222-222222222222", title: "Group Doc", slug: "plan", groupId: GID, ownerHandle: null },
];

// ⚠ 每一處 `EditorSession.open` 都要 `try { … } finally { s.close() }`：`close()` 是唯一釋放 runtime
// lease 的路徑，這裡的 `rt` 又是模組層共用的，回呼一 throw 就永久佔掉一個 in-flight 名額
// （`session.ts` 的 m3 不變量）。**斷言失敗本身就是 throw**，所以「先 close 再 expect」不是替代方案。
const withSession = async (fn: (ed: EditorSession["editor"]) => void) => {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    fn(s.editor);
  } finally {
    s.close();
  }
};
/** 把 blocks 寫進一份新的 Y.Doc（經真編輯器正規化）。 */
const docWith = async (blocks: unknown[]) => {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
    s.editor.replaceBlocks(s.editor.document, blocks as any);
  } finally {
    s.close();
  }
  return doc;
};
/** 讀路徑匯出（等同 MCP read_note_section／REST /content 整篇形的 markdown）。 */
const readMd = async (doc: Y.Doc) => {
  const r = await readNoteContentFromDoc(rt, doc);
  if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
  return r.markdown;
};
const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: Array<{ id: string; markdown: string }> };
const golden = (id: string): string => goldens.cases.find(c => c.id === id)!.markdown;
/** spec §11.1 的範例（＝golden G1-cols-spec 的 markdown）。 */
const ROW2 =
  '<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n<figure><img alt="A 點" src="/api/uploads/u1" width="300"></figure>\n\n</div>\n' +
  '<div data-kb-column style="flex:1.5">\n\n## 設備規格\n\n型號：x\n\n</div>\n</div>\n';

describe("parseMarkdownForNote", () => {
  it("ROW2 與 golden G1-cols-spec 逐字相同", () => {
    expect(ROW2).toBe(golden("G1-cols-spec"));
  });
  it("wikilink 重綁、mermaid 還原、unbound 計數", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "x [[A]] [[B]]\n\n```mermaid\ngraph TD\n```", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.unbound).toBe(1);
      expect(r.blocks.map(b => b.type)).toEqual(["paragraph", "mermaid"]);
    });
  });
  it("空／純空白 → empty_content；> MAX_BLOCKS → too_many_blocks", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, "   \n  \n", notes, ORIGIN)).toEqual({ error: "empty_content" });
      expect(parseMarkdownForNote(ed, Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => `p${i}`).join("\n\n"), notes, ORIGIN)).toEqual({ error: "too_many_blocks" });
    });
  });
  it("未知型別整筆拒絕（不靜默剝除）", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "<custom-widget>x</custom-widget>", notes, ORIGIN);
      // BlockNote 對未知 HTML 元素通常降級為 paragraph；本案釘住「若 parse 產出的 type 不在 schema
      // 白名單 → unsupported_block」，用收窄白名單的假 editor 來驗。真 schema ＝ defaultBlockSpecs
      // 全集＋mermaid／codeBlock（見 shared 的 createHeadlessNoteSchema），markdown/HTML parser 產得
      // 出來的 type 一定在裡面——所以**整合層只造得出 parse 丟例外那一種**（見下面 GM-THROW 與 mcp-write-guards GW5），那邊的清單要誠實寫明不驗，別硬塞。
      const narrowed = { ...ed, schema: { blockSchema: { paragraph: ed.schema.blockSchema.paragraph } }, tryParseHTMLToBlocks: ed.tryParseHTMLToBlocks.bind(ed) } as unknown as typeof ed;
      expect(parseMarkdownForNote(narrowed, "# heading", notes, ORIGIN)).toEqual({ error: "unsupported_block" });
      expect("error" in r ? r.error : "ok").not.toBe("unsupported_block"); // 真 schema 下純 HTML 不會炸成 500
    });
  });

  // ── 並排與尺寸的寫入驗證（PR-2；spec §11.3）：語法檢查 → parse → 結構檢查，不合格整筆拒絕 ──
  type B = { type: string; props?: Record<string, unknown>; content?: unknown; children?: B[] };
  const okBlocks = (r: ReturnType<typeof parseMarkdownForNote>): B[] => {
    if ("error" in r) throw new Error(r.error);
    return r.blocks as B[];
  };
  const COLS = { error: "unsupported_columns" };
  const SIZE = { error: "unsupported_size" };
  /** 列的結構（型別、欄寬、各欄子 block 型別與 previewWidth），不含文字。 */
  const rowShape = (bs: B[]) =>
    bs.map(b => ({ type: b.type, cols: (b.children ?? []).map(c => ({ type: c.type, width: c.props?.width, kids: (c.children ?? []).map(k => [k.type, k.props?.previewWidth]) })) }));

  it("GM1：正規形兩欄（spec §11.1 範例）→ 一列兩欄、寬 [1, 1.5]、左欄圖片 previewWidth 300、右欄 [heading, paragraph]", async () => {
    await withSession(ed => {
      const bs = okBlocks(parseMarkdownForNote(ed, ROW2, notes, ORIGIN));
      expect(bs.map(b => b.type)).toEqual(["columnList"]);
      const cols = bs[0]!.children!;
      expect(cols.map(c => [c.type, c.props?.width])).toEqual([["column", 1], ["column", 1.5]]);
      expect(cols[0]!.children!.map(k => [k.type, k.props?.previewWidth])).toEqual([["image", 300]]);
      expect(cols[1]!.children!.map(k => k.type)).toEqual(["heading", "paragraph"]);
    });
  });
  it("GM2：清單項目下縮排的兩欄 → unsupported_columns", async () => {
    await withSession(ed => {
      const nested = `- item\n\n${ROW2.split("\n").map(l => (l === "" ? l : `  ${l}`)).join("\n")}`;
      expect(parseMarkdownForNote(ed, nested, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("GM3：站內形 data-node-type=columnList 兩欄 → unsupported_columns", async () => {
    await withSession(ed => {
      const siteForm = `<div data-node-type="columnList"><div data-node-type="column" data-width="1"><p>A</p></div><div data-node-type="column" data-width="1"><p>B</p></div></div>`;
      expect(parseMarkdownForNote(ed, siteForm, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("GM4：單欄外部形 → unsupported_columns（PR-1 時攤平成一般段落）", async () => {
    await withSession(ed => {
      const one = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nonly\n\n</div>\n</div>`;
      expect(parseMarkdownForNote(ed, one, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("GM5：只有 display:flex 的版面 → unsupported_columns（PR-1 時接受並攤平）", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, `<div style="display:flex"><div><p>L</p></div><div><p>R</p></div></div>`, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("GM6：不含並排的 markdown（標題、清單、表格、mermaid）照舊通過", async () => {
    await withSession(ed => {
      const md = "# T\n\n- a\n- b\n\n| h1 | h2 |\n| -- | -- |\n| 1 | 2 |\n\n```mermaid\ngraph TD\n```";
      const r = parseMarkdownForNote(ed, md, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.blocks.map(b => b.type)).toEqual(["heading", "bulletListItem", "bulletListItem", "table", "mermaid"]);
    });
  });
  it("GM7：孤立的 column（parse 結果被換成含 column 的 blocks）→ 結構檢查回 unsupported_columns", async () => {
    await withSession(ed => {
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockReturnValue([{ id: "c", type: "column", props: { width: 1 }, children: [{ id: "p", type: "paragraph", content: "x" }] }] as never);
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual(COLS);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("GM8：孤立的 columnList（無 column 子節點）→ 結構檢查回 unsupported_columns", async () => {
    await withSession(ed => {
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockReturnValue([{ id: "r", type: "columnList", children: [] }] as never);
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual(COLS);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("GM-ORD：孤立 column 與不在色盤的顏色同一筆 → unsupported_columns（結構檢查在顏色之前）", async () => {
    await withSession(ed => {
      const bad = [{ id: "c", type: "column", props: { width: 1 }, children: [{ id: "p", type: "paragraph", content: [{ type: "text", text: "x", styles: { textColor: "#ff0000" } }] }] }];
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockReturnValue(bad as never);
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual(COLS);
      } finally {
        spy.mockRestore();
      }
    });
  });
  it("GM9：<figure> 內帶 width 的 img → image previewWidth 300、name 保留；裸的帶寬 img → unsupported_size", async () => {
    await withSession(ed => {
      const bs = okBlocks(parseMarkdownForNote(ed, '<figure><img alt="p" src="/api/uploads/u9" width="300"></figure>', notes, ORIGIN));
      expect(bs.map(b => [b.type, b.props?.previewWidth, b.props?.name])).toEqual([["image", 300, "p"]]);
      expect(parseMarkdownForNote(ed, '<img alt="p" src="/api/uploads/u9" width="300">', notes, ORIGIN)).toEqual(SIZE);
    });
  });
  it("GM10：第一列 colwidth → columnWidths[0] 120；第二列帶 colwidth → unsupported_size", async () => {
    await withSession(ed => {
      const bs = okBlocks(parseMarkdownForNote(ed, '<table><tr><th colwidth="120">a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></table>', notes, ORIGIN));
      expect((bs[0]!.content as { columnWidths: unknown[] }).columnWidths[0]).toBe(120);
      expect(parseMarkdownForNote(ed, '<table><tr><th>a</th><th>b</th></tr><tr><td colwidth="120">c</td><td>d</td></tr></table>', notes, ORIGIN)).toEqual(SIZE);
    });
  });
  it.each<[string, unknown[]]>([
    ["G3-table-colspan-partial", [120, "unset", 80]],
    ["G3-table-colored-merged", ["unset", "unset", "unset"]],
  ])("GM-CW：%s（合併格未設寬的空段）→ 存成 undefined（不是 NaN），寫回再讀逐字相同", async (id, expected) => {
    const md = golden(id);
    let blocks: B[] = [];
    await withSession(ed => {
      blocks = okBlocks(parseMarkdownForNote(ed, md, notes, ORIGIN));
    });
    const ws = (blocks[0]!.content as { columnWidths: unknown[] }).columnWidths;
    expect(ws.map(v => (v === undefined ? "unset" : v))).toEqual(expected);
    for (const v of ws) expect(Object.is(v, NaN)).toBe(false);
    expect(await readMd(await docWith(blocks))).toBe(md);
  });
  it("GM11：一列兩欄、每欄 1000 段 → too_many_blocks（欄與欄內都計入）；每欄 998 段 → 通過（1＋2＋1996＝1999）", async () => {
    const colOf = (n: number) => `<div data-kb-column style="flex:1">\n\n${Array.from({ length: n }, (_, i) => `p${i}`).join("\n\n")}\n\n</div>`;
    const rowOf = (n: number) => `<div data-kb-columns style="display:flex;gap:16px">\n${colOf(n)}\n${colOf(n)}\n</div>\n`;
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, rowOf(1000), notes, ORIGIN)).toEqual({ error: "too_many_blocks" });
      const bs = okBlocks(parseMarkdownForNote(ed, rowOf(998), notes, ORIGIN));
      expect(bs.map(b => b.type)).toEqual(["columnList"]);
      expect(bs[0]!.children!.map(c => c.children!.length)).toEqual([998, 998]);
    });
  });
  it("GM12：不在色盤的顏色與 display:flex 的 div 同一筆 → unsupported_columns（語法檢查在顏色之前）", async () => {
    await withSession(ed => {
      const md = 'x <span style="color:#ff0000">r</span>\n\n<div style="display:flex"><div><p>L</p></div><div><p>R</p></div></div>';
      expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual(COLS);
    });
  });
  it("GM13：CRLF 換行的兩欄 → 通過，結構與 LF 相同（不比文字：core 對 CRLF 段落多留尾端空白）", async () => {
    await withSession(ed => {
      const lf = okBlocks(parseMarkdownForNote(ed, ROW2, notes, ORIGIN));
      const crlf = okBlocks(parseMarkdownForNote(ed, ROW2.replace(/\n/g, "\r\n"), notes, ORIGIN));
      expect(rowShape(crlf)).toEqual(rowShape(lf));
      expect(rowShape(crlf)[0]!.cols).toHaveLength(2);
    });
  });
  it("GM-REL：收合標題內的本站上傳網址存成相對形；外站同形路徑原樣；頂層相對網址照舊", async () => {
    const UP = "/api/uploads/00000000-0000-4000-8000-000000000001";
    const toggle = (src: string) => `<details open="" data-is-toggleable="true"><summary><h2>h</h2></summary><figure><img alt="n" src="${src}" width="300"></figure></details>\n`;
    expect(new URL(document.baseURI).origin).toBe(ORIGIN);
    await withSession(ed => {
      const inToggle = (md: string) => okBlocks(parseMarkdownForNote(ed, md, notes, ORIGIN))[0]!.children![0]!.props?.url;
      expect(inToggle(toggle(UP))).toBe(UP);
      expect(inToggle(toggle(`https://evil.example${UP}`))).toBe(`https://evil.example${UP}`);
      const top = okBlocks(parseMarkdownForNote(ed, `<figure><img alt="n" src="${UP}" width="300"></figure>`, notes, ORIGIN));
      expect(top[0]!.props?.url).toBe(UP);
    });
  });
  it("GM14（§11.11）：欄內的 [[…]] 與站內連結都綁成 wikilink、mermaid 還原；欄內不在色盤的顏色 → unsupported_color", async () => {
    await withSession(ed => {
      const md = ROW2.replace("<figure>", "```mermaid\ngraph TD\n```\n\n<figure>").replace("型號：x", "[[A]] [x](/notes/11111111-1111-4111-8111-111111111111)");
      const r = parseMarkdownForNote(ed, md, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.unbound).toBe(0);
      const cols = (r.blocks as B[])[0]!.children!;
      expect(cols[0]!.children!.map(k => k.type)).toEqual(["mermaid", "image"]);
      const para = cols[1]!.children!.find(k => k.type === "paragraph")!;
      expect((para.content as Array<{ type: string }>).filter(n => n.type === "wikilink")).toHaveLength(2);
      expect(parseMarkdownForNote(ed, ROW2.replace("型號：x", '<span style="color:#ff0000">r</span>'), notes, ORIGIN)).toEqual({ error: "unsupported_color" });
    });
  });
  it("GM-THROW：core parse 丟例外的輸入（編輯器內部形 data-content-type）→ unsupported_block，不往外拋", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, '<div data-content-type="paragraph">x</div>', notes, ORIGIN)).toEqual({ error: "unsupported_block" });
      const spy = vi.spyOn(ed, "tryParseHTMLToBlocks").mockImplementation(() => {
        throw new Error("boom");
      });
      try {
        expect(parseMarkdownForNote(ed, "x", notes, ORIGIN)).toEqual({ error: "unsupported_block" });
      } finally {
        spy.mockRestore();
      }
    });
  });
  // final review Nit 1：帶事件處理屬性的 HTML 在 core parse 之前就整筆拒絕（unsupported_block），不進 `tryParseHTMLToBlocks`
  it("GM-EH：<details> 內、figure 內的 <img onerror> → unsupported_block，core parse 沒被呼叫", async () => {
    await withSession(ed => {
      const parse = vi.spyOn(ed, "tryParseHTMLToBlocks");
      try {
        for (const md of [
          '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>\n',
          '<figure><img alt="a" src="/api/uploads/00000000-0000-4000-8000-000000000001" width="300" onerror="alert(1)"></figure>\n',
        ]) {
          expect(parseMarkdownForNote(ed, md, notes, ORIGIN)).toEqual({ error: "unsupported_block" });
        }
        expect(parse).not.toHaveBeenCalled();
        // 對照：拿掉 onerror 就照收
        expect("error" in parseMarkdownForNote(ed, '<figure><img alt="a" src="/api/uploads/00000000-0000-4000-8000-000000000001" width="300"></figure>\n', notes, ORIGIN)).toBe(false);
      } finally {
        parse.mockRestore();
      }
    });
  });
  // T4 審查 Minor-2：core 對合法內容開始丟例外時（例如升級 BlockNote 後），維運要看得到——warn 一筆，帶例外的類名與 stack 的呼叫框。
  // final review Nit 5：不帶 message（PM 的錯誤訊息可能拼進內容片段），也不帶筆記內容。
  it("GM-THROW-LOG：parse 例外轉成 unsupported_block 時 console.warn 一次，帶 name 與 stack 呼叫框、不含 message 與 markdown 內容；正常 parse 不 warn", async () => {
    await withSession(ed => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // 訊息裡放內容片段，模擬 PM 的 `Invalid content for node …`
      const boom = new RangeError("Invalid content for node paragraph: <SECRET-IN-MESSAGE>");
      const parse = vi.spyOn(ed, "tryParseHTMLToBlocks").mockImplementationOnce(() => {
        throw boom;
      });
      try {
        expect(parseMarkdownForNote(ed, "SECRET-NOTE-TEXT", notes, ORIGIN)).toEqual({ error: "unsupported_block" });
        expect(warn).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify(warn.mock.calls[0]);
        expect(logged).toContain("unsupported_block");
        expect(logged).toContain("RangeError");
        const frames = boom.stack!.split("\n").filter(l => /^\s+at /.test(l));
        expect(frames.length).toBeGreaterThan(0);
        expect(warn.mock.calls[0]![1]).toEqual({ name: "RangeError", frames });
        expect(logged).not.toContain("SECRET-IN-MESSAGE");
        expect(logged).not.toContain("SECRET-NOTE-TEXT");
        // 真輸入（core 真的丟）同樣 warn、同樣不帶內容
        expect(parseMarkdownForNote(ed, '<div data-content-type="paragraph">SECRET-NOTE-TEXT</div>', notes, ORIGIN)).toEqual({ error: "unsupported_block" });
        expect(warn).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(warn.mock.calls[1])).not.toContain("SECRET-NOTE-TEXT");
        // cleanup r2 Nit 2：多行 message 裡以「    at 」開頭的行不得被當成呼叫框記下
        const tricky = new Error("first\n    at SECRET-LINE (x)");
        parse.mockImplementationOnce(() => {
          throw tricky;
        });
        expect(parseMarkdownForNote(ed, "y", notes, ORIGIN)).toEqual({ error: "unsupported_block" });
        expect(warn).toHaveBeenCalledTimes(3);
        expect(JSON.stringify(warn.mock.calls[2])).not.toContain("SECRET-LINE");
        expect((warn.mock.calls[2]![1] as { frames: string[] }).frames.length).toBeGreaterThan(0);
        // 對照：parse 沒丟例外就不 warn
        expect("error" in parseMarkdownForNote(ed, "plain", notes, ORIGIN)).toBe(false);
        expect(warn).toHaveBeenCalledTimes(3);
      } finally {
        parse.mockRestore();
        warn.mockRestore();
      }
    });
  });

  // ── href 的 scheme 過濾（issue #153）──────────────────────────────────────
  //
  // `parseMarkdownForNote` 的白名單只驗 **block** 型別、不看 inline content，所以
  // `link` 一路通過；擋掉 `javascript:`／`data:` 的**唯一**那道防線是 `@blocknote/core`
  // 內嵌 Tiptap Link extension 的預設 `isValidLink` 正則（它的 `parseHTML.getAttrs`
  // 對不合法的 href 回 `false` ⇒ mark 不成立 ⇒ 退化成純文字）。而那是一個**可被覆寫
  // 的 option**，`packages/shared/src/note-schema-config.ts` 對 `link` 零額外守衛
  // （對照 `image`／`audio`／`video`／`file` 都被 `withGuardedExternalHTML` 包過）。
  // 升級套件或換掉 markdown 解析器，這道防線會**無聲**消失——這一案就是釘住它。
  describe("href 的 scheme 過濾（唯一防線在上游，這裡是它的守衛）", () => {
    /** 遞迴收集所有 inline content 的 type（`{ type, href }` 形，方便正向對照比值）。 */
    const inlines = (blocks: unknown[]): Array<{ type: string; href?: unknown }> =>
      (blocks as Array<{ content?: unknown; children?: unknown[] }>).flatMap(b => [
        ...(Array.isArray(b.content) ? (b.content as Array<{ type: string; href?: unknown }>) : []),
        ...(Array.isArray(b.children) ? inlines(b.children) : []),
      ]);

    // 正向對照證明「抽 link 的取值路徑是對的」：少了它，下面「沒有 link 存活」那兩句
    // 會在 `inlines()` 寫壞成恆回空陣列時照樣全綠。
    // ⚠ 別把理由寫成「必須排在前面、否則失敗後跑不到」——那是假的：vitest 預設
    // `bail: 0`，一個 `it` 失敗不會中止其他 `it`（實測弄壞 `inlines()` 時，這條與下面
    // 兩個 it.each 列**全部照跑照紅**）。只有**同一個 `it` 內**的斷言才會在第一個失敗
    // 處中止。排在前面純粹是給讀的人的順序，不是它有鑑別力的條件。
    it("正向對照：合法的 https 連結真的變成 link，href 一字不差", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(ed, "[x](https://example.com)", notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        const links = inlines(r.blocks).filter(c => c.type === "link");
        expect(links).toHaveLength(1);
        expect(links[0]!.href).toBe("https://example.com");
      });
    });

    it.each([
      ["javascript:", "[x](javascript:alert(1))"],
      ["data:", "[x](data:text/html,evil)"],
    ])("%s 的 href 不會產出任何 link inline content（退化成純文字）", async (_scheme, markdown) => {
      await withSession(ed => {
        const r = parseMarkdownForNote(ed, markdown, notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        const content = inlines(r.blocks);
        expect(content.filter(c => c.type === "link")).toEqual([]);
        // 文字本身要還在（確認是「退化成純文字」而不是「整段被吃掉」——後者會讓
        // 上面那句恆真）。
        expect(content.some(c => c.type === "text")).toBe(true);
      });
    });
  });

  // ── http(s) 連結會開新分頁（issue #153）──────────────────────────────────
  //
  // 同一個風險模型的另一半。編輯器只給 `http(s)` 連結加「開新分頁」圖示
  // （`apps/web/src/index.css`），那個標示之所以為真，**唯一**的依據是
  // `@blocknote/core` 的 Link extension 在 `addOptions().HTMLAttributes` 裡**靜態**寫著
  // `target: "_blank"`——我們沒有覆寫它，也沒有任何地方複述它（全樹 grep `_blank` 只有
  // 註解與無關的 Yjs fixture）。上游哪天把它改成條件式，圖示就開始對使用者說謊，而在
  // 這一案之前**不會有任何測試變紅**。
  it("http(s) 連結匯出的 HTML 帶 target=\"_blank\"——圖示語意的唯一依據", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "[abs](https://example.com/p)", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      const html = ed.blocksToHTMLLossy(r.blocks);
      // 先確認這一輪真的產出了 anchor——否則下面那句會在「根本沒有連結」時恆假／
      // 誤導（同上面正向對照的理由）。
      expect(html, `沒有變成 link：${html}`).toContain('href="https://example.com/p"');
      expect(html, `連結沒有 target="_blank"，「開新分頁」圖示的標示就不成立：${html}`).toContain(
        'target="_blank"',
      );
    });
  });

  describe("#269 站內連結 → wikilink（§8.5、§9.2）", () => {
    const wl = (r: ReturnType<typeof parseMarkdownForNote>) => {
      if ("error" in r) throw new Error(r.error);
      return r.blocks;
    };
    it("三形（/notes/<id>、/n/、/g/）相對與同 origin 絕對、帶 #b- 錨點 → wikilink；label 規則；unbound 不計站內連結", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(
          ed,
          `[A](/notes/11111111-1111-4111-8111-111111111111) [自訂](${ORIGIN}/n/alice/a#b-h1) [x](/g/${GID}/plan) [[A]]`,
          notes,
          ORIGIN,
        );
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(0);
        const content = (r.blocks[0] as { content: Array<{ type: string; props?: Record<string, string> }> }).content.filter(n => n.type === "wikilink");
        expect(content.map(n => n.props)).toEqual([
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "A", label: "", anchorBlockId: "" },
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "自訂", label: "自訂", anchorBlockId: "h1" },
          { targetNoteId: "22222222-2222-4222-8222-222222222222", snapshotTitle: "x", label: "x", anchorBlockId: "" },
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "A" },
        ]);
      });
    });

    it("寫入者看不到的目標、看不到的群組、舊 slug、帶 query、#/ fragment、/p/ → 維持一般連結（不計 unbound）", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(
          ed,
          [
            "[n](/notes/33333333-3333-4333-8333-333333333333)",
            `[g](/g/88888888-8888-4888-8888-888888888888/plan)`,
            "[old](/n/alice/old-slug)",
            "[q](/n/alice/a?present)",
            "[s](/n/alice/a#/slide)",
            "[p](/p/alice/a)",
          ].join(" "),
          notes,
          ORIGIN,
        );
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(0);
        const types = (r.blocks[0] as { content: Array<{ type: string }> }).content.filter(n => n.type !== "text").map(n => n.type);
        expect(types).toEqual(["link", "link", "link", "link", "link", "link"]);
      });
    });

    it("表格裡的站內連結與 [[…]] 都綁；表格裡找不到的 [[…]] 計入 unbound", async () => {
      await withSession(ed => {
        const blocks = wl(parseMarkdownForNote(ed, "| a | b |\n| --- | --- |\n| [x](/n/alice/a) | [[A]] [[Nope]] |", notes, ORIGIN));
        const table = blocks[0] as { type: string; content: { rows: Array<{ cells: unknown[] }> } };
        expect(table.type).toBe("table");
        const body = JSON.stringify(table.content.rows);
        expect(body).toContain('"type":"wikilink"');
        expect(body.match(/"type":"wikilink"/g)).toHaveLength(2);
        const r = parseMarkdownForNote(ed, "| a |\n| --- |\n| [[Nope]] |", notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(1);
      });
    });
  });
});

// #269 Task 6 RF1：讀出（readNoteContentFromDoc → wikilinksToLinks〔不跳脫〕→ shared note-markdown-read.ts 的 markdown 分支以 `escapeLinkText`
// 跳脫站內連結文字、上色區塊的原始 HTML 分支不跳脫 → BlockNote markdown）再寫回（parseMarkdownForNote）的往返——BlockNote 的
// 匯出本身不跳脫文字；這裡用真編輯器量往返結果。
describe("#269 RF1：wikilink 讀出→寫回，label 逐字相同（段落與表格 cell）", () => {
  const ID = notes[0]!.id;
  const wlNode = (label: string) => ({ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "snap", label, anchorBlockId: "" } });
  const labelsOf = (blocks: unknown) => [...JSON.stringify(blocks).matchAll(/"label":("(?:[^"\\]|\\.)*")/g)].map(m => JSON.parse(m[1]!) as string);

  /** 讀出 → 寫回 → 再讀出 → 再寫回：兩輪的 label 都要等於原值，第二輪的 markdown 與第一輪位元組相同（反斜線不累積）。 */
  const roundTripTwice = async (blocks: unknown[]) => {
    const md1 = await readMd(await docWith(blocks));
    let back1: unknown[] = [];
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, md1, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      back1 = r.blocks;
    });
    const md2 = await readMd(await docWith(back1));
    let back2: unknown[] = [];
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, md2, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      back2 = r.blocks;
    });
    return { md1, md2, labels1: labelsOf(back1), labels2: labelsOf(back2) };
  };
  const SIX = ["[Draft] Plan *v2*", "a]b\\", "a_b_ `c` ~~s~~ x|y", "C:\\path\\", "![img] #h", "foo]bar"];
  const headerRow = { cells: [[{ type: "text", text: "h", styles: {} }]] };

  it.each(SIX)("markdown 形（無色段落＋無色表格 cell）：%s", async text => {
    const r = await roundTripTwice([
      { type: "paragraph", content: [wlNode(text)] },
      { type: "table", content: { type: "tableContent", rows: [headerRow, { cells: [[wlNode(text)]] }] } },
    ]);
    expect(r.labels1).toEqual([text, text]);
    expect(r.labels2).toEqual([text, text]);
    expect(r.md2).toBe(r.md1);
  });

  // 審查 r0 I1：上色區塊整塊以原始 HTML 讀出，裡面的連結文字**不得**跳脫（HTML 寫回不反跳脫，會一輪多一層反斜線）。
  // 中間夾一個無色段落：文件有顏色時無色節點走 `flush()` 的 markdown 分支——那條分支的跳脫也在這一案觀測。
  it.each(SIX)("HTML 形（底色段落、文字色段落、有上色 cell 的表格）＋夾在中間的無色段落：%s", async text => {
    const r = await roundTripTwice([
      { type: "paragraph", props: { backgroundColor: "yellow" }, content: [wlNode(text)] },
      { type: "paragraph", content: [wlNode(text)] },
      { type: "paragraph", props: { textColor: "red" }, content: [wlNode(text)] },
      { type: "table", content: { type: "tableContent", rows: [headerRow, { cells: [{ type: "tableCell", props: { backgroundColor: "red" }, content: [wlNode(text)] }] }] } },
    ]);
    expect(r.md1).toContain(`<a href="/notes/${ID}"`); // 確實走了 HTML 分支
    expect(r.md1).toContain(`](/notes/${ID})`); // 無色段落確實走 markdown 分支
    expect(r.labels1).toEqual([text, text, text, text]);
    expect(r.labels2).toEqual([text, text, text, text]);
    expect(r.md2).toBe(r.md1);
  });

  // 上色的區塊整塊以 HTML 讀出（shared note-markdown-read.ts `toBlockHTML`）——裡面的連結是 `<a href="/notes/<id>">`，不是 `[text](…)`；
  // READ_NOTE_LINK_SENTENCE 的括號子句依此寫成。
  it("上色段落裡的 wikilink 讀出為 <a href=\"/notes/<id>\">", async () => {
    const doc = await docWith([{ type: "paragraph", props: { backgroundColor: "yellow" }, content: [wlNode("L")] }]);
    const md = await readMd(doc);
    expect(md).toContain(`<a href="/notes/${ID}"`);
    expect(md).not.toContain(`](/notes/${ID})`);
  });
});
