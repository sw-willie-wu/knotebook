import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { NoteList } from "./NoteList";

/** 模擬 NotePage 的「解析成功後 set」——測試用的最小 setter（#122 ActiveNoteContext）。 */
function SetActive({ id }: { id: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

// 跟 App.test.tsx / guards.test.tsx 同一套約定：mock 全域 fetch，讓真正的
// useNotes()（react-query）打到假回應，而不是 mock hook 本身——這樣測到的是
// NoteList 與 Task 10 hooks 真實串接後的行為。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

function renderNoteList(query?: string, queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <NoteList query={query} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** #122：以指定 active 筆記渲染——「目前開啟中」判斷改吃 ActiveNoteContext 的 note.id
 * （SetActive 模擬 NotePage 解析成功後的 set），不再讀路由參數（也就不再需要掛在
 * `/notes/:ref` 路由底下）。回傳 view＋queryClient 供改資料/卸載類案子用。 */
function renderNoteListWithActive(activeId: string | undefined, query?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          {activeId !== undefined && <SetActive id={activeId} />}
          <NoteList query={query} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

const OWNER_NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Has A Slug",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "custom-slug",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "owner-one",
};

const SHARED_NOTE: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "No Slug Note",
  ownerId: "u9",
  role: "editor",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "no-slug-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "owner-nine",
};

// 第三篇筆記，只用於「三分組/過濾/最近前 2」那幾案——server 已按
// updated_at DESC 排序，這裡故意排在 OWNER_NOTE/SHARED_NOTE 之後，驗證
// 「最近」只取原始清單的前 2 篇。
const THIRD_OWNER_NOTE: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Third Owner Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2025-12-01T00:00:00.000Z",
  slug: "third-owner-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "owner-one",
};

function stubNotesFetch(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }))),
  );
}

describe("NoteList", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state while /api/notes is pending", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );

    renderNoteList();

    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows an error message when /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          fakeResponse({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
          }),
        ),
      ),
    );

    renderNoteList();

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."),
    );
  });

  it("shows guidance to create the first note when there are none", async () => {
    stubNotesFetch([]);

    renderNoteList();

    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeInTheDocument());
  });

  it("links each note to its canonicalNotePath — /n/<ownerHandle>/<slug> 單一形（#122）", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();

    // 只有 2 篇筆記時兩篇都落在「最近」，也各自落在自己的主清單——用
    // `within` 鎖定主清單那份，href 兩份應該一致（同一個 canonicalNotePath）。
    const myNotes = await screen.findByTestId("notegroup-myNotes");
    expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).toHaveAttribute(
      "href",
      canonicalNotePath(OWNER_NOTE),
    );
    expect(canonicalNotePath(OWNER_NOTE)).toBe("/n/owner-one/custom-slug");

    const shared = screen.getByTestId("notegroup-shared");
    expect(within(shared).getByRole("link", { name: "No Slug Note" })).toHaveAttribute(
      "href",
      canonicalNotePath(SHARED_NOTE),
    );
    expect(canonicalNotePath(SHARED_NOTE)).toBe("/n/owner-nine/no-slug-note"); // 新形字面（原 not.toBe 在 slug 恆字串後恆真）

    // #115：列高 `<md` 44px（觸控目標）、`md+` 回 28px——h-11 md:h-7 缺一即壞
    // （缺 md:h-7 寬螢幕列變胖；缺 h-11 窄視窗點不準）。
    const touchRow = within(myNotes).getByRole("link", { name: "Has A Slug" });
    expect(touchRow.closest("li")).toHaveClass("h-11", "md:h-7");
    // 觸控目標是 <Link> 不是 <li>：li 撐 44 高但 items-center 下錨點只有內容高
    // （~20px），上下各 12px 是死區——Link 要 self-stretch 吃滿列高才是真的 44px
    // 目標（審查抓到的「宣稱到不了的行為」形）。
    expect(touchRow).toHaveClass("self-stretch", "flex", "items-center");
  });

  it("shows a role badge only for shared (non-owner) notes; no delete button anywhere (moved to the ⋮ menu)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));

    // "Editor" 出現兩次（最近 + 與我共享），"Owner" 之類的 owner 徽章從不存在。
    expect(screen.getAllByText("Editor").length).toBeGreaterThan(0);
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  // ── #122：active 高亮改吃 ActiveNoteContext（note.id 單一真相，URL 判斷退役） ──

  it("開頁亮：context 有 active id（NotePage 解析後 set）→ 該列 aria-current=page，只在主清單、不在 最近", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListWithActive(OWNER_NOTE.id);

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));

    const currentLinks = screen.getAllByRole("link", { current: "page" });
    expect(currentLinks).toHaveLength(1);
    expect(currentLinks[0]).toHaveAccessibleName("Has A Slug");
    expect(within(screen.getByTestId("notegroup-myNotes")).getByRole("link", { name: "Has A Slug" })).toBe(
      currentLinks[0],
    );

    for (const link of screen.getAllByRole("link", { name: "No Slug Note" })) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  // PR3：active 列跟主題色，且 hover 態要一起換成 brand（B3——twMerge 讓後出的
  // hover:bg-brand-soft-strong 蓋掉 hover:bg-accent/60，同一個 variant 群組互斥）。
  // 握把：class 掛在 <li>，不是 <a>，因此用 getByRole("link").closest("li") 取。
  it("active 列套用主題色 tint（bg-brand-soft/text-brand-on-soft/hover:bg-brand-soft-strong）", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListWithActive(OWNER_NOTE.id);

    const activeLink = await screen.findByRole("link", { current: "page" });
    const activeRow = activeLink.closest("li");
    expect(activeRow).toHaveClass("bg-brand-soft", "text-brand-on-soft", "font-medium", "hover:bg-brand-soft-strong");
    // twMerge 真的蓋掉了中性 hover，不是兩個 class 並存靠優先權僥倖對——驗證
    // hover:bg-accent/60 確實從 active 列的 class 清單裡消失。
    expect(activeRow).not.toHaveClass("hover:bg-accent/60");

    const sharedGroup = screen.getByTestId("notegroup-shared");
    const inactiveLink = within(sharedGroup).getByRole("link", { name: "No Slug Note" });
    const inactiveRow = inactiveLink.closest("li");
    expect(inactiveRow).not.toHaveClass("bg-brand-soft");
    expect(inactiveRow).toHaveClass("hover:bg-accent/60");
  });

  it("點擊即亮：樂觀 set，不等任何解析", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListWithActive(undefined);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));
    expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);

    const myNotes = screen.getByTestId("notegroup-myNotes");
    fireEvent.click(within(myNotes).getByRole("link", { name: "Has A Slug" }));
    expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).toHaveAttribute("aria-current", "page");
  });

  it("換頁換：點另一篇 → 高亮移轉、不殘留", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListWithActive(undefined);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));

    const myNotes = screen.getByTestId("notegroup-myNotes");
    fireEvent.click(within(myNotes).getByRole("link", { name: "Has A Slug" }));
    const shared = screen.getByTestId("notegroup-shared");
    fireEvent.click(within(shared).getByRole("link", { name: "No Slug Note" }));
    expect(within(shared).getByRole("link", { name: "No Slug Note" })).toHaveAttribute("aria-current", "page");
    expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).not.toHaveAttribute("aria-current");
  });

  it("修飾鍵點擊（cmd/ctrl/shift＋左鍵＝開新分頁）**不**樂觀 set", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteListWithActive(undefined);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Has A Slug" }).length).toBeGreaterThan(0));

    const myNotes = screen.getByTestId("notegroup-myNotes");
    const link = within(myNotes).getByRole("link", { name: "Has A Slug" });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { shiftKey: true });
    expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);
  });

  it("active 以 id 為錨：**同一棵樹**上 title/slug 全變（模擬改標題後清單更新）→ 高亮不掉、恰一個", async () => {
    // 「跨 pattern 換頁」案延 Task 5b（plan gate m17——/n/ route 屆時才存在）。
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
    const { queryClient } = renderNoteListWithActive(OWNER_NOTE.id);
    await screen.findByRole("link", { current: "page" });

    // 同一個 QueryClient 就地換資料（不卸載）：id 相同、title 與 slug 都變——
    // 任何以 title/slug/URL 當判準的實作在這裡會掉高亮，id 錨定不會。
    const renamed = { ...OWNER_NOTE, title: "Renamed Entirely", slug: "renamed-entirely" };
    queryClient.setQueryData<NoteDto[]>(["notes"], [renamed, SHARED_NOTE]);

    const current = await screen.findAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Renamed Entirely");
  });

  // ── PR2：三分組、先分組後過濾、最近前 2、無符合 ──────────────────────────

  it("groups notes into recent (first 2, server order) / my notes (owner) / shared (editor|viewer)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList();

    const recent = await screen.findByTestId("notegroup-recent");
    // 「最近」固定取原始清單前 2 篇——THIRD_OWNER_NOTE 排第三，不在最近裡。
    expect(within(recent).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    expect(within(recent).getByRole("link", { name: "No Slug Note" })).toBeInTheDocument();
    expect(within(recent).queryByRole("link", { name: "Third Owner Note" })).not.toBeInTheDocument();

    const myNotes = screen.getByTestId("notegroup-myNotes");
    expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    expect(within(myNotes).getByRole("link", { name: "Third Owner Note" })).toBeInTheDocument();
    expect(within(myNotes).queryByRole("link", { name: "No Slug Note" })).not.toBeInTheDocument();

    const shared = screen.getByTestId("notegroup-shared");
    expect(within(shared).getByRole("link", { name: "No Slug Note" })).toBeInTheDocument();
    expect(within(shared).queryByRole("link", { name: "Has A Slug" })).not.toBeInTheDocument();

    // 結構性守衛：分組 label 文案要對、DOM 順序要對（最近 → 我的筆記 → 與我共享）。
    // 沒有這三行，label 塞錯組、打錯 i18n key、或順序對調，上面全部靠 testid 鎖定
    // 的斷言照樣綠——這是唯一擋得住這幾種錯的地方。
    expect(within(recent).getByText("Recent")).toBeInTheDocument();
    expect(within(myNotes).getByText("My notes")).toBeInTheDocument();
    expect(within(shared).getByText("Shared with me")).toBeInTheDocument();
    const groupOrder = Array.from(document.querySelectorAll('[data-testid^="notegroup-"]')).map((el) =>
      el.getAttribute("data-testid"),
    );
    expect(groupOrder).toEqual(["notegroup-recent", "notegroup-myNotes", "notegroup-shared"]);
  });

  it("filters within each already-formed group by title (先分組、後過濾) — 最近 shrinks accordingly", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList("third");

    const myNotes = await screen.findByTestId("notegroup-myNotes");
    expect(within(myNotes).getByRole("link", { name: "Third Owner Note" })).toBeInTheDocument();
    expect(within(myNotes).queryByRole("link", { name: "Has A Slug" })).not.toBeInTheDocument();

    // 「最近」的固定集合是前 2 篇（Has A Slug / No Slug Note），過濾成 "third"
    // 之後兩篇都不合 → 最近整組不渲染（不是空的 group，是整個 testid 都不存在）。
    expect(screen.queryByTestId("notegroup-recent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-shared")).not.toBeInTheDocument();
  });

  it("shows sidebar.noMatch when there are notes but none match the filter", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList("nonexistent-xyz");

    await waitFor(() => expect(screen.getByText("No notes match your search.")).toBeInTheDocument());
    expect(screen.queryByTestId("notegroup-recent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-myNotes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-shared")).not.toBeInTheDocument();
  });

  it("still shows the fully-empty EmptyState (not sidebar.noMatch) when there are zero notes at all, regardless of query", async () => {
    stubNotesFetch([]);

    renderNoteList("anything");

    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeInTheDocument());
    expect(screen.queryByText("No notes match your search.")).not.toBeInTheDocument();
  });
});
