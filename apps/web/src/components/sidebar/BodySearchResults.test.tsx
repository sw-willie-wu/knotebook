import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
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
function LocationProbe() {
  const loc = useLocation();
  useEffect(() => {
    lastLocation = { pathname: loc.pathname, hash: loc.hash, state: loc.state };
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

  it("B1 ready：每篇一列只顯示第一個片段；mark、段落標題（空不渲染）、位置行含資料夾路徑、遠命中以 … 開頭", () => {
    renderView(readyState([
      hit(N1, [m("_top", "", "a needle here")]),
      hit(N2, [m("h1", "Intro", "needle one"), m("h2", "", "two needle"), m("h3", "Third", FAR)]),
    ]));
    const r = region();
    const items = within(r).getAllByTestId("search-hit");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getAllByTestId("body-match")).toHaveLength(1);
    expect(within(items[1]!).getAllByTestId("body-match")).toHaveLength(1); // 另外兩個收著
    const firstMatch = within(items[0]!).getByTestId("body-match");
    expect(firstMatch.querySelector("mark")).toHaveTextContent("needle");
    expect(firstMatch.querySelectorAll("div")).toHaveLength(1); // _top：沒有段落標題行
    expect(within(items[1]!).getByTestId("body-match").querySelector("div")!.textContent).toBe("Intro");
    expect(within(items[0]!).getByTitle("我的筆記 › A › A1")).toBeInTheDocument();
    // 遠命中：展開後第三個片段
    fireEvent.click(within(items[1]!).getByTestId("body-more"));
    const [, m2, m3] = within(items[1]!).getAllByTestId("body-match");
    expect(m2!.querySelectorAll("div")).toHaveLength(1);
    expect(m3!.querySelectorAll("div")[1]!.textContent).toBe("…0123456789abNeedle tail");
    expect(m3!.querySelector("mark")).toHaveTextContent("Needle");
  });

  it("B1b 「另 N 處」：N＝剩餘片段數（≤2）；點了展開、aria-expanded 跟著變、再點收起；只有 1 個片段就沒有這顆鈕", () => {
    renderView(readyState([
      hit(N1, [m("_top", "", "needle only")]),
      hit(N2, [m("h1", "Intro", "needle one"), m("h2", "B", "two needle"), m("h3", "C", "three needle")]),
    ]));
    const items = within(region()).getAllByTestId("search-hit");
    expect(within(items[0]!).queryByTestId("body-more")).toBeNull();
    const more = within(items[1]!).getByTestId("body-more");
    expect(more).toHaveTextContent("顯示另外 2 處");
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", within(items[1]!).getAllByRole("list")[0]!.id);
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    expect(more).toHaveTextContent("收起");
    expect(within(items[1]!).getAllByTestId("body-match")).toHaveLength(3);
    fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(within(items[1]!).getAllByTestId("body-match")).toHaveLength(1);
  });

  it("B1c 合併去重：標題命中與內文命中是同一篇 → 一列（帶片段）；只中標題的 → 一列、沒有片段；標題命中的排前面", () => {
    renderView(
      readyState([hit(N2, [m("h1", "Intro", "needle one")]), hit(N1, [m("_top", "", "needle first")])]),
      { titleNotes: [N1] },
    );
    const items = within(region()).getAllByTestId("search-hit");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getAllByRole("link")[0]!.querySelector("div")!.textContent).toBe("First");
    expect(within(items[0]!).getAllByTestId("body-match")).toHaveLength(1); // N1 既是標題命中、也有片段：同一列
    expect(within(items[1]!).getAllByRole("link")[0]!.querySelector("div")!.textContent).toBe("Second");
    expect(screen.getAllByRole("link", { name: /^First/ })).toHaveLength(1);
  });

  it("B1d 只有標題命中（沒有內文片段）→ 只顯示標題與位置", () => {
    renderView(readyState([]), { titleNotes: [N1] });
    const item = within(region()).getByTestId("search-hit");
    expect(within(item).getAllByRole("link")).toHaveLength(1);
    expect(item.querySelector("ul")).toBeNull();
    expect(within(item).queryByTestId("body-more")).toBeNull();
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

  it("B3b onStatus：ready 回報合併後的篇數與 more；pending／unmount 回 null", () => {
    const onStatus = vi.fn();
    const a = renderView({ kind: "pending" }, { onStatus });
    expect(onStatus).toHaveBeenLastCalledWith(null);
    a.unmount();
    onStatus.mockClear();
    const b = renderView(readyState([hit(N2, [m("_top", "", "needle")])], { hasMore: true }), { titleNotes: [N1], onStatus });
    expect(onStatus).toHaveBeenLastCalledWith({ count: 2, more: true });
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

  it("B5 matches: [] 的 body hit → 只有標題列、沒有片段清單", () => {
    renderView(readyState([hit(N1, [])]));
    const item = within(region()).getByTestId("search-hit");
    expect(item.querySelector("ul")).toBeNull();
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
    const match = within(region()).getByTestId("body-match");
    expect(match.textContent).toBe("…0123456789ababc tail");
    expect(match.querySelector("mark")).toHaveTextContent("abc");
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
});
