import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { QueryClient } from "@tanstack/react-query";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { collabUndoManager } from "@/collab/undo";
import { attachTestElementRenderer } from "@/test/element-renderer";
import type { AnyEditor } from "@/test/columns-fixtures";
import { buildSampleBlocks, createSampleNote, seedSampleNote } from "./sample-note";

const t = i18n.getFixedT("en");
const NOTE = { id: "11111111-1111-4111-8111-111111111111", title: t("tourGuide.sample.title") };

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

/** 帶 `Y.Doc` 共編的真編輯器（不需要 provider）；沒有 collaboration 的編輯器走 prosemirror-history，不是線上那條路徑。 */
function mountCollab(doc: Y.Doc): AnyEditor {
  const editor = BlockNoteEditor.create(
    withCollaboration({
      schema: noteSchema,
      collaboration: {
        provider: { awareness: undefined },
        fragment: doc.getXmlFragment(YDOC_FRAGMENT),
        user: { id: "u1", name: "User 1", color: "hsl(0 65% 45%)" },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
    } as any),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
  ) as any as AnyEditor;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  attachTestElementRenderer(editor); // 連結的 toDOM 要它
  cleanups.push(() => {
    editor.unmount();
    el.remove();
    doc.destroy();
  });
  return editor;
}

/** 一篇剛建好的空筆記：文件已同步、只有一個空段落。 */
async function mountEmptyNote(): Promise<{ editor: AnyEditor; doc: Y.Doc }> {
  const doc = new Y.Doc();
  const editor = mountCollab(doc);
  await tick();
  return { editor, doc };
}

const types = (editor: AnyEditor) => (editor.document as { type: string }[]).map((b) => b.type);

const BLOCK_TYPES_WITH_AI = [
  "paragraph",
  "heading",
  "bulletListItem",
  "bulletListItem",
  "numberedListItem",
  "numberedListItem",
  "checkListItem",
  "checkListItem",
  "quote",
  "codeBlock",
  "paragraph",
  "columnList",
  "mermaid",
  "table",
  "paragraph",
  "paragraph",
];
// 沒開 AI：少了倒數第二段的 AI 句
const BLOCK_TYPES = BLOCK_TYPES_WITH_AI.filter((_, i) => i !== BLOCK_TYPES_WITH_AI.length - 2);

describe("createSampleNote", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ ...NOTE }) } as unknown as Response);
    vi.stubGlobal("fetch", fetchMock);
  });

  it("只打一次 POST /api/notes，body 只有 title；成功後筆記清單被重抓", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const note = await createSampleNote(queryClient, t);
    expect(note.id).toBe(NOTE.id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/notes");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ title: t("tourGuide.sample.title") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes"] });
  });

  it("標題依目前介面語言", async () => {
    const tZh = i18n.getFixedT("zh-TW");
    await createSampleNote(new QueryClient(), tZh);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ title: tZh("tourGuide.sample.title") });
    expect(tZh("tourGuide.sample.title")).not.toBe(t("tourGuide.sample.title"));
  });

  it("POST 失敗 → 拋出錯誤、不重抓清單", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
    } as unknown as Response);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await expect(createSampleNote(queryClient, t)).rejects.toMatchObject({ status: 500 });
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe("seedSampleNote", () => {
  it("空筆記 → 寫入，回傳 true，block 種類依序如預期", async () => {
    const { editor } = await mountEmptyNote();
    expect(seedSampleNote(editor, NOTE, t, true)).toBe(true);
    expect(types(editor)).toEqual(BLOCK_TYPES_WITH_AI);
  });

  it("文件已經有內容 → 什麼都不做，回傳 false", async () => {
    const { editor } = await mountEmptyNote();
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "已經有字" }]);
    const before = JSON.stringify(editor.document);
    expect(seedSampleNote(editor, NOTE, t, true)).toBe(false);
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("沒開 AI → 寫入時不放 AI 句，其餘內容不變，最後仍是空段落", async () => {
    const { editor } = await mountEmptyNote();
    expect(seedSampleNote(editor, NOTE, t, false)).toBe(true);
    expect(types(editor)).toEqual(BLOCK_TYPES);
    expect(JSON.stringify(editor.document)).not.toContain(t("tourGuide.sample.aiSentence"));
    const withAi = buildSampleBlocks(t, NOTE, true);
    const withoutAi = buildSampleBlocks(t, NOTE, false);
    expect(withoutAi).toEqual(withAi.filter((_, i) => i !== withAi.length - 2));
    expect(withoutAi[withoutAi.length - 1]).toEqual({ type: "paragraph" });
  });

  it.each([
    ["只有一個流程圖", [{ type: "mermaid", props: { code: "graph LR\n  A --> B" } }]],
    ["只有一個空標題", [{ type: "heading", props: { level: 2 } }]],
  ])("文件%s（沒有文字的非段落 block）→ 視為有內容，不寫入", async (_name, blocks) => {
    const { editor } = await mountEmptyNote();
    editor.replaceBlocks(editor.document, blocks);
    const before = JSON.stringify(editor.document);
    expect(seedSampleNote(editor, NOTE, t, true)).toBe(false);
    expect(JSON.stringify(editor.document)).toBe(before);
  });

  it("連結指向筆記自己", async () => {
    const { editor } = await mountEmptyNote();
    seedSampleNote(editor, NOTE, t, true);
    const links = (editor.document as { content?: { type: string; props?: Record<string, string> }[] }[])
      .flatMap((b) => (Array.isArray(b.content) ? b.content : []))
      .filter((c) => c.type === "wikilink");
    expect(links).toHaveLength(1);
    expect(links[0]!.props).toMatchObject({ targetNoteId: NOTE.id, snapshotTitle: NOTE.title });
  });

  it("AI 站框選的那句在倒數第二段，最後是空段落", async () => {
    const blocks = buildSampleBlocks(t, NOTE, true);
    const last = blocks[blocks.length - 1]!;
    const sentence = blocks[blocks.length - 2]!;
    expect(last).toEqual({ type: "paragraph" });
    expect(sentence).toMatchObject({ type: "paragraph", content: [{ text: t("tourGuide.sample.aiSentence") }] });
  });

  it("寫入不進撤銷：寫入後撤銷，文件不變", async () => {
    const { editor } = await mountEmptyNote();
    const manager = collabUndoManager(editor)!;
    expect(manager).toBeDefined();
    seedSampleNote(editor, NOTE, t, true);
    expect(manager.undoStack).toHaveLength(0);
    manager.undo();
    expect(types(editor)).toEqual(BLOCK_TYPES_WITH_AI);
  });

  it("寫入是一個交易、一次 Y 更新", async () => {
    const { editor, doc } = await mountEmptyNote();
    await tick();
    const updates: number[] = [];
    doc.on("update", (u: Uint8Array) => updates.push(u.length));
    const view = editor.prosemirrorView!;
    const dispatch = vi.spyOn(view, "dispatch");
    seedSampleNote(editor, NOTE, t, true);
    expect(dispatch.mock.calls.filter(([tr]) => tr.docChanged)).toHaveLength(1);
    expect(updates).toHaveLength(1);
  });

  it("決定要寫入之後、交易開始之前，另一個分頁的字才同步到 → 不寫入、那段字還在", async () => {
    const docA = new Y.Doc();
    const a = mountCollab(docA);
    await tick();
    // 兩邊從同一份空文件開始，免得各自的預設段落合併成兩段
    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
    const b = mountCollab(docB);
    await tick();
    b.setTextCursorPosition(b.document[0]!.id, "end");
    b.prosemirrorView!.dispatch(b.prosemirrorView!.state.tr.insertText("typed elsewhere"));
    await tick();

    // 遠端的字在 `seedSampleNote` 開始執行之後、交易開始之前才到
    const original = a.transact.bind(a);
    vi.spyOn(a, "transact").mockImplementation(((fn: Parameters<typeof original>[0]) => {
      Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
      return original(fn);
    }) as typeof a.transact);

    expect(seedSampleNote(a, NOTE, t, true)).toBe(false);
    expect(types(a)).toEqual(["paragraph"]);
    expect(a.prosemirrorState.doc.textContent).toBe("typed elsewhere");
  });
});
