import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vid, vlabel, vtarget } from "@/test/version-fixtures";
import { Profiler } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT, type VersionDto, type VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { noteSchema } from "@/collab/schema";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { ARTICLE_COLUMN, ARTICLE_COLUMN_PADDING, articleColumn } from "@/components/ui/article-column";
import { setNoteWidth } from "@/components/note-width";
import { ThemeProvider } from "@/theme";
import { versionListKey } from "@/api/versions";
import { KIND_FILTER_STORAGE_KEY } from "@/lib/versions-context";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { diffBlocks, renderDiff, type DiffBlock } from "@/lib/version-diff";
import { MediaZoomProvider } from "@/components/media-zoom/MediaZoomProvider";
import { DiffEditor, VersionPreview } from "./VersionPreview";
import { PreviewBanner } from "./PreviewBanner";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

vi.mock("@/lib/use-container-width", () => ({ useContainerWidth: () => widthRef.current }));
// mermaid itself cannot run under jsdom: return a fixed small SVG.
vi.mock("@/lib/mermaid", () => ({
  renderMermaid: vi.fn(() => Promise.resolve({ ok: true, svg: "<svg viewBox='0 0 10 10'></svg>" })),
  cachedMermaid: vi.fn(() => null),
  preloadMermaid: vi.fn(),
  nextMermaidId: () => "mermaid-test",
}));
const widthRef = vi.hoisted(() => ({ current: 600 }));

const NOTE = "n1";
function b64(blocks: unknown[]): string {
  const doc = new Y.Doc();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock generic triple
  blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), blocks as any, doc.getXmlFragment(YDOC_FRAGMENT));
  return btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
}
const ver = (seq: number): VersionDto => ({ id: vid(seq), seq, kind: "auto", name: null, editors: [{ handle: "ann", agentLabel: null, avatar: null }], baseSeq: null, base: null, createdAt: "2026-10-09T00:00:00.000Z" });
const V1 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }];
const V2 = [{ id: "A", type: "paragraph", content: "甲改" }, { id: "C", type: "paragraph", content: "丙" }];

function stub(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (!(url in routes)) throw new Error(`unexpected fetch: ${url}`);
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(routes[url]) } as Response);
    }),
  );
  return calls;
}
const list = (versions: VersionDto[], nextBefore: number | null = null): VersionListDto => ({
  versions,
  current: { baseSeq: versions[0]?.seq ?? null, base: versions[0] ? { id: versions[0].id, name: versions[0].name, deleted: false } : null, dirty: false, nextSeq: (versions[0]?.seq ?? 0) + 1, autoEnabled: true },
  nextBefore,
});

function Probe() {
  const s = useVersions();
  return (
    <>
      <span data-testid="preview-state">{JSON.stringify(s.preview)}</span>
      <span data-testid="right-state">{JSON.stringify(s.compareRight)}</span>
    </>
  );
}
/** `profile`: onRender of a `<Profiler>` wrapped around VersionPreview **alone**: it counts only commits of the VersionPreview subtree (PreviewBanner also reads the list and must not be counted).
 * `right`: the "r" button sets the right side to that version; the "rc" button sets it back to the current state (also used to trigger a context change after widthRef changes). */
function Host({ doc, seq, seq2, right, forceSingle, profile }: { doc: Y.Doc; seq: number; seq2?: number; right?: number; forceSingle?: boolean; profile?: () => void }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  return (
    <VersionsProvider value={value}>
      <button type="button" onClick={() => value.startPreview(vtarget(seq))}>go</button>
      {seq2 !== undefined && (
        <button type="button" onClick={() => value.startPreview(vtarget(seq2))}>
          go2
        </button>
      )}
      {right !== undefined && (
        <button type="button" onClick={() => value.setCompareRight(vtarget(right))}>
          r
        </button>
      )}
      <button type="button" onClick={() => value.setCompareRight("current")}>
        rc
      </button>
      <button type="button" onClick={() => value.setSplitMode("single")}>
        ss
      </button>
      <Probe />
      {value.preview && (
        <>
          {/* A narrow full page (forceSingle) has no side-by-side / single-column buttons: the banner must also collapse to narrow, or the forceSingle case's no-Side-by-side-button assertion cannot hold */}
          <PreviewBanner narrow={forceSingle} />
          <Profiler id="version-preview" onRender={() => profile?.()}>
            <VersionPreview doc={doc} forceSingle={forceSingle} />
          </Profiler>
        </>
      )}
    </VersionsProvider>
  );
}
/** `rightLater`: renders the "r" button but does not press it automatically (look at it vs the current state first, change the right side afterwards). */
function renderPreview(opts: { seq: number; seq2?: number; right?: number; rightLater?: boolean; live?: unknown[]; forceSingle?: boolean; profile?: () => void }) {
  const live = new Y.Doc();
  if (opts.live) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    blocksToYXmlFragment(BlockNoteEditor.create({ schema: noteSchema }), opts.live as any, live.getXmlFragment(YDOC_FRAGMENT));
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <Host doc={live} seq={opts.seq} seq2={opts.seq2} right={opts.right} forceSingle={opts.forceSingle} profile={opts.profile} />
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText("go"));
  if (opts.right !== undefined && !opts.rightLater) fireEvent.click(screen.getByText("r"));
  return { live, queryClient };
}
const routesV1 = () => ({
  [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
  [`/api/notes/${NOTE}/versions/2`]: { id: vid(2), seq: 2, ydoc: b64(V2) },
  [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(V1) },
});

describe("VersionPreview", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.clear();
    dismissAllToasts();
    widthRef.current = 600; // below the 720 side-by-side threshold: single column
  });
  afterEach(() => vi.unstubAllGlobals());

  it("default = left (the chosen version) vs the current state (a fork of the live document): a single-column read-only editor, data-diff pasted back (A changed, B deleted with a synthesized id, C added), unchanged blocks pasted back as context, and no writes to the live document", async () => {
    stub(routesV1());
    const { live } = renderPreview({ seq: 1, live: [...V2, { id: "D", type: "paragraph", content: "丁" }] });
    let updates = 0;
    live.on("update", () => (updates += 1));
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull();
    expect(view.querySelector('[data-id^="diff-del-"][data-diff="deleted"]')).not.toBeNull();
    expect(view.querySelector('[contenteditable="true"]')).toBeNull();
    expect(screen.getByTestId("right-state")).toHaveTextContent('"current"');
    expect(updates).toBe(0);
  });

  it("carry: unchanged blocks are not in the marks and DiffEditor pastes context back (vs the current state)", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1, live: [{ id: "A", type: "paragraph", content: "甲" }, { id: "D", type: "paragraph", content: "丁" }] });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="D"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="context"]')).not.toBeNull();
  });

  it("two snapshots: an unrelated context change (splitMode) -> VersionPreview does re-render but does not rebuild the read-only editor (BlockNoteEditor.create call count 0); the single column takes the article column width", async () => {
    // The second response MUST differ from the first: when the body is unchanged React Query's structural sharing keeps the old data reference, so VersionPreview
    // does not re-render at all and the check stays green with or without useMemo.
    // Comparing the same `.bn-editor` node does not work either: when BlockNote rebuilds the read-only editor the `.bn-editor` root node is reused, so that check is green with or without useMemo.
    // The assertion is BlockNoteEditor.create's call count after the refetch (expected 0).
    // The right side is two snapshots (right selects seq 2), so both snapshot useMemos are on the path.
    // VersionPreview does not read the list's data (React Query re-renders only when a field that was read changes),
    // so a list refetch alone does not make it re-render: an unrelated context change (setSplitMode("single") at narrow width, layout unchanged)
    // guarantees a real re-render, and then the assertion is that nothing was rebuilt.
    // The list refetch below (dirty flipping) is kept as a regression guard: today it is a no-op for VersionPreview; if VersionPreview reads the list data,
    // it re-renders with it and this part guards that a list refetch does not rebuild (the create count is still asserted to be 0).
    const routes: Record<string, unknown> = routesV1();
    stub(routes);
    const commits = vi.fn();
    const { queryClient } = renderPreview({ seq: 1, right: 2, profile: commits });
    const view = await screen.findByTestId("diff-single");
    expect(view).toHaveClass(...ARTICLE_COLUMN.split(" "), ARTICLE_COLUMN_PADDING);
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      const base = list([ver(2), ver(1)]);
      routes[`/api/notes/${NOTE}/versions?limit=50`] = { ...base, current: { ...base.current, dirty: true } };
      await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
      const commitsBefore = commits.mock.calls.length;
      fireEvent.click(screen.getByText("ss"));
      await waitFor(() => expect(commits.mock.calls.length).toBeGreaterThan(commitsBefore));
      expect(screen.getByTestId("diff-single")).toBeInTheDocument();
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
  });

  it("#297: this note's in-site width is wide -> the single-column diff takes the wide column, without the standard max-w", async () => {
    stub(routesV1());
    setNoteWidth(NOTE, "wide");
    renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    expect(view).toHaveClass(...articleColumn("wide").split(" "), ARTICLE_COLUMN_PADDING);
    expect(view).not.toHaveClass("max-w-[clamp(42.5rem,85%,66rem)]");
  });

  it("#297: changing the width while previewing -> the single column follows to full width without rebuilding the read-only editor", async () => {
    stub(routesV1());
    renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      act(() => setNoteWidth(NOTE, "full"));
      const after = screen.getByTestId("diff-single");
      expect(after).toHaveClass("max-w-none");
      expect(after).not.toHaveClass("max-w-[clamp(42.5rem,85%,66rem)]");
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
  });

  it("vs the current state: an unrelated context change (splitMode) -> the read-only editor is not rebuilt and the live document is not re-read", async () => {
    // The list refetch part is the same as the previous case: a no-op for VersionPreview today, kept as a regression guard.
    const routes: Record<string, unknown> = routesV1();
    stub(routes);
    const commits = vi.fn();
    const { queryClient } = renderPreview({ seq: 1, live: V2, profile: commits });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      const base = list([ver(2), ver(1)]);
      routes[`/api/notes/${NOTE}/versions?limit=50`] = { ...base, current: { ...base.current, dirty: true } };
      await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
      const commitsBefore = commits.mock.calls.length;
      fireEvent.click(screen.getByText("ss"));
      await waitFor(() => expect(commits.mock.calls.length).toBeGreaterThan(commitsBefore));
      expect(create).toHaveBeenCalledTimes(0);
    } finally {
      create.mockRestore();
    }
  });

  it("choosing a version on the right -> compares two snapshots in the direction left -> right (left seq 2, right seq 1: B added, C deleted, A changed); the live document is not read", async () => {
    stub(routesV1());
    renderPreview({ seq: 2, right: 1, live: [{ id: "Z", type: "paragraph", content: "活" }] });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="B"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-id="A"][data-diff="changed"]')).not.toBeNull();
    expect(view.querySelector('[data-id^="diff-del-"][data-diff="deleted"]')).not.toBeNull();
    expect(view.querySelector('[data-id="C"]')).toBeNull();
    expect(view.querySelector('[data-id="Z"]')).toBeNull();
    expect(view.querySelector('[data-diff="deleted"]')).toHaveTextContent("丙");
  });

  it("a right version newer than the left (left seq 1, right seq 2) is computed as is without swapping sides: C added, B deleted; the triggers stay left seq 1, right seq 2", async () => {
    stub(routesV1());
    renderPreview({ seq: 1, right: 2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    expect(view.querySelector('[data-diff="deleted"]')).toHaveTextContent("乙");
    const banner = within(screen.getByTestId("preview-banner"));
    expect(banner.getByRole("button", { name: "Left side" })).toHaveTextContent(vlabel(1));
    expect(banner.getByRole("button", { name: "Right side" })).toHaveTextContent(vlabel(2));
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":1');
    expect(screen.getByTestId("right-state")).toHaveTextContent('"seq":2');
  });

  it("show only differences: unchanged blocks collapse to one line", async () => {
    const many = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }, { id: "E", type: "paragraph", content: "戊" }];
    const many2 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }, { id: "E", type: "paragraph", content: "戊改" }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(many) },
    });
    renderPreview({ seq: 1, live: many2 });
    fireEvent.click(await screen.findByRole("button", { name: "Only changes" }));
    expect(await screen.findByText("… 2 unchanged blocks …")).toBeInTheDocument();
  });

  it("side by side (threshold 720): width >= 720 switches to side by side automatically (two read-only editors, left and right labelled, a two-column grid); choosing Single column manually overrides it", async () => {
    stub(routesV1());
    widthRef.current = 720;
    renderPreview({ seq: 1, live: V2 });
    const split = await screen.findByTestId("diff-split");
    // Narrow does not render side-by-side, so side-by-side always has two columns (no container query stacks them when narrow).
    expect(split).toHaveClass("grid", "grid-cols-2");
    expect(split).not.toHaveClass("grid-cols-1");
    // The vertical line runs the full height of the preview area: the wrapper fills at least the scroll container and the content grid fills the remaining height (the right section's border-l stretches to the bottom).
    expect(split.parentElement).toHaveClass("relative", "min-h-full", "flex", "flex-col");
    expect(split).toHaveClass("flex-1");
    const [left, right] = within(split).getAllByTestId("diff-pane");
    await waitFor(() => expect(left.querySelector('[data-id="B"][data-diff="deleted"]')).not.toBeNull());
    await waitFor(() => expect(right.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Single column" }));
    const single = await screen.findByTestId("diff-single");
    expect(single).toBeInTheDocument();
    expect(single.querySelector(".border-l")).toBeNull();
    expect(single).not.toHaveClass("border-l");
    expect(single).not.toHaveClass("flex-1");
  });

  describe("side-by-side block alignment (left seq 1 = [A, B], right current state = [A changed, N new, B]: rows {0,0}{null,1}{1,2})", () => {
    const INS_V1 = [{ id: "A", type: "paragraph", content: "甲" }, { id: "B", type: "paragraph", content: "乙" }];
    const INS_LIVE = [{ id: "A", type: "paragraph", content: "甲改" }, { id: "N", type: "paragraph", content: "新" }, { id: "B", type: "paragraph", content: "乙" }];
    const routesIns = () => ({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(INS_V1) },
    });
    const rowOf = (pane: Element) => Array.from(pane.querySelectorAll<HTMLElement>(".bn-block-outer")).map((el) => [el.dataset.id, el.dataset.diffRow]);

    it("top-level block-outer in both columns carries data-diff-row: the same row has the same number, a one-sided row (N) has its number only in the right column; jsdom heights are all 0 -> no spacer and no inline margin", async () => {
      stub(routesIns());
      widthRef.current = 900;
      renderPreview({ seq: 1, live: INS_LIVE });
      const split = await screen.findByTestId("diff-split");
      const [left, right] = within(split).getAllByTestId("diff-pane");
      await waitFor(() => expect(rowOf(right)).toEqual([["A", "0"], ["N", "1"], ["B", "2"]]));
      expect(rowOf(left)).toEqual([["A", "0"], ["B", "2"]]);
      expect(split.querySelector(".kb-diff-spacer")).toBeNull();
      for (const el of split.querySelectorAll<HTMLElement>(".bn-block-outer")) {
        expect(el.style.marginTop).toBe("");
        expect(el.style.marginBottom).toBe("");
      }
      expect(split.querySelectorAll("section")[0]).toHaveClass("relative");
      expect(split.querySelectorAll("section")[1]).toHaveClass("relative");
    });

    it("when heights are measurable (getBoundingClientRect faked from text length: 12.4px per character, block left 20 / width 100): the shorter side's difference plus the whole height of the opposite one-sided row accumulate into the next block's margin-top (decimals not rounded); a one-sided row gets an equal-height spacer opposite it, narrowed to the block's horizontal extent; when the rows change the old margins are cleared first", async () => {
      const orig = Element.prototype.getBoundingClientRect;
      const spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
        if (!this.classList.contains("bn-block-outer")) return orig.call(this);
        const h = 12.4 * (this.textContent ?? "").length;
        return { x: 20, y: 0, left: 20, top: 0, width: 100, height: h, right: 120, bottom: h, toJSON: () => ({}) } as DOMRect;
      });
      try {
        stub(routesIns());
        widthRef.current = 900;
        renderPreview({ seq: 1, live: INS_LIVE, right: 1, rightLater: true });
        const split = await screen.findByTestId("diff-split");
        const [left, right] = within(split).getAllByTestId("diff-pane");
        await waitFor(() => expect(rowOf(right)).toEqual([["A", "0"], ["N", "1"], ["B", "2"]]));
        // Row 0: left A is 12.4, right A is 24.8 -> left is short by 12.4; row 1: left empty, the whole row is 12.4 -> left B's margin-top = 24.8 (an integer offsetHeight would give 24).
        await waitFor(() => expect(left.querySelector<HTMLElement>('.bn-block-outer[data-id="B"]')!.style.marginTop).toBe("24.8px"));
        expect(left.querySelector<HTMLElement>('.bn-block-outer[data-id="A"]')!.style.marginTop).toBe("");
        for (const el of right.querySelectorAll<HTMLElement>(".bn-block-outer")) expect(el.style.marginTop).toBe("");
        const [leftSec, rightSec] = split.querySelectorAll("section");
        const spacers = leftSec.querySelectorAll<HTMLElement>(".kb-diff-spacer");
        expect(spacers).toHaveLength(1);
        expect(spacers[0]).toHaveAttribute("aria-hidden", "true");
        expect(spacers[0].style.height).toBe("12.4px");
        expect(spacers[0].style.left).toBe("20px");
        expect(spacers[0].style.width).toBe("100px");
        expect(rightSec.querySelector(".kb-diff-spacer")).toBeNull();
        expect((leftSec as HTMLElement).style.paddingBottom).toBe("");
        // The right side switches to seq 1 (same as the left): the left editor is not rebuilt (identity a unchanged), and the margins written last round must be cleared and the spacer gone.
        const leftB = left.querySelector<HTMLElement>('.bn-block-outer[data-id="B"]')!;
        fireEvent.click(screen.getByText("r"));
        await waitFor(() => expect(rowOf(within(screen.getByTestId("diff-split")).getAllByTestId("diff-pane")[1])).toEqual([["A", "0"], ["B", "1"]]));
        expect(left.querySelector('.bn-block-outer[data-id="B"]')).toBe(leftB);
        expect(leftB.style.marginTop).toBe("");
        expect(screen.getByTestId("diff-split").querySelector(".kb-diff-spacer")).toBeNull();
      } finally {
        spy.mockRestore();
      }
    });

    it("insufficient width (single column) does not paste back data-diff-row and creates no spacer", async () => {
      stub(routesIns());
      widthRef.current = 600;
      renderPreview({ seq: 1, live: INS_LIVE });
      const view = await screen.findByTestId("diff-single");
      await waitFor(() => expect(view.querySelector('[data-id="N"][data-diff="added"]')).not.toBeNull());
      expect(document.querySelector("[data-diff-row]")).toBeNull();
      expect(document.querySelector(".kb-diff-spacer")).toBeNull();
    });
  });

  it("in side-by-side the two column headers are two dropdowns (left seq 1 / right Current state), not plain-text h3; the banner has no dropdown", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    const split = await screen.findByTestId("diff-split");
    // The header row shares the same two-column grid as the two columns (left/right aligned) and sits above them.
    const head = screen.getByTestId("diff-split-head");
    expect(head).toHaveClass("grid", "grid-cols-2", "gap-4");
    expect(head.compareDocumentPosition(split) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const [leftCell, rightCell] = Array.from(head.children) as HTMLElement[];
    expect(within(leftCell).getByRole("button", { name: "Left side" })).toHaveTextContent(vlabel(1));
    expect(within(rightCell).getByRole("button", { name: "Right side" })).toHaveTextContent("Current state");
    expect(document.querySelector('[data-testid="diff-split-head"] h3, [data-testid="diff-split"] h3')).toBeNull();
    // A 1px border-border vertical line between the columns: the right column (right header cell + right content section) carries border-l and the left does not; the header uses pb rather than mb so the line is continuous.
    const [leftSection, rightSection] = Array.from(split.children) as HTMLElement[];
    for (const el of [rightCell, rightSection]) expect(el).toHaveClass("border-l", "border-border");
    for (const el of [leftCell, leftSection]) expect(el).not.toHaveClass("border-l");
    expect(leftCell).not.toHaveClass("mb-1");
    expect(rightCell).not.toHaveClass("mb-1");
    const banner = within(screen.getByTestId("preview-banner"));
    await waitFor(() => expect(banner.getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "true"));
    expect(banner.queryByRole("button", { name: "Left side" })).not.toBeInTheDocument();
    expect(banner.queryByRole("button", { name: "Right side" })).not.toBeInTheDocument();
  });

  it("side by side, the snapshot read for right seq 1 fails (500) -> the column header dropdowns stay; choosing Current state on the right again -> the error disappears and the preview stays", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as Response);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return ok(list([ver(2), ver(1)]));
        if (url === `/api/notes/${NOTE}/versions/2`) return ok({ id: vid(2), seq: 2, ydoc: b64(V2) });
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    widthRef.current = 900;
    renderPreview({ seq: 2, right: 1, live: V1 });
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    const right = within(screen.getByTestId("diff-split-head")).getByRole("button", { name: "Right side" });
    expect(right).toHaveTextContent(vlabel(1));
    fireEvent.pointerDown(right, { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: "Current state" }));
    await waitFor(() => expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument());
    expect(screen.getByTestId("right-state")).toHaveTextContent('"current"');
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
  });

  it("side by side, choosing an uncached version in the column header (snapshot pending) -> the header row stays and the same trigger button remains mounted", async () => {
    let release!: () => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as Response);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return ok(list([ver(2), ver(1)]));
        if (url === `/api/notes/${NOTE}/versions/1`) return ok({ id: vid(1), seq: 1, ydoc: b64(V1) });
        if (url === `/api/notes/${NOTE}/versions/2`)
          return new Promise<Response>((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve({ id: vid(2), seq: 2, ydoc: b64(V2) }) } as Response)));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const right = within(screen.getByTestId("diff-split-head")).getByRole("button", { name: "Right side" });
    fireEvent.pointerDown(right, { button: 0, ctrlKey: false });
    fireEvent.click(within(await screen.findByRole("menu")).getByRole("menuitemradio", { name: vlabel(2) }));
    expect(await screen.findByText("Loading version…")).toBeInTheDocument();
    expect(screen.getByTestId("diff-split-head")).toBeInTheDocument();
    expect(right.isConnected).toBe(true);
    expect(right).toHaveTextContent(vlabel(2));
    release();
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
  });

  it("show-only-differences has no effect in side-by-side -> the banner's switch is aria-disabled with an explanatory title and clicking does not toggle it; back in single column it is pressable again", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = within(screen.getByTestId("preview-banner"));
    const only = banner.getByRole("button", { name: "Only changes" });
    await waitFor(() => expect(only).toHaveAttribute("aria-disabled", "true"));
    expect(only).toHaveAttribute("title", "Only changes works in single column");
    // The screen-reader description goes through aria-describedby pointing at sr-only text, not only title (toHaveAccessibleDescription falls back to title and could not tell them apart, so the referenced element is queried directly).
    const describedBy = only.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent("Only changes works in single column");
    expect(document.getElementById(describedBy!)).toHaveClass("sr-only");
    fireEvent.click(only);
    expect(only).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(banner.getByRole("button", { name: "Single column" }));
    await screen.findByTestId("diff-single");
    await waitFor(() => expect(only).not.toHaveAttribute("aria-disabled"));
    // The icon button's title is its name normally (visible on hover) and becomes the explanation only when disabled.
    expect(only).toHaveAttribute("title", "Only changes");
    expect(only).not.toHaveAttribute("aria-describedby");
    fireEvent.click(only);
    expect(only).toHaveAttribute("aria-pressed", "true");
  });

  it("preview area < 720 px -> no side-by-side: neither the Side by side nor the Single column button is rendered and the DOM has only the single-column diff", async () => {
    stub(routesV1());
    widthRef.current = 719;
    renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    const banner = within(screen.getByTestId("preview-banner"));
    expect(banner.getByRole("button", { name: "Only changes" })).toBeInTheDocument();
    expect(banner.queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
    expect(banner.queryByRole("button", { name: "Single column" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("diff-split")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("diff-single-editor")).toHaveLength(1);
    expect(screen.queryByTestId("diff-pane")).not.toBeInTheDocument();
  });

  it(">= 720 px the buttons exist and auto shows the effective Side by side as pressed; choosing single column presses it; choosing side by side again -> two columns; narrowing -> only single column and the buttons disappear; widening again -> back to the chosen side by side", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, right: 2, live: V2 });
    // Start with right = seq 2; the "rc" (right back to the current state) / "r" (right back to seq 2) buttons trigger re-renders through the two kinds of context change below.
    await screen.findByTestId("diff-split");
    const banner = () => within(screen.getByTestId("preview-banner"));
    const split = () => banner().getByRole("button", { name: "Side by side" });
    const single = () => banner().getByRole("button", { name: "Single column" });
    await waitFor(() => expect(split()).toHaveAttribute("aria-pressed", "true"));
    expect(single()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(single());
    await screen.findByTestId("diff-single");
    expect(single()).toHaveAttribute("aria-pressed", "true");
    expect(split()).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(split());
    expect(await screen.findByTestId("diff-split")).toHaveClass("grid-cols-2");
    expect(split()).toHaveAttribute("aria-pressed", "true");
    widthRef.current = 600;
    fireEvent.click(screen.getByText("rc"));
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
    await waitFor(() => expect(banner().queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument());
    expect(screen.queryByTestId("diff-split")).not.toBeInTheDocument();
    widthRef.current = 900;
    fireEvent.click(screen.getByText("r"));
    expect(await screen.findByTestId("diff-split")).toBeInTheDocument();
    await waitFor(() => expect(split()).toHaveAttribute("aria-pressed", "true"));
  });

  it("choosing single column manually while wide -> shrinking to < 720 -> back to >= 720 is still single column (the manual choice is kept and not overridden by auto)", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, right: 2, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = () => within(screen.getByTestId("preview-banner"));
    fireEvent.click(banner().getByRole("button", { name: "Single column" }));
    await screen.findByTestId("diff-single");
    // Narrowing / widening: useContainerWidth is mocked to read widthRef and a context change (changing the right side) triggers the re-render.
    widthRef.current = 600;
    fireEvent.click(screen.getByText("rc"));
    await waitFor(() => expect(banner().queryByRole("button", { name: "Single column" })).not.toBeInTheDocument());
    widthRef.current = 900;
    fireEvent.click(screen.getByText("r"));
    await waitFor(() => expect(banner().getByRole("button", { name: "Single column" })).toHaveAttribute("aria-pressed", "true"));
    expect(banner().getByRole("button", { name: "Side by side" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByTestId("diff-split")).not.toBeInTheDocument();
  });

  it("style: the toggle buttons (side by side / single column, show only differences) carry hover:bg-brand/15 when idle and bg-brand/25 plus hover:bg-brand/35 when pressed (visible on a brand-colored background), and hover never goes back to bg-accent", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = within(screen.getByTestId("preview-banner"));
    const split = banner.getByRole("button", { name: "Side by side" });
    await waitFor(() => expect(split).toHaveAttribute("aria-pressed", "true"));
    expect(split).toHaveClass("bg-brand/25", "hover:bg-brand/35");
    expect(split).not.toHaveClass("hover:bg-brand/15");
    // ghost's hover:bg-accent: if it stayed, the pressed background would be overridden while the mouse rests on the pressed button.
    expect(split).not.toHaveClass("hover:bg-accent");
    const idle = banner.getByRole("button", { name: "Single column" });
    expect(idle).toHaveAttribute("aria-pressed", "false");
    expect(idle).toHaveClass("hover:bg-brand/15");
    expect(idle).not.toHaveClass("bg-brand/25");
    expect(idle).not.toHaveClass("hover:bg-accent");
  });

  it("style: the body of the two side-by-side columns does not use justify (index.css resets blocks without custom alignment to left under .kb-diff-split; jsdom does not load index.css, so the computed style needs a browser)", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const justifyAt = css.search(/text-align:\s*justify;/);
    const rule = /\.kb-diff-split \.bn-editor \.bn-block-content:not\(\[data-text-alignment\]\)\s*\{[^}]*text-align:\s*left;[^}]*\}/.exec(css);
    expect(justifyAt).toBeGreaterThan(-1);
    expect(rule, "找不到 .kb-diff-split 的 text-align:left 覆寫").not.toBeNull();
    // Equal specificity (0,4,0): the later one wins by source order, so the override must come after the justify rule.
    expect(rule!.index).toBeGreaterThan(justifyAt);
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    expect(await screen.findByTestId("diff-split")).toHaveClass("kb-diff-split");
  });

  it("ready: a background list refetch fails (data still there) -> the preview stays and does not go back to loading", async () => {
    let failList = false;
    const listUrl = `/api/notes/${NOTE}/versions?limit=50`;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === listUrl) {
          if (failList) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(list([ver(1)])) } as Response);
        }
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: vid(1), seq: 1, ydoc: b64(V1) }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { queryClient } = renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    failList = true;
    await queryClient.invalidateQueries({ queryKey: ["notes", NOTE, "versions"] });
    await waitFor(() => expect(queryClient.getQueryState(versionListKey(NOTE, "all"))?.status).toBe("error"));
    expect(calls.filter((u) => u === listUrl).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("Loading version…")).not.toBeInTheDocument();
    expect(screen.getByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument();
  });

  it("#258: fetching the filtered list (kind=manual) fails -> the preview still shows the diff, no error and no stuck loading (the preview uses only snapshots and does not subscribe to the list)", async () => {
    window.localStorage.setItem(KIND_FILTER_STORAGE_KEY, "manual");
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url === `/api/notes/${NOTE}/versions?kind=manual&limit=50`) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ id: vid(1), seq: 1, ydoc: b64(V1) }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    const { queryClient } = renderPreview({ seq: 1, live: V2 });
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="C"][data-diff="added"]')).not.toBeNull());
    await waitFor(() => expect(queryClient.getQueryState(versionListKey(NOTE, "manual"))?.status).toBe("error"));
    expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading version…")).not.toBeInTheDocument();
    expect(calls).not.toContain(`/api/notes/${NOTE}/versions?limit=50`);
  });

  it("forceSingle (narrow full page): always single column with no side-by-side / single-column toggle", async () => {
    stub(routesV1());
    widthRef.current = 1600;
    renderPreview({ seq: 1, live: V2, forceSingle: true });
    expect(await screen.findByTestId("diff-single")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Side by side" })).not.toBeInTheDocument();
  });

  it("a changed non-text block -> a see-before-and-after button that opens a dialog with two read-only mini editors", async () => {
    const i1 = [{ id: "I", type: "image", props: { url: "/api/uploads/1" } }];
    const i2 = [{ id: "I", type: "image", props: { url: "/api/uploads/2" } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(i1) },
    });
    renderPreview({ seq: 1, live: i2 });
    fireEvent.click(await screen.findByRole("button", { name: "Changed · see before and after" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Before")).toBeInTheDocument();
    expect(within(dialog).getByText("After")).toBeInTheDocument();
    expect(within(dialog).getAllByTestId("diff-pane")).toHaveLength(2);
  });

  it("a javascript: image URL in a snapshot never appears in any img src", async () => {
    const bad = [{ id: "I", type: "image", props: { url: "javascript:alert(1)" } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(bad) },
    });
    renderPreview({ seq: 1 });
    await screen.findByTestId("diff-single");
    await new Promise((r) => setTimeout(r, 50));
    const srcs = Array.from(document.querySelectorAll("img")).map((img) => img.getAttribute("src") ?? "");
    expect(srcs.some((s) => s.startsWith("javascript:"))).toBe(false);
  });

  it("the left snapshot id mismatches -> a toast that this version no longer exists, and the preview is left", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-OTHER", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    expect(await screen.findByText("This version no longer exists. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent("null"));
  });

  it("the right snapshot id mismatches -> the right side returns to the current state with the same toast and the preview is not left", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: vid(2), seq: 2, ydoc: b64(V2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: "v-OTHER", seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 2, right: 1, live: V1 });
    expect(await screen.findByText("This version no longer exists. The list has been refreshed.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("right-state")).toHaveTextContent('"current"'));
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
    // compares with the live document (V1) again: left seq 2 -> right V1: B added
    const view = await screen.findByTestId("diff-single");
    await waitFor(() => expect(view.querySelector('[data-id="B"][data-diff="added"]')).not.toBeNull());
    expect(screen.queryByText("An unexpected error occurred.")).not.toBeInTheDocument();
    // The toast appears once (after the reset the right snapshot query is disabled, so rightGone does not flip to true again). Wait a while so a possible second one has a chance to show up.
    await new Promise((r) => setTimeout(r, 200));
    expect(screen.getAllByText("This version no longer exists. The list has been refreshed.")).toHaveLength(1);
  });

  it("the right snapshot read fails (not an id mismatch) -> the preview area shows a generic error and the preview is not left", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        const ok = (json: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(json) } as Response);
        if (url === `/api/notes/${NOTE}/versions?limit=50`) return ok(list([ver(2), ver(1)]));
        if (url === `/api/notes/${NOTE}/versions/2`) return ok({ id: vid(2), seq: 2, ydoc: b64(V2) });
        if (url === `/api/notes/${NOTE}/versions/1`) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) } as Response);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderPreview({ seq: 2, right: 1 });
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":2');
  });

  it("banner: the three mode buttons are icon buttons (aria-label and title = name, no text, h-7 w-7) inside an ml-auto container aligned right; no close button (Close preview)", async () => {
    stub(routesV1());
    widthRef.current = 900;
    renderPreview({ seq: 1, live: V2 });
    await screen.findByTestId("diff-split");
    const banner = screen.getByTestId("preview-banner");
    const names = ["Side by side", "Single column", "Only changes"] as const;
    const buttons = names.map((name) => within(banner).getByRole("button", { name }));
    await waitFor(() => expect(buttons[2]).toHaveAttribute("aria-disabled", "true"));
    buttons.forEach((b, i) => {
      expect(b).toHaveAttribute("aria-label", names[i]);
      expect(b).toHaveClass("h-7", "w-7");
      expect(b.textContent).toBe("");
      expect(b.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    });
    expect(buttons[0]).toHaveAttribute("title", "Side by side");
    expect(buttons[1]).toHaveAttribute("title", "Single column");
    expect(buttons[2]).toHaveAttribute("title", "Only changes works in single column");
    expect(buttons[0].querySelector("svg")).toHaveAttribute("data-icon", "columns-2");
    expect(buttons[1].querySelector("svg")).toHaveAttribute("data-icon", "rows-3");
    expect(buttons[2].querySelector("svg")).toHaveAttribute("data-icon", "list-filter");
    const group = buttons[0].parentElement!;
    expect(group).toHaveClass("ml-auto");
    expect(buttons[1].parentElement).toBe(group);
    expect(buttons[2].parentElement).toBe(group);
    expect(within(banner).queryByRole("button", { name: "Close preview" })).not.toBeInTheDocument();
    expect(within(banner).queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
  });

  it("banner: bg-brand-soft (not bg-accent or bg-primary), 'Previewing name (short id)', no time / editors / Compare with; in single column there are left and right dropdowns (an arrow between)", async () => {
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(V1) },
    });
    renderPreview({ seq: 1 });
    const banner = await screen.findByTestId("preview-banner");
    expect(banner).toHaveClass("bg-brand-soft");
    expect(banner).not.toHaveClass("bg-accent");
    expect(banner).not.toHaveClass("flex-wrap");
    expect(banner).toHaveClass("flex-nowrap");
    await waitFor(() => expect(within(banner).getByRole("button", { name: "Left side" })).toHaveTextContent(vlabel(1)));
    expect(within(banner).getByRole("button", { name: "Right side" })).toHaveTextContent("Current state");
    await screen.findByTestId("diff-single");
    expect(screen.queryByTestId("diff-split-head")).toBeNull();
    expect(screen.getAllByRole("button", { name: "Left side" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Right side" })).toHaveLength(1);
    expect(within(banner).getByText("Previewing agile-beaver (0001aaa)")).toBeInTheDocument();
    expect(within(banner).getByText("→")).toHaveAttribute("aria-hidden", "true");
    expect(banner).not.toHaveTextContent("ann");
    expect(banner).not.toHaveTextContent("Compare with");
    expect(banner).not.toHaveTextContent("2026");
    expect(banner).not.toHaveTextContent("Previous version");
    // The banner has no close button; leaving the preview with Esc is covered in NotePage.test.tsx and the panel's ways to leave in VersionsPanel.test.tsx.
    expect(within(banner).queryByRole("button", { name: "Close preview" })).not.toBeInTheDocument();
  });

  it("switching the previewed version while the see-before-and-after dialog is open -> the dialog closes and the new version's button appears as usual", async () => {
    const img = (n: number) => [{ id: "I", type: "image", props: { url: `/api/uploads/${n}` } }];
    stub({
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(3), ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/3`]: { id: vid(3), seq: 3, ydoc: b64(img(3)) },
      [`/api/notes/${NOTE}/versions/2`]: { id: vid(2), seq: 2, ydoc: b64(img(2)) },
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(img(1)) },
    });
    renderPreview({ seq: 2, seq2: 3, live: img(9) });
    fireEvent.click(await screen.findByRole("button", { name: "Changed · see before and after" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("go2"));
    await waitFor(() => expect(screen.getByTestId("preview-state")).toHaveTextContent('"seq":3'));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "Changed · see before and after" })).toBeInTheDocument();
  });

  it("#269: a wikilink inside a changed block is shown with the cached current title (renderDiff receives titleOf); blocks changed only in the snapshot are not marked; a list refetch with unchanged related titles does not rebuild the read-only editor", async () => {
    const ID = "11111111-1111-4111-8111-111111111111";
    const W1 = [
      { id: "A", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "Old", label: "", anchorBlockId: "" } }, " a"] },
      { id: "B", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "Old", label: "", anchorBlockId: "" } }] },
    ];
    const W2 = [
      { id: "A", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "New", label: "", anchorBlockId: "" } }, " b"] },
      { id: "B", type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "New", label: "", anchorBlockId: "" } }] },
    ];
    // ownerHandle / groupId / slug: unchanged block B is rendered by MemberWikilink, which builds canonicalNotePath on a hit (it throws if they are missing).
    const notes = [{ id: ID, title: "Live Title", ownerHandle: "ann", groupId: null, slug: "live-title" }];
    stub({
      "/api/notes": notes,
      "/api/folders": FOLDER_LIST_EMPTY,
      [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(2), ver(1)]),
      [`/api/notes/${NOTE}/versions/2`]: { id: vid(2), seq: 2, ydoc: b64(W2) },
      [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(W1) },
    });
    const create = vi.spyOn(BlockNoteEditor, "create");
    try {
      // Not renderPreview: unchanged block B's wikilink is rendered by MemberWikilink, which needs a Router (useNavigate); this case brings its own MemoryRouter.
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const commits = vi.fn();
      render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ThemeProvider>
              <Host doc={new Y.Doc()} seq={1} right={2} profile={commits} />
            </ThemeProvider>
          </QueryClientProvider>
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByText("go"));
      fireEvent.click(screen.getByText("r"));
      queryClient.setQueryData(["notes"], notes);
      const view = await screen.findByTestId("diff-single");
      // Changed block A's wikilink goes through renderDiff's verbatim layer: it shows the current title from titleOf, not the snapshot's Old/New.
      await waitFor(() => expect(view.querySelector('[data-id="A"]')).toHaveTextContent("Live Title"));
      expect(within(view).queryByText("Old")).not.toBeInTheDocument();
      expect(view.querySelector('[data-id="B"]')?.closest("[data-diff]")?.getAttribute("data-diff") ?? "context").toBe("context");
      const before = create.mock.calls.length;
      const commitsBefore = commits.mock.calls.length;
      // List refetch with an unrelated extra note: first wait until the VersionPreview subtree has really committed (the hook subscribes to ["notes"]), then count create calls;
      // unchanged related titles => titleOf is the same function => the read-only editor is not rebuilt.
      act(() => queryClient.setQueryData(["notes"], [...notes, { id: "unrelated", title: "U", ownerHandle: "ann", groupId: null, slug: "u" }]));
      await waitFor(() => expect(commits.mock.calls.length).toBeGreaterThan(commitsBefore));
      expect(create.mock.calls.length).toBe(before);
    } finally {
      create.mockRestore();
    }
  });

  it("the previewed version is renamed -> the banner and the left trigger switch to the new name at once (the list row takes precedence over the name remembered at selection)", async () => {
    stub(routesV1());
    const { queryClient } = renderPreview({ seq: 1, live: V2 });
    const banner = await screen.findByTestId("preview-banner");
    await waitFor(() => expect(within(banner).getByRole("button", { name: "Left side" })).toHaveTextContent(vlabel(1)));
    expect(banner).toHaveTextContent(`Previewing ${vlabel(1)}`);
    expect(within(banner).getByText(`Previewing ${vlabel(1)}`)).toHaveAttribute("title", vlabel(1)); // a truncated label is read in full through title
    act(() => {
      queryClient.setQueryData(versionListKey(NOTE, "all"), {
        pages: [list([ver(2), { ...ver(1), kind: "manual" as const, name: "改好的名字" }])],
        pageParams: [undefined],
      });
    });
    await waitFor(() => expect(banner).toHaveTextContent(`Previewing ${vlabel(1, "改好的名字")}`));
    expect(within(banner).getByRole("button", { name: "Left side" })).toHaveTextContent(vlabel(1, "改好的名字"));
  });

  it("#462: with an outer zoom feature, the mermaid diagram in the version preview still has no zoom button and the diagram itself is not a button", async () => {
    const blocks = [{ id: "m1", type: "mermaid", props: { code: "graph TD; A-->B;" }, children: [] }] as unknown as DiffBlock[];
    render(
      <ThemeProvider>
        <MediaZoomProvider>
          <DiffEditor blocks={blocks} marks={new Map()} />
        </MediaZoomProvider>
      </ThemeProvider>,
    );
    const pane = screen.getByTestId("diff-pane");
    await waitFor(() => expect(pane.querySelector("svg")).not.toBeNull());
    const box = pane.querySelector("svg")!.closest("div.py-2")!;
    expect(box).not.toHaveAttribute("role");
    expect(box).not.toHaveAttribute("tabindex");
  });

  it("a file block's text or PDF name opens the file preview modal in the version preview too", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response("alpha,1", { status: 206, headers: { "content-type": "text/plain; charset=utf-8", "content-range": "bytes 0-6/7" } })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const blocks = [{ id: "f1", type: "file", props: { url: "/api/uploads/u1", name: "data.csv" }, children: [] }] as unknown as DiffBlock[];
      render(
        <ThemeProvider>
          <DiffEditor blocks={blocks} marks={new Map()} />
        </ThemeProvider>,
      );
      const link = await waitFor(() => {
        const a = screen.getByTestId("diff-pane").querySelector<HTMLAnchorElement>(".bn-file-name a");
        if (!a) throw new Error("not linked yet");
        return a;
      });
      expect(fireEvent.click(link, { button: 0 })).toBe(false);
      const dialog = await screen.findByRole("dialog", { name: "data.csv" });
      expect(await within(dialog).findByText("alpha,1")).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe("side-by-side diff marks and split top-level units", () => {
    // The fixture has the same shape as the column-diff cases in version-diff.test.ts; rows and columns always carry ids.
    const P = (text: string, id: string): DiffBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] });
    const col = (id: string, kids: DiffBlock[], width = 1): DiffBlock => ({ id, type: "column", props: { width }, children: kids });
    const row = (id: string, cols: DiffBlock[]): DiffBlock => ({ id, type: "columnList", props: {}, children: cols });
    const base = () => [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")])]), P("z", "z9")];
    const mountDiff = (a: DiffBlock[], b: DiffBlock[], onlyChanges = false) => {
      const { blocks, marks } = renderDiff(diffBlocks(a, b), { onlyChanges });
      render(
        <ThemeProvider>
          <DiffEditor blocks={blocks} marks={marks} />
        </ThemeProvider>,
      );
      return screen.getByTestId("diff-pane");
    };
    const colEl = (pane: Element, id: string) => pane.querySelector<HTMLElement>(`[data-node-type="column"][data-id="${id}"]`);

    it("the show-only-changes result builds (a row's direct children are all columns); column c1 is marked context and b1 inside it changed", async () => {
      const b = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b2", "b1")])]), P("z", "z9")];
      const pane = mountDiff(base(), b, true);
      await waitFor(() => expect(colEl(pane, "c1")).toHaveAttribute("data-diff", "context"));
      expect(colEl(pane, "c0")).toHaveAttribute("data-diff", "context");
      const rowEl = pane.querySelector('[data-node-type="columnList"][data-id="r"]')!;
      expect(Array.from(rowEl.children).map((el) => el.getAttribute("data-node-type"))).toEqual(["column", "column"]);
      expect(colEl(pane, "c1")!.querySelector('.bn-block-outer[data-id="b1"]')).toHaveAttribute("data-diff", "changed");
    });

    it("column width 1 -> 2: column c1 has data-diff=changed and column c0 is context", async () => {
      const b = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")], 2)]), P("z", "z9")];
      const pane = mountDiff(base(), b);
      await waitFor(() => expect(colEl(pane, "c1")).toHaveAttribute("data-diff", "changed"));
      expect(colEl(pane, "c0")).toHaveAttribute("data-diff", "context");
    });

    it("one row deleted and another added elsewhere, without collapsing: the deleted row has data-diff=deleted and r2 has data-diff=added, one each", async () => {
      const a = [P("x", "x0"), row("r1", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")])]), P("z", "z9")];
      const b = [P("x", "x0"), P("z", "z9"), row("r2", [col("d0", [P("p", "p1")]), col("d1", [P("q", "q1")])])];
      const pane = mountDiff(a, b);
      await waitFor(() => expect(pane.querySelectorAll('[data-node-type="columnList"][data-id="r2"][data-diff="added"]')).toHaveLength(1));
      expect(pane.querySelectorAll('[data-node-type="columnList"][data-diff="deleted"]')).toHaveLength(1);
    });

    it("c1 deleted and c2 added: the merged row renders with 3 columns and builds: the deleted column is deleted, c2 is added", async () => {
      const b = [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c2", [P("n", "n1")])]), P("z", "z9")];
      const pane = mountDiff(base(), b);
      await waitFor(() => expect(colEl(pane, "c2")).toHaveAttribute("data-diff", "added"));
      expect(colEl(pane, "diff-del-1")).toHaveAttribute("data-diff", "deleted");
      expect(colEl(pane, "c0")).toHaveAttribute("data-diff", "context");
      expect(pane.querySelectorAll('[data-node-type="columnList"] > [data-node-type="column"]')).toHaveLength(3);
    });

    it("side by side: both sides [x, row, z] -> the top-level units of both columns have data-diff-row 0, 1, 2 in order (a row counts as one top-level unit and columns inside it are not aligned one by one)", async () => {
      stub({
        [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
        [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(base()) },
      });
      widthRef.current = 900;
      renderPreview({ seq: 1, live: [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b2", "b1")])]), P("z", "z9")] });
      const split = await screen.findByTestId("diff-split");
      const rowsOf = (pane: Element) => Array.from(pane.querySelectorAll<HTMLElement>("[data-diff-row]")).map((el) => [el.dataset.id, el.dataset.diffRow]);
      const [left, right] = within(split).getAllByTestId("diff-pane");
      await waitFor(() => expect(rowsOf(right)).toEqual([["x0", "0"], ["r", "1"], ["z9", "2"]]));
      expect(rowsOf(left)).toEqual([["x0", "0"], ["r", "1"], ["z9", "2"]]);
    });

    it("single-column preview with only a column width change -> the column is marked changed but there is no see-before-and-after button (the dialog can render only that one column, where the width is invisible)", async () => {
      stub({
        [`/api/notes/${NOTE}/versions?limit=50`]: list([ver(1)]),
        [`/api/notes/${NOTE}/versions/1`]: { id: vid(1), seq: 1, ydoc: b64(base()) },
      });
      renderPreview({ seq: 1, live: [P("x", "x0"), row("r", [col("c0", [P("a", "a1")]), col("c1", [P("b", "b1")], 2)]), P("z", "z9")] });
      const view = await screen.findByTestId("diff-single");
      await waitFor(() => expect(colEl(view, "c1")).toHaveAttribute("data-diff", "changed"));
      expect(screen.queryByRole("button", { name: "Changed · see before and after" })).not.toBeInTheDocument();
    });
  });
});
