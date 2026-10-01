import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto, type NotePermissions, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteList, partitionNotes, type NoteListProps } from "./NoteList";
import { adminRole, EDITOR_PERMS, groupDto, memberRole, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";

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
  groupId: null,
  permissions: OWNER_PERMS,
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
  groupId: null,
  permissions: EDITOR_PERMS,
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
  groupId: null,
  permissions: OWNER_PERMS,
};

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

/**
 * #175 群組筆記的 fixture 形：群組持有、沒有個人 owner（`ownerId`／`ownerHandle` null）、`role` 由群組角色推得
 * （從不是 owner）、`permissions` 由角色旗標推得。`perms` 缺省＝內建管理員角色的形。
 */
function groupNote(
  base: { id: string; title: string; slug: string; groupId: string; groupName: string },
  role: "editor" | "viewer",
  perms: NotePermissions = { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
): NoteDto {
  return {
    ...OWNER_NOTE,
    id: base.id,
    title: base.title,
    slug: base.slug,
    slugIsCustom: false,
    ownerId: null,
    ownerHandle: null,
    role,
    groupId: base.groupId,
    group: { id: base.groupId, name: base.groupName },
    permissions: perms,
  };
}

/** 群組筆記、我是 A 成員（管理員角色 → editor）→ A 段（spec §8.2 第 1 列）。 */
const MY_GROUP_NOTE: NoteDto = groupNote(
  { id: "44444444-4444-4444-4444-444444444444", title: "Mine In A", slug: "mine-in-a", groupId: GROUP_A.id, groupName: GROUP_A.name },
  "editor",
);
/** 群組筆記、我的角色只能讀 → A 段，徽章＝viewer（§8.2 第 1 列的徽章欄）。 */
const OTHERS_GROUP_NOTE: NoteDto = groupNote(
  { id: "55555555-5555-5555-5555-555555555555", title: "Theirs In A", slug: "theirs-in-a", groupId: GROUP_A.id, groupName: GROUP_A.name },
  "viewer",
  { ...VIEWER_PERMS },
);
/** 群組筆記、但那個群組不在 useGroups() 裡（剛被移出、清單未 refetch）→ 與我共享（兜底，§8.2 第 2 列）。 */
const ORPHAN_GROUP_NOTE: NoteDto = groupNote(
  { id: "66666666-6666-6666-6666-666666666666", title: "Orphan", slug: "orphan", groupId: "99999999-9999-9999-9999-999999999999", groupName: "Gone" },
  "editor",
  { ...EDITOR_PERMS },
);

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

    it("#175 §8.2 四列：我的／群組／與我共享各落各段，群組段徽章＝我在該筆記上的角色（editor／viewer）", async () => {
      stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE, OTHERS_GROUP_NOTE, SHARED_NOTE, ORPHAN_GROUP_NOTE], [GROUP_A]);
      renderNoteList();

      const groupA = await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
      expect(within(groupA).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      expect(within(groupA).getByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
      expect(within(groupA).getByText("Editor")).toBeInTheDocument(); // MY_GROUP_NOTE 的徽章（A4）
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

    it("#175：群組筆記的群組不在 useGroups（剛被移出、清單未 refetch）→ 落「與我共享」兜底，不落「我的筆記」（群組筆記的 role 從不是 owner）", async () => {
      stubNotesFetch([MY_GROUP_NOTE], []);
      renderNoteList();
      const shared = await screen.findByTestId("notegroup-shared");
      expect(within(shared).getByRole("link", { name: "Mine In A" })).toHaveAttribute(
        "href",
        `/g/${GROUP_A.id}/mine-in-a`,
      );
      expect(within(screen.getByTestId("notegroup-myNotes")).queryByRole("link", { name: "Mine In A" })).toBeNull();
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

    it("#175 §8.2：群組段「＋」只在能建立且能編輯時渲染——不能建立的角色沒有「＋」，⋮ 照舊", async () => {
      // 自訂角色「讀者」：只有 read。一般成員（內建）有 create——兩個群組並排，各看各的角色。
      const readerRole = memberRole({
        id: "r-reader",
        builtin: null,
        name: "讀者",
        permissions: { ...memberRole().permissions, create: false, edit: false },
      });
      const readOnlyGroup = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Readers" }, readerRole);
      const memberGroup = groupDto({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Writers" }, memberRole());
      const onCreateNote = vi.fn();
      stubNotesFetch([OWNER_NOTE], [readOnlyGroup, memberGroup]);
      renderNoteList({ onCreateNote });

      const writersPlus = await screen.findByRole("button", { name: "New note in Writers" });
      expect(screen.queryByRole("button", { name: "New note in Readers" })).toBeNull();
      // 群組段本身與它的 ⋮（GroupMenu）仍在——只有「＋」隱藏。
      expect(screen.getByRole("button", { name: "Readers" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Group actions for Readers" })).toBeInTheDocument();
      fireEvent.click(writersPlus);
      expect(onCreateNote).toHaveBeenLastCalledWith(memberGroup.id);
    });

    it("#175 PR3（spec 疑點 11）：能新建但不能編輯的角色沒有「＋」——建出來的是自己也改不了的空白筆記；⋮ 照舊", async () => {
      const creatorRole = memberRole({
        id: "r-creator",
        builtin: null,
        name: "Creators only",
        permissions: { ...memberRole().permissions, create: true, edit: false },
      });
      const creatorsGroup = groupDto({ id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", name: "Creators" }, creatorRole);
      const memberGroup = groupDto({ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Writers" }, memberRole());
      stubNotesFetch([OWNER_NOTE], [creatorsGroup, memberGroup]);
      renderNoteList({ onCreateNote: vi.fn() });

      expect(await screen.findByRole("button", { name: "New note in Writers" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New note in Creators" })).toBeNull();
      expect(screen.getByRole("button", { name: "Group actions for Creators" })).toBeInTheDocument();
    });

    it("#175：`myRole` 為 null 的群組（防禦；GET /api/groups 理論上不回）→ 不渲染「＋」、不丟錯", async () => {
      const orphanRoleGroup = groupDto({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "No Role" }, null);
      stubNotesFetch([OWNER_NOTE], [orphanRoleGroup]);
      renderNoteList({ onCreateNote: vi.fn() });
      expect(await screen.findByRole("button", { name: "No Role" })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "New note in No Role" })).toBeNull();
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

    // class 斷言，不是行為斷言：jsdom 沒有 CSS／hover，「真的滑過才浮出」要在瀏覽器看。
    it("群組段標 ⋮（aria-label 含群組名）與「＋」同列、一起 hover 浮出（class 斷言）", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList();
      const header = await screen.findByRole("button", { name: "Workshop A" });
      const menu = screen.getByRole("button", { name: "Group actions for Workshop A" });
      expect(menu.parentElement).toBe(header.parentElement);
      expect(screen.getByRole("button", { name: "New note in Workshop A" }).parentElement).toBe(header.parentElement);
      expect(menu).toHaveClass(
        "opacity-0",
        "group-hover/grouprow:opacity-100",
        "group-has-[:focus-visible]/grouprow:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
        "data-[state=open]:opacity-100",
      );
      // 跟群組列走，不跟頂層段標走
      expect(menu).not.toHaveClass("group-hover/section:opacity-100");
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

// ── 側欄筆記列 ⋮（SidebarNoteMenu）──
// 既有的 stubNotesFetch 對 DELETE 會 throw，而那種 throw 會被 react-query 靜默吞掉（測試不會紅），
// 所以這裡自己寫 stub 並記錄每一筆呼叫，斷言「打了哪支 API」一律看 `calls`。

function RowMenuLocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}|{JSON.stringify(location.state ?? null)}</div>;
}

function renderRowMenu(
  controls: NotePageControls | null,
  notes: NoteDto[] = [OWNER_NOTE, SHARED_NOTE],
  deleteFails = false,
  groups: GroupDto[] = [],
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      // 群組段的 ⋮（GroupMenu）用 useSession 拿自己的 id（只在傳了 groups 時會打）
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
      }
      if (url.startsWith("/api/notes/") && method === "DELETE") {
        if (deleteFails) {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 403,
              json: () => Promise.resolve({ error: { code: "forbidden", message: "x" } }),
            }),
          );
        }
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/somewhere"]}>
        <ActiveNoteProvider>
          <NotePageControlsContext.Provider value={controls}>
            <NoteList />
            <RowMenuLocationProbe />
            <Toaster />
          </NotePageControlsContext.Provider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

/** 「我的筆記」段裡 OWNER_NOTE 那列的 ⋮（「最近」段也有一顆同名的，一律 within 鎖定）。 */
async function ownerRowTrigger(): Promise<HTMLElement> {
  const section = await screen.findByTestId("notegroup-myNotes");
  return within(section).getByRole("button", { name: "Note actions for Has A Slug" });
}

async function openRowMenu(trigger: HTMLElement): Promise<HTMLElement> {
  // Radix DropdownMenu 的 trigger 只聽 pointerdown。
  fireEvent.pointerDown(trigger, { button: 0 });
  return screen.findByRole("menu");
}

describe("筆記列 ⋮", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    // 前面的摺疊測試會把 `sidebar.collapsed.*` 寫進 localStorage；亂序執行時「我的筆記」段會被收起來。
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("每列都有、名稱含標題、在徽章之後；class＝24px＋hover 浮出（class 斷言，不是行為斷言——jsdom 沒有 CSS／hover）", async () => {
    renderRowMenu(null);
    const trigger = await ownerRowTrigger();
    const row = trigger.closest("li") as HTMLElement;
    expect(row).toHaveClass("group/noterow");
    expect(trigger).toHaveClass(
      "h-6",
      "w-6",
      "opacity-0",
      "focus-visible:opacity-100",
      "[@media(hover:none)]:opacity-100",
      "data-[state=open]:opacity-100",
      "group-hover/noterow:opacity-100",
      "group-has-[:focus-visible]/noterow:opacity-100",
    );
    // owner 列沒有徽章，⋮ 是列的最後一個子元素。
    expect(row.lastElementChild).toBe(trigger);

    // 與我共享（editor）那列：順序＝標題、徽章、⋮。
    const shared = screen.getByTestId("notegroup-shared");
    const sharedTrigger = within(shared).getByRole("button", { name: "Note actions for No Slug Note" });
    const badge = within(shared).getByText("Editor");
    expect(badge.nextElementSibling).toBe(sharedTrigger);
    expect(sharedTrigger.closest("li")?.lastElementChild).toBe(sharedTrigger);

    // 單一側欄實例裡同一篇兩顆（「最近」＋「我的筆記」）。
    expect(screen.getAllByRole("button", { name: "Note actions for Has A Slug" })).toHaveLength(2);
  });

  it("開選單時 trigger 帶 data-state=open（hover 浮出的「開著不消失」靠它；CSS 生效要瀏覽器看）", async () => {
    renderRowMenu(null);
    const trigger = await ownerRowTrigger();
    expect(trigger).toHaveAttribute("data-state", "closed");
    await openRowMenu(trigger);
    expect(trigger).toHaveAttribute("data-state", "open");
  });

  it("別篇：AI 修改紀錄 → 帶 {openEdits:true} 導到那篇", async () => {
    renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent('/n/owner-one/custom-slug|{"openEdits":true}'),
    );
  });

  it("別篇：刪除 → 打 DELETE、關對話框、不導頁", async () => {
    const { calls } = renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete note?" })).toBeNull());
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    // 位置斷言之前必須有一個 `await waitFor(...)`：少了它，「刪除後多補一次 navigate("/")」
    // 的錯法會存活〔棚內實測〕。
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(2));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("別篇：刪除失敗（403）→ 錯誤 toast、關對話框、不導頁", async () => {
    const { calls } = renderRowMenu(null, [OWNER_NOTE, SHARED_NOTE], true);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Delete note?" })).toBeNull();
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    // 位置斷言之前必須有一個 `await waitFor(...)`：少了它，「刪除後多補一次 navigate("/")」
    // 的錯法會存活〔棚內實測〕。
    await waitFor(() => expect(true).toBe(true));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("別篇刪除成功會讓所有反向連結 query 失效（留在 A 頁刪 B 時，A 底部的 B 晶片不能殘留）", async () => {
    const { queryClient } = renderRowMenu(null);
    // 模擬「目前開著的 A 頁」的反向連結快取（key 形與 useBacklinks 相同）。
    queryClient.setQueryData(["backlinks", SHARED_NOTE.id], []);
    expect(queryClient.getQueryState(["backlinks", SHARED_NOTE.id])?.isInvalidated).toBe(false);

    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete note?" })).toBeNull());
    expect(queryClient.getQueryState(["backlinks", SHARED_NOTE.id])?.isInvalidated).toBe(true);
  });

  it("開著的是另一篇（controls.noteId ≠ 此列）：AI 修改紀錄導到此列那篇、不呼叫 openEdits；刪除不動 leavingRef、不導頁", async () => {
    const openEdits = vi.fn();
    const leavingRef = { current: false };
    const { calls } = renderRowMenu({
      noteId: SHARED_NOTE.id,
      state: { phase: "connected", role: "editor" },
      leavingRef,
      openEdits,
    });

    let menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent('/n/owner-one/custom-slug|{"openEdits":true}'),
    );
    expect(openEdits).not.toHaveBeenCalled();

    menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(leavingRef.current).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete note?" })).toBeNull());
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(2));
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    expect(leavingRef.current).toBe(false);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/owner-one\/custom-slug\|/);
  });

  it("開著的那篇（controls.noteId 相同）：AI 修改紀錄呼叫 controls.openEdits、不導頁；刪除先設 leavingRef 再 DELETE，成功回 /", async () => {
    const openEdits = vi.fn();
    const leavingRef = { current: false };
    const { calls } = renderRowMenu({
      noteId: OWNER_NOTE.id,
      state: { phase: "connected", role: "owner" },
      leavingRef,
      openEdits,
    });

    let menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));
    expect(openEdits).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByTestId("location")).toHaveTextContent("/somewhere|null");

    menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    // 同步：handler 的第一行就設閘門（早於 DELETE 回應）。
    expect(leavingRef.current).toBe(true);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/\|null$/));
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
  });

  // #175 §8.3（gate r1 B-N10）：側欄 ⋮ 與頁首共用 NoteMenuCore，但清單列的 `permissions` 來自
  // `GET /api/notes` 的 grouped 支欄位（規格落差 4）——另一條資料路徑，所以在清單列上各釘一次。
  it("#175：群組筆記列（role editor、permissions.delete true）的 ⋮ 有「Delete note」，按下打 DELETE", async () => {
    const deletable = groupNote(
      { id: "77777777-7777-7777-7777-777777777777", title: "Group Deletable", slug: "group-deletable", groupId: GROUP_A.id, groupName: GROUP_A.name },
      "editor",
      { ...EDITOR_PERMS, delete: true },
    );
    const { calls } = renderRowMenu(null, [deletable], false, [GROUP_A]);
    const section = await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
    const menu = await openRowMenu(within(section).getByRole("button", { name: "Note actions for Group Deletable" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete note" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain(`DELETE /api/notes/${deletable.id}`));
  });

  it("#175：同一種群組筆記列但 permissions.delete false → ⋮ 沒有「Delete note」（其餘項照舊）", async () => {
    const notDeletable = groupNote(
      { id: "88888888-8888-8888-8888-888888888888", title: "Group Kept", slug: "group-kept", groupId: GROUP_A.id, groupName: GROUP_A.name },
      "editor",
      { ...EDITOR_PERMS, delete: false },
    );
    renderRowMenu(null, [notDeletable], false, [GROUP_A]);
    const section = await screen.findByTestId(`notegroup-group-${GROUP_A.id}`);
    const menu = await openRowMenu(within(section).getByRole("button", { name: "Note actions for Group Kept" }));
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete note" })).toBeNull();
  });
});

// ── partitionNotes（#175 spec §8.2 四列）──純函式，每列一案。
describe("partitionNotes（#175 §8.2）", () => {
  it("第 1 列：群組筆記且群組在 groups → 該群組段（不進我的筆記／與我共享）", () => {
    const parts = partitionNotes([MY_GROUP_NOTE], [GROUP_A]);
    expect(parts.byGroup.get(GROUP_A.id)?.map((n) => n.id)).toEqual([MY_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.shared).toEqual([]);
  });

  it("第 2 列：群組筆記但群組不在 groups → 與我共享（兜底）", () => {
    const parts = partitionNotes([ORPHAN_GROUP_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([ORPHAN_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.byGroup.get(GROUP_A.id)).toEqual([]);
  });

  it("第 3 列：role === owner（個人筆記）→ 我的筆記", () => {
    const parts = partitionNotes([OWNER_NOTE], [GROUP_A]);
    expect(parts.myNotes.map((n) => n.id)).toEqual([OWNER_NOTE.id]);
    expect(parts.shared).toEqual([]);
  });

  it("第 4 列：其餘（逐人分享給我的個人筆記）→ 與我共享", () => {
    const parts = partitionNotes([SHARED_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([SHARED_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
  });
});
