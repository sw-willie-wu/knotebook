import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor, markdownToHTML } from "@blocknote/core";
import type { SiteLinkCandidate } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { replaceBlocksKeepColumns } from "@/collab/columns/keep-columns";
import { createTestEditor } from "@/test/ai-host";
import { IMG, P, integrity, row, shape, withChildren } from "@/test/columns-fixtures";
import { diffBlocks, markOf } from "@/lib/version-diff";
import { blockSnapshot, captureAnchor, verifyAnchor } from "./anchor";
import { buildPreview } from "./preview";
import { anchorPlacement, applyAiResult, hasNonTextBlock, prepareAiResult, revertAiResult, type PreparedResult } from "./apply";

// 與 server `note-markdown-goldens.test.ts` 共用的 golden（web 的 vitest 下 `import.meta.url` 不是 file:，從 apps/web 根目錄算）。
const goldens = JSON.parse(readFileSync(`${process.cwd()}/../../packages/shared/test-fixtures/note-markdown-goldens.json`, "utf8")) as {
  cases: { id: string; markdown: string }[];
};
const golden = (id: string): string => {
  const c = goldens.cases.find((x) => x.id === id);
  if (!c) throw new Error(`找不到 golden ${id}`);
  return c.markdown;
};

// 包一層照呼叫原實作的 spy（斷言寫入的陣列身分）；不用 automock——那會讓同檔真編輯器案的寫入變成什麼都不做。
vi.mock("@/collab/columns/keep-columns", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/collab/columns/keep-columns")>();
  return { ...m, replaceBlocksKeepColumns: vi.fn(m.replaceBlocksKeepColumns) };
});
beforeEach(() => {
  vi.mocked(replaceBlocksKeepColumns).mockReset(); // 不可寫成箭頭直接回傳：beforeEach 回傳的函式會被當成 teardown 呼叫；mockReset 連 mockImplementationOnce 佇列一起清，並還原成包裝的原實作
});

// ⚠ 自我審查發現（不在 brief 的逐字程式碼裡，brief 只驗過 anchor/apply 邏輯本身；
// fix round 1 M-1 已用 fetch spy probe 驗證下述因果，見 task-1-report.md）：
// wikilink 是用 `createReactInlineContentSpec` 蓋的 React inline content。ProseMirror
// 在**掛載中**（非 headless）的編輯器插入這類節點時，會同步走
// `ReactInlineContentSpec.tsx` 的 `renderHTML`（Tiptap node spec 的 `toDOM`，用於
// NodeViewDesc 初始 DOM shell，不是互動渲染），該函式選 Content 的順序是
// `toExternalHTML || render`（`ReactInlineContentSpec.tsx:152-154`）——本專案的
// `wikilinkSpec` 有掛 `toExternalHTML`（`WikilinkExternalHTML`，純函式、零 hook，
// 見 `components/wikilink/spec.tsx`），所以這條路徑渲染的**不是**互動用的
// `WikilinkInline`（那支才讀 `useNotes()`/`useNavigate()`/`useTranslation()`）。
// `renderHTML` 內部再呼叫 `renderToDOMSpec`（`@blocknote/react/.../ReactRenderUtil.ts`），
// 該函式只認 `editor.elementRenderer`（由正式的 `<BlockNoteView>` 元件透過
// `withReactContext` 掛上）；`editor.headless` 掛載後是 `false`，`elementRenderer`
// 是 `null` 時就直接丟 `Error: elementRenderer not available, expected headless
// editor`。brief 給的 harness 只 `editor.mount(el)`，沒有渲染 `<BlockNoteView>`，因此
// 需要補上這個 shim；但因為實際渲染的是無 hook 的 `toExternalHTML`，shim 只需要滿足
// `renderToDOMSpec` 對「非 null」的檢查、把節點同步塞進 DOM 即可，**不需要**
// `QueryClientProvider`／`MemoryRouter`／`fetch` stub（fix round 1 前的版本誤判了這點，
// 用 fetch spy 探測過：wikilink 重綁測試全程 `fetch` 呼叫次數＝0，8 個測試拿掉這些
// context/stub 後全數照樣通過）。這是**測試 harness 的補強**，不改動任何一條測試斷言。
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- initialContent 走 BlockNote 泛型三元組最寬型別，同 brief 原始碼與 repo 慣例
function mountedEditor(initial?: any[]) {
  const editor = BlockNoteEditor.create({ schema: noteSchema, initialContent: initial });
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.elementRenderer = (node: unknown, container: HTMLElement) =>
    flushSync(() => createRoot(container).render(node as never));
  return editor;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
function prep(editor: any, markdown: string, notes: SiteLinkCandidate[] = []): PreparedResult {
  const prepared = prepareAiResult(editor, markdown, { notes, placement: "top" });
  if ("empty" in prepared || "invalid" in prepared) throw new Error("預期非空結果");
  return prepared;
}

describe("AI 套用鏈（spec §13.3）", () => {
  it("套用：markdown 結果替換錨定 blocks，回傳插入 ids 與被替換快照", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文一" }, { type: "paragraph", content: "原文二" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    const out = applyAiResult(editor, anchor, prep(editor, "改寫後的第一段\n\n改寫後的第二段"));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.insertedIds.length).toBeGreaterThan(0);
    expect(out.replacedSnapshot).toHaveLength(2);
    const text = JSON.stringify(editor.document);
    expect(text).toContain("改寫後的第一段");
    expect(text).not.toContain("原文一");
  });

  it("守門1：錨點 block 被刪 → {ok:false, reason:'missing'}，文件不變", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }, { type: "paragraph", content: "乙" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    editor.removeBlocks([ids[0]]);
    const before = JSON.stringify(editor.document);
    const out = applyAiResult(editor, anchor, prep(editor, "任何結果"));
    expect(out).toEqual({ ok: false, reason: "missing" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("守門2：錨點 block 內容被改 → {ok:false, reason:'changed'}，文件不變", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }]);
    const id = editor.document[0].id;
    const anchor = captureAnchor(editor, "note-1", [id]);
    editor.updateBlock(id, { content: "被協作者改掉了" });
    const out = applyAiResult(editor, anchor, prep(editor, "任何結果"));
    expect(out).toEqual({ ok: false, reason: "changed" });
  });

  it("revert：取代(插入ids, 快照) 還原原文；插入 block 被改/被刪後 revert 皆回 'stale' 且不動文件", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const out = applyAiResult(editor, anchor, prep(editor, "新文"));
    if (!out.ok) throw new Error("apply 應成功");
    const inserted = captureAnchor(editor, "note-1", out.insertedIds); // 套用後立刻存插入錨點（Task 6 同款）
    expect(revertAiResult(editor, inserted, out.replacedSnapshot)).toBe("ok");
    expect(JSON.stringify(editor.document)).toContain("原文");
    // 再套一次後「內容被改」→ stale 且文件不變
    const anchor2 = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const out2 = applyAiResult(editor, anchor2, prep(editor, "新文二"));
    if (!out2.ok) throw new Error("apply 應成功");
    const inserted2 = captureAnchor(editor, "note-1", out2.insertedIds);
    editor.updateBlock(out2.insertedIds[0], { content: "他人改動" });
    const before = JSON.stringify(editor.document);
    expect(revertAiResult(editor, inserted2, out2.replacedSnapshot)).toBe("stale");
    expect(JSON.stringify(editor.document)).toBe(before);
    // 「被刪」→ stale
    editor.removeBlocks([out2.insertedIds[0]]);
    expect(revertAiResult(editor, inserted2, out2.replacedSnapshot)).toBe("stale");
  });

  it("wikilink 重綁三態：唯一命中→wikilink 節點；零/多重命中→純文字保留＋unboundCount", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "上下文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const notes: SiteLinkCandidate[] = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", title: "產品規劃", slug: "plan", groupId: null, ownerHandle: "alice" },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", title: "重複標題", slug: "dup-1", groupId: null, ownerHandle: "alice" },
      { id: "aaaaaaaa-0000-0000-0000-000000000003", title: "重複標題", slug: "dup-2", groupId: null, ownerHandle: "alice" },
    ];
    const p = prep(editor, "見 [[產品規劃]] 與 [[重複標題]] 及 [[不存在]]", notes);
    const out = applyAiResult(editor, anchor, p);
    if (!out.ok) throw new Error("apply 應成功");
    const doc = JSON.stringify(editor.document);
    expect(doc).toContain('"wikilink"');
    expect(doc).toContain("aaaaaaaa-0000-0000-0000-000000000001");
    expect(doc).toContain("[[重複標題]]"); // 多重命中→純文字
    expect(doc).toContain("[[不存在]]");   // 零命中→純文字
    expect(p.unboundCount).toBe(2);
  });

  // fix round 1 I-1：codeBlock 的 content 型態是 "plain"，但 parse 出來的節點形狀跟
  // inline content 的 paragraph 一樣是 `{type:"text"}[]` 陣列——重綁若只憑
  // `Array.isArray` 判斷會把 code fence 裡剛好命中的 `[[X]]` 也换成 wikilink inline
  // node，塞進不接受 inline content 的 block。
  it("重綁跳過 plain-content block：code block 內的 [[X]]（唯一命中）保持純文字、不計入 unboundCount", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "上下文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const notes: SiteLinkCandidate[] = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "產品規劃", slug: "plan", groupId: null, ownerHandle: "alice" }];
    const p = prep(editor, "```\n見 [[產品規劃]]\n```", notes);
    const out = applyAiResult(editor, anchor, p);
    if (!out.ok) throw new Error("apply 應成功");
    const doc = JSON.stringify(editor.document);
    expect(doc).toContain('"codeBlock"');
    expect(doc).not.toContain('"wikilink"');
    expect(doc).toContain("[[產品規劃]]");
    expect(p.unboundCount).toBe(0);
  });

  // fix round 1 I-2：`tryParseMarkdownToBlocks` 對空／純空白 markdown 實測回傳單一空
  // 段落（不是 `[]`，見 apply.ts `isBlankParseResult` 的實測註記）——不擋的話
  // `replaceBlocks` 會把使用者原本的段落換成空段落、卻回報 ok。
  it("空結果：空字串／純空白 markdown → prepareAiResult 回 {empty:true}，不碰文件", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別刪我" }]);
    const before = JSON.stringify(editor.document);
    expect(prepareAiResult(editor, "", { notes: [], placement: "top" })).toEqual({ empty: true });
    expect(prepareAiResult(editor, "   \n  \n", { notes: [], placement: "top" })).toEqual({ empty: true });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  // 並排 PR-2（spec §11.6 第 1 點、§11.3、Q6）：AI 結果走與 MCP 相同的語法＋結構檢查；目標不在頂層（"nested"）時不收任何並排。
  const ROW2 = golden("G1-cols-spec");
  it("GA1：正規形兩欄、placement top → PreparedResult，一列兩欄、欄寬 [1, 1.5]", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, ROW2, { notes: [], placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    expect(p.blocks).toHaveLength(1);
    expect(p.blocks[0]!.type).toBe("columnList");
    expect(p.blocks[0]!.children.map((c) => (c.props as { width: number }).width)).toEqual([1, 1.5]);
  });

  it("GA2：同一段、placement nested → { invalid: unsupported_columns }，文件不變", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const before = JSON.stringify(editor.document);
    expect(prepareAiResult(editor, ROW2, { notes: [], placement: "nested" })).toEqual({ invalid: "unsupported_columns" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("GA3：不含並排的 markdown 照舊回 PreparedResult", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, "# T\n\n- a\n- b", { notes: [], placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    expect(p.blocks.map((b) => b.type)).toEqual(["heading", "bulletListItem", "bulletListItem"]);
  });

  it("GA4：孤立的 columnList／column（parse 結果被換掉）→ 結構檢查擋下 unsupported_columns", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    for (const type of ["columnList", "column"]) {
      const spy = vi.spyOn(editor, "tryParseHTMLToBlocks").mockReturnValue([{ id: "c", type, props: { width: 1 }, children: [] }] as never);
      try {
        expect(prepareAiResult(editor, "x", { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_columns" });
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("GA5：裸 <img width>（不在 figure 裡）→ unsupported_size", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    expect(prepareAiResult(editor, '<img src="/x" width="300">', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_size" });
  });

  it("GA6：其他 div 用 display:flex 排版 → unsupported_columns", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    expect(prepareAiResult(editor, '<div style="display:flex">x</div>', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_columns" });
  });

  it("GA9：core parse 丟例外的輸入（編輯器內部形 data-content-type）→ { invalid: unsupported_block }，不往外拋、文件不變", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const md = '<div data-content-type="paragraph">x</div>';
    expect(() => editor.tryParseHTMLToBlocks(markdownToHTML(md))).toThrow(); // fixture 自檢：jsdom 上 core 真的丟
    const before = JSON.stringify(editor.document);
    expect(prepareAiResult(editor, md, { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_block" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  // final review Nit 1：core 剖析 <details> 時把子節點 clone 進活文件，瀏覽器裡 <img onerror> 會觸發——語法檢查先擋，不進 core parse
  it("GA10：<details> 內、figure 內的 <img onerror> → { invalid: unsupported_block }，core parse 沒被呼叫；top 與 nested 同", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const parse = vi.spyOn(editor, "tryParseHTMLToBlocks");
    try {
      for (const md of [
        '<details><summary>s</summary><img src="x" onerror="alert(1)"></details>',
        '<figure><img alt="a" src="/x" width="300" onerror="alert(1)"></figure>',
      ]) {
        for (const placement of ["top", "nested"] as const) {
          expect(prepareAiResult(editor, md, { notes: [], placement })).toEqual({ invalid: "unsupported_block" });
        }
      }
      expect(parse).not.toHaveBeenCalled();
      expect(prepareAiResult(editor, '<figure><img alt="a" src="/x" width="300"></figure>', { notes: [], placement: "top" })).not.toHaveProperty("invalid");
    } finally {
      parse.mockRestore();
    }
  });

  // 同 server 管線（#94）：```mermaid 的 codeBlock 還原成 mermaid block，否則 AI 套回會把圖變成程式碼區塊
  const FENCE = "```mermaid\ngraph TD; A-->B\n```";
  const mermaidOf = (markdown: string, placement: "top" | "nested") => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, markdown, { notes: [], placement });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    return p.blocks;
  };
  it("MM1：頂層 ```mermaid fence → mermaid block（code 逐字）", () => {
    const blocks = mermaidOf(FENCE, "top");
    expect(blocks.map((b) => b.type)).toEqual(["mermaid"]);
    expect(blocks[0]!.props).toEqual({ code: "graph TD; A-->B" });
  });

  it("MM2：列的欄內有 mermaid fence（錨點頂層）→ 欄內是 mermaid block；錨點在欄內、AI 回 fence（nested）→ mermaid block", () => {
    const rowMd = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\n${FENCE}\n\n</div>\n<div data-kb-column style="flex:1">\n\nB\n\n</div>\n</div>`;
    const [list] = mermaidOf(rowMd, "top");
    expect(list!.type).toBe("columnList");
    expect(list!.children[0]!.children.map((b) => [b.type, b.props])).toEqual([["mermaid", { code: "graph TD; A-->B" }]]);
    expect(mermaidOf(FENCE, "nested").map((b) => b.type)).toEqual(["mermaid"]);
  });

  it("MM4（review r1 M1）：AI 沒改的圖在預覽 diff 裡是 context（還原後保留 parse 給的 id 才配得到）", () => {
    const CODE = "graph TD; A-->B";
    const editor = mountedEditor([P("old words", "p1"), { id: "m", type: "mermaid", props: { code: CODE } }, P("tail", "p3")]);
    const p = prep(editor, "new words\n\n```mermaid\n" + CODE + "\n```\n\ntail");
    expect(typeof p.blocks[1]!.id).toBe("string");
    const preview = buildPreview(editor, ["p1", "m", "p3"], p.blocks, false);
    const marks = diffBlocks(preview.before as never, preview.after as never).filter((e) => (e.after ?? e.before)?.type === "mermaid").map(markOf);
    expect(marks).toEqual(["context"]);
  });

  it("GA7（Q2）：合併表頭只設一欄寬（colwidth=\"120,\"）→ PreparedResult，columnWidths 第二項是 undefined（不是 NaN）", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const p = prepareAiResult(editor, golden("G3-table-colspan-partial"), { notes: [], placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
    const ws = (p.blocks[0]!.content as { columnWidths: unknown[] }).columnWidths;
    expect(ws).toHaveLength(3);
    expect(ws[0]).toBe(120);
    expect(Object.is(ws[1], undefined)).toBe(true);
    expect(ws[2]).toBe(80);
  });

  it("GA8（讀碼發現 15）：收合標題底下的站內上傳圖片 → url 還原成相對形；同形外站網址原樣不動", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別動我" }]);
    const md = golden("G2-img-in-toggle-heading");
    const urlOf = (markdown: string): unknown => {
      const p = prepareAiResult(editor, markdown, { notes: [], placement: "top" });
      if ("empty" in p || "invalid" in p) throw new Error("預期 PreparedResult");
      return p.blocks[0]!.children[0]!.props.url;
    };
    expect(urlOf(md)).toBe("/api/uploads/00000000-0000-4000-8000-000000000001");
    const external = "https://other.example/api/uploads/00000000-0000-4000-8000-000000000001";
    expect(urlOf(md.replace('src="/api/uploads/', 'src="https://other.example/api/uploads/'))).toBe(external);
  });

  it("PL1：anchorPlacement——頂層 → top；欄內 → nested；縮排子 block → nested；頂層段落＋頂層列 → top；頂層＋欄內 → nested", () => {
    const editor = mountedEditor([P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r"), withChildren(P("p", "p"), [P("c", "c1")])]);
    expect(anchorPlacement(editor, ["x"])).toBe("top");
    expect(anchorPlacement(editor, ["a1"])).toBe("nested");
    expect(anchorPlacement(editor, ["c1"])).toBe("nested");
    expect(anchorPlacement(editor, ["x", "r"])).toBe("top");
    expect(anchorPlacement(editor, ["x", "a1"])).toBe("nested");
  });

  it("#263：applyAiResult 寫進文件的就是 prepared.blocks 這個陣列（同一物件，預覽與寫入同一份）", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const prepared = prep(editor, "新文");
    const out = applyAiResult(editor, anchor, prepared);
    expect(vi.mocked(replaceBlocksKeepColumns).mock.calls[0]?.[2]).toBe(prepared.blocks);
    expect(out.ok).toBe(true);
  });

  // 同列另一欄是空的：core 的 fixColumnList 會刪掉所有空欄、把剩一欄的列攤平——D25 不收。
  it("AP1（D25）：錨點是欄內唯一 block → 套用與撤回都不收欄", () => {
    const editor = mountedEditor([P("x", "x"), row([[P("原文", "b")], [P("", "e")]], "r"), P("z", "z")]);
    const anchor = captureAnchor(editor, "note-1", ["b"]);
    const out = applyAiResult(editor, anchor, prep(editor, "新一\n\n新二"));
    if (!out.ok) throw new Error("apply 應成功");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:新一,paragraph:新二) | COL(paragraph)]  paragraph:z");
    const inserted = captureAnchor(editor, "note-1", out.insertedIds);
    expect(revertAiResult(editor, inserted, out.replacedSnapshot)).toBe("ok");
    expect(shape(editor)).toBe("paragraph:x  ROW[COL(paragraph:原文) | COL(paragraph)]  paragraph:z");
  });

  it("hasNonTextBlock：image block 在錨點內 → true（降級 preview 判定）", () => {
    const editor = mountedEditor([
      { type: "paragraph", content: "文" },
      { type: "image", props: { url: "https://example.com/a.png" } },
    ]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    expect(hasNonTextBlock(editor, ids)).toBe(true);
    expect(hasNonTextBlock(editor, [ids[0]])).toBe(false);
  });

  it("HN1：hasNonTextBlock 看錨點的子孫——列的第 2 欄有 image → true；段落底下縮排 image → true；只有文字的列 → false", () => {
    const editor = mountedEditor([
      row([[P("a", "a1")], [P("b", "b1"), IMG("i1")]], "r"),
      withChildren(P("p", "p"), [IMG("i2")]),
      row([[P("c", "c1")], [P("d", "d1")]], "t"),
    ]);
    expect(hasNonTextBlock(editor, ["r"])).toBe(true);
    expect(hasNonTextBlock(editor, ["p"])).toBe(true);
    expect(hasNonTextBlock(editor, ["t"])).toBe(false);
    expect(hasNonTextBlock(editor, ["gone"])).toBe(false); // 錨點在串流期間被刪：不丟（否則 finish 會在這裡炸）
  });

  // T6 review r1 I1：守門 verifyAnchor 只比內容不比位置；預覽期間錨點換了位置，套用前以現在的位置重驗結構（Q6）。
  const ROW_AB = `<div data-kb-columns style="display:flex;gap:16px">\n<div data-kb-column style="flex:1">\n\nA\n\n</div>\n<div data-kb-column style="flex:1.5">\n\nB\n\n</div>\n</div>`;
  const clean = { dupIds: 0, nullIds: 0, nestedRows: 0, valid: true };
  it("AP-Q6a：預覽期間把頂層錨點縮排（Tab／nestBlock）→ 套用回 changed、文件不變、沒有巢狀列；不含並排的結果照常套用", () => {
    const editor = mountedEditor([P("prev", "p0"), P("x", "x")]);
    const prepared = prep(editor, ROW_AB);
    const plain = prep(editor, "plain");
    const anchor = captureAnchor(editor, "note-1", ["x"]);
    editor.setTextCursorPosition("x", "end");
    editor.nestBlock();
    expect(anchorPlacement(editor, ["x"])).toBe("nested"); // fixture 自檢：真的縮排了
    const before = JSON.stringify(editor.document);
    expect(applyAiResult(editor, anchor, prepared)).toEqual({ ok: false, reason: "changed" });
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(integrity(editor)).toEqual(clean);
    expect(applyAiResult(editor, anchor, plain).ok).toBe(true);
    expect(shape(editor)).toBe("paragraph:prev{paragraph:plain}");
  });

  it("AP-Q6b：預覽期間把頂層錨點搬進欄 → 套用回 changed、文件不變、沒有巢狀列／重複 id／空 id", () => {
    const editor = mountedEditor([P("x", "x"), row([[P("a", "a1")], [P("b", "b1")]], "r")]);
    const prepared = prep(editor, ROW_AB);
    const anchor = captureAnchor(editor, "note-1", ["x"]);
    const xb = editor.getBlock("x")!;
    editor.transact(() => {
      editor.removeBlocks(["x"]);
      editor.insertBlocks([xb], "a1", "after");
    });
    expect(editor.getParentBlock("x")?.type).toBe("column"); // fixture 自檢
    const before = JSON.stringify(editor.document);
    expect(applyAiResult(editor, anchor, prepared)).toEqual({ ok: false, reason: "changed" });
    expect(JSON.stringify(editor.document)).toBe(before);
    expect(integrity(editor)).toEqual(clean);
  });

  // T6 review r1 M2：同 MCP（#222），不在色盤的色值整筆拒絕
  it("GA-C1：文字色是 #hex（parse 成 rgb()）→ unsupported_color", () => {
    const editor = mountedEditor([P("別動我")]);
    expect(prepareAiResult(editor, '<span style="color:#ff0000">x</span>', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_color" });
  });

  it("GA-C2：底色是 CSS 合法但不在色盤的色名 → unsupported_color；色盤內的色名照收", () => {
    const editor = mountedEditor([P("別動我")]);
    expect(prepareAiResult(editor, '<p data-background-color="chartreuse">x</p>', { notes: [], placement: "top" })).toEqual({ invalid: "unsupported_color" });
    const ok = prepareAiResult(editor, '<p data-background-color="red">x</p>', { notes: [], placement: "top" });
    expect("blocks" in ok && ok.blocks[0]!.props.backgroundColor).toBe("red");
  });

  it("GA-C3（T6 re-review Na）：parse 結果是單一帶色盤外底色的空段落 → unsupported_color（同 server：色值檢查在空判準之前）；色盤內底色仍是 empty", () => {
    const editor = mountedEditor([P("別動我")]);
    // 事實釘：core 0.52.1 parse 空 <p> 時丟掉段落、補一個預設 props 的空段落，所以真的 markdown 走不到「空且帶色」——以 spy 造 parse 結果（同 GA4）
    expect(prepareAiResult(editor, '<p data-background-color="chartreuse"></p>', { notes: [], placement: "top" })).toEqual({ empty: true });
    for (const [color, expected] of [
      ["chartreuse", { invalid: "unsupported_color" }],
      ["red", { empty: true }],
    ] as const) {
      const spy = vi.spyOn(editor, "tryParseHTMLToBlocks").mockReturnValue([{ id: "e", type: "paragraph", props: { backgroundColor: color }, content: [], children: [] }] as never);
      try {
        expect(prepareAiResult(editor, "x", { notes: [], placement: "top" })).toEqual(expected);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    }
  });

  it("blockSnapshot：同一 block 兩次呼叫字串相等；block 不存在回 null", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "穩定" }]);
    const id = editor.document[0].id;
    expect(blockSnapshot(editor, id)).toBe(blockSnapshot(editor, id));
    expect(blockSnapshot(editor, "no-such-id")).toBeNull();
  });

  it("verifyAnchor 三態：ok／missing／changed（Task 6 revert 鈕啟用判定逐字依賴的公開介面）", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }, { type: "paragraph", content: "乙" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    expect(verifyAnchor(editor, anchor)).toBe("ok");
    editor.updateBlock(ids[1], { content: "被改" });
    expect(verifyAnchor(editor, anchor)).toBe("changed");
    editor.removeBlocks([ids[0]]);
    expect(verifyAnchor(editor, anchor)).toBe("missing");
  });
});

describe("#269 W10：站內連結 → wikilink（快取命中才轉，沒有後備）", () => {
  const notes2: SiteLinkCandidate[] = [
    { id: "11111111-1111-4111-8111-111111111111", title: "Alpha", slug: "alpha", groupId: null, ownerHandle: "alice" },
  ];
  it("[文字](/notes/<id>)、/n/ 現行網址、表格內 → wikilink；快取裡沒有的維持一般連結；預覽與寫入同一份 blocks", () => {
    const editor = createTestEditor([{ id: "p", type: "paragraph", content: "x" }]);
    const p = prepareAiResult(
      editor,
      `see [Alpha](/notes/${notes2[0]!.id}#b-h1) and [mine](/n/alice/alpha) and [gone](/n/alice/missing)\n\n| a |\n| --- |\n| [t](/n/alice/alpha) |`,
      { notes: notes2, siteOrigin: window.location.origin, placement: "top" },
    );
    if ("empty" in p || "invalid" in p) throw new Error("empty");
    const json = JSON.stringify(p.blocks);
    expect(json.match(/"type":"wikilink"/g)).toHaveLength(3);
    expect(json).toContain('"anchorBlockId":"h1"');
    expect(json).toContain('"label":"mine"');
    expect(json).toContain('"href":"/n/alice/missing"');
  });

  it("RF1：AI 回寫的跳脫連結文字（我們送出的形）解回原字串——label 逐字保留、文字等於現行標題時 label 為空", () => {
    const editor = createTestEditor([{ id: "p", type: "paragraph", content: "x" }]);
    const id = notes2[0]!.id;
    const titled: SiteLinkCandidate[] = [{ ...notes2[0]!, title: "[Draft] Plan *v2*" }];
    const p = prepareAiResult(editor, `a [\\[Draft\\] Plan \\*v2\\*](/notes/${id}) b [a\\]b\\\\](/notes/${id}) c`, { notes: titled, siteOrigin: window.location.origin, placement: "top" });
    if ("empty" in p || "invalid" in p) throw new Error("empty");
    const links = (p.blocks[0]!.content as Array<{ type: string; props?: Record<string, string> }>).filter((n) => n.type === "wikilink");
    expect(links.map((n) => n.props!.label)).toEqual(["", "a]b\\"]);
    expect(links.map((n) => n.props!.snapshotTitle)).toEqual(["[Draft] Plan *v2*", "a]b\\"]);
  });
});
