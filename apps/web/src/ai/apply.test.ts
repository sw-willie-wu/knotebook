import { describe, expect, it } from "vitest";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BlockNoteEditor } from "@blocknote/core";
import { noteSchema } from "@/collab/schema";
import { blockSnapshot, captureAnchor, verifyAnchor } from "./anchor";
import { applyAiResult, hasNonTextBlock, revertAiResult } from "./apply";

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

describe("AI 套用鏈（spec §13.3）", () => {
  it("套用：markdown 結果替換錨定 blocks，回傳插入 ids 與被替換快照", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文一" }, { type: "paragraph", content: "原文二" }]);
    const ids = editor.document.slice(0, 2).map((b) => b.id);
    const anchor = captureAnchor(editor, "note-1", ids);
    const out = applyAiResult(editor, anchor, "改寫後的第一段\n\n改寫後的第二段", { notes: [] });
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
    const out = applyAiResult(editor, anchor, "任何結果", { notes: [] });
    expect(out).toEqual({ ok: false, reason: "missing" });
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("守門2：錨點 block 內容被改 → {ok:false, reason:'changed'}，文件不變", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "甲" }]);
    const id = editor.document[0].id;
    const anchor = captureAnchor(editor, "note-1", [id]);
    editor.updateBlock(id, { content: "被協作者改掉了" });
    const out = applyAiResult(editor, anchor, "任何結果", { notes: [] });
    expect(out).toEqual({ ok: false, reason: "changed" });
  });

  it("revert：replaceBlocks(插入ids, 快照) 還原原文；插入 block 被改/被刪後 revert 皆回 'stale' 且不動文件", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "原文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const out = applyAiResult(editor, anchor, "新文", { notes: [] });
    if (!out.ok) throw new Error("apply 應成功");
    const inserted = captureAnchor(editor, "note-1", out.insertedIds); // 套用後立刻存插入錨點（Task 6 同款）
    expect(revertAiResult(editor, inserted, out.replacedSnapshot)).toBe("ok");
    expect(JSON.stringify(editor.document)).toContain("原文");
    // 再套一次後「內容被改」→ stale 且文件不變
    const anchor2 = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const out2 = applyAiResult(editor, anchor2, "新文二", { notes: [] });
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
    const notes = [
      { id: "aaaaaaaa-0000-0000-0000-000000000001", title: "產品規劃" },
      { id: "aaaaaaaa-0000-0000-0000-000000000002", title: "重複標題" },
      { id: "aaaaaaaa-0000-0000-0000-000000000003", title: "重複標題" },
    ];
    const out = applyAiResult(editor, anchor, "見 [[產品規劃]] 與 [[重複標題]] 及 [[不存在]]", { notes });
    if (!out.ok) throw new Error("apply 應成功");
    const doc = JSON.stringify(editor.document);
    expect(doc).toContain('"wikilink"');
    expect(doc).toContain("aaaaaaaa-0000-0000-0000-000000000001");
    expect(doc).toContain("[[重複標題]]"); // 多重命中→純文字
    expect(doc).toContain("[[不存在]]");   // 零命中→純文字
    expect(out.unboundCount).toBe(2);
  });

  // fix round 1 I-1：codeBlock 的 content 型態是 "plain"，但 parse 出來的節點形狀跟
  // inline content 的 paragraph 一樣是 `{type:"text"}[]` 陣列——重綁若只憑
  // `Array.isArray` 判斷會把 code fence 裡剛好命中的 `[[X]]` 也换成 wikilink inline
  // node，塞進不接受 inline content 的 block。
  it("重綁跳過 plain-content block：code block 內的 [[X]]（唯一命中）保持純文字、不計入 unboundCount", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "上下文" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const notes = [{ id: "aaaaaaaa-0000-0000-0000-000000000001", title: "產品規劃" }];
    const out = applyAiResult(editor, anchor, "```\n見 [[產品規劃]]\n```", { notes });
    if (!out.ok) throw new Error("apply 應成功");
    const doc = JSON.stringify(editor.document);
    expect(doc).toContain('"codeBlock"');
    expect(doc).not.toContain('"wikilink"');
    expect(doc).toContain("[[產品規劃]]");
    expect(out.unboundCount).toBe(0);
  });

  // fix round 1 I-2：`tryParseMarkdownToBlocks` 對空／純空白 markdown 實測回傳單一空
  // 段落（不是 `[]`，見 apply.ts `isBlankParseResult` 的實測註記）——不擋的話
  // `replaceBlocks` 會把使用者原本的段落換成空段落、卻回報 ok。
  it("空結果守門：空字串／純空白 markdown → {ok:false, reason:'empty'}，文件不變", () => {
    const editor = mountedEditor([{ type: "paragraph", content: "別刪我" }]);
    const anchor = captureAnchor(editor, "note-1", [editor.document[0].id]);
    const before = JSON.stringify(editor.document);

    const outEmpty = applyAiResult(editor, anchor, "", { notes: [] });
    expect(outEmpty).toEqual({ ok: false, reason: "empty" });
    expect(JSON.stringify(editor.document)).toBe(before);

    const outBlank = applyAiResult(editor, anchor, "   \n  \n", { notes: [] });
    expect(outBlank).toEqual({ ok: false, reason: "empty" });
    expect(JSON.stringify(editor.document)).toBe(before);
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
