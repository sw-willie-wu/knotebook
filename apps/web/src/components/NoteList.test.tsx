import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { NoteList, type NoteListProps } from "./NoteList";

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

function renderNoteList(
  props: Partial<NoteListProps> = {},
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <NoteList {...props} />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** #122：以指定 active 筆記渲染——「目前開啟中」判斷改吃 ActiveNoteContext 的 note.id
 * （SetActive 模擬 NotePage 解析成功後的 set），不再讀路由參數（也就不再需要掛在
 * `/notes/:ref` 路由底下）。回傳 view＋queryClient 供改資料/卸載類案子用。 */
function renderNoteListWithActive(activeId: string | undefined, props: Partial<NoteListProps> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          {activeId !== undefined && <SetActive id={activeId} />}
          <NoteList {...props} />
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
  lastEdited: null,
  group: null,
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
  lastEdited: null,
  group: null,
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
  lastEdited: null,
  group: null,
};

const GROUP_A: GroupDto = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A", myRole: "admin", createdAt: "2026-09-01T00:00:00.000Z" };
/** 我的筆記、在 A、我是 A 成員 → A 段，無徽章（§3.3 第 2 列）。 */
const MY_GROUP_NOTE: NoteDto = { ...OWNER_NOTE, id: "44444444-4444-4444-4444-444444444444", title: "Mine In A", slug: "mine-in-a", group: { id: GROUP_A.id, name: GROUP_A.name, role: "editor" } };
/** 別人的、在 A、我是成員 → A 段，徽章＝group_role（§3.3 第 5 列）。 */
const OTHERS_GROUP_NOTE: NoteDto = { ...SHARED_NOTE, id: "55555555-5555-5555-5555-555555555555", title: "Theirs In A", slug: "theirs-in-a", role: "viewer", group: { id: GROUP_A.id, name: GROUP_A.name, role: "viewer" } };
/** 別人的、group 非 null 但那個群組不在 useGroups() 裡（剛被移出）→ 與我共享（兜底，第 6 列）。 */
const ORPHAN_GROUP_NOTE: NoteDto = { ...SHARED_NOTE, id: "66666666-6666-6666-6666-666666666666", title: "Orphan", slug: "orphan", role: "editor", group: { id: "99999999-9999-9999-9999-999999999999", name: "Gone", role: "editor" } };

const ME: UserDto = { id: "u1", email: "me@example.com", handle: "owner-one", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true };

function stubNotesFetch(notes: NoteDto[], groups: GroupDto[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      // 群組段的 ⋮（GroupMenu）用 useSession 拿自己的 id（退出群組）
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
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
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
          }),
        );
      }),
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
    // #103：工作坊段在非搜尋時恆渲染（§8.1 順序：最近 → 我的筆記 → 與我共享 → 工作坊）。
    expect(groupOrder).toEqual(["notegroup-recent", "notegroup-myNotes", "notegroup-shared", "notegroup-workspace"]);
  });

  it("filters within each already-formed group by title (先分組、後過濾) — 最近 shrinks accordingly", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList({ query: "third" });

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

    renderNoteList({ query: "nonexistent-xyz" });

    await waitFor(() => expect(screen.getByText("No notes match your search.")).toBeInTheDocument());
    expect(screen.queryByTestId("notegroup-recent")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-myNotes")).not.toBeInTheDocument();
    expect(screen.queryByTestId("notegroup-shared")).not.toBeInTheDocument();
  });

  it("still shows the fully-empty EmptyState (not sidebar.noMatch) when there are zero notes at all, regardless of query", async () => {
    stubNotesFetch([]);

    renderNoteList({ query: "anything" });

    await waitFor(() => expect(screen.getByText("No notes yet.")).toBeInTheDocument());
    expect(screen.queryByText("No notes match your search.")).not.toBeInTheDocument();
  });

  describe("側欄分段與折疊（#103）", () => {
    beforeEach(() => {
      window.localStorage.clear();
    });

    it("§3.3 七列：我的／群組／與我共享各落各段，群組段徽章只給非 owner", async () => {
      stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE, OTHERS_GROUP_NOTE, SHARED_NOTE, ORPHAN_GROUP_NOTE], [GROUP_A]);
      renderNoteList();

      const groupA = await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
      expect(within(groupA).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      expect(within(groupA).getByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
      expect(within(groupA).getByText("Viewer")).toBeInTheDocument(); // OTHERS_GROUP_NOTE 的徽章
      expect(within(groupA).queryByText("Owner")).not.toBeInTheDocument();

      const myNotes = screen.getByTestId("notegroup-myNotes");
      expect(within(myNotes).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
      expect(within(myNotes).queryByRole("link", { name: "Mine In A" })).not.toBeInTheDocument();

      const shared = screen.getByTestId("notegroup-shared");
      expect(within(shared).getByRole("link", { name: "No Slug Note" })).toBeInTheDocument();
      expect(within(shared).getByRole("link", { name: "Orphan" })).toBeInTheDocument(); // 兜底列
      expect(within(shared).queryByRole("link", { name: "Theirs In A" })).not.toBeInTheDocument();

      // 工作坊段標與群組段標都是 aria-expanded 的按鈕，且群組段縮排在工作坊底下
      const workspace = screen.getByTestId("notegroup-workspace");
      expect(within(workspace).getByRole("button", { name: "Workspace", expanded: true })).toBeInTheDocument();
      expect(within(workspace).getByRole("button", { name: "Workshop A", expanded: true })).toBeInTheDocument();
      expect(workspace).toContainElement(groupA);
    });

    it("RF2 側欄：owner 已不是群組成員（group 非 null 但不在 useGroups）→ 落「我的筆記」", async () => {
      stubNotesFetch([MY_GROUP_NOTE], []);
      renderNoteList();
      const myNotes = await screen.findByTestId("notegroup-myNotes");
      expect(within(myNotes).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      expect(screen.queryByTestId(`notegroup-group-${GROUP_A.id}`)).not.toBeInTheDocument();
    });

    it("RF3：零筆記但有群組 → 不是 EmptyState；「我的筆記」與群組段標仍渲染", async () => {
      stubNotesFetch([], [GROUP_A]);
      renderNoteList();
      expect(await screen.findByRole("button", { name: "Workshop A" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "My notes" })).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
      // 最近／與我共享為空 → 整段不渲染（現狀）
      expect(screen.queryByTestId("notegroup-recent")).not.toBeInTheDocument();
      expect(screen.queryByTestId("notegroup-shared")).not.toBeInTheDocument();
    });

    it("零筆記且零群組 → EmptyState（既有行為不變）", async () => {
      stubNotesFetch([], []);
      renderNoteList();
      expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
    });

    it("折疊：點段標 → aria-expanded=false、列消失、localStorage 寫 sidebar.collapsed.myNotes=1；重掛後仍收合", async () => {
      stubNotesFetch([OWNER_NOTE], []);
      const first = renderNoteListWithActive(undefined);
      // ⚠ 「最近」會重複顯示同一篇——所有列的斷言都用 within(我的筆記段) 圈定。
      const header = await screen.findByRole("button", { name: "My notes", expanded: true });
      const myNotes = () => within(screen.getByTestId("notegroup-myNotes"));
      expect(myNotes().getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
      fireEvent.click(header);
      expect(screen.getByRole("button", { name: "My notes" })).toHaveAttribute("aria-expanded", "false");
      expect(myNotes().queryByRole("link", { name: "Has A Slug" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem("sidebar.collapsed.myNotes")).toBe("1");

      first.view.unmount();
      renderNoteList();
      expect(await screen.findByRole("button", { name: "My notes" })).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(screen.getByRole("button", { name: "My notes" }));
      expect(window.localStorage.getItem("sidebar.collapsed.myNotes")).toBeNull();
      expect(myNotes().getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    });

    it("RF4：localStorage 拋錯（隱私模式）→ 側欄照常、預設展開、本次 session 仍能折疊", async () => {
      const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("SecurityError");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      try {
        stubNotesFetch([OWNER_NOTE], []);
        renderNoteList();
        const header = await screen.findByRole("button", { name: "My notes", expanded: true });
        fireEvent.click(header);
        expect(screen.getByRole("button", { name: "My notes" })).toHaveAttribute("aria-expanded", "false");
        expect(within(screen.getByTestId("notegroup-myNotes")).queryByRole("link", { name: "Has A Slug" })).not.toBeInTheDocument();
      } finally {
        getItem.mockRestore();
        setItem.mockRestore();
      }
    });

    it("搜尋強制展開（A5）：收合中的段有命中 → 展開顯示；四段全無命中 → noMatch", async () => {
      window.localStorage.setItem("sidebar.collapsed.myNotes", "1");
      window.localStorage.setItem(`sidebar.collapsed.group:${GROUP_A.id}`, "1");
      stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE], [GROUP_A]);
      const { view } = renderNoteListWithActive(undefined, { query: "in a" });
      const groupA = await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
      expect(within(groupA).getByRole("link", { name: "Mine In A" })).toBeInTheDocument(); // 「最近」也有一份，必須圈定
      expect(screen.getByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "true");
      // 沒命中的段（我的筆記：Has A Slug 不含 "in a"）在搜尋時不渲染
      expect(screen.queryByTestId("notegroup-myNotes")).not.toBeInTheDocument();

      view.unmount();
      renderNoteList({ query: "zzz-nothing" });
      expect(await screen.findByText("No notes match your search.")).toBeInTheDocument();
    });

    it("aria-current=page 在整個側欄恰一個（active 是群組筆記時給群組段那列，不給「最近」）", async () => {
      stubNotesFetch([MY_GROUP_NOTE, OWNER_NOTE], [GROUP_A]);
      renderNoteListWithActive(MY_GROUP_NOTE.id);
      await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
      const current = document.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(screen.getByTestId(`notegroup-group-${GROUP_A.id}`)).toContainElement(current[0] as HTMLElement);
    });

    it("段標的 chevron＋名稱是一顆 button，「＋」是它的兄弟（不巢狀）；「＋」鍵盤可及、hover 才顯示", async () => {
      const onCreateNote = vi.fn();
      stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({ onCreateNote });
      const header = await screen.findByRole("button", { name: "My notes" });
      expect(header.querySelector("button")).toBeNull();
      const plus = screen.getByRole("button", { name: "New personal note" });
      expect(header.contains(plus)).toBe(false);
      expect(plus.parentElement).toBe(header.parentElement);
      expect(plus).toHaveClass(
        "opacity-0",
        "group-hover/section:opacity-100",
        "group-has-[:focus-visible]/section:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      );
      expect(plus).not.toHaveClass("group-focus-within/section:opacity-100");
      plus.focus();
      expect(document.activeElement).toBe(plus);

      fireEvent.click(plus);
      expect(onCreateNote).toHaveBeenCalledTimes(1);
      expect(onCreateNote.mock.calls[0]).toEqual([undefined]);
      fireEvent.click(screen.getByRole("button", { name: "New note in Workshop A" }));
      expect(onCreateNote).toHaveBeenLastCalledWith(GROUP_A.id);
    });

    it("群組取名「My notes」時，「我的筆記」的「＋」與該群組的「＋」可及名稱不同（#103 PR3）", async () => {
      const onCreateNote = vi.fn();
      const lookalike: GroupDto = { ...GROUP_A, name: "My notes" };
      stubNotesFetch([OWNER_NOTE], [lookalike]);
      renderNoteList({ onCreateNote });
      const groupPlus = await screen.findByRole("button", { name: "New note in My notes" });
      const personalPlus = screen.getByRole("button", { name: "New personal note" });
      expect(personalPlus).not.toBe(groupPlus);
      fireEvent.click(personalPlus);
      expect(onCreateNote).toHaveBeenLastCalledWith(undefined);
      fireEvent.click(groupPlus);
      expect(onCreateNote).toHaveBeenLastCalledWith(lookalike.id);
    });

    it("useGroups pending：工作坊段標下顯示 Loading…，群組筆記暫依兜底列落段", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === "/api/notes") {
            return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OTHERS_GROUP_NOTE]) }));
          }
          return new Promise<Response>(() => {}); // /api/groups 永不 resolve
        }),
      );
      renderNoteList();
      const workspace = await screen.findByTestId("notegroup-workspace");
      expect(within(workspace).getByText("Loading…")).toBeInTheDocument();
      expect(within(screen.getByTestId("notegroup-shared")).getByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
    });

    it("useGroups error：工作坊段標下 role=alert，其餘側欄不受影響", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === "/api/notes") {
            return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE]) }));
          }
          return Promise.resolve(
            fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
          );
        }),
      );
      renderNoteList();
      const workspace = await screen.findByTestId("notegroup-workspace");
      await waitFor(() => expect(within(workspace).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      expect(within(screen.getByTestId("notegroup-myNotes")).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    });

    it("零筆記＋/api/groups pending → Loading…（不是 EmptyState、也沒有段標）", async () => {
      let notesFetched = false;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === "/api/notes") {
            notesFetched = true;
            return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
          }
          return new Promise<Response>(() => {}); // /api/groups 永不 resolve
        }),
      );
      renderNoteList();
      await waitFor(() => expect(notesFetched).toBe(true));
      // notes 已 resolve 但群組未到：仍是整張清單的 Loading…
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "My notes" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("notegroup-workspace")).not.toBeInTheDocument();
    });

    it("零筆記＋/api/groups 500 → 「我的筆記」段標＋工作坊段內 role=alert，不是 EmptyState", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === "/api/notes") {
            return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
          }
          return Promise.resolve(
            fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
          );
        }),
      );
      renderNoteList();
      const workspace = await screen.findByTestId("notegroup-workspace");
      await waitFor(() => expect(within(workspace).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      expect(screen.getByRole("button", { name: "My notes" })).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("搜尋中（forceExpanded）點段標是 no-op：收合狀態不被翻動、仍展開", async () => {
      window.localStorage.setItem("sidebar.collapsed.myNotes", "1");
      stubNotesFetch([OWNER_NOTE], []);
      renderNoteList({ query: "has" });
      const header = await screen.findByRole("button", { name: "My notes" });
      expect(header).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(header);
      expect(window.localStorage.getItem("sidebar.collapsed.myNotes")).toBe("1");
      expect(screen.getByRole("button", { name: "My notes" })).toHaveAttribute("aria-expanded", "true");
      expect(within(screen.getByTestId("notegroup-myNotes")).getByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    });

    it("工作坊段標「＋」→ 新增群組對話框；建立成功後新群組段出現且展開、焦點回「＋」", async () => {
      let groups: GroupDto[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE]) }));
          if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
          if (url === "/api/groups" && method === "POST") {
            groups = [GROUP_A];
            return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(GROUP_A) }));
          }
          if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
          throw new Error(`unexpected fetch: ${method} ${url}`);
        }),
      );
      renderNoteList();
      const plus = await screen.findByRole("button", { name: "New group" });
      plus.focus(); // fireEvent.click 不會聚焦；真人是用鍵盤或滑鼠點到它才開的
      fireEvent.click(plus);
      const dialog = await screen.findByRole("dialog", { name: "New group" });
      fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Workshop A" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).not.toBeInTheDocument());
      expect(await screen.findByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "true");
      await waitFor(() => expect(document.activeElement).toBe(plus));
    });

    it("群組段標常駐 ⋮（aria-label 含群組名），與「＋」同為段標 button 的兄弟", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList();
      const header = await screen.findByRole("button", { name: "Workshop A" });
      const menu = screen.getByRole("button", { name: "Group actions for Workshop A" });
      expect(menu.parentElement).toBe(header.parentElement);
      expect(screen.getByRole("button", { name: "New note in Workshop A" }).parentElement).toBe(header.parentElement);
      expect(menu).not.toHaveClass("opacity-0");
    });

    it("群組列前導槽：Users 平常顯示、hover／focus-within／觸控換成 chevron；button 名稱只有群組名", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList();
      const header = await screen.findByRole("button", { name: "Workshop A", expanded: true });
      expect(header).toHaveAccessibleName("Workshop A");
      expect(header).toHaveClass("h-7", "gap-1.5", "px-2", "text-[13px]", "font-medium", "text-foreground");
      expect(header).not.toHaveClass("text-muted-foreground");
      expect(header.parentElement).toHaveClass("group/grouprow", "hover:bg-accent/60");

      const users = header.querySelector('svg[data-icon="users"]');
      const chevron = header.querySelector('svg[data-icon="chevron-right"]');
      expect(users).not.toBeNull();
      expect(chevron).not.toBeNull();
      expect(users).toHaveAttribute("aria-hidden", "true");
      expect(chevron).toHaveAttribute("aria-hidden", "true");
      // 同一個槽
      expect(users?.parentElement).toBe(chevron?.parentElement);
      expect(users).not.toHaveClass("hidden");
      expect(users).toHaveClass(
        "group-hover/grouprow:hidden",
        "group-has-[:focus-visible]/grouprow:hidden",
        "[@media(hover:none)]:hidden",
      );
      expect(chevron).toHaveClass(
        "hidden",
        "group-hover/grouprow:block",
        "group-has-[:focus-visible]/grouprow:block",
        "[@media(hover:none)]:block",
        "rotate-90",
      );
      // 只有鍵盤焦點換圖示：滑鼠點完留在 button 上的焦點不該讓 chevron 卡住
      expect(users).not.toHaveClass("group-focus-within/grouprow:hidden");
      expect(chevron).not.toHaveClass("group-focus-within/grouprow:block");

      // 群組列的「＋」跟群組列走，不跟頂層段標走
      const plus = screen.getByRole("button", { name: "New note in Workshop A" });
      expect(plus).toHaveClass(
        "opacity-0",
        "group-hover/grouprow:opacity-100",
        "group-has-[:focus-visible]/grouprow:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      );
      expect(plus).not.toHaveClass("group-hover/section:opacity-100");
      expect(plus).not.toHaveClass("group-focus-within/grouprow:opacity-100");

      fireEvent.click(header);
      expect(header).toHaveAttribute("aria-expanded", "false");
      expect(chevron).not.toHaveClass("rotate-90");
      expect(window.localStorage.getItem(`sidebar.collapsed.group:${GROUP_A.id}`)).toBe("1");
    });

    it("群組筆記列掛在導引線容器內（border-l），列左內距 pl-3；群組清單縮排 pl-4", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList();
      const groupA = await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
      const row = within(groupA).getByRole("link", { name: "Mine In A" }).closest("li") as HTMLElement;
      const guide = row.closest("ul")?.parentElement as HTMLElement;
      expect(guide).toHaveClass("ml-[15px]", "border-l", "border-muted-foreground/35", "pl-2");
      expect(groupA).toContainElement(guide);
      expect(row).toHaveClass("pl-3", "pr-2");
      expect(row).not.toHaveClass("pl-6");
      expect(groupA.parentElement).toHaveClass("pl-4", "gap-1");
    });

    it("頂層段的筆記列左內距 pl-6（列文字對齊段名）", async () => {
      stubNotesFetch([OWNER_NOTE, SHARED_NOTE], []);
      renderNoteList();
      for (const [testId, name] of [
        ["notegroup-myNotes", "Has A Slug"],
        ["notegroup-shared", "No Slug Note"],
        ["notegroup-recent", "Has A Slug"],
      ] as const) {
        const section = await screen.findByTestId(testId);
        const row = within(section).getByRole("link", { name }).closest("li");
        expect(row).toHaveClass("pl-6", "pr-2");
        expect(row).not.toHaveClass("px-2");
      }
    });
  });
});
