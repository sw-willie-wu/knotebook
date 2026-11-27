import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import * as Y from "yjs";
import i18n from "@/i18n";
import { NOOP_VERSIONS, VersionsProvider, type VersionsContextValue } from "@/lib/versions-context";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { ThemeProvider } from "@/theme";
import type { OutlineHeading } from "@/components/outline/headings";
import type { NoteOutlineProps } from "@/components/outline/NoteOutline";
import { useOutlineMenu } from "@/components/outline/outline-menu-context";
import type { OutlineScrollBubbleProps } from "@/components/outline/OutlineScrollBubble";
import type { OutlineSheetProps } from "@/components/outline/OutlineSheet";
import { OUTLINE_PINNED_STORAGE_KEY } from "@/components/outline/outline-pin";
import type { OutlineBox } from "@/components/outline/use-outline-box";
import { resetNoteWidthsForTest, setNoteWidth } from "@/components/note-width";
import { ARTICLE_COLUMN_MAX, articleColumn, type ArticleColumnState } from "@/components/ui/article-column";
import { PHONE_EDIT_TOOLBAR_CLEARANCE_PX } from "@/components/ai/SelectionAiController";
import { CORNER_STACK_FOOTPRINT_PX, cornerStackFootprint } from "@/components/corner-stack-geometry";
import { CORNER_STACK_COLLAPSED_STORAGE_KEY } from "@/components/corner-stack-state";
import { CommentsProvider, NOOP_COMMENTS, type CommentsContextValue } from "@/lib/comments-context";
import { PHONE_FAB_FOOTPRINT_PX } from "@/components/sidebar/PhoneListFabs";
import { NoteEditor } from "./NoteEditor";

const WIDE_BOX: OutlineBox = { width: 1072, height: 700, firstLineTop: null };

const outline = vi.hoisted(() => ({
  headings: [] as OutlineHeading[],
  props: [] as NoteOutlineProps[],
  box: null as OutlineBox | null,
  /** Renders in which `useOutlineBox` got both elements (the real hook measures only then). */
  measured: 0,
}));

vi.mock("@/components/outline/use-outline-headings", () => ({
  useOutlineHeadings: () => outline.headings,
}));
// Like the real hook: nothing to measure until both elements are passed in.
vi.mock("@/components/outline/use-outline-box", () => ({
  useOutlineBox: (scrollEl: HTMLElement | null, columnEl: HTMLElement | null) => {
    if (scrollEl === null || columnEl === null) return null;
    outline.measured += 1;
    return outline.box;
  },
}));
vi.mock("@/components/outline/NoteOutline", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/NoteOutline")>();
  return {
    ...original,
    NoteOutline: (props: NoteOutlineProps) => {
      outline.props.push(props);
      return <div data-testid="outline-stub" />;
    },
  };
});
// Phone pieces: recording stubs. The bubble stub is a button calling `onOpen`, as a tap would.
const phoneStubs = vi.hoisted(() => ({
  bubble: [] as OutlineScrollBubbleProps[],
  sheet: [] as OutlineSheetProps[],
  /** Render the real sheet (still recording its props), for the cases about where focus lands when it closes. */
  realSheet: false,
}));
vi.mock("@/components/outline/OutlineScrollBubble", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/OutlineScrollBubble")>();
  return {
    ...original,
    OutlineScrollBubble: (props: OutlineScrollBubbleProps) => {
      phoneStubs.bubble.push(props);
      return <button type="button" data-testid="bubble-stub" onClick={(e) => props.onOpen(e.currentTarget)} />;
    },
  };
});
vi.mock("@/components/outline/OutlineSheet", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/outline/OutlineSheet")>();
  return {
    ...original,
    OutlineSheet: (props: OutlineSheetProps) => {
      phoneStubs.sheet.push(props);
      if (phoneStubs.realSheet) return <original.OutlineSheet {...props} />;
      return <div data-testid="sheet-stub" data-open={String(props.open)} />;
    },
  };
});
/** Reads the ⋮ context from inside the header slot, where the header ⋮ sits; opens the sheet handing over itself, as the ⋮ hands over its trigger. */
function MenuProbe() {
  const { available, open } = useOutlineMenu();
  return (
    <>
      <button type="button" data-testid="menu-probe" data-available={String(available)} onClick={(e) => open(e.currentTarget)} />
      <button type="button" data-testid="menu-probe-bare" onClick={() => open()} />
    </>
  );
}
// The versions panel itself is not under test here; keep it from fetching.
vi.mock("@/components/versions/VersionsLazy", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/components/versions/VersionsLazy")>();
  return { ...original, VersionsPanel: () => <div data-testid="versions-panel-stub" /> };
});

const HEADINGS: OutlineHeading[] = [
  { id: "h-intro", level: 1, text: "Intro" },
  { id: "h-usage", level: 2, text: "Usage" },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/ai/actions" && method === "GET") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

async function renderAt(tier: LayoutTier, versions: Partial<VersionsContextValue> = {}, previewSlot?: ReactNode) {
  stubLayoutTier(tier);
  const doc = new Y.Doc();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (v: Partial<VersionsContextValue>, preview: ReactNode) => (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <VersionsProvider value={{ ...NOOP_VERSIONS, enabled: true, noteId: "note-1", ...v }}>
          <NoteEditor
            doc={doc}
            provider={{ awareness: null } as never}
            editable
            user={{ id: "u1", name: "alice" }}
            noteId="note-1"
            headerSlot={<div data-testid="header-marker">header</div>}
            previewSlot={preview}
          />
        </VersionsProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
  const utils = render(tree(versions, previewSlot));
  const editor = await screen.findByTestId("note-editor");
  // The column's pin transition exists only after the outline has been present for a full frame: pass one frame first, so later assertions look at the settled state.
  await nextFrame();
  const scroll = editor.parentElement!.parentElement!.parentElement!;
  /** Re-renders with new versions state or preview, picking up whatever `outline.box` is now. */
  const update = (v: Partial<VersionsContextValue> = versions, preview: ReactNode = previewSlot) => utils.rerender(tree(v, preview));
  return { ...utils, doc, scroll, update };
}

const nextFrame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
const stub = () => screen.queryByTestId("outline-stub");
const lastProps = () => outline.props[outline.props.length - 1]!;
const column = () => screen.getByTestId("article-column");
const PIN_TRANSITION = "transition-[max-width,left]";
const PINNED_MAX = ARTICLE_COLUMN_MAX["standard-pinned"].split(" ")[0]!;

/**
 * The column carries exactly the width-chain classes of `state` and none of the other states' widths;
 * with `motion` the pin transition is on, without it the column has neither the transition nor `left-0`.
 */
function expectColumn(state: ArticleColumnState, motion = true) {
  const expected = articleColumn(state, { pinMotion: motion }).split(" ");
  expect(column()).toHaveClass(...expected);
  const others = (Object.keys(ARTICLE_COLUMN_MAX) as ArticleColumnState[])
    .filter((s) => s !== state)
    .flatMap((s) => ARTICLE_COLUMN_MAX[s].split(" "))
    .filter((c) => !expected.includes(c));
  for (const c of others) expect(column()).not.toHaveClass(c);
  if (!motion) {
    expect(column()).not.toHaveClass(PIN_TRANSITION);
    expect(column()).not.toHaveClass("left-0");
  }
}

/**
 * Starts recording; the returned function stops and gives every class string the column has had since, in order
 * (from attribute mutation records), ending with the current one. Each commit that changes the class is one entry.
 */
function trackColumnClasses(): () => string[] {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((list) => records.push(...list));
  observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  return () => {
    records.push(...observer.takeRecords());
    observer.disconnect();
    const own = records.filter((r) => (r.target as HTMLElement).dataset?.testid === "article-column");
    return [...own.map((r) => r.oldValue ?? ""), column().className];
  };
}

describe("NoteEditor: mounting conditions of the right-side heading outline", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubFetch();
    outline.headings = HEADINGS;
    outline.props = [];
    outline.box = WIDE_BOX;
    outline.measured = 0;
    resetNoteWidthsForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("no headings -> not mounted, and no layout measuring", async () => {
    outline.headings = [];
    const { doc } = await renderAt("docked");
    expect(stub()).toBeNull();
    expect(outline.measured).toBe(0);
    doc.destroy();
  });

  it("headings, fixed tier -> one mounted, after the header slot and before the scroll container; it gets the scroll container; the bubble is there", async () => {
    const { doc, scroll } = await renderAt("docked");
    expect(screen.getAllByTestId("outline-stub")).toHaveLength(1);
    const header = document.querySelector("[data-note-header-slot]")!;
    expect(header.compareDocumentPosition(stub()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(stub()!.compareDocumentPosition(scroll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The anchor isn't inside the scroll container (the thin line doesn't scroll with the body).
    expect(scroll.contains(stub())).toBe(false);
    expect(stub()!.parentElement).toBe(scroll.parentElement);
    expect(scroll).toHaveClass("overflow-y-auto");
    const props = lastProps();
    expect(props.scrollEl).toBe(scroll);
    expect(props.headings).toBe(HEADINGS);
    expect(props.box).toEqual({ width: 1072, height: 700, firstLineTop: null });
    expect(props.bubbleShown).toBe(true);
    // No pin preference: standard width, container wide enough, can pin but isn't pinned.
    expect(props.pinned).toBe(false);
    expect(props.pinAvailable).toBe(true);
    expectColumn("standard");
    doc.destroy();
  });

  it("during version preview -> not mounted", async () => {
    const { doc } = await renderAt("docked", {}, <div data-testid="preview-marker">preview</div>);
    expect(screen.getByTestId("preview-marker")).toBeInTheDocument();
    expect(stub()).toBeNull();
    doc.destroy();
  });

  it("versions panel open: floating tier (panel covers the card) -> not mounted; fixed tier (panel is the third column) -> mounted, above the stack that stays", async () => {
    const overlay = await renderAt("overlay", { panelOpen: true, mode: "panel" });
    expect(stub()).toBeNull();
    overlay.unmount();
    overlay.doc.destroy();

    outline.props = [];
    const docked = await renderAt("docked", { panelOpen: true, mode: "panel" });
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(true);
    expect(lastProps().bubbleCount).toBe(2);
    docked.doc.destroy();
  });

  it("floating tier, panel not open -> mounted (tablet width has the outline as usual)", async () => {
    const { doc } = await renderAt("overlay");
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(true);
    doc.destroy();
  });

  it("phone tier -> not mounted, and no layout measuring", async () => {
    const { doc } = await renderAt("phone");
    expect(stub()).toBeNull();
    expect(outline.measured).toBe(0);
    doc.destroy();
  });

  it("no versions feature (viewer) -> mounted, no bubble", async () => {
    const { doc } = await renderAt("docked", { enabled: false, noteId: null });
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleShown).toBe(false);
    doc.destroy();
  });
});

describe("NoteEditor: pinned outline", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    window.localStorage.setItem(OUTLINE_PINNED_STORAGE_KEY, "1");
    stubFetch();
    outline.headings = HEADINGS;
    outline.props = [];
    outline.box = WIDE_BOX;
    outline.measured = 0;
    resetNoteWidthsForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    resetNoteWidthsForTest();
  });

  it("standard width, container 1072, preference pinned -> the column switches to the pinned state (with transition), the outline gets pinned and pinAvailable", async () => {
    const { doc } = await renderAt("docked");
    expectColumn("standard-pinned");
    expect(lastProps().pinned).toBe(true);
    expect(lastProps().pinAvailable).toBe(true);
    doc.destroy();
  });

  it("during version preview -> no outline, the column returns to the unpinned standard width, no transition", async () => {
    const { doc } = await renderAt("docked", {}, <div data-testid="preview-marker">preview</div>);
    expect(stub()).toBeNull();
    expectColumn("standard", false);
    doc.destroy();
  });

  it("640-767 (outline uses the phone shape): not pinned even with the preference pinned, the column is the unpinned standard width", async () => {
    const { doc } = await renderAt("compact");
    expect(stub()).toBeNull();
    expectColumn("standard", false);
    doc.destroy();
  });

  it("768-1279 with the versions panel floating over the card -> no outline, the column returns to the unpinned standard width, no transition", async () => {
    const { doc } = await renderAt("overlay", { panelOpen: true, mode: "panel" });
    expect(stub()).toBeNull();
    expectColumn("standard", false);
    doc.destroy();
  });

  it("opening a note: the first switch of the column to the pinned width has no transition (doesn't slide from standard width); pressing pin after one frame has one", async () => {
    const history = trackColumnClasses();
    const { doc } = await renderAt("docked");
    const values = history();
    const firstPinned = values.find((c) => c.split(" ").includes(PINNED_MAX));
    expect(firstPinned, values.join("\n")).toBeDefined();
    expect(firstPinned!.split(" ")).not.toContain(PIN_TRANSITION);
    // One frame has passed (renderAt already waited): the transition is on.
    expectColumn("standard-pinned");

    act(() => lastProps().onPinnedChange(false));
    expectColumn("standard");
    act(() => lastProps().onPinnedChange(true));
    expectColumn("standard-pinned");
    doc.destroy();
  });

  it("leaving version preview and closing the floating versions panel: when the outline returns the column is directly at pinned width without a transition; with one after a frame", async () => {
    const preview = await renderAt("docked", {}, <div data-testid="preview-marker">preview</div>);
    let history = trackColumnClasses();
    preview.update({}, null);
    expect(stub()).not.toBeNull();
    let values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    await nextFrame();
    expectColumn("standard-pinned");
    preview.unmount();
    preview.doc.destroy();

    const overlay = await renderAt("overlay", { panelOpen: true, mode: "panel" });
    history = trackColumnClasses();
    overlay.update({ panelOpen: false, mode: "panel" });
    expect(stub()).not.toBeNull();
    values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    await nextFrame();
    expectColumn("standard-pinned");
    overlay.doc.destroy();
  });

  it("opening preview while pinned then leaving, opening the floating panel then closing: the return has no transition either (an earlier-enabled transition isn't carried over)", async () => {
    const note = await renderAt("docked");
    expectColumn("standard-pinned");
    note.update({}, <div data-testid="preview-marker">preview</div>);
    expectColumn("standard", false);
    await nextFrame();
    let history = trackColumnClasses();
    note.update({}, null);
    let values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    await nextFrame();
    expectColumn("standard-pinned");
    note.unmount();
    note.doc.destroy();

    const tablet = await renderAt("overlay");
    expectColumn("standard-pinned");
    tablet.update({ panelOpen: true, mode: "panel" });
    expectColumn("standard", false);
    await nextFrame();
    history = trackColumnClasses();
    tablet.update({ panelOpen: false, mode: "panel" });
    values = history();
    expect(values[values.length - 1]!.split(" ")).toContain(PINNED_MAX);
    for (const c of values) expect(c.split(" ")).not.toContain(PIN_TRANSITION);
    tablet.doc.destroy();
  });

  it("container 912 can't fit a 640 column -> falls back to the thin line, preference unchanged; width back to 1072 -> pins again automatically", async () => {
    outline.box = { ...WIDE_BOX, width: 912 };
    const { doc, update } = await renderAt("docked");
    expectColumn("standard");
    expect(lastProps().pinAvailable).toBe(false);
    expect(lastProps().pinned).toBe(false);
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");

    outline.box = WIDE_BOX;
    update();
    expectColumn("standard-pinned");
    expect(lastProps().pinned).toBe(true);
    doc.destroy();
  });

  it("fixed tier opens the versions panel, container 1072 -> 740 -> falls back to the thin line; closing the panel and width back to 1072 -> pins again", async () => {
    const { doc, update } = await renderAt("docked");
    expectColumn("standard-pinned");

    outline.box = { ...WIDE_BOX, width: 740 };
    update({ panelOpen: true, mode: "panel" });
    expect(stub()).not.toBeNull();
    expect(lastProps().pinned).toBe(false);
    expect(lastProps().pinAvailable).toBe(false);
    expectColumn("standard");

    outline.box = WIDE_BOX;
    update({});
    expect(lastProps().pinned).toBe(true);
    expectColumn("standard-pinned");
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");
    doc.destroy();
  });

  it("note changes to wide -> the column is wide and can't pin; back to standard -> pins again", async () => {
    const { doc } = await renderAt("docked");
    expectColumn("standard-pinned");

    act(() => setNoteWidth("note-1", "wide"));
    expectColumn("wide");
    expect(lastProps().pinAvailable).toBe(false);
    expect(lastProps().pinned).toBe(false);

    act(() => setNoteWidth("note-1", "standard"));
    expectColumn("standard-pinned");
    expect(lastProps().pinned).toBe(true);
    doc.destroy();
  });

  it("no preference -> can pin but isn't pinned; pressing pin (onPinnedChange(true)) -> remembers the preference, the column switches to the pinned state", async () => {
    window.localStorage.removeItem(OUTLINE_PINNED_STORAGE_KEY);
    const { doc } = await renderAt("docked");
    expect(lastProps().pinAvailable).toBe(true);
    expect(lastProps().pinned).toBe(false);
    expectColumn("standard");

    act(() => lastProps().onPinnedChange(true));
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBe("1");
    expect(lastProps().pinned).toBe(true);
    expectColumn("standard-pinned");

    act(() => lastProps().onPinnedChange(false));
    expect(window.localStorage.getItem(OUTLINE_PINNED_STORAGE_KEY)).toBeNull();
    expectColumn("standard");
    doc.destroy();
  });
});

describe("NoteEditor: phone position bubble, bottom sheet and the header menu entry", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    stubFetch();
    outline.headings = HEADINGS;
    outline.props = [];
    outline.box = WIDE_BOX;
    outline.measured = 0;
    phoneStubs.bubble = [];
    phoneStubs.sheet = [];
    phoneStubs.realSheet = false;
    resetNoteWidthsForTest();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The header slot carries a probe reading the ⋮ context, as the header ⋮ does. */
  async function renderPhone(opts: { tier?: LayoutTier; mobileToolbar?: boolean; fabClearance?: boolean; previewSlot?: ReactNode } = {}) {
    const tier = stubLayoutTier(opts.tier ?? "phone");
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // One provider object across re-renders: a new one would build a new editor.
    const provider = { awareness: null } as never;
    const tree = (mobileToolbar: boolean | undefined) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <VersionsProvider value={{ ...NOOP_VERSIONS, enabled: true, noteId: "note-1" }}>
            <NoteEditor
              doc={doc}
              provider={provider}
              editable
              user={{ id: "u1", name: "alice" }}
              noteId="note-1"
              headerSlot={<MenuProbe />}
              mobileToolbar={mobileToolbar}
              fabClearance={opts.fabClearance}
              previewSlot={opts.previewSlot}
            />
          </VersionsProvider>
        </ThemeProvider>
      </QueryClientProvider>
    );
    const utils = render(tree(opts.mobileToolbar));
    const editor = await screen.findByTestId("note-editor");
    await nextFrame();
    const scroll = editor.parentElement!.parentElement!.parentElement!;
    return { ...utils, doc, scroll, tier, setMobileToolbar: (next: boolean) => utils.rerender(tree(next)) };
  }

  const probe = () => screen.getByTestId("menu-probe");
  const lastBubble = () => phoneStubs.bubble[phoneStubs.bubble.length - 1]!;
  const lastSheet = () => phoneStubs.sheet[phoneStubs.sheet.length - 1]!;

  it("phone, headings -> none of the desktop thin line; the bubble is fixed below the header, listens to the window's scroll, jumps inside the scroll container; the header menu in the header slot gets available", async () => {
    const { doc, scroll } = await renderPhone();
    expect(stub()).toBeNull();
    expect(screen.getByTestId("bubble-stub")).toBeInTheDocument();
    expect(lastBubble().placement).toBe("page");
    expect(lastBubble().scrollTarget).toBe(window);
    expect(lastBubble().headings).toBe(HEADINGS);
    // Scrolling caused by typing doesn't bring up the bubble: it looks at input inside the article column.
    expect(lastBubble().inputRoot).toBe(column());
    expect(probe()).toHaveAttribute("data-available", "true");
    expect(scroll.contains(screen.getByTestId("bubble-stub"))).toBe(false);
    expect(lastSheet().open).toBe(false);
    doc.destroy();
  });

  it("640-767: likewise no thin line; the bubble floats on the anchor layer at the container's top edge and listens to the container's scroll (the document doesn't scroll); the header menu gets available", async () => {
    const { doc, scroll } = await renderPhone({ tier: "compact" });
    expect(stub()).toBeNull();
    expect(screen.getByTestId("bubble-stub")).toBeInTheDocument();
    expect(lastBubble().placement).toBe("anchor");
    expect(lastBubble().scrollTarget).toBe(scroll);
    expect(lastBubble().scrollTarget).not.toBe(window);
    expect(probe()).toHaveAttribute("data-available", "true");
    doc.destroy();
  });

  it("767 -> 768: switches from the phone shape to the thin line and the sheet closes; back to 767 switches to the bubble again", async () => {
    const { doc, tier } = await renderPhone({ tier: "compact" });
    expect(screen.getByTestId("bubble-stub")).toBeInTheDocument();
    act(() => tier.setLayoutTier("overlay"));
    await waitFor(() => expect(stub()).not.toBeNull());
    expect(screen.queryByTestId("bubble-stub")).toBeNull();
    act(() => tier.setLayoutTier("compact"));
    await waitFor(() => expect(screen.getByTestId("bubble-stub")).toBeInTheDocument());
    expect(stub()).toBeNull();
    doc.destroy();
  });

  it("widening to 768 at 640-767 with the sheet open: the sheet closes", async () => {
    const { doc, tier } = await renderPhone({ tier: "compact" });
    fireEvent.click(probe());
    expect(lastSheet().open).toBe(true);
    act(() => tier.setLayoutTier("overlay"));
    await waitFor(() => expect(stub()).not.toBeNull());
    act(() => tier.setLayoutTier("compact"));
    await waitFor(() => expect(screen.getByTestId("bubble-stub")).toBeInTheDocument());
    expect(lastSheet().open).toBe(false);
    doc.destroy();
  });

  it("the header menu's open() -> the bottom sheet opens; closing it (onOpenChange(false)) -> closed; tapping the bubble also opens it", async () => {
    const { doc } = await renderPhone();
    fireEvent.click(probe());
    expect(lastSheet().open).toBe(true);
    act(() => lastSheet().onOpenChange(false));
    expect(lastSheet().open).toBe(false);
    fireEvent.click(screen.getByTestId("bubble-stub"));
    expect(lastSheet().open).toBe(true);
    doc.destroy();
  });

  it("phone: while browsing the track's bottom end clears the floating button at the bottom right; with the editing toolbar present it clears the toolbar instead", async () => {
    const browsing = await renderPhone({ fabClearance: true });
    expect(lastBubble().bottomReserve).toBe(PHONE_FAB_FOOTPRINT_PX);
    expect(lastBubble().editToolbarHeight).toBe(0);
    browsing.unmount();
    browsing.doc.destroy();
    const editing = await renderPhone();
    editing.setMobileToolbar(true);
    expect(lastBubble().editToolbarHeight).toBe(PHONE_EDIT_TOOLBAR_CLEARANCE_PX);
    editing.unmount();
    editing.doc.destroy();
  });

  it("640-767: the track's bottom end stops above the stack: the toggle and the versions bubble, or the toggle alone when collapsed", async () => {
    const { doc, unmount } = await renderPhone({ tier: "compact" });
    expect(lastBubble().bottomReserve).toBe(cornerStackFootprint(2));
    expect(lastBubble().editToolbarHeight).toBe(0);
    unmount();
    doc.destroy();
    window.localStorage.setItem(CORNER_STACK_COLLAPSED_STORAGE_KEY, "1");
    const collapsed = await renderPhone({ tier: "compact" });
    expect(lastBubble().bottomReserve).toBe(CORNER_STACK_FOOTPRINT_PX);
    collapsed.doc.destroy();
  });

  it("tapping the bubble while editing (the bubble doesn't take focus, the toolbar stays): the sheet gets a restoreFocus that returns focus to the editor without scrolling; the toolbar collapsing while the sheet is open doesn't change it", async () => {
    const editing = await renderPhone({ mobileToolbar: true });
    fireEvent.click(screen.getByTestId("bubble-stub"));
    expect(lastSheet().open).toBe(true);
    const restore = lastSheet().restoreFocus;
    expect(restore).toEqual(expect.any(Function));
    // While the sheet is open focus is inside the sheet and the toolbar collapses: restoreFocus is still the one recorded at the moment it opened.
    editing.setMobileToolbar(false);
    expect(lastSheet().restoreFocus).toBe(restore);
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    restore!();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(focus.mock.contexts[0]).toHaveClass("ProseMirror");
    editing.unmount();
    editing.doc.destroy();
  });

  it("not editing: restoreFocus returns to the element that opened it (the header menu hands over its trigger, the bubble hands over itself); no element handed over -> none", async () => {
    const { doc } = await renderPhone();
    fireEvent.click(probe());
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    lastSheet().restoreFocus!();
    expect(focus.mock.contexts[0]).toBe(probe());
    act(() => lastSheet().onOpenChange(false));
    focus.mockClear();
    fireEvent.click(screen.getByTestId("bubble-stub"));
    lastSheet().restoreFocus!();
    expect(focus.mock.contexts[0]).toBe(screen.getByTestId("bubble-stub"));
    act(() => lastSheet().onOpenChange(false));
    fireEvent.click(screen.getByTestId("menu-probe-bare"));
    expect(lastSheet().open).toBe(true);
    expect(lastSheet().restoreFocus).toBeUndefined();
    doc.destroy();
  });

  describe("the real bottom sheet: where focus lands when it is closed directly (Esc)", () => {
    beforeEach(() => {
      phoneStubs.realSheet = true;
    });

    it("opened from the bubble while editing -> Esc closes -> focus returns to the editor (the toolbar follows focus, doesn't disappear)", async () => {
      const { doc } = await renderPhone({ mobileToolbar: true });
      fireEvent.click(screen.getByTestId("bubble-stub"));
      const dialog = await screen.findByRole("dialog", { name: "Heading outline" });
      fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toHaveClass("ProseMirror"));
      doc.destroy();
    });

    it("opened from the header menu -> Esc closes -> focus returns to the header menu (doesn't fall to body)", async () => {
      const { doc } = await renderPhone();
      fireEvent.click(probe());
      const dialog = await screen.findByRole("dialog", { name: "Heading outline" });
      fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(probe()));
      doc.destroy();
    });
  });

  it.each([
    ["version preview", { previewSlot: <div>preview</div> }],
    ["fixed tier (with thin line)", { tier: "docked" as const }],
    ["floating tier (with thin line)", { tier: "overlay" as const }],
  ])("%s -> the header menu gets available=false, no bubble and no sheet", async (_label, opts) => {
    const { doc } = await renderPhone(opts);
    expect(probe()).toHaveAttribute("data-available", "false");
    expect(screen.queryByTestId("bubble-stub")).toBeNull();
    expect(phoneStubs.sheet).toHaveLength(0);
    doc.destroy();
  });

  it("no headings -> available=false, no bubble", async () => {
    outline.headings = [];
    const { doc } = await renderPhone();
    expect(probe()).toHaveAttribute("data-available", "false");
    expect(screen.queryByTestId("bubble-stub")).toBeNull();
    doc.destroy();
  });

  it("widening out of the phone tier with the sheet open -> the sheet closes; returning to the phone tier doesn't reopen it by itself", async () => {
    const { doc, tier } = await renderPhone();
    fireEvent.click(probe());
    expect(lastSheet().open).toBe(true);
    act(() => tier.setLayoutTier("overlay"));
    expect(probe()).toHaveAttribute("data-available", "false");
    expect(screen.queryByTestId("bubble-stub")).toBeNull();
    phoneStubs.sheet = [];
    act(() => tier.setLayoutTier("phone"));
    expect(screen.getByTestId("bubble-stub")).toBeInTheDocument();
    expect(lastSheet().open).toBe(false);
    doc.destroy();
  });
});

describe("NoteEditor: the outline and the comments panel share the right-hand slot rules", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    outline.headings = HEADINGS;
    outline.props = [];
    outline.box = WIDE_BOX;
    outline.measured = 0;
    phoneStubs.bubble = [];
    resetNoteWidthsForTest();
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/ai/actions") return Promise.resolve(json({ actions: [] }));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/notes") return Promise.resolve(json([]));
      if (url.endsWith("/comments/unread-count")) return Promise.resolve(json({ count: 0 }));
      throw new Error(`unexpected fetch: ${url}`);
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  async function renderWithComments(tier: LayoutTier, comments: Partial<CommentsContextValue>, versionsEnabled = true) {
    stubLayoutTier(tier);
    const doc = new Y.Doc();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <VersionsProvider value={{ ...NOOP_VERSIONS, enabled: versionsEnabled, noteId: "note-1" }}>
            <CommentsProvider value={{ ...NOOP_COMMENTS, enabled: true, noteId: "note-1", ...comments }}>
              <NoteEditor doc={doc} provider={{ awareness: null } as never} editable user={{ id: "u1", name: "alice" }} noteId="note-1" />
            </CommentsProvider>
          </VersionsProvider>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await screen.findByTestId("note-editor");
    await nextFrame();
    return doc;
  }

  it("two bubbles and the toggle: the outline stops above all three; the toggle and one bubble for a viewer", async () => {
    const both = await renderWithComments("docked", {});
    expect(lastProps().bubbleShown).toBe(true);
    expect(lastProps().bubbleCount).toBe(3);
    cleanup();
    both.destroy();
    outline.props = [];
    const viewer = await renderWithComments("docked", {}, false);
    expect(lastProps().bubbleCount).toBe(2);
    viewer.destroy();
  });

  it("comments panel open: floating tier -> no outline; fixed tier -> outline above the stack that stays", async () => {
    const overlay = await renderWithComments("overlay", { panelOpen: true, mode: "panel" });
    expect(stub()).toBeNull();
    cleanup();
    overlay.destroy();
    outline.props = [];
    const docked = await renderWithComments("docked", { panelOpen: true, mode: "panel" });
    expect(stub()).not.toBeNull();
    expect(lastProps().bubbleCount).toBe(3);
    docked.destroy();
  });

  it("640-767: the phone outline track stops above both bubbles and the toggle", async () => {
    const doc = await renderWithComments("compact", {});
    expect(phoneStubs.bubble[phoneStubs.bubble.length - 1]!.bottomReserve).toBe(cornerStackFootprint(3));
    doc.destroy();
  });
});
