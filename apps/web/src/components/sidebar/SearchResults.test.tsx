import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto, type NoteSearchHitDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { SearchResults, highlightTitle } from "./SearchResults";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

function fakeResponse(ok: boolean, status: number, body?: unknown): Response {
  return {
    ok,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function note(id: string, title: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `slug-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "owner-one",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

const ALPHA_PLAN = note("n1", "Alpha Plan");
const ALPHA_GROUP = note("n2", "Alpha Group", {
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GROUP_A.id,
  group: { id: GROUP_A.id, name: GROUP_A.name },
  permissions: EDITOR_PERMS,
});
const ALPHA_SHARED = note("n3", "alpha shared", {
  ownerId: "u9",
  role: "editor",
  ownerHandle: "owner-nine",
  permissions: EDITOR_PERMS,
});
const BETA = note("n4", "Beta");
const FIXTURE = [ALPHA_PLAN, ALPHA_GROUP, ALPHA_SHARED, BETA];

/** #93 PR2：`/api/search` 的回應（預設空）。測試可換成自己的處理（回 Response 或 Promise）。 */
const EMPTY_SEARCH = () => fakeResponse(true, 200, { hits: [], nextCursor: null });
let searchHandler: (url: string) => Response | Promise<Response> = EMPTY_SEARCH;
let searchUrls: string[] = [];

function stubFetch(notes: NoteDto[] | "pending" | "error", groups: GroupDto[] = [GROUP_A]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.startsWith("/api/search?")) {
        searchUrls.push(url);
        return Promise.resolve(searchHandler(url));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        if (notes === "pending") return new Promise(() => {});
        if (notes === "error") return Promise.resolve(fakeResponse(false, 500, { error: "internal" }));
        return Promise.resolve(fakeResponse(true, 200, notes));
      }
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse(true, 200, groups));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function SetActive({ id }: { id: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

function renderResults(query: string, activeId?: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ActiveNoteProvider>
          {activeId !== undefined && <SetActive id={activeId} />}
          <SearchResults query={query} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 以 `^標題` 取結果列連結（可及名稱是「標題 位置」）。 */
function rowLink(title: string): HTMLElement {
  return screen.getByRole("link", { name: new RegExp("^" + escapeRe(title)) });
}

describe("SearchResults", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("SR1：扁平結果、server 順序、位置行與結果數", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(items.map((li) => li.querySelector("div:nth-child(1)")?.textContent)).toEqual([
      "Alpha Plan",
      "Alpha Group",
      "alpha shared",
    ]);
    expect(items.map((li) => li.querySelector("div:nth-child(2)")?.textContent)).toEqual([
      "My notes",
      "Groups › Workshop A",
      "Shared with me · Editor",
    ]);
    expect(screen.getByRole("status")).toHaveTextContent("3 title matches");
  });

  it("SR1：只剩一筆時是 1 result", async () => {
    stubFetch(FIXTURE);
    renderResults("beta");
    await screen.findByRole("link", { name: /^Beta/ });
    expect(screen.getByRole("status").textContent).toMatch(/\b1 title match$/);
  });

  it("SR1：zh-TW 的結果數", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFetch(FIXTURE);
    renderResults("alpha");
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    expect(screen.getByRole("status")).toHaveTextContent("標題符合 · 3 篇");
  });

  it("SR2：高亮只標第一個命中、保留原大小寫、標題文字完整", async () => {
    stubFetch([note("s1", "Has A Slug")]);
    renderResults("a sl");
    const link = await screen.findByRole("link", { name: /^Has A Slug/ });
    const marks = link.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("A Sl");
    expect(marks[0]).toHaveClass("bg-search-highlight");
    expect(link.querySelector("div")?.textContent).toBe("Has A Slug");
  });

  it("SR3：toLowerCase 後長度改變的標題照樣列出、不標 mark、標題完整", async () => {
    stubFetch([note("s1", "İstanbul notes")]);
    renderResults("notes");
    const link = await screen.findByRole("link", { name: /^İstanbul notes/ });
    expect(link.querySelector("mark")).toBeNull();
    expect(link.querySelector("div")?.textContent).toBe("İstanbul notes");
  });

  it("SR4：查詢字串一律字面比對（括號不丟錯、點不當萬用字元）", async () => {
    stubFetch([note("s1", "x (y)"), note("s2", "axb")]);
    const first = renderResults("(");
    await screen.findByRole("link", { name: /^x \(y\)/ });
    expect(screen.queryByRole("link", { name: /^axb/ })).not.toBeInTheDocument();
    first.unmount();

    renderResults("a.b");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 title matches"));
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(await screen.findByText("No notes match your search.")).toBeInTheDocument();
  });

  it("SR5：無命中——0 results、提示可見、沒有 listitem", async () => {
    stubFetch(FIXTURE);
    renderResults("zzz");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("0 title matches"));
    expect(await screen.findByText("No notes match your search.")).toBeVisible();
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
  });

  it("SR6：不放 ⋮、href 為 canonicalNotePath、可及名稱含位置、aria-current 與樂觀 active", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha", ALPHA_PLAN.id);
    await screen.findByRole("link", { name: /^Alpha Plan/ });
    expect(screen.queryAllByRole("button", { name: /^Note actions for/ })).toHaveLength(0);
    expect(rowLink("Alpha Plan")).toHaveAttribute("href", canonicalNotePath(ALPHA_PLAN));
    expect(rowLink("Alpha Group")).toHaveAttribute("href", canonicalNotePath(ALPHA_GROUP));
    expect(screen.getByRole("link", { name: "Alpha Group Groups › Workshop A" })).toBeInTheDocument();

    await waitFor(() => expect(rowLink("Alpha Plan")).toHaveAttribute("aria-current", "page"));
    expect(rowLink("Alpha Group")).not.toHaveAttribute("aria-current");
    expect(rowLink("alpha shared")).not.toHaveAttribute("aria-current");

    fireEvent.click(rowLink("alpha shared"));
    await waitFor(() => expect(rowLink("alpha shared")).toHaveAttribute("aria-current", "page"));
    expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
  });

  it("SR7：notes pending → Loading…；500 → role=alert", async () => {
    stubFetch("pending");
    const first = renderResults("a");
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toHaveClass("flex-1");
    first.unmount();
    vi.unstubAllGlobals();

    stubFetch("error");
    renderResults("a");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-search")).toHaveClass("flex-1");
  });

  it("SR8：長標題——標題與位置元素 truncate、連結 min-w-0", async () => {
    stubFetch([note("s1", "L".repeat(120))]);
    renderResults("l");
    const link = await screen.findByRole("link");
    expect(link).toHaveClass("min-w-0");
    const lines = link.querySelectorAll("div");
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toHaveClass("truncate");
    expect(within(link).getByText("My notes")).toHaveClass("truncate");
  });
});

describe("SearchResults × 資料夾路徑", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SR-F1 搜到 p2 → 第二行「My notes › A › A1」，title 同字", async () => {
    const p2 = note("p2", "Deep note", { folderId: "A1" });
    const folders = [folderDto({ id: "A", name: "A" }), folderDto({ id: "A1", name: "A1", parentId: "A" })];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify({ folders }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse(true, 200, [p2]));
        if (url === "/api/groups") return Promise.resolve(fakeResponse(true, 200, []));
        if (url.startsWith("/api/search?")) return Promise.resolve(fakeResponse(true, 200, { hits: [], nextCursor: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    renderResults("deep");
    await waitFor(() => expect(screen.getByTitle("My notes › A › A1")).toHaveTextContent("My notes › A › A1"));
  });
});

describe("SearchResults × 內文符合（#93 PR2 T5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    searchUrls = [];
    searchHandler = EMPTY_SEARCH;
  });
  afterEach(() => {
    vi.useRealTimers();
    searchHandler = EMPTY_SEARCH;
  });

  const bodyHit = (n: NoteDto, matchedOn: NoteSearchHitDto["matchedOn"] = "body"): NoteSearchHitDto => ({
    note: n,
    matchedOn,
    matches: matchedOn === "title" ? [] : [{ sectionId: "s1", heading: "", snippet: "body text" }],
  });
  const searchBody = (hits: NoteSearchHitDto[]) => fakeResponse(true, 200, { hits, nextCursor: null });
  /** 可外部放行的 /api/search 回應。 */
  function deferredSearch() {
    const pending: Array<(r: Response) => void> = [];
    searchHandler = () => new Promise<Response>((resolve) => pending.push(resolve));
    return pending;
  }
  const qOf = (url: string) => new URL(url, "http://x").searchParams.get("q");
  const noMatch = () => screen.queryAllByText("No notes match your search.");
  const region = () => screen.getByRole("region", { name: "In note text" });

  /** lazy 是模組級單例：先用真計時器掛一次，讓後面的 fake timers 案不必等 chunk。 */
  async function warmLazy() {
    stubFetch(FIXTURE);
    const r = renderResults("warmup");
    await screen.findByRole("region", { name: "In note text" });
    r.unmount();
    searchUrls = [];
  }

  function renderControlled(initial: string) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const tree = (q: string) => (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SearchResults query={q} />
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const r = render(tree(initial));
    return { ...r, setQuery: (q: string) => r.rerender(tree(q)) };
  }

  it("S2 noMatch：標題 0＋內文 pending → 沒有、有「Searching…」；回空 → 恰一個；error → 沒有；stale 的空批 → 沒有", async () => {
    stubFetch(FIXTURE);
    let pending = deferredSearch();
    const a = renderResults("zzz");
    await waitFor(() => expect(searchUrls.length).toBe(1));
    expect(await screen.findByText("Searching note text…")).toBeInTheDocument();
    expect(noMatch()).toHaveLength(0);
    act(() => pending[0]!(searchBody([])));
    await waitFor(() => expect(noMatch()).toHaveLength(1));
    a.unmount();

    searchHandler = () => fakeResponse(false, 500, { error: { code: "internal", message: "x" } });
    const b = renderResults("yyy");
    expect(await screen.findByText("Couldn't search note text.")).toBeInTheDocument();
    expect(noMatch()).toHaveLength(0);
    b.unmount();

    // stale 的空批：舊批本身是空的（標題 0、內文 0 → 先看到 noMatch）；改字後防抖中、新請求未回都是 stale → noMatch 消失（舊的空批
    // 不能拿來斷定新字也沒有命中）；新批回空 → noMatch 再出現。舊批若有結果，rows.length > 0 本來就不顯示，殺不掉「拿掉 !stale」（審查 m3）。
    searchHandler = EMPTY_SEARCH;
    const c = renderControlled("qqq");
    await waitFor(() => expect(noMatch()).toHaveLength(1));
    pending = deferredSearch();
    c.setQuery("qqqq");
    expect(noMatch()).toHaveLength(0); // 防抖中：stale（query !== debounced）
    await waitFor(() => expect(searchUrls.some((u) => qOf(u) === "qqqq")).toBe(true));
    expect(noMatch()).toHaveLength(0); // 新請求在路上：stale（placeholder）
    act(() => pending[0]!(searchBody([])));
    await waitFor(() => expect(noMatch()).toHaveLength(1));
  });

  it("S3 標題 0 但內文 2 篇 → 沒有 noMatch", async () => {
    stubFetch(FIXTURE);
    searchHandler = () => searchBody([bodyHit(BETA), bodyHit(ALPHA_PLAN)]);
    renderResults("zzz");
    await waitFor(() => expect(within(region()).getAllByTestId("body-hit")).toHaveLength(2));
    expect(noMatch()).toHaveLength(0);
  });

  it("S4 both 的筆記在兩區各一次；只中標題的不在內文區", async () => {
    stubFetch(FIXTURE);
    searchHandler = () => searchBody([bodyHit(ALPHA_PLAN, "both"), bodyHit(ALPHA_SHARED, "title")]);
    renderResults("alpha");
    await waitFor(() => expect(within(region()).getAllByTestId("body-hit")).toHaveLength(1));
    expect(screen.getAllByRole("link", { name: /^Alpha Plan/ })).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: /^alpha shared/ })).toHaveLength(1);
    expect(within(region()).queryByRole("link", { name: /^alpha shared/ })).not.toBeInTheDocument();
  });

  it("S6 版面：內文區最近的 overflow-y-auto 祖先＝標題清單所在的容器；status 不在裡面；側欄恰一個 status", async () => {
    stubFetch(FIXTURE);
    renderResults("alpha");
    const body = await screen.findByTestId("sidebar-body-search");
    const titleList = screen.getAllByRole("link", { name: /^Alpha Plan/ })[0]!.closest("ul")!;
    const scroller = body.parentElement!.closest(".overflow-y-auto");
    expect(scroller).not.toBeNull();
    expect(scroller).toBe(titleList.closest(".overflow-y-auto"));
    expect(scroller!.contains(screen.getByRole("status"))).toBe(false);
    expect(within(screen.getByTestId("sidebar-search")).getAllByRole("status")).toHaveLength(1);
  });

  it("S7 防抖：a→ab→abc→abcd 各隔 100 ms → 推過 300 ms → /api/search 恰一次、q=abcd", async () => {
    await warmLazy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const r = renderControlled("a");
    await screen.findByRole("status");
    for (const q of ["ab", "abc", "abcd"]) {
      r.setQuery(q);
      await act(async () => vi.advanceTimersByTime(100));
    }
    await act(async () => vi.advanceTimersByTime(300));
    await waitFor(() => expect(searchUrls.length).toBe(1));
    await act(async () => vi.advanceTimersByTime(400));
    expect(searchUrls.map(qOf)).toEqual(["abcd"]);
  });

  it("S8 重新掛載不重發：abcd 回來 → a（lazy 卸載）→ 100 ms 內 ab（重新掛載）→ 推過 300 ms → 只多一次 q=ab", async () => {
    await warmLazy();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const r = renderControlled("abcd");
    await waitFor(() => expect(searchUrls.map(qOf)).toEqual(["abcd"]));
    await screen.findByText("0 notes");
    r.setQuery("a");
    expect(screen.queryByTestId("sidebar-body-search")).not.toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(50));
    r.setQuery("ab");
    await act(async () => vi.advanceTimersByTime(50));
    expect(searchUrls.map(qOf)).toEqual(["abcd"]);
    await act(async () => vi.advanceTimersByTime(300));
    await waitFor(() => expect(searchUrls.map(qOf)).toEqual(["abcd", "ab"]));
    await act(async () => vi.advanceTimersByTime(400));
    expect(searchUrls.map(qOf)).toEqual(["abcd", "ab"]);
  });
});

describe("highlightTitle", () => {
  it("找不到、或小寫化改變長度 → 回原字串", () => {
    expect(highlightTitle("Beta", "zz")).toBe("Beta");
    expect(highlightTitle("İstanbul", "stan")).toBe("İstanbul");
  });

  it("兩處命中只標第一個、保留原大小寫", () => {
    const { container } = render(<>{highlightTitle("Alpha alpha", "alpha")}</>);
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("Alpha");
    expect(marks[0].previousSibling).toBeNull();
    expect(container.textContent).toBe("Alpha alpha");
    expect(marks[0].nextSibling?.textContent).toBe(" alpha");
  });
});
