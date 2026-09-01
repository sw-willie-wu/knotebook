import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { BlockNoteEditor } from "@blocknote/core";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { noteSchema } from "@/collab/schema";
import { insertWikilink, WikilinkInline } from "./spec";

// ── headless 匯出（external HTML / markdown）──────────────────────────────────
//
// `BlockNoteEditor.create({ schema })` 不掛載即 headless：`toExternalHTML` 是
// `blocksToHTMLLossy`/`blocksToMarkdownLossy` 唯一會走到的實作（`blocksToFullHTML`
// 是 internal serializer，一律呼叫互動用的 `render`，headless 下零 React context，
// `useNotes`/`useTranslation`/`useNavigate` 任一個都會直接炸掉——brief 明講過，
// 這裡刻意不測 `blocksToFullHTML`）。

function headlessBlocks() {
  return [
    {
      type: "paragraph" as const,
      content: [
        "See ",
        { type: "wikilink" as const, props: { targetNoteId: "note-1", snapshotTitle: "Meeting Notes" } },
        " for details.",
      ],
    },
  ];
}

describe("wikilink 匯出（headless BlockNoteEditor，noteSchema 已含 wikilink spec）", () => {
  it("blocksToHTMLLossy：data-* 屬性、純文字 [[title]]、絕不是 <a>", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const html = editor.blocksToHTMLLossy(headlessBlocks());

    expect(html).toContain('data-inline-content-type="wikilink"');
    expect(html).toContain('data-target-note-id="note-1"');
    expect(html).toContain('data-snapshot-title="Meeting Notes"');
    expect(html).toContain("[[Meeting Notes]]");
    expect(html).not.toContain("<a");
  });

  it("blocksToMarkdownLossy：[[title]] 原樣輸出，方括號不跳脫", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const markdown = editor.blocksToMarkdownLossy(headlessBlocks());

    expect(markdown).toContain("[[Meeting Notes]]");
    expect(markdown).not.toContain("\\[");
    expect(markdown).not.toContain("\\]");
  });

  it("noteSchema 的 inline content：預設 text/link 都保留，另外多了 wikilink", () => {
    expect(Object.keys(noteSchema.inlineContentSpecs)).toEqual(expect.arrayContaining(["text", "link", "wikilink"]));
  });
});

// ── WikilinkInline（互動 render，三態）──────────────────────────────────────

const TARGET_NOTE: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Renamed In The Meantime",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "renamed-in-the-meantime",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
};

/** `editor`/`updateInlineContent` prop 是 `WikilinkInline` 簽章要求，但元件本身不用
 * 到——一個 headless 的 stub editor 加一個 no-op 就夠，不必是掛好共編的真編輯器。 */
function renderWikilink(options: {
  queryClient: QueryClient;
  targetNoteId?: string;
  snapshotTitle?: string;
  destinationPath: string;
}) {
  const { queryClient, targetNoteId = "22222222-2222-2222-2222-222222222222", snapshotTitle = "Meeting Notes" } =
    options;
  // `WikilinkInline` 不讀 `editor` prop（三態全靠 `useNotes()` 的 React Query cache），
  // 只需要滿足型別簽章——真的去 `BlockNoteEditor.create({ schema: noteSchema })` 會撞上
  // `noteSchema` 的 ISchema（含全部預設 inline spec）跟 `WikilinkRenderProps["editor"]`
  // 要求的窄 ISchema（僅 `{ wikilink: ... }`）在不變位置（`insertInlineContent` 這類
  // 方法的參數＋回傳都用到 ISchema）互不相容，一個空物件打通型別更直接。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上，測試替身走 repo 慣例的 BlockNoteEditor<any,any,any>
  const editor = {} as BlockNoteEditor<any, any, any>;

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/start"]}>
        <Routes>
          <Route
            path="/start"
            element={
              <WikilinkInline
                inlineContent={{ type: "wikilink", props: { targetNoteId, snapshotTitle }, content: undefined }}
                updateInlineContent={() => {}}
                editor={editor}
                contentRef={() => {}}
              />
            }
          />
          <Route path={options.destinationPath} element={<p>navigated here</p>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("WikilinkInline（三態）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    // 三態測試都不需要 `/api/notes` 真的解析——標題來源全靠 `queryClient.setQueryData`
    // 塞好的假 cache（brief 指定的作法）；stub 一個永不 resolve 的 fetch，讓背景
    // refetch 不會意外把假資料換掉，也不會噴未攔截的 network 錯誤。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    dismissAllToasts();
  });

  it("loading（notes 查詢尚未解析）：顯示 snapshotTitle，點擊以 /notes/<targetNoteId> 導航", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 刻意不 setQueryData——維持 isPending。

    renderWikilink({
      queryClient,
      targetNoteId: "33333333-3333-3333-3333-333333333333",
      snapshotTitle: "Meeting Notes",
      destinationPath: "/notes/33333333-3333-3333-3333-333333333333",
    });

    const button = screen.getByRole("button", { name: "Meeting Notes" });
    // Important #2（審查）：mutation 測試證實過，若 loading 分支誤套斷鏈的
    // className，先前的測試組合仍然全綠——這句補上直接鎖死「loading 不是斷鏈」。
    expect(button).not.toHaveClass("border-dashed");
    fireEvent.click(button);

    expect(screen.getByText("navigated here")).toBeInTheDocument();
  });

  it("列表查詢失敗（重試耗盡，isPending=false 但 data 仍是 undefined）：跟 loading 同一態，不是斷鏈，不編造「筆記不存在」", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // 蓋掉 beforeEach 那個永不 resolve 的 stub：這裡要真的落到 error 終態
    // （isPending 變 false、但 data 從未拿到過，維持 undefined）。
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("network down"))),
    );

    renderWikilink({
      queryClient,
      targetNoteId: "55555555-5555-5555-5555-555555555555",
      snapshotTitle: "Meeting Notes",
      destinationPath: "/notes/55555555-5555-5555-5555-555555555555",
    });

    await waitFor(() => expect(queryClient.getQueryState(["notes"])?.status).toBe("error"));

    const button = screen.getByRole("button", { name: "Meeting Notes" });
    expect(button).not.toHaveClass("border-dashed");
    fireEvent.click(button);

    expect(screen.getByText("navigated here")).toBeInTheDocument();
    expect(screen.queryByText("This linked note no longer exists.")).not.toBeInTheDocument();
  });

  it("resolved 命中：顯示目標筆記現行標題（非 snapshotTitle），點擊用 canonicalNotePath 導航", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["notes"], [TARGET_NOTE]);

    renderWikilink({
      queryClient,
      targetNoteId: TARGET_NOTE.id,
      snapshotTitle: "Old Snapshot Title",
      destinationPath: canonicalNotePath(TARGET_NOTE),
    });

    // 現行標題取代了插入當下的 snapshotTitle。
    expect(screen.queryByText("Old Snapshot Title")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: TARGET_NOTE.title });
    expect(button).not.toHaveClass("border-dashed");
    fireEvent.click(button);

    expect(screen.getByText("navigated here")).toBeInTheDocument();
  });

  it("resolved 未命中（目標筆記已刪除）：斷鏈樣式＋snapshotTitle，點擊只 toast、不導航", () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["notes"], []); // 已解析，但找不到 targetNoteId。

    renderWikilink({
      queryClient,
      targetNoteId: "44444444-4444-4444-4444-444444444444",
      snapshotTitle: "Deleted Note",
      destinationPath: "/notes/44444444-4444-4444-4444-444444444444",
    });

    const button = screen.getByRole("button", { name: "Deleted Note" });
    expect(button).toHaveClass("border-dashed");
    fireEvent.click(button);

    expect(screen.getByText("This linked note no longer exists.")).toBeInTheDocument();
    expect(screen.queryByText("navigated here")).not.toBeInTheDocument();
  });
});

// ── insertWikilink ───────────────────────────────────────────────────────────

describe("insertWikilink", () => {
  it("插入 wikilink 節點，並補一個 trailing space 讓游標不黏在 atom node 上", () => {
    const insertInlineContent = vi.fn();
    const editorStub = {
      insertInlineContent,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試替身只需要 insertInlineContent 這一個方法，其餘用 repo 慣例的 any 打通型別
    } as any;

    insertWikilink(editorStub, { targetNoteId: "n1", snapshotTitle: "Meeting Notes" });

    expect(insertInlineContent).toHaveBeenCalledWith([
      { type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes" } },
      " ",
    ]);
  });
});
