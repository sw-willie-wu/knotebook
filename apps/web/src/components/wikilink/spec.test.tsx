import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { BlockNoteEditor } from "@blocknote/core";
import { canonicalNotePath, type NoteDto, type PublicLinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { noteSchema } from "@/collab/schema";
import { BlockAnchorContext, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { OWNER_PERMS } from "@/test/fixtures";
import { WikilinkContext, type WikilinkMode } from "./context";
import { insertWikilink, WikilinkInline } from "./spec";

// spec 2026-10-13 site-links §7、§11.2、§15.1 W1／W5（元件半）。

describe("匯出（headless BlockNoteEditor，§7.3）", () => {
  const blocks = (props: Record<string, string>) => [
    { type: "paragraph" as const, content: ["See ", { type: "wikilink" as const, props: { targetNoteId: "note-1", snapshotTitle: "Meeting Notes", label: "", anchorBlockId: "", ...props } }, " now."] },
  ];
  it("blocksToHTMLLossy：<a href=/notes/<id>>，文字 label 優先、否則 snapshotTitle；錨點進 href；外層 data-* 照帶", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    const plain = editor.blocksToHTMLLossy(blocks({}));
    expect(plain).toContain('data-inline-content-type="wikilink"');
    expect(plain).toContain('<a href="/notes/note-1">Meeting Notes</a>');
    expect(plain).not.toContain("[[");
    const labelled = editor.blocksToHTMLLossy(blocks({ label: "L", anchorBlockId: "b1" }));
    expect(labelled).toContain('<a href="/notes/note-1#b-b1">L</a>');
  });
  it("blocksToMarkdownLossy：[文字](/notes/<id>)；顯示文字全空時退到 href（永不從匯出消失）", () => {
    const editor = BlockNoteEditor.create({ schema: noteSchema });
    expect(editor.blocksToMarkdownLossy(blocks({}))).toContain("[Meeting Notes](/notes/note-1)");
    // 全空時連結文字＝href：HTML 照樣是 <a>；markdown 由 BlockNote 0.52.1 的 htmlToMarkdown `formatLink`（文字等於網址時輸出裸網址）
    // 收成 `/notes/note-1`——實測如此（計畫原期望 `[/notes/note-1](/notes/note-1)`），文字仍在匯出裡。
    expect(editor.blocksToHTMLLossy(blocks({ snapshotTitle: "" }))).toContain('<a href="/notes/note-1">/notes/note-1</a>');
    expect(editor.blocksToMarkdownLossy(blocks({ snapshotTitle: "" }))).toContain("See /notes/note-1 now.");
  });
});

const TARGET: NoteDto = {
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
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
};

function LocationProbe() {
  const l = useLocation();
  return <p data-testid="loc">{`${l.pathname}${l.search}${l.hash}`}</p>;
}
const loc = () => screen.getByTestId("loc").textContent;

interface RenderOpts {
  props: { targetNoteId: string; snapshotTitle?: string; label?: string; anchorBlockId?: string };
  queryClient?: QueryClient;
  editor?: Record<string, unknown>;
  mode?: WikilinkMode;
  anchors?: Partial<BlockAnchorApi>;
}

function renderWikilink(opts: RenderOpts) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試替身：元件只讀 isEditable／getBlock，走 repo 慣例的 BlockNoteEditor<any,any,any>
  const editor = (opts.editor ?? { isEditable: false }) as unknown as BlockNoteEditor<any, any, any>;
  const anchors: BlockAnchorApi = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn(), ...opts.anchors };
  const tree = (
    <MemoryRouter initialEntries={["/start?x=1"]}>
      <BlockAnchorContext.Provider value={anchors}>
        <WikilinkContext.Provider value={opts.mode ?? { mode: "member" }}>
          <WikilinkInline
            inlineContent={{ type: "wikilink", props: { snapshotTitle: "", label: "", anchorBlockId: "", ...opts.props }, content: undefined }}
            updateInlineContent={() => {}}
            editor={editor}
            contentRef={() => {}}
          />
        </WikilinkContext.Provider>
      </BlockAnchorContext.Provider>
      <Routes>
        <Route path="*" element={<LocationProbe />} />
      </Routes>
      <Toaster />
    </MemoryRouter>
  );
  render(opts.queryClient ? <QueryClientProvider client={opts.queryClient}>{tree}</QueryClientProvider> : tree);
  return { anchors };
}

const pendingClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const loadedClient = (notes: NoteDto[]) => {
  const qc = pendingClient();
  qc.setQueryData(["notes"], notes);
  return qc;
};

describe("MemberWikilink（W1）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    dismissAllToasts();
  });

  it("清單未到：<a href=/notes/<id>[#b-…]>，文字 label 優先否則 snapshotTitle；活連結樣式；一般點擊同分頁導航", () => {
    renderWikilink({ queryClient: pendingClient(), props: { targetNoteId: TARGET.id, snapshotTitle: "Snap", anchorBlockId: "b1" } });
    const link = screen.getByRole("link", { name: "Snap" });
    expect(link).toHaveAttribute("href", `/notes/${TARGET.id}#b-b1`);
    expect(link).toHaveClass("text-(--color-brand)", "underline");
    expect(link).not.toHaveClass("border-dashed");
    fireEvent.click(link);
    expect(loc()).toBe(`/notes/${TARGET.id}#b-b1`);
  });

  it("列表查詢失敗（重試耗盡，isPending=false 但 data 仍是 undefined）：跟清單未到同一態，不是斷鏈，不編造「筆記不存在」", async () => {
    // 蓋掉 beforeEach 那個永不 resolve 的 stub：這裡要真的落到 error 終態（isPending 變 false、data 從未拿到過）。
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("network down"))));
    const queryClient = pendingClient();
    renderWikilink({ queryClient, props: { targetNoteId: TARGET.id, snapshotTitle: "Snap" } });
    await waitFor(() => expect(queryClient.getQueryState(["notes"])?.status).toBe("error"));
    const link = screen.getByRole("link", { name: "Snap" });
    expect(link).toHaveAttribute("href", `/notes/${TARGET.id}`);
    expect(link).toHaveClass("text-(--color-brand)", "underline");
    expect(link).not.toHaveClass("border-dashed");
    fireEvent.click(link);
    expect(loc()).toBe(`/notes/${TARGET.id}`);
    expect(screen.queryByText("This linked note no longer exists.")).not.toBeInTheDocument();
  });

  it("命中：文字＝label（有）或現行標題；href＝canonical＋錨點；點擊導航到 canonical", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id, snapshotTitle: "Old", anchorBlockId: "h2" } });
    const link = screen.getByRole("link", { name: TARGET.title });
    expect(link).toHaveAttribute("href", `${canonicalNotePath(TARGET)}#b-h2`);
    fireEvent.click(link);
    expect(loc()).toBe(`${canonicalNotePath(TARGET)}#b-h2`);
  });

  it("命中且有 label：顯示 label，不顯示現行標題", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id, snapshotTitle: "Old", label: "Custom" } });
    expect(screen.getByRole("link", { name: "Custom" })).toHaveAttribute("href", canonicalNotePath(TARGET));
    expect(screen.queryByText(TARGET.title)).not.toBeInTheDocument();
  });

  it("斷鏈（清單到了卻沒有這個 id）：<span> 斷鏈樣式（不是連結）、label 或 snapshotTitle；點擊只 toast", () => {
    renderWikilink({ queryClient: loadedClient([]), props: { targetNoteId: "44444444-4444-4444-4444-444444444444", snapshotTitle: "Deleted Note" } });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    const span = screen.getByText("Deleted Note");
    expect(span).toHaveClass("border-dashed", "text-muted-foreground");
    expect(span).not.toHaveClass("text-(--color-brand)");
    fireEvent.click(span);
    expect(screen.getByText("This linked note no longer exists.")).toBeInTheDocument();
    expect(loc()).toBe("/start?x=1");
  });

  it("修飾鍵（Ctrl／Meta／Shift／Alt）與非左鍵點擊：不 preventDefault、不導航（交給瀏覽器開新分頁）", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id } });
    const link = screen.getByRole("link", { name: TARGET.title });
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      expect(fireEvent.click(link, init), JSON.stringify(init)).toBe(true);
      expect(loc()).toBe("/start?x=1");
    }
  });

  it("可編輯時一般點擊：preventDefault、不導航（工具列由 Task 10 接上）", () => {
    renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id }, editor: { isEditable: true } });
    const link = screen.getByRole("link", { name: TARGET.title });
    expect(fireEvent.click(link)).toBe(false);
    expect(loc()).toBe("/start?x=1");
  });

  it("同篇＋錨點：requestAnchor(id)、只改 hash（pathname／search 不變），不換頁", () => {
    const { anchors } = renderWikilink({
      queryClient: loadedClient([TARGET]),
      props: { targetNoteId: TARGET.id, anchorBlockId: "b9" },
      anchors: { currentNoteId: TARGET.id },
    });
    fireEvent.click(screen.getByRole("link"));
    expect(anchors.requestAnchor).toHaveBeenCalledWith("b9");
    expect(loc()).toBe("/start?x=1#b-b9");
  });

  it("同篇無錨點：scrollToTop、網址不變", () => {
    const { anchors } = renderWikilink({ queryClient: loadedClient([TARGET]), props: { targetNoteId: TARGET.id }, anchors: { currentNoteId: TARGET.id } });
    fireEvent.click(screen.getByRole("link"));
    expect(anchors.scrollToTop).toHaveBeenCalledTimes(1);
    expect(loc()).toBe("/start?x=1");
  });
});

describe("PublicWikilink（W5 元件半：不呼叫 useNotes）", () => {
  const links = (list: PublicLinkDto[]): WikilinkMode => ({ mode: "public", links: new Map(list.map((l) => [l.id, l])) });
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("沒有 QueryClientProvider 也能渲染（不呼叫 useNotes）、零 fetch；有自訂公開網址的目標成 <a href=/p/…[#b-…]>、label 優先", () => {
    const fetchSpy = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchSpy);
    renderWikilink({ mode: links([{ id: TARGET.id, title: "Public Title", path: "/p/tester/pub" }]), props: { targetNoteId: TARGET.id, anchorBlockId: "x1" } });
    const link = screen.getByRole("link", { name: "Public Title" });
    expect(link).toHaveAttribute("href", "/p/tester/pub#b-x1");
    fireEvent.click(link);
    expect(loc()).toBe("/p/tester/pub#b-x1");
    expect(fetchSpy).not.toHaveBeenCalled();
    // label 優先：同一個公開目標帶 label 時顯示 label、不顯示公開標題。
    cleanup();
    renderWikilink({ mode: links([{ id: TARGET.id, title: "Public Title", path: "/p/tester/pub" }]), props: { targetNoteId: TARGET.id, label: "L" } });
    expect(screen.getByRole("link", { name: "L" })).toHaveAttribute("href", "/p/tester/pub");
    expect(screen.queryByText("Public Title")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("不在 links 裡（非公開、只有 token 形、已刪）：純文字 <span>（不可點、無連結樣式）", () => {
    renderWikilink({ mode: links([]), props: { targetNoteId: TARGET.id, snapshotTitle: "Snap", label: "Lab" } });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Lab")).not.toHaveClass("underline");
  });

  it("同篇錨點：links 沒有、但本頁有該區塊 ⇒ <a href=#b-…>，點擊 requestAnchor＋只改 hash；本頁沒有該區塊 ⇒ 純文字", () => {
    const { anchors } = renderWikilink({
      mode: links([]),
      props: { targetNoteId: TARGET.id, snapshotTitle: "Here", anchorBlockId: "b1" },
      editor: { isEditable: false, getBlock: (id: string) => (id === "b1" ? { id } : undefined) },
    });
    const link = screen.getByRole("link", { name: "Here" });
    expect(link).toHaveAttribute("href", "#b-b1");
    fireEvent.click(link);
    expect(anchors.requestAnchor).toHaveBeenCalledWith("b1");
    expect(loc()).toBe("/start?x=1#b-b1");
    // 反面：錨點指向本頁沒有的區塊（stub 的 getBlock 對 "zz" 回 undefined）⇒ 純文字，不是捲不到的 <a href="#b-zz">。
    cleanup();
    renderWikilink({
      mode: links([]),
      props: { targetNoteId: TARGET.id, snapshotTitle: "Elsewhere", anchorBlockId: "zz" },
      editor: { isEditable: false, getBlock: (id: string) => (id === "b1" ? { id } : undefined) },
    });
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Elsewhere")).not.toHaveClass("underline");
  });
});

describe("insertWikilink（§8.7）", () => {
  it("新 props 預設空字串；呼叫端可帶 label／anchorBlockId；補一個 trailing space", () => {
    const insertInlineContent = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 測試替身只需要 insertInlineContent
    const editorStub = { insertInlineContent } as any;
    insertWikilink(editorStub, { targetNoteId: "n1", snapshotTitle: "Meeting Notes" });
    expect(insertInlineContent).toHaveBeenLastCalledWith([
      { type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "Meeting Notes", label: "", anchorBlockId: "" } },
      " ",
    ]);
    insertWikilink(editorStub, { targetNoteId: "n1", snapshotTitle: "M", label: "L", anchorBlockId: "b" });
    expect(insertInlineContent).toHaveBeenLastCalledWith([{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "M", label: "L", anchorBlockId: "b" } }, " "]);
  });
});
