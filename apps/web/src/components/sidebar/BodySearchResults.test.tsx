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

let lastLocation: { pathname: string; hash: string } = { pathname: "", hash: "" };
function LocationProbe() {
  const loc = useLocation();
  useEffect(() => {
    lastLocation = { pathname: loc.pathname, hash: loc.hash };
  });
  return null;
}
let activeId: string | null = null;
function ActiveProbe() {
  activeId = useActiveNote().activeNoteId;
  return null;
}

function renderView(state: BodySearchState, opts: { titleCount?: number; notes?: NoteDto[]; anchors?: BlockAnchorApi; wrap?: (n: ReactNode) => ReactNode } = {}) {
  const view = (
    <BodySearchView state={state} titleCount={opts.titleCount ?? 1} notes={opts.notes ?? NOTES} location={LOCATION} />
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
const region = () => screen.getByRole("region", { name: "內文符合" });

describe("BodySearchView（T5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
  });

  it("B1 ready：計數、每篇片段數、mark、段落標題（空不渲染）、位置行含資料夾路徑、遠命中以 … 開頭", () => {
    renderView(readyState([
      hit(N1, [m("_top", "", "a needle here")]),
      hit(N2, [m("h1", "Intro", "needle one"), m("h2", "", "two needle"), m("h3", "Third", FAR)]),
    ]));
    const r = region();
    expect(within(r).getByText("2 篇")).toHaveAttribute("aria-live", "polite");
    const items = within(r).getAllByTestId("body-hit");
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getAllByTestId("body-match")).toHaveLength(1);
    expect(within(items[1]!).getAllByTestId("body-match")).toHaveLength(3);
    const firstMatch = within(items[0]!).getByTestId("body-match");
    expect(firstMatch.querySelector("mark")).toHaveTextContent("needle");
    expect(firstMatch.querySelectorAll("div")).toHaveLength(1); // _top：沒有段落標題行
    const [mi, m2, m3] = within(items[1]!).getAllByTestId("body-match");
    expect(mi!.querySelector("div")!.textContent).toBe("Intro");
    expect(m2!.querySelectorAll("div")).toHaveLength(1);
    expect(m3!.querySelectorAll("div")[1]!.textContent).toBe("…0123456789abNeedle tail");
    expect(m3!.querySelector("mark")).toHaveTextContent("Needle");
    expect(within(items[0]!).getByTitle("My notes › A › A1".replace("My notes", "我的筆記"))).toBeInTheDocument();
  });

  it("B2 pending／error／rateLimited 各一句；載入更多鈕、載入中 disabled、moreError 清單還在", () => {
    const first = renderView({ kind: "pending" });
    expect(within(region()).getByText("正在搜尋內文…")).toBeInTheDocument();
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
    expect(within(region()).getAllByTestId("body-hit")).toHaveLength(1);
    expect(within(region()).getByText("無法搜尋內文。")).toBeInTheDocument();
  });

  it("B3 region「內文符合」在 pending／error／ready 三態都找得到", () => {
    for (const s of [{ kind: "pending" } as const, { kind: "error", rateLimited: false } as const, readyState([])]) {
      const r = renderView(s);
      expect(region()).toHaveAttribute("data-testid", "sidebar-body-search");
      r.unmount();
    }
  });

  it("B4 交叉比對：不在清單的 hit 不顯示、不計數；改名後用清單的名字與 canonicalNotePath", () => {
    const renamed = note("n2", "Renamed now");
    const gone = note("zz", "Gone");
    renderView(readyState([hit(gone, [m("_top", "", "needle")]), hit(note("n2", "Old name"), [m("_top", "", "needle")])]), { notes: [N1, renamed] });
    const items = within(region()).getAllByTestId("body-hit");
    expect(items).toHaveLength(1);
    expect(within(region()).getByText("1 篇")).toBeInTheDocument();
    const titleLink = within(items[0]!).getAllByRole("link")[0]!;
    expect(titleLink.querySelector("div")!.textContent).toBe("Renamed now");
    expect(titleLink).toHaveAttribute("href", canonicalNotePath(renamed));
    expect(screen.queryByText("Gone")).not.toBeInTheDocument();
  });

  it("B5 matches: [] 的 body hit → 只有標題列、沒有片段清單", () => {
    renderView(readyState([hit(N1, [])]));
    const item = within(region()).getByTestId("body-hit");
    expect(item.querySelector("ul")).toBeNull();
    expect(within(item).getAllByRole("link")).toHaveLength(1);
  });

  it("B6 matchedOn: title 的 hit 不出現在內文區", () => {
    renderView(readyState([hit(N1, [], "title"), hit(N2, [m("_top", "", "needle")], "both")]));
    const items = within(region()).getAllByTestId("body-hit");
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
    expect(within(region()).getAllByTestId("body-hit")).toHaveLength(1);
  });

  it("noMatch：標題 0、ready、非 stale、顯示 0 篇 → 有；stale 或標題 > 0 → 沒有", () => {
    const a = renderView(readyState([]), { titleCount: 0 });
    expect(screen.getAllByText("沒有符合搜尋的筆記。")).toHaveLength(1);
    a.unmount();
    const b = renderView(readyState([], { stale: true }), { titleCount: 0 });
    expect(screen.queryByText("沒有符合搜尋的筆記。")).not.toBeInTheDocument();
    b.unmount();
    renderView(readyState([]), { titleCount: 2 });
    expect(screen.queryByText("沒有符合搜尋的筆記。")).not.toBeInTheDocument();
  });
});

describe("BodySearchView 點擊（T6）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-TW");
    lastLocation = { pathname: "", hash: "" };
    activeId = null;
  });
  const matchLink = (i = 0) => within(region()).getAllByTestId("body-match")[i]!;

  it("C1 點別篇的 match → pathname 是該篇、hash #b-<id>；requestAnchor 沒被叫", () => {
    const anchors = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    expect(matchLink()).toHaveAttribute("href", `${canonicalNotePath(N2)}#b-h1`);
    fireEvent.click(matchLink());
    expect(lastLocation).toEqual({ pathname: canonicalNotePath(N2), hash: "#b-h1" });
    expect(anchors.requestAnchor).not.toHaveBeenCalled();
  });

  it("C2 同篇：requestAnchor 一次、hash 變、pathname 不變", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    fireEvent.click(matchLink());
    expect(anchors.requestAnchor).toHaveBeenCalledTimes(1);
    expect(anchors.requestAnchor).toHaveBeenCalledWith("h1");
    expect(lastLocation).toEqual({ pathname: "/start", hash: "#b-h1" });
  });

  it("C3 _top：別篇沒有 hash；同篇 scrollToTop、不 requestAnchor", () => {
    const other = { currentNoteId: null, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    const r = renderView(readyState([hit(N2, [m("_top", "", "needle")])]), { anchors: other });
    expect(matchLink()).toHaveAttribute("href", canonicalNotePath(N2));
    fireEvent.click(matchLink());
    expect(lastLocation).toEqual({ pathname: canonicalNotePath(N2), hash: "" });
    r.unmount();
    const same = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("_top", "", "needle")])]), { anchors: same });
    fireEvent.click(matchLink());
    expect(same.scrollToTop).toHaveBeenCalledTimes(1);
    expect(same.requestAnchor).not.toHaveBeenCalled();
  });

  it("C4 Ctrl＋點擊 → 不 preventDefault、網址不變、requestAnchor 沒被叫", () => {
    const anchors = { currentNoteId: N2.id, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
    renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]), { anchors });
    expect(fireEvent.click(matchLink(), { ctrlKey: true })).toBe(true);
    expect(lastLocation).toEqual({ pathname: "/start", hash: "" });
    expect(anchors.requestAnchor).not.toHaveBeenCalled();
  });

  it("C5 點 match 與點標題列都會 setActiveNoteId", () => {
    const r = renderView(readyState([hit(N2, [m("h1", "Intro", "needle")])]));
    fireEvent.click(matchLink());
    expect(activeId).toBe(N2.id);
    r.unmount();
    activeId = null;
    renderView(readyState([hit(N1, [m("h1", "Intro", "needle")])]));
    fireEvent.click(within(within(region()).getByTestId("body-hit")).getAllByRole("link")[0]!);
    expect(activeId).toBe(N1.id);
  });
});
