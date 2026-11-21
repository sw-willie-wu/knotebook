import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import type { AiActionDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING, ARTICLE_TEXT_INSET, articleColumn } from "@/components/ui/article-column";
import { setNoteWidth } from "@/components/note-width";
import { ThemeProvider } from "@/theme";
import { NoteEditor } from "./NoteEditor";
import { NoteWidthToggle } from "./NoteWidthToggle";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AI_ACTION: AiActionDto = { id: "action-1", name: "Rewrite", applyMode: "direct", kind: "quick" };

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ actions: [AI_ACTION] }) }),
        );
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/**
 * Card layout: a missing class in any of the three flex layers is a silent failure (it looks fine in jsdom snapshots and ordinary interaction tests and only shows with real scrolling content and flex squeeze), so this asserts the class strings themselves, against the slotted node chain:
 *
 *   root row (relative flex h-full min-h-0 min-w-0 flex-1 gap-3; `relative` is the positioning base of the 640-1279 floating versions panel, guarded in `NoteEditor.versions-floating.test.tsx`)
 *     content card (flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card)
 *       {headerSlot}
 *       scroll container (min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-clip; `overflow-x-clip` (#162) clips the part of a wide table's hover "add row" button that sticks out past the right edge, so it doesn't become horizontal scroll overflow of this layer)
 *         centering wrapper (articleColumn(width) + ARTICLE_COLUMN_PADDING + relative flex min-h-full flex-col py-6; standard column width = 85% of the scroll container, at least 680px (the fixed value before the redesign, load-bearing at medium windows), at most 1056px; the wide / full-width modes (#297) are never narrower than standard (92.5% capped at 1408px / uncapped), same minimum. Column width and padding are constants of `ui/article-column.ts` (header/footer don't use it; they are full card width). `relative` (#160) is the containing block of BlockNote's table hover overlays, kept at this layer to avoid a page-wide scrollbar; don't move it to the scroll container)
 *           note-editor (BlockNoteView, className adds flex-1: the wrapper's min-h-full can't pass a percentage height to grandchildren, so BlockNoteView itself must be the growing item of the centering wrapper; both must be asserted)
 *       {previewSlot} (rendered only when set, data-testid="preview-slot"; the scroll container then gets hidden)
 *       CornerStack (zero-height anchor of the history bubble, inside the card, before the footer; no provider in this file = not rendered)
 *       {footerSlot}
 *     VersionsPanel (when panelOpen, via VersionsLazyBoundary; no provider in this file = never rendered)
 *
 * The real `<NoteEditor>` is mounted on purpose (not the mock used in `NotePage.test.tsx`/`NoteEditorView.test.tsx`, nor half the layer via `NoteEditorView`), to verify that the container classes `NoteEditor.tsx` really renders match the required ones verbatim.
 */
describe("NoteEditor layout (slotted: node chain + two-layer class smoke)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("five layers' classes asserted one by one (root / content card / scroll container / centering wrapper / BlockNoteView); headerSlot/footerSlot land in the right place", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-slot-marker">header</div>}
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    const editorRoot = await screen.findByTestId("note-editor");
    const centerWrapper = editorRoot.parentElement;
    // One layer outside the columns is a display: contents flow wrapper (on phone the footer becomes a column only when inside the scroll container); it produces no box.
    const flow = centerWrapper?.parentElement;
    expect(flow).toHaveAttribute("data-article-flow");
    expect(flow).toHaveClass("contents");
    const scrollWrapper = flow?.parentElement;
    const contentCard = scrollWrapper?.parentElement;
    const root = contentCard?.parentElement;

    expect(centerWrapper).not.toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(contentCard).not.toBeNull();
    expect(root).not.toBeNull();

    expect(root).toHaveClass("relative", "flex", "h-full", "min-h-0", "min-w-0", "flex-1", "gap-3");
    // #274: the width source shared by the versions panel and its error frame: the row container sets a CSS variable (default 320). Removing the style breaks both widths.
    expect(root!.style.getPropertyValue("--versions-panel-width")).toBe("320px");
    expect(contentCard).toHaveClass(
      "flex",
      "min-h-0",
      "min-w-0",
      "flex-1",
      "flex-col",
      "overflow-hidden",
      "rounded-xl",
      "border",
      "border-border",
      "bg-card",
    );
    // Phone (< 640): the content card hugs the screen edges, no rounded corners or border; from 640 up rounded-xl/border remain (above).
    expect(contentCard).toHaveClass("max-sm:rounded-none", "max-sm:border-0");
    expect(scrollWrapper).toHaveClass("min-h-0", "min-w-0", "flex-1", "overflow-y-auto", "overflow-x-clip");
    // From 640 up a scrollbar gutter is always reserved: the text column doesn't jump when a note starts to overflow, and the gap between the history bubble and the scrollbar stays constant.
    expect(scrollWrapper).toHaveClass("sm:[scrollbar-gutter:stable]");
    // Column width and padding come from `ui/article-column.ts` (#115; header/footer don't use it, they are full card width).
    // The structural guard is in `ui/article-column.guard.test.ts`.
    // #160: `relative` is the one thing the centering wrapper must carry: BlockNote's table hover overlays (`bn-extend-button` etc.) use FloatingPortal + `position: absolute`;
    // with no positioned ancestor they take `<html>` as containing block and produce a page-wide scrollbar.
    expect(centerWrapper).toHaveClass(
      ...ARTICLE_COLUMN.split(" "),
      ARTICLE_COLUMN_PADDING,
      "relative",
      "flex",
      "min-h-full",
      "flex-col",
      "py-6",
    );
    // No extra bottom space for the history bubble: only py-6, bottom padding equals top padding.
    expect(centerWrapper!.className).not.toMatch(/(sm:)?pb-/);
    // Two-layer assertion: the centering wrapper's min-h-full/flex-col AND BlockNoteView's flex-1;
    // the height chain only holds when both are present.
    expect(editorRoot).toHaveClass("min-h-full", "flex-1");

    // headerSlot/footerSlot sit inside the content card, before and after the scroll container (not nested inside it).
    expect(contentCard).toContainElement(screen.getByTestId("header-slot-marker"));
    expect(contentCard).toContainElement(screen.getByTestId("footer-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("header-slot-marker"));
    expect(scrollWrapper).not.toContainElement(screen.getByTestId("footer-slot-marker"));

    doc.destroy();
  });

  it("contentTopSlot renders inside the article column, before the editor and outside its contenteditable, with ARTICLE_TEXT_INSET", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-slot-marker">header</div>}
            contentTopSlot={<div data-testid="top-slot-marker">tags</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    const column = screen.getByTestId("article-column");
    const marker = screen.getByTestId("top-slot-marker");
    const wrapper = marker.parentElement!;
    expect(wrapper).toHaveAttribute("data-note-content-top");
    expect(wrapper.parentElement).toBe(column);
    expect(wrapper).toHaveClass(...ARTICLE_TEXT_INSET.split(" "), "shrink-0", "pb-2", "empty:hidden");
    // The wrapper is the column's first child: the slot comes before the editor.
    expect(column.firstElementChild).toBe(wrapper);
    expect(wrapper.compareDocumentPosition(editorRoot) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(wrapper.contains(editorRoot)).toBe(false);
    expect(editorRoot.contains(marker)).toBe(false);
    expect(marker.closest("[contenteditable]")).toBeNull();
    // The header slot stays where it was, outside the scroll area.
    expect(screen.getByTestId("header-slot-marker").closest("[data-testid=article-column]")).toBeNull();
    doc.destroy();
  });

  it("a note without contentTopSlot has no wrapper for it, so the column is unchanged", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await screen.findByTestId("note-editor");
    expect(document.querySelector("[data-note-content-top]")).toBeNull();
    doc.destroy();
  });

  it("previewSlot: the scroll container gets hidden, the slot renders in the same card (after the scroll container, before the footer), the live editor stays in the DOM", async () => {
    const doc = new Y.Doc();
    const provider = { awareness: null } as never;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={doc}
            provider={provider}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId="note-1"
            footerSlot={<div data-testid="footer-slot-marker">footer</div>}
            previewSlot={<div data-testid="preview-marker">preview</div>}
          />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    const scrollWrapper = editorRoot.parentElement!.parentElement!.parentElement!;
    const contentCard = scrollWrapper.parentElement!;
    expect(scrollWrapper).toHaveClass("hidden", "overflow-y-auto");
    const slot = screen.getByTestId("preview-slot");
    expect(slot).toContainElement(screen.getByTestId("preview-marker"));
    expect(slot.parentElement).toBe(contentCard);
    const order = Array.from(contentCard.children);
    expect(order.indexOf(slot)).toBe(order.indexOf(scrollWrapper) + 1);
    expect(order.indexOf(slot)).toBeLessThan(order.indexOf(screen.getByTestId("footer-slot-marker")));
    expect(editorRoot).toBeInTheDocument();
    doc.destroy();
  });

  it("no previewSlot -> the scroll container has no hidden and there is no preview-slot node", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const editorRoot = await screen.findByTestId("note-editor");
    expect(editorRoot.parentElement!.parentElement!.parentElement).not.toHaveClass("hidden");
    expect(screen.queryByTestId("preview-slot")).not.toBeInTheDocument();
    doc.destroy();
  });

  it("live editor isn't remounted: the BlockNoteView root is the same DOM element when previewSlot enters and leaves", async () => {
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (slot?: ReactNode) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" previewSlot={slot} />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree());
    const before = await screen.findByTestId("note-editor");
    rerender(tree(<div>preview</div>));
    rerender(tree());
    expect(screen.getByTestId("note-editor")).toBe(before);
    doc.destroy();
  });
});

/** #297: the body column follows this note's in-site width (`useNoteWidth(noteId)`); changing the width doesn't rebuild the editor. */
describe("NoteEditor body width (#297)", () => {
  const STANDARD_MAX = "max-w-[clamp(42.5rem,85%,66rem)]";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    localStorage.clear();
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    // Cases that change the width leave note.width.note-1 behind; clear it so it doesn't carry over to later files.
    localStorage.clear();
  });

  function renderEditor(noteId: string, doc: Y.Doc, headerSlot?: ReactNode) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (id: string, d: Y.Doc) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor
            doc={d}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "Ann" }}
            noteId={id}
            headerSlot={headerSlot}
          />
        </ThemeProvider>
      </QueryClientProvider>
    );
    const { rerender } = render(tree(noteId, doc));
    return { rerender: (id: string, d: Y.Doc) => rerender(tree(id, d)) };
  }

  it("default: the column is standard width", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    doc.destroy();
  });

  it("localStorage already stores wide -> wide on mount, without the standard max-w", async () => {
    localStorage.setItem("note.width.note-1", "wide");
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    const column = screen.getByTestId("article-column");
    expect(column).toHaveClass(...articleColumn("wide").split(" "));
    expect(column).not.toHaveClass(STANDARD_MAX);
    doc.destroy();
  });

  it("switching to full width after mount -> the column follows, BlockNoteEditor.create isn't called again", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      act(() => setNoteWidth("note-1", "full"));
      const column = screen.getByTestId("article-column");
      expect(column).toHaveClass("max-w-none");
      expect(column).not.toHaveClass(STANDARD_MAX);
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
    doc.destroy();
  });

  it("another tab changes this note (storage event) -> an open column follows immediately", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc);
    await screen.findByTestId("note-editor");
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "note.width.note-1", newValue: "wide" }));
    });
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("wide").split(" "));
    doc.destroy();
  });

  it("switching notes: note-2 is standard; after setting note-1 to full width and switching back to note-1 -> full width", async () => {
    const doc1 = new Y.Doc();
    const doc2 = new Y.Doc();
    const { rerender } = renderEditor("note-1", doc1);
    await screen.findByTestId("note-editor");
    rerender("note-2", doc2);
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    act(() => setNoteWidth("note-1", "full"));
    expect(screen.getByTestId("article-column")).toHaveClass(...articleColumn("standard").split(" "));
    rerender("note-1", doc1);
    expect(screen.getByTestId("article-column")).toHaveClass("max-w-none");
    doc1.destroy();
    doc2.destroy();
  });

  it("header width button (headerSlot, same composition as NotePage) pressed once -> column becomes wide; pressed again -> full width", async () => {
    const doc = new Y.Doc();
    renderEditor("note-1", doc, <NoteWidthToggle noteId="note-1" />);
    await screen.findByTestId("note-editor");
    const column = screen.getByTestId("article-column");
    fireEvent.click(screen.getByRole("button", { name: /^Width/ }));
    expect(column).toHaveClass(...articleColumn("wide").split(" "));
    expect(column).not.toHaveClass(STANDARD_MAX);
    fireEvent.click(screen.getByRole("button", { name: /^Width/ }));
    expect(screen.getByTestId("article-column")).toHaveClass("max-w-none");
    doc.destroy();
  });
});

describe("NoteEditor phone editing toolbar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderEditor(mobileToolbar: boolean | undefined, footerSlot?: ReactNode, fabClearance?: boolean, container?: HTMLElement) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={new Y.Doc()} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" mobileToolbar={mobileToolbar} footerSlot={footerSlot} fabClearance={fabClearance} />
        </ThemeProvider>
      </QueryClientProvider>,
      container === undefined ? undefined : { container },
    );
  }

  it("mobileToolbar: toolbar present, and an aria-hidden spacer at the end of the article column (so the document end can scroll above the toolbar)", async () => {
    renderEditor(true);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    expect(document.querySelector("[data-mobile-edit-toolbar]")).not.toBeNull();
    const spacer = column.querySelector("[data-mobile-toolbar-spacer]");
    expect(spacer).not.toBeNull();
    expect(column.lastElementChild).toBe(spacer);
  });

  it("mobileToolbar: on phone the content card leaves a safe-area gap at the bottom (toolbar top sits exactly 60px above the scroll container bottom); none without a toolbar", async () => {
    const on = renderEditor(true);
    const cardOn = (await screen.findByTestId("article-column")).closest(".overflow-hidden") as HTMLElement;
    expect(cardOn).toHaveClass("max-sm:pb-[env(safe-area-inset-bottom)]");
    on.unmount();
    renderEditor(false);
    const cardOff = (await screen.findByTestId("article-column")).closest(".overflow-hidden") as HTMLElement;
    expect(cardOff).not.toHaveClass("max-sm:pb-[env(safe-area-inset-bottom)]");
  });

  const FOOTER = <div data-testid="footer-probe">mentions</div>;
  const scrollRootOf = (column: HTMLElement) => column.closest(".overflow-y-auto") as HTMLElement;

  it("phone: column, footer and toolbar spacer are wrapped in a min-h-full vertical flow (in that order), the column fills the remaining height; the scroll container on phone is a vertical flex filling the card and the flow wrapper stretches with it", async () => {
    stubLayoutTier("phone");
    renderEditor(true, FOOTER);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const scrollRoot = scrollRootOf(column);
    const flow = column.parentElement as HTMLElement;
    const footer = screen.getByTestId("footer-probe");
    const spacer = document.querySelector("[data-mobile-toolbar-spacer]") as HTMLElement;
    expect(flow.parentElement).toBe(scrollRoot);
    expect(flow).toHaveClass("flex", "min-h-full", "flex-col");
    expect(flow).not.toHaveClass("contents");
    // From 640 up it's still an ordinary block; on phone the card is at least one viewport tall, and this layer and the flow wrapper must pass the height down (tapping blank space under a short note still focuses the last block).
    expect(scrollRoot).not.toHaveClass("flex");
    expect(scrollRoot).toHaveClass("max-sm:flex", "max-sm:flex-col");
    expect(flow).toHaveClass("max-sm:grow");
    expect(column).toHaveClass("grow", "shrink-0", "relative");
    expect(column).not.toHaveClass("min-h-full");
    expect(Array.from(flow.children)).toEqual([column, footer, spacer]);
    expect(scrollRoot.children).toHaveLength(1);
    expect(column.contains(spacer)).toBe(false);
  });

  it("phone, not editing (no toolbar): the footer is still last in the scroll container", async () => {
    stubLayoutTier("phone");
    renderEditor(false, FOOTER);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    expect(column.parentElement!.lastElementChild).toBe(screen.getByTestId("footer-probe"));
  });

  it("phone: the scroll container delegates the table right-edge hint (a wide table appearing later is marked too; not on non-phone)", async () => {
    vi.stubGlobal("CSS", { supports: () => false });
    stubLayoutTier("phone");
    const view = renderEditor(false, FOOTER);
    const scrollRoot = scrollRootOf((await screen.findByTestId("article-column")) as HTMLElement);
    const table = document.createElement("div");
    table.className = "tableWrapper";
    for (const [key, value] of Object.entries({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })) Object.defineProperty(table, key, { value, configurable: true });
    scrollRoot.appendChild(table);
    await waitFor(() => expect(table).toHaveAttribute("data-kb-more-right"));
    view.unmount();
    expect(table).not.toHaveAttribute("data-kb-more-right");
  });

  it.each(["overlay", "docked"] as const)("%s: tables get no right-edge hint", async (tier) => {
    vi.stubGlobal("CSS", { supports: () => false });
    stubLayoutTier(tier);
    renderEditor(false, FOOTER);
    const scrollRoot = scrollRootOf((await screen.findByTestId("article-column")) as HTMLElement);
    const table = document.createElement("div");
    table.className = "tableWrapper";
    for (const [key, value] of Object.entries({ scrollWidth: 900, clientWidth: 300, scrollLeft: 0 })) Object.defineProperty(table, key, { value, configurable: true });
    scrollRoot.appendChild(table);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(table).not.toHaveAttribute("data-kb-more-right");
  });

  it.each(["overlay", "docked"] as const)("%s: the footer stays at the card bottom, not inside the scroll container", async (tier) => {
    stubLayoutTier(tier);
    renderEditor(false, FOOTER);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const footer = screen.getByTestId("footer-probe");
    expect(scrollRootOf(column).contains(footer)).toBe(false);
    expect(footer.previousElementSibling).toBe(scrollRootOf(column));
  });

  it("header slot gets the top safe area on phone (banner and header are both below it)", async () => {
    renderEditor(false);
    await screen.findByTestId("article-column");
    expect(document.querySelector("[data-note-header-slot]")).toHaveClass("max-sm:pt-[env(safe-area-inset-top)]");
  });

  it("on phone the document scrolls: the card doesn't clip and is at least one viewport tall (svh); the scroll container is vertically visible; the header slot is sticky at the top with an opaque background; unchanged from 640 up", async () => {
    renderEditor(false, FOOTER, true);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const scrollRoot = scrollRootOf(column);
    const card = scrollRoot.parentElement as HTMLElement;
    const header = document.querySelector("[data-note-header-slot]") as HTMLElement;
    expect(card).toHaveClass("overflow-hidden", "max-sm:overflow-visible", "max-sm:min-h-svh");
    expect(card.className).not.toMatch(/(^|\s)max-sm:min-h-dvh(\s|$)/);
    expect(scrollRoot).toHaveClass("overflow-y-auto", "max-sm:overflow-y-visible", "overflow-x-clip");
    // On phone the height grows from the content (flex-basis auto); the editor (className is also applied to BlockNote's portal root) doesn't rely on min-h-full.
    expect(scrollRoot).toHaveClass("max-sm:flex-auto");
    expect(screen.getByTestId("note-editor")).toHaveClass("min-h-full", "flex-1", "max-sm:min-h-0", "max-sm:flex-auto");
    expect(header).toHaveClass("max-sm:sticky", "max-sm:top-0", "max-sm:bg-card");
    expect(header.className).toMatch(/max-sm:z-\d+/);
    // On phone no ancestor of the header (up to the card) may be a scroll container, otherwise sticky can't stick to the document.
    expect(header.parentElement).toBe(card);
  });

  it("during version preview: the scroll container has only hidden, without the phone flex (otherwise the preview and the live editor would show together on phone)", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <NoteEditor doc={new Y.Doc()} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "Ann" }} noteId="note-1" previewSlot={<div>preview</div>} />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const scrollRoot = scrollRootOf((await screen.findByTestId("article-column")) as HTMLElement);
    expect(scrollRoot).toHaveClass("hidden");
    expect(scrollRoot).not.toHaveClass("max-sm:flex");
  });

  it("phone: the header slot's height is written into <html>'s --kb-sticky-top and removed on unmount; not written on non-phone", async () => {
    const rect = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      return new DOMRect(0, 0, 390, this.hasAttribute("data-note-header-slot") ? 97.4 : 0);
    });
    onTestFinished(() => rect.mockRestore());
    // Only written when the note is inside AppShell's frame (the document scrolls on its behalf).
    const frame = document.createElement("div");
    frame.setAttribute("data-phone-page-scroll", "");
    document.body.append(frame);
    onTestFinished(() => frame.remove());
    stubLayoutTier("phone");
    const view = renderEditor(false, FOOTER, undefined, frame);
    await screen.findByTestId("article-column");
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--kb-sticky-top")).toBe("97px"));
    view.unmount();
    expect(document.documentElement.style.getPropertyValue("--kb-sticky-top")).toBe("");
    stubLayoutTier("overlay");
    renderEditor(false, FOOTER, undefined, frame.appendChild(document.createElement("div")));
    await screen.findByTestId("article-column");
    expect(document.documentElement.style.getPropertyValue("--kb-sticky-top")).toBe("");
  });

  it.each([false, true])("fabClearance: the scroll content ends with an aria-hidden spacer (5rem + safe area, above the floating buttons); the column fills the height (same with footer = %s)", async (withFooter) => {
    stubLayoutTier("phone");
    renderEditor(false, withFooter ? FOOTER : undefined, true);
    const column = (await screen.findByTestId("article-column")) as HTMLElement;
    const flow = column.parentElement as HTMLElement;
    const clearance = document.querySelector("[data-fab-clearance]") as HTMLElement;
    expect(clearance).toHaveAttribute("aria-hidden", "true");
    expect(clearance).toHaveClass("h-[calc(5rem+env(safe-area-inset-bottom))]");
    expect(flow.lastElementChild).toBe(clearance);
    expect(flow).toHaveClass("flex", "min-h-full", "flex-col");
    expect(column).toHaveClass("grow", "shrink-0");
  });

  it("no fabClearance: no such spacer", async () => {
    stubLayoutTier("phone");
    renderEditor(false, FOOTER);
    await screen.findByTestId("article-column");
    expect(document.querySelector("[data-fab-clearance]")).toBeNull();
  });

  it.each([false, undefined])("mobileToolbar=%s (desktop, or phone not editing): no toolbar and no spacer", async (flag) => {
    renderEditor(flag);
    await screen.findByTestId("article-column");
    expect(document.querySelector("[data-mobile-edit-toolbar]")).toBeNull();
    expect(document.querySelector("[data-mobile-toolbar-spacer]")).toBeNull();
  });
});
