import { createRef, forwardRef, useImperativeHandle, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { BlockNoteEditor, SuggestionMenu } from "@blocknote/core";
import type { NoteDto } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { buildWikilinkMenuItems, type EditorRef } from "./menu";

// **mount harness**（見 NoteEditor.test.ts 同名章節的長註解）：`BlockNoteEditor.create`
// 後必須 `editor.mount(掛在 document.body 的元素)`，headless 下 `openSuggestionMenu`
// 會直接 early-return（`SuggestionMenu.ts`：`if (editor.headless) return;`），
// `SuggestionMenu` 的 plugin view（`closeMenu`/`clearQuery` 真正生效的地方）也只有
// 真的 mount 才會建起來——「選定候選後 [[+query 被消費」這個案例兩者都要。
//
// **elementRenderer**：`[[` 補全選單的候選項一旦被點擊，`menu.ts` 會呼叫
// `insertWikilink`，把一個真的 wikilink inline node 插進「已掛載、非 headless」的
// 編輯器——`@blocknote/react` 的 `ReactRenderUtil.renderToDOMSpec` 這時要嘛用
// `editor.elementRenderer`（只有 `<BlockNoteView>` 會設定）渲染節點的 React
// 內容，要嘛（`editor.headless` 為 true 時）自己開一個暫時 root；两者都沒有就直接
// 丟 `elementRenderer not available, expected headless editor`。這裡沒有掛
// `<BlockNoteView>`，所以照抄 BlockNote 自己那支沒對外匯出的 `ElementRenderer.tsx`
// （原始碼很短，見 `@blocknote/react/src/editor/ElementRenderer.tsx`），掛進一棵帶
// `QueryClientProvider`/`MemoryRouter` 的 React 樹（`WikilinkInline` 要用
// `useNotes`/`useNavigate`），把它的 imperative handle 接上 `editor.elementRenderer`。
type ElementRendererHandle = (node: ReactNode, container: HTMLElement) => void;

const TestElementRenderer = forwardRef<ElementRendererHandle>((_props, ref) => {
  const [singleRenderData, setSingleRenderData] = useState<{ node: ReactNode; container: HTMLElement } | undefined>();

  useImperativeHandle(
    ref,
    () => (node: ReactNode, container: HTMLElement) => {
      flushSync(() => setSingleRenderData({ node, container }));
      setSingleRenderData(undefined);
    },
    [],
  );

  return singleRenderData ? createPortal(singleRenderData.node, singleRenderData.container) : null;
});
TestElementRenderer.displayName = "TestElementRenderer";

function mountedEditor() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 spec.tsx）
  const editor = BlockNoteEditor.create({ schema: noteSchema }) as BlockNoteEditor<any, any, any>;
  const container = document.createElement("div");
  document.body.appendChild(container);
  editor.mount(container);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // WikilinkInline 三態渲染要靠 `useNotes()` 的快取；這裡不必真的解析出候選筆記
  // （這個檔案不斷言 DOM），塞空陣列讓它落在「resolved 未命中」態、不吊著 pending。
  queryClient.setQueryData(["notes"], []);

  const rendererRef = createRef<ElementRendererHandle>();
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TestElementRenderer ref={rendererRef} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  editor.elementRenderer = rendererRef.current!;

  return { editor, container };
}

function note(overrides: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "n1",
    title: "Meeting Notes",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "meeting-notes",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    ...overrides,
  };
}

const translate = (key: string) => `t:${key}`;

interface WikilinkProps {
  targetNoteId: string;
  snapshotTitle: string;
}

/** 在第一個 block 的 inline content 裡找 wikilink 節點——沒有就回傳 undefined。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 spec.tsx）
function wikilinkIn(editor: BlockNoteEditor<any, any, any>): WikilinkProps | undefined {
  const content: unknown = editor.document[0]?.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const found = content.find(
    (item): item is { type: "wikilink"; props: WikilinkProps } =>
      typeof item === "object" && item !== null && "type" in item && (item as { type: unknown }).type === "wikilink",
  );
  return found?.props;
}

describe("buildWikilinkMenuItems", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（同 spec.tsx）
  let editor: BlockNoteEditor<any, any, any>;
  let container: HTMLElement;
  let editorRef: EditorRef;
  let toast: ReturnType<typeof vi.fn>;
  let createNote: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // useNotes() 的背景 refetch（staleTime 預設 0）不該真的打網路——擋掉，行為同
    // spec.test.tsx 的 beforeEach。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    ({ editor, container } = mountedEditor());
    editorRef = { current: editor };
    toast = vi.fn();
    createNote = vi.fn();
  });

  afterEach(() => {
    editor.unmount();
    container.remove();
    vi.unstubAllGlobals();
  });

  it("候選：標題 substring、case-insensitive 過濾；query 非空時附帶「建立並連結」", () => {
    const notes = [note({ id: "1", title: "Meeting Notes" }), note({ id: "2", title: "Grocery List" })];

    const items = buildWikilinkMenuItems({ query: "meet", notes, createNote, editorRef, translate, toast });

    expect(items.map((item) => item.title)).toEqual(["Meeting Notes", "t:note.wikilink.createAndLink"]);
  });

  it("query 空字串：不顯示「建立並連結」", () => {
    const items = buildWikilinkMenuItems({ query: "", notes: [note()], createNote, editorRef, translate, toast });

    expect(items.map((item) => item.title)).toEqual(["Meeting Notes"]);
  });

  it("editorRef.current 為 null（尚未掛載）：既有筆記 item 的 onItemClick 不炸也不插入", () => {
    editorRef.current = null;
    const items = buildWikilinkMenuItems({
      query: "meet",
      notes: [note()],
      createNote,
      editorRef,
      translate,
      toast,
    });

    expect(() => items[0]!.onItemClick()).not.toThrow();
  });

  it("點擊既有筆記候選 → 在目前選取位置插入 wikilink（insertWikilink）", () => {
    const items = buildWikilinkMenuItems({
      query: "meet",
      notes: [note({ id: "n1", title: "Meeting Notes" })],
      createNote,
      editorRef,
      translate,
      toast,
    });

    items[0]!.onItemClick();

    expect(wikilinkIn(editor)).toEqual({ targetNoteId: "n1", snapshotTitle: "Meeting Notes" });
  });

  it("建立並連結成功：createNote 解析後，在追蹤位置插入新筆記的 wikilink", async () => {
    const created = note({ id: "new-1", title: "Brand New" });
    createNote.mockResolvedValue(created);
    const items = buildWikilinkMenuItems({ query: "brand new", notes: [], createNote, editorRef, translate, toast });
    const item = items.find((i) => i.title === "t:note.wikilink.createAndLink")!;

    item.onItemClick();

    expect(createNote).toHaveBeenCalledWith("brand new");
    await vi.waitFor(() => {
      expect(wikilinkIn(editor)).toEqual({ targetNoteId: "new-1", snapshotTitle: "Brand New" });
    });
    expect(toast).not.toHaveBeenCalled();
  });

  it("建立並連結成功、但等待期間文件在插入點之前發生漂移（他人/自己輸入）：落點跟著 trackPosition 換算，不是點擊當下的絕對位置", async () => {
    // 這個案例是專門戳「trackPosition 到底有沒有真的被拿來用」——如果實作偷懶用
    // 點擊當下讀到的固定絕對位置（而不是 `trackPosition` 回傳的 getter 在 resolve
    // 後重新換算），這裡會斷言失敗（見下方的精確位置驗證）。
    //
    // 佈局：先打「Keep this」，游標（＝點擊當下的插入點）落在它後面。createNote
    // 還在 pending 時，在同一個 block 的最前面插入 "PREFIX-"（模擬等待期間別人
    // 打字/自己移到別處繼續編輯造成的漂移）——如果用的是點擊當下讀到的絕對位置
    // （未經事後換算），插入點就會誤落在被漂移推走前的舊座標，直接切進
    // 「Keep this」中間，把它剖成兩半；用 `trackPosition` 換算過的位置則仍然精確
    // 落在「Keep this」之後，文字不會被切開。
    //
    // 插入點刻意算成「目前選取位置 - 'Keep this'.length」（而不是寫死的 magic
    // number）：BlockNote 的文件結構是 doc > blockGroup > blockContainer >
    // paragraph，文字實際起始的絕對位置會因巢狀深度而變，寫死數字一戳就撞到
    // schema 邊界（試過 `insertText(..., 1)`：那個位置其實落在 blockContainer
    // 的邊界上，不在 paragraph 的 inline content 裡，插入後 ProseMirror 為了滿足
    // schema 反而把它包成獨立新段落，"Keep this" 也不會被剖開，讓這個案例失去意義）。
    editor.insertInlineContent(["Keep this"]);
    const paragraphStart = editor.transact((tr) => tr.selection.from) - "Keep this".length;

    let resolveCreateNote!: (value: NoteDto) => void;
    createNote.mockReturnValue(
      new Promise<NoteDto>((resolve) => {
        resolveCreateNote = resolve;
      }),
    );
    const created = note({ id: "new-1", title: "Brand New" });
    const items = buildWikilinkMenuItems({ query: "brand new", notes: [], createNote, editorRef, translate, toast });
    const item = items.find((i) => i.title === "t:note.wikilink.createAndLink")!;

    item.onItemClick();

    // 漂移：在插入點「之前」、同一個 block 的最前面插入文字，讓原本的絕對位置
    // 整個往後推，但不切開任何既有文字、也不跨 block。
    editor.transact((tr) => tr.insertText("PREFIX-", paragraphStart));

    resolveCreateNote(created);
    await vi.waitFor(() => {
      expect(wikilinkIn(editor)).toEqual({ targetNoteId: "new-1", snapshotTitle: "Brand New" });
    });

    // 精確位置驗證：「Keep this」必須完整保留、緊接在 "PREFIX-" 後面，wikilink（＋
    // insertWikilink 的 trailing space）落在它後面——不是切進「Keep this」中間。
    expect(editor.transact((tr) => tr.doc.textContent)).toBe("PREFIX-Keep this ");
  });

  it("建立並連結失敗：插回純文字 [[query]]，並跳 toast 提示", async () => {
    createNote.mockRejectedValue(new Error("network down"));
    const items = buildWikilinkMenuItems({ query: "brand new", notes: [], createNote, editorRef, translate, toast });
    const item = items.find((i) => i.title === "t:note.wikilink.createAndLink")!;

    item.onItemClick();

    await vi.waitFor(() => {
      expect(editor.transact((tr) => tr.doc.textContent)).toBe("[[brand new]]");
    });
    expect(toast).toHaveBeenCalledWith({ title: "t:note.wikilink.createFailed" });
    expect(wikilinkIn(editor)).toBeUndefined();
  });

  it("選定候選後（複刻 React onItemClickCloseMenu 的兩步）：closeMenu → clearQuery → handler，[[+query 從文件消失、換成 wikilink 節點", () => {
    // 模擬「[[ 已經被觸發、使用者接著打了 query 文字」——不透過 NoteEditor 的
    // handleTextInput，直接操作 SuggestionMenu extension（menu.ts 的契約跟觸發方式無關）。
    const suggestionMenu = editor.getExtension(SuggestionMenu)!;
    suggestionMenu.openSuggestionMenu("[[", { deleteTriggerCharacter: true });
    editor.insertInlineContent(["meet"]);

    const items = buildWikilinkMenuItems({
      query: "meet",
      notes: [note({ id: "n1", title: "Meeting Notes" })],
      createNote,
      editorRef,
      translate,
      toast,
    });
    const item = items.find((i) => i.title === "Meeting Notes")!;

    // React 端 SuggestionMenuWrapper.onItemClickCloseMenu：先 closeMenu()、再
    // clearQuery()，最後才呼叫 item 的 onItemClick——順序不能反，少 closeMenu 會讓
    // plugin 在 handler 期間仍 active，insertWikilink 的 transaction 會被拿去重算 query。
    suggestionMenu.closeMenu();
    suggestionMenu.clearQuery();
    item.onItemClick();

    const text = editor.transact((tr) => tr.doc.textContent);
    expect(text).not.toContain("[[");
    expect(text).not.toContain("meet");
    expect(wikilinkIn(editor)).toEqual({ targetNoteId: "n1", snapshotTitle: "Meeting Notes" });
  });
});
