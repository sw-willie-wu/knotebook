import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigationType } from "react-router";
import { canonicalNotePath, type NoteDto, type NoteSearchHitDto, type NoteSearchMatchDto } from "@knotebook/shared";
import i18n from "@/i18n";
import type { BodySearchState } from "@/api/search";
import { BlockAnchorContext, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { OWNER_PERMS } from "@/test/fixtures";
import { folderDto } from "@/test/folder-fixtures";
import { indexFolders } from "./folder-index";
import { BodySearchView } from "./BodySearchResults";

function note(id: string, title: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id, title, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `slug-${id}`, slugIsCustom: false, prevSlug: null, ownerHandle: "owner-one", lastEdited: null, group: null, groupId: null,
    folderId: null, permissions: OWNER_PERMS, ...over,
  };
}
const m = (sectionId: string, heading: string, snippet: string): NoteSearchMatchDto => ({ sectionId, heading, snippet });
const hit = (n: NoteDto, matches: NoteSearchMatchDto[], matchedOn: NoteSearchHitDto["matchedOn"] = "body"): NoteSearchHitDto => ({ note: n, matchedOn, matches });

const FOLDERS = [folderDto({ id: "A", name: "A" }), folderDto({ id: "A1", name: "A1", parentId: "A" })];
const LOCATION = { groupIds: new Set<string>(), folders: indexFolders(FOLDERS) };
const N1 = note("n1", "First", { folderId: "A1" });
const N2 = note("n2", "Second");
const NOTES = [N1, N2];
const FAR = `${"x".repeat(18)}0123456789abNeedle tail`; // the hit is at the 30th character

function readyState(hits: NoteSearchHitDto[], over: Partial<Extract<BodySearchState, { kind: "ready" }>> = {}): BodySearchState {
  return { kind: "ready", hits, forQuery: "needle", stale: false, hasMore: false, loadingMore: false, moreError: null, loadMore: () => {}, ...over };
}

let lastLocation: { pathname: string; hash: string; state: unknown } = { pathname: "", hash: "", state: null };
let lastNavType = "";
function LocationProbe() {
  const loc = useLocation();
  const navType = useNavigationType();
  useEffect(() => {
    lastLocation = { pathname: loc.pathname, hash: loc.hash, state: loc.state };
    lastNavType = navType;
  });
  return null;
}
let activeId: string | null = null;
function ActiveProbe() {
  activeId = useActiveNote().activeNoteId;
  return null;
}

interface ViewOpts {
  titleNotes?: NoteDto[];
  notes?: NoteDto[];
  anchors?: BlockAnchorApi;
  wrap?: (n: ReactNode) => ReactNode;
  onStatus?: (s: { count: number; more: boolean } | null) => void;
}
function renderView(state: BodySearchState, opts: ViewOpts = {}) {
  const view = (
    <BodySearchView
      state={state}
      titleNotes={opts.titleNotes ?? []}
      titleLowerQuery="needle"
      notes={opts.notes ?? NOTES}
      location={LOCATION}
      {...(opts.onStatus ? { onStatus: opts.onStatus } : {})}
    />
  );
  const anchors = opts.anchors ?? { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
  return render(
    <MemoryRouter initialEntries={["/start"]}>
      <ActiveNoteProvider>
        <BlockAnchorContext.Provider value={anchors}>
          <LocationProbe />
          <ActiveProbe />
          {opts.wrap ? opts.wrap(view) : view}
        </BlockAnchorContext.Provider>
      </ActiveNoteProvider>
    </MemoryRouter>,
  );
}
const region = () => screen.getByRole("region", { name: "搜尋結果" });

describe("BodySearchView merged list", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
  });

  it("ready: each in-text hit is one item with three lines (highlighted title / folder path / highlighted snippet), no section heading shown; a far hit's snippet starts with an ellipsis", () => {
    renderView(readyState([
      hit(N1, [m("_top", "", "a needle here")]),
      hit(N2, [m("h1", "Intro", "needle one"), m("h2", "", "two needle"), m("h3", "Third", FAR)]),
    ]));
    const items = within(region()).getAllByTestId("search-hit");
    expect(items).toHaveLength(4); // 1 + 3: a note with 3 hits gives 3 items
    const matches = within(region()).getAllByTestId("body-match");
    expect(matches).toHaveLength(4);
    const first = matches[0]!;
    const lines = first.querySelectorAll(":scope > div");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.textContent).toBe("First");
    expect(lines[1]!.textContent).toBe("我的筆記 › A › A1");
    expect(lines[1]).toHaveAttribute("title", "我的筆記 › A › A1");
    expect(lines[2]!.textContent).toBe("a needle here");
    expect(lines[2]!.querySelector("mark")).toHaveTextContent("needle");
    expect(screen.queryByText("Intro")).toBeNull();
    expect(screen.queryByText("Third")).toBeNull();
    for (const [i, snippet] of [[1, "needle one"], [2, "two needle"], [3, "…0123456789abNeedle tail"]] as const) {
      const ls = matches[i]!.querySelectorAll(":scope > div");
      expect(ls).toHaveLength(3);
      expect(ls[0]!.textContent).toBe("Second");
      expect(ls[1]!.textContent).toBe("我的筆記");
      expect(ls[2]!.textContent).toBe(snippet);
    }
    expect(matches[3]!.querySelector("div:nth-child(3) mark")).toHaveTextContent("Needle");
  });

  it("no \"N more\" line: all hits are listed however many there are, no expand button", () => {
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle one"), m("h2", "B", "two needle"), m("h3", "C", "three needle")])]));
    expect(within(region()).getAllByTestId("body-match")).toHaveLength(3);
    expect(screen.queryByTestId("body-more")).toBeNull();
    expect(within(region()).queryByRole("button", { name: /另外|收起/ })).toBeNull();
    expect(region().querySelectorAll("[aria-expanded]")).toHaveLength(0);
  });

  it("the title line (first) and the location line (second): the same small grey text, differing only in that the title line is bold (same for a body-hit MatchItem and a title-only SearchRow); mark is kept", () => {
    const strip = (el: Element) => el.className.split(/\s+/).filter((c) => c !== "mt-0.5").sort().join(" ");
    const noBold = (el: Element) => strip(el).split(" ").filter((c) => c !== "font-semibold").join(" ");
    const check = (lines: ArrayLike<Element>) => {
      expect(lines[0]!.className).toContain("font-semibold");
      expect(lines[1]!.className).not.toContain("font-semibold");
      expect(noBold(lines[0]!)).toBe(strip(lines[1]!)); // apart from bold, the class is identical
      expect(lines[0]!.className).toContain("text-muted-foreground");
      expect(lines[0]!.className).toContain("text-[11px]");
      expect(lines[0]!.className).not.toMatch(/font-medium|text-\[1[23]px\]/);
    };
    const first = renderView(readyState([hit(N1, [m("_top", "", "a needle here")])]), { titleNotes: [] });
    check(within(region()).getAllByTestId("body-match")[0]!.querySelectorAll(":scope > div"));
    first.unmount();
    renderView(readyState([]), { titleNotes: [N2] });
    check(within(region()).getAllByTestId("search-hit").at(-1)!.querySelectorAll("a > div"));
  });

  it("several items of the same note (the one currently open): only the first has aria-current=page, the rest do not", () => {
    function Open({ id }: { id: string }) {
      const { setActiveNoteId } = useActiveNote();
      useEffect(() => setActiveNoteId(id), [id, setActiveNoteId]);
      return null;
    }
    renderView(readyState([hit(N2, [m("_top", "", "needle a"), m("h1", "", "needle b"), m("h2", "", "needle c")]), hit(N1, [m("_top", "", "needle d")])]), {
      wrap: (n) => (
        <>
          <Open id={N2.id} />
          {n}
        </>
      ),
    });
    const links = within(region()).getAllByTestId("body-match");
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null, null]);
  });

  it("the currently open note: both meta lines use text-brand-on-soft (grey on brand-soft is below AA 4.5:1), other items stay grey", () => {
    function Open({ id }: { id: string }) {
      const { setActiveNoteId } = useActiveNote();
      useEffect(() => setActiveNoteId(id), [id, setActiveNoteId]);
      return null;
    }
    renderView(readyState([hit(N2, [m("_top", "", "needle a")]), hit(N1, [m("_top", "", "needle d")])]), {
      wrap: (n) => (
        <>
          <Open id={N2.id} />
          {n}
        </>
      ),
    });
    const [open, other] = within(region()).getAllByTestId("body-match");
    for (const line of Array.from(open!.querySelectorAll(":scope > div")).slice(0, 2)) {
      expect(line.className).toContain("text-brand-on-soft");
      expect(line.className).not.toContain("text-muted-foreground");
    }
    for (const line of Array.from(other!.querySelectorAll(":scope > div")).slice(0, 2)) expect(line.className).toContain("text-muted-foreground");
    expect(open!.className).toContain("group");
  });

  it("title highlight: the mark on the first line is the title's matched text (uses titleLowerQuery)", () => {
    const hot = note("n3", "Needle Notes");
    renderView(readyState([hit(hot, [m("_top", "", "needle in body")])]), { notes: [hot] });
    const match = within(region()).getByTestId("body-match");
    expect(match.querySelector(":scope > div:nth-child(1) mark")).toHaveTextContent("Needle");
    expect(match.querySelector(":scope > div:nth-child(3) mark")).toHaveTextContent("needle");
  });

  it("title-only hit (no body snippet): two lines (title + path), not a body-match, clicking carries no kbFind", () => {
    renderView(readyState([]), { titleNotes: [N1] });
    const item = within(region()).getByTestId("search-hit");
    expect(within(item).getAllByRole("link")).toHaveLength(1);
    expect(within(item).queryByTestId("body-match")).toBeNull();
    const link = within(item).getByRole("link");
    expect(link.querySelectorAll(":scope > div")).toHaveLength(2);
    expect(link.querySelectorAll(":scope > div")[1]!.textContent).toBe("我的筆記 › A › A1");
    expect(link).toHaveAttribute("href", canonicalNotePath(N1));
    fireEvent.click(link);
    expect(lastLocation).toMatchObject({ pathname: canonicalNotePath(N1), hash: "", state: null });
  });

  it("ordering and flattening: notes with title hits come first; several hits of one note stay together in server order; a note hit in both title and body is not listed again as title-only", () => {
    // titleNotes: [N1, N3] (N1 also has body hits); server: N2 (2 hits), N1 (2 hits)
    const N3 = note("n3", "Third needle");
    renderView(
      readyState([
        hit(N2, [m("a", "", "needle a"), m("b", "", "needle b")]),
        hit(N1, [m("c", "", "needle c"), m("d", "", "needle d")]),
      ]),
      { titleNotes: [N1, N3], notes: [N1, N2, N3] },
    );
    const items = within(region()).getAllByTestId("search-hit");
    const seq = items.map((li) => {
      const link = within(li).getByRole("link");
      return `${link.querySelector("div")!.textContent}|${link.getAttribute("href")!.split("#b-")[1] ?? "-"}`;
    });
    expect(seq).toEqual(["First|c", "First|d", "Third needle|-", "Second|a", "Second|b"]);
    expect(within(region()).getAllByTestId("body-match")).toHaveLength(4); // N3 has only a title hit: not a body-match
  });

  it("pending / error / rateLimited each have one sentence; rows with title hits still show; load-more button, disabled while loading, the list stays on moreError", () => {
    const first = renderView({ kind: "pending" }, { titleNotes: [N1] });
    expect(within(region()).getByText("正在搜尋內文…")).toBeInTheDocument();
    expect(within(region()).getAllByTestId("search-hit")).toHaveLength(1);
    first.unmount();
    const second = renderView({ kind: "error", rateLimited: false, invalidTags: false });
    expect(within(region()).getByText("無法搜尋內文。")).toBeInTheDocument();
    second.unmount();
    const third = renderView({ kind: "error", rateLimited: true, invalidTags: false });
    expect(within(region()).getByText("搜尋太頻繁，請稍等一下再試。")).toBeInTheDocument();
    third.unmount();

    const loadMore = vi.fn();
    const fourth = renderView(readyState([hit(N1, [m("_top", "", "needle")])], { hasMore: true, loadMore }));
    fireEvent.click(screen.getByRole("button", { name: "載入更多" }));
    expect(loadMore).toHaveBeenCalledTimes(1);
    fourth.unmount();
    const fifth = renderView(readyState([hit(N1, [m("_top", "", "needle")])], { hasMore: true, loadingMore: true }));
    expect(screen.getByRole("button", { name: "載入中…" })).toBeDisabled();
    fifth.unmount();
    renderView(readyState([hit(N1, [m("_top", "", "needle")])], { hasMore: true, moreError: { rateLimited: false } }));
    expect(within(region()).getAllByTestId("search-hit")).toHaveLength(1);
    expect(within(region()).getByText("無法搜尋內文。")).toBeInTheDocument();
  });

  it("the search results region is found in all three states pending / error / ready", () => {
    for (const s of [{ kind: "pending" } as const, { kind: "error", rateLimited: false, invalidTags: false } as const, readyState([])]) {
      const r = renderView(s);
      expect(region()).toHaveAttribute("data-testid", "sidebar-search-results");
      r.unmount();
    }
  });

  it("onStatus: ready reports the number of listed items (one per hit) and more; pending / unmount report null", () => {
    const onStatus = vi.fn();
    const a = renderView({ kind: "pending" }, { onStatus });
    expect(onStatus).toHaveBeenLastCalledWith(null);
    a.unmount();
    onStatus.mockClear();
    const b = renderView(readyState([hit(N2, [m("_top", "", "needle"), m("h1", "", "needle 2")])], { hasMore: true }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith({ count: 3, more: true }); // 1 title item + 2 items for N2's two hits
    b.unmount();
    expect(onStatus).toHaveBeenLastCalledWith(null);
  });

  it("stale (body results of an old query): onStatus reports null and the note-count line does not count the old query's body hits; it reports when not stale", () => {
    const onStatus = vi.fn();
    const a = renderView(readyState([hit(N2, [m("_top", "", "needle")])], { stale: true }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith(null);
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ count: expect.any(Number) }));
    a.unmount();
    renderView(readyState([hit(N2, [m("_top", "", "needle")])], { stale: false }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith({ count: 2, more: false });
  });

  it("cross-check: a hit not in the list is not shown; after a rename the list's name and canonicalNotePath are used", () => {
    const renamed = note("n2", "Renamed now");
    const gone = note("zz", "Gone");
    renderView(readyState([hit(gone, [m("_top", "", "needle")]), hit(note("n2", "Old name"), [m("_top", "", "needle")])]), { notes: [N1, renamed] });
    const items = within(region()).getAllByTestId("search-hit");
    expect(items).toHaveLength(1);
    const titleLink = within(items[0]!).getAllByRole("link")[0]!;
    expect(titleLink.querySelector("div")!.textContent).toBe("Renamed now");
    expect(titleLink).toHaveAttribute("href", canonicalNotePath(renamed));
    expect(screen.queryByText("Gone")).not.toBeInTheDocument();
  });

  it("a body hit with matches: [] gives only the title row, no snippet", () => {
    renderView(readyState([hit(N1, [])]));
    const item = within(region()).getByTestId("search-hit");
    expect(within(item).queryByTestId("body-match")).toBeNull();
    expect(within(item).getAllByRole("link")).toHaveLength(1);
  });

  it("a hit with matchedOn: title does not become its own row (title hits come from titleNotes)", () => {
    renderView(readyState([hit(N1, [], "title"), hit(N2, [m("_top", "", "needle")], "both")]));
    const items = within(region()).getAllByTestId("search-hit");
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getAllByRole("link")[0]!.querySelector("div")!.textContent).toBe("Second");
  });

  it("forQuery: the state's forQuery is abc (the current text is already abcd): the leading text is trimmed and highlighted per abc", () => {
    const s = `${"x".repeat(18)}0123456789ababc tail`;
    renderView(readyState([hit(N1, [m("_top", "", s)])], { forQuery: "abc", stale: true }));
    const snippet = within(region()).getByTestId("body-match").querySelector(":scope > div:nth-child(3)")!;
    expect(snippet.textContent).toBe("…0123456789ababc tail");
    expect(snippet.querySelector("mark")).toHaveTextContent("abc");
  });

  it("ready, stale, hasMore false: no load-more; the list shows as is", () => {
    renderView(readyState([hit(N1, [m("_top", "", "needle")])], { stale: true, hasMore: false }));
    expect(screen.queryByRole("button", { name: "載入更多" })).not.toBeInTheDocument();
    expect(within(region()).getAllByTestId("search-hit")).toHaveLength(1);
  });

  it("noMatch: no rows, ready, not stale: shown; stale or with title-hit rows: not shown", () => {
    const a = renderView(readyState([]));
    expect(screen.getAllByText("沒有符合搜尋的筆記。")).toHaveLength(1);
    a.unmount();
    const b = renderView(readyState([], { stale: true }));
    expect(screen.queryByText("沒有符合搜尋的筆記。")).not.toBeInTheDocument();
    b.unmount();
    renderView(readyState([]), { titleNotes: [N1] });
    expect(screen.queryByText("沒有符合搜尋的筆記。")).not.toBeInTheDocument();
  });
});

describe("BodySearchView click", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    lastLocation = { pathname: "", hash: "", state: null };
    activeId = null;
  });
  const matchLink = (i = 0) => within(region()).getAllByTestId("body-match")[i]!;

  it("clicking a match of another note: pathname is that note, hash #b-<id>, the query is in the navigation state (not in the URL); requestAnchor is not called", () => {
    const anchors = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    expect(matchLink()).toHaveAttribute("href", `${canonicalNotePath(N2)}#b-h1`);
    fireEvent.click(matchLink());
    expect(lastLocation).toEqual({ pathname: canonicalNotePath(N2), hash: "#b-h1", state: { kbFind: "needle" } });
    expect(anchors.requestAnchor).not.toHaveBeenCalled();
  });

  it("same note: requestAnchor(id, query) once, hash changes, pathname unchanged", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    fireEvent.click(matchLink());
    expect(anchors.requestAnchor).toHaveBeenCalledTimes(1);
    expect(anchors.requestAnchor).toHaveBeenCalledWith("h1", "needle");
    expect(lastLocation).toMatchObject({ pathname: "/start", hash: "#b-h1" });
  });

  it("the query is forQuery (the text that produced this batch), not the current text", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "abc")])], { forQuery: "abc", stale: true }), { anchors });
    fireEvent.click(matchLink());
    expect(anchors.requestAnchor).toHaveBeenCalledWith("h1", "abc");
  });

  it("_top: another note has no hash and the query is in state; the same note calls requestAnchor(_top, query) and does not scrollToTop", () => {
    const other = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    const r = renderView(readyState([hit(N2, [m("_top", "", "needle")])]), { anchors: other });
    expect(matchLink()).toHaveAttribute("href", canonicalNotePath(N2));
    fireEvent.click(matchLink());
    expect(lastLocation).toEqual({ pathname: canonicalNotePath(N2), hash: "", state: { kbFind: "needle" } });
    r.unmount();
    const same = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("_top", "", "needle")])]), { anchors: same });
    fireEvent.click(matchLink());
    expect(same.requestAnchor).toHaveBeenCalledWith("_top", "needle");
    expect(same.scrollToTop).not.toHaveBeenCalled();
    // `_top` in the same note also writes the query into the current history entry's state (replace, no extra entry), so a reload can jump back
    expect(lastLocation).toEqual({ pathname: "/start", hash: "", state: { kbFind: "needle" } });
    expect(lastNavType).toBe("REPLACE"); // no extra history entry
  });

  it("Ctrl + click: no preventDefault, URL unchanged, requestAnchor not called", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    expect(fireEvent.click(matchLink(), { ctrlKey: true })).toBe(true);
    expect(lastLocation).toEqual({ pathname: "/start", hash: "", state: null });
    expect(anchors.requestAnchor).not.toHaveBeenCalled();
  });

  it("clicking a match and clicking a title row both setActiveNoteId", () => {
    const r = renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]));
    fireEvent.click(matchLink());
    expect(activeId).toBe(N2.id);
    r.unmount();
    activeId = null;
    renderView(readyState([hit(N1, [m("h1", "Intro", "needle")])]));
    fireEvent.click(within(within(region()).getByTestId("search-hit")).getAllByRole("link")[0]!);
    expect(activeId).toBe(N1.id);
  });
  it("several hits in one note: each item carries the right sectionId and kbFind when clicked (navigate for another note / requestAnchor for the same note)", () => {
    const hits = [hit(N2, [m("h1", "A", "needle one"), m("h2", "B", "needle two"), m("_top", "", "needle top")])];
    const expected = [
      { hash: "#b-h1", id: "h1" },
      { hash: "#b-h2", id: "h2" },
      { hash: "", id: "_top" },
    ];
    for (const [i, e] of expected.entries()) {
      const other = renderView(readyState(hits), { anchors: { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() } });
      fireEvent.click(matchLink(i));
      expect(lastLocation).toEqual({ pathname: canonicalNotePath(N2), hash: e.hash, state: { kbFind: "needle" } });
      other.unmount();
      const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
      const same = renderView(readyState(hits), { anchors });
      fireEvent.click(matchLink(i));
      expect(anchors.requestAnchor).toHaveBeenCalledTimes(1);
      expect(anchors.requestAnchor).toHaveBeenCalledWith(e.id, "needle");
      same.unmount();
    }
  });
});
