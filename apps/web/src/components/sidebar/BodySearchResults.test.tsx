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
const FAR = `${"x".repeat(18)}0123456789abNeedle tail`; // 命中在第 30 字

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

describe("BodySearchView 合併列表（T5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
  });

  it("B1 ready：每處內文命中各一項、三行（標題標亮／資料夾路徑／片段標亮），不顯示段落標題；遠命中片段以 … 開頭", () => {
    renderView(readyState([
      hit(N1, [m("_top", "", "a needle here")]),
      hit(N2, [m("h1", "Intro", "needle one"), m("h2", "", "two needle"), m("h3", "Third", FAR)]),
    ]));
    const items = within(region()).getAllByTestId("search-hit");
    expect(items).toHaveLength(4); // 1 + 3，一篇 3 處命中就 3 項
    const matches = within(region()).getAllByTestId("body-match");
    expect(matches).toHaveLength(4);
    // 第一項（N1 / A1）：三行
    const first = matches[0]!;
    const lines = first.querySelectorAll(":scope > div");
    expect(lines).toHaveLength(3);
    expect(lines[0]!.textContent).toBe("First");
    expect(lines[1]!.textContent).toBe("我的筆記 › A › A1");
    expect(lines[1]).toHaveAttribute("title", "我的筆記 › A › A1");
    expect(lines[2]!.textContent).toBe("a needle here");
    expect(lines[2]!.querySelector("mark")).toHaveTextContent("needle");
    // 段落標題不顯示（Intro／Third 都不出現）
    expect(screen.queryByText("Intro")).toBeNull();
    expect(screen.queryByText("Third")).toBeNull();
    // 同一篇的三項各自重複標題與路徑，片段不同
    for (const [i, snippet] of [[1, "needle one"], [2, "two needle"], [3, "…0123456789abNeedle tail"]] as const) {
      const ls = matches[i]!.querySelectorAll(":scope > div");
      expect(ls).toHaveLength(3);
      expect(ls[0]!.textContent).toBe("Second");
      expect(ls[1]!.textContent).toBe("我的筆記");
      expect(ls[2]!.textContent).toBe(snippet);
    }
    expect(matches[3]!.querySelector("div:nth-child(3) mark")).toHaveTextContent("Needle");
  });

  it("B1b 沒有「另 N 處」：不論幾處命中都全列，沒有展開鈕", () => {
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle one"), m("h2", "B", "two needle"), m("h3", "C", "three needle")])]));
    expect(within(region()).getAllByTestId("body-match")).toHaveLength(3);
    expect(screen.queryByTestId("body-more")).toBeNull();
    expect(within(region()).queryByRole("button", { name: /另外|收起/ })).toBeNull();
    expect(region().querySelectorAll("[aria-expanded]")).toHaveLength(0);
  });

  it("B1d 標題行（第一行）與位置行（第二行）：同樣的灰色小字，只差標題行是粗體（內文命中項 MatchItem 與只命中標題的 SearchRow 都一樣）；mark 保留", () => {
    const strip = (el: Element) => el.className.split(/\s+/).filter((c) => c !== "mt-0.5").sort().join(" ");
    const noBold = (el: Element) => strip(el).split(" ").filter((c) => c !== "font-semibold").join(" ");
    const check = (lines: ArrayLike<Element>) => {
      expect(lines[0]!.className).toContain("font-semibold");
      expect(lines[1]!.className).not.toContain("font-semibold");
      expect(noBold(lines[0]!)).toBe(strip(lines[1]!)); // 除了粗體，其餘 class 完全相同
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

  it("B1e 同一篇有多項（目前開著的那篇）：只有第一項帶 aria-current=page，其餘項不帶", () => {
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

  it("B1f 目前開著的那篇：兩行 meta 改用 text-brand-on-soft（灰字疊在 brand-soft 上不到 AA 4.5:1），其餘項仍是灰字", () => {
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

  it("B1c 標題標亮：第一行的 mark 是標題命中的字（用 titleLowerQuery）", () => {
    const hot = note("n3", "Needle Notes");
    renderView(readyState([hit(hot, [m("_top", "", "needle in body")])]), { notes: [hot] });
    const match = within(region()).getByTestId("body-match");
    expect(match.querySelector(":scope > div:nth-child(1) mark")).toHaveTextContent("Needle");
    expect(match.querySelector(":scope > div:nth-child(3) mark")).toHaveTextContent("needle");
  });

  it("B1d 只有標題命中（沒有內文片段）→ 兩行（標題＋路徑），不是 body-match，點了不帶 kbFind", () => {
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

  it("B1e 排序與攤平：標題命中的篇在前；同篇多處命中連在一起、照 server 順序；標題＋內文都中的篇不另列「只有標題」", () => {
    // titleNotes: [N1, N3]（N1 也有內文命中）；server：N2(2 處)、N1(2 處)
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
    expect(within(region()).getAllByTestId("body-match")).toHaveLength(4); // N3 只有標題命中：不是 body-match
  });

  it("B2 pending／error／rateLimited 各一句；標題命中的列照顯示；載入更多鈕、載入中 disabled、moreError 清單還在", () => {
    const first = renderView({ kind: "pending" }, { titleNotes: [N1] });
    expect(within(region()).getByText("正在搜尋內文…")).toBeInTheDocument();
    expect(within(region()).getAllByTestId("search-hit")).toHaveLength(1);
    first.unmount();
    const second = renderView({ kind: "error", rateLimited: false });
    expect(within(region()).getByText("無法搜尋內文。")).toBeInTheDocument();
    second.unmount();
    const third = renderView({ kind: "error", rateLimited: true });
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

  it("B3 region「搜尋結果」在 pending／error／ready 三態都找得到", () => {
    for (const s of [{ kind: "pending" } as const, { kind: "error", rateLimited: false } as const, readyState([])]) {
      const r = renderView(s);
      expect(region()).toHaveAttribute("data-testid", "sidebar-search-results");
      r.unmount();
    }
  });

  it("B3b onStatus：ready 回報列出的項數（每處命中一項）與 more；pending／unmount 回 null", () => {
    const onStatus = vi.fn();
    const a = renderView({ kind: "pending" }, { onStatus });
    expect(onStatus).toHaveBeenLastCalledWith(null);
    a.unmount();
    onStatus.mockClear();
    const b = renderView(readyState([hit(N2, [m("_top", "", "needle"), m("h1", "", "needle 2")])], { hasMore: true }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith({ count: 3, more: true }); // 標題 1 項＋N2 兩處命中 2 項
    b.unmount();
    expect(onStatus).toHaveBeenLastCalledWith(null);
  });

  it("B3c stale（舊字的內文結果）→ onStatus 回報 null，篇數行不把舊查詢的內文命中算進去；非 stale 才回報", () => {
    const onStatus = vi.fn();
    const a = renderView(readyState([hit(N2, [m("_top", "", "needle")])], { stale: true }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith(null);
    expect(onStatus).not.toHaveBeenCalledWith(expect.objectContaining({ count: expect.any(Number) }));
    a.unmount();
    renderView(readyState([hit(N2, [m("_top", "", "needle")])], { stale: false }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith({ count: 2, more: false });
  });

  it("B4 交叉比對：不在清單的 hit 不顯示；改名後用清單的名字與 canonicalNotePath", () => {
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

  it("B5 matches: [] 的 body hit → 只有標題列、沒有片段", () => {
    renderView(readyState([hit(N1, [])]));
    const item = within(region()).getByTestId("search-hit");
    expect(within(item).queryByTestId("body-match")).toBeNull();
    expect(within(item).getAllByRole("link")).toHaveLength(1);
  });

  it("B6 matchedOn: title 的 hit 不單獨成列（標題命中以 titleNotes 為準）", () => {
    renderView(readyState([hit(N1, [], "title"), hit(N2, [m("_top", "", "needle")], "both")]));
    const items = within(region()).getAllByTestId("search-hit");
    expect(items).toHaveLength(1);
    expect(within(items[0]!).getAllByRole("link")[0]!.querySelector("div")!.textContent).toBe("Second");
  });

  it("B7 forQuery：state 的 forQuery 是 abc（當下的字已是 abcd）→ 照 abc 裁前文並標亮", () => {
    const s = `${"x".repeat(18)}0123456789ababc tail`;
    renderView(readyState([hit(N1, [m("_top", "", s)])], { forQuery: "abc", stale: true }));
    const snippet = within(region()).getByTestId("body-match").querySelector(":scope > div:nth-child(3)")!;
    expect(snippet.textContent).toBe("…0123456789ababc tail");
    expect(snippet.querySelector("mark")).toHaveTextContent("abc");
  });

  it("B8 ready、stale、hasMore false → 沒有載入更多；清單照顯示", () => {
    renderView(readyState([hit(N1, [m("_top", "", "needle")])], { stale: true, hasMore: false }));
    expect(screen.queryByRole("button", { name: "載入更多" })).not.toBeInTheDocument();
    expect(within(region()).getAllByTestId("search-hit")).toHaveLength(1);
  });

  it("noMatch：沒有任何列、ready、非 stale → 有；stale 或有標題命中的列 → 沒有", () => {
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

describe("BodySearchView 點擊（T6）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    lastLocation = { pathname: "", hash: "", state: null };
    activeId = null;
  });
  const matchLink = (i = 0) => within(region()).getAllByTestId("body-match")[i]!;

  it("C1 點別篇的 match → pathname 是該篇、hash #b-<id>、查詢字在 navigation state（不在網址）；requestAnchor 沒被叫", () => {
    const anchors = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    expect(matchLink()).toHaveAttribute("href", `${canonicalNotePath(N2)}#b-h1`);
    fireEvent.click(matchLink());
    expect(lastLocation).toEqual({ pathname: canonicalNotePath(N2), hash: "#b-h1", state: { kbFind: "needle" } });
    expect(anchors.requestAnchor).not.toHaveBeenCalled();
  });

  it("C2 同篇：requestAnchor(id, 查詢字) 一次、hash 變、pathname 不變", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    fireEvent.click(matchLink());
    expect(anchors.requestAnchor).toHaveBeenCalledTimes(1);
    expect(anchors.requestAnchor).toHaveBeenCalledWith("h1", "needle");
    expect(lastLocation).toMatchObject({ pathname: "/start", hash: "#b-h1" });
  });

  it("C2b 查詢字用 forQuery（產出這批的字），不是當下的字", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "abc")])], { forQuery: "abc", stale: true }), { anchors });
    fireEvent.click(matchLink());
    expect(anchors.requestAnchor).toHaveBeenCalledWith("h1", "abc");
  });

  it("C3 _top：別篇沒有 hash、查詢字在 state；同篇 requestAnchor(_top, 查詢字)、不 scrollToTop", () => {
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
    // 同篇 `_top` 也把查詢字寫進目前這筆 history 的 state（replace，不多一筆），重整才跳得回去
    expect(lastLocation).toEqual({ pathname: "/start", hash: "", state: { kbFind: "needle" } });
    expect(lastNavType).toBe("REPLACE"); // 不多一筆 history
  });

  it("C4 Ctrl＋點擊 → 不 preventDefault、網址不變、requestAnchor 沒被叫", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    expect(fireEvent.click(matchLink(), { ctrlKey: true })).toBe(true);
    expect(lastLocation).toEqual({ pathname: "/start", hash: "", state: null });
    expect(anchors.requestAnchor).not.toHaveBeenCalled();
  });

  it("C5 點 match 與點標題列都會 setActiveNoteId", () => {
    const r = renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]));
    fireEvent.click(matchLink());
    expect(activeId).toBe(N2.id);
    r.unmount();
    activeId = null;
    renderView(readyState([hit(N1, [m("h1", "Intro", "needle")])]));
    fireEvent.click(within(within(region()).getByTestId("search-hit")).getAllByRole("link")[0]!);
    expect(activeId).toBe(N1.id);
  });
  it("C6 一篇多處命中：每一項點下去都帶對的 sectionId 與 kbFind（別篇 navigate／同篇 requestAnchor）", () => {
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
