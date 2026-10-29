import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { canonicalNotePath, type FolderDto, type GroupDto, type NoteDto, type NotePermissions, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { GROUPS_QUERY_KEY } from "@/api/groups";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { SidebarTabList } from "@/components/sidebar/SidebarTabList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteList, type NoteListProps } from "./NoteList";
import { adminRole, customRole, EDITOR_PERMS, groupDto, memberRole, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests, setFolderSort } from "@/components/sidebar/folder-sort";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote as selGroupNote, personalNote, sharedNote } from "@/test/select-fixtures";

// `sidebar.tab`／`sidebar.collapsed.*`（含 collapse store 的記憶體覆蓋層）會往外流到同檔後面的案（亂序跑時尤其），檔案頂層清（plan I3）。
afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

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

interface RenderOpts {
  /** render 前寫進 `sidebar.tab`（缺省＝不寫，走預設「我的筆記」）。 */
  tab?: SidebarTab;
  queryClient?: QueryClient;
  activeId?: string;
}

/** 真實版面裡 tablist 與 tabpanel 外框由 AppShell 給；這裡由 helper 補（面板握把才成立）。 */
function renderNoteList(props: Partial<NoteListProps> = {}, opts: RenderOpts = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            {opts.activeId !== undefined && <SetActive id={opts.activeId} />}
            <SidebarTabList idBase="t" />
            <div role="tabpanel">
              <NoteList {...props} />
            </div>
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

const panel = () => screen.getByRole("tabpanel");
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const noteRow = (id: string) => panel().querySelector(`[data-node-kind="note"][data-node-id="${id}"]`) as HTMLElement | null;
const groupNode = (id: string) => panel().querySelector(`[data-node-kind="group"][data-node-id="${id}"]`) as HTMLElement | null;
const selectTab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
/** 最近 tab 的連結名稱含位置行，找標題一律用 `^標題`。 */
const startsWith = (title: string) => new RegExp("^" + title);

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
  folderId: null,
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
  folderId: null,
  permissions: EDITOR_PERMS,
};

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
  folderId: null,
  permissions: OWNER_PERMS,
};

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
const GROUP_B: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Workshop B" }, adminRole());

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

/** 群組筆記、我是 A 成員（管理員角色 → editor）→ A 群組（spec §8.2 第 1 列）。 */
const MY_GROUP_NOTE: NoteDto = groupNote(
  { id: "44444444-4444-4444-4444-444444444444", title: "Mine In A", slug: "mine-in-a", groupId: GROUP_A.id, groupName: GROUP_A.name },
  "editor",
);
/** 群組筆記、我的角色只能讀 → A 群組，不標角色（§8.2 第 1 列）。 */
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

const ME: UserDto = { id: "u1", email: "me@example.com", handle: "owner-one", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };

function stubNotesFetch(notes: NoteDto[], groups: GroupDto[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      // 群組列的 ⋮（GroupMenu）用 useSession 拿自己的 id（退出群組）
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** `/api/notes` 正常、`/api/groups` 永不 resolve（pending）。 */
function stubGroupsPending(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (String(input) === "/api/notes") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      return new Promise<Response>(() => {});
    }),
  );
}

/** `/api/notes` 正常、`/api/groups` 500。 */
function stubGroupsError(notes: NoteDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (String(input) === "/api/notes") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      return Promise.resolve(
        fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
      );
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

    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
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
      expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."),
    );
  });

  it("links each note to its canonicalNotePath — /n/<ownerHandle>/<slug> 單一形（#122）", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();

    const mine = await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(mine).toHaveAttribute("href", canonicalNotePath(OWNER_NOTE));
    expect(canonicalNotePath(OWNER_NOTE)).toBe("/n/owner-one/custom-slug");

    selectTab("Shared with me");
    expect(within(panel()).getByRole("link", { name: "No Slug Note" })).toHaveAttribute(
      "href",
      canonicalNotePath(SHARED_NOTE),
    );
    expect(canonicalNotePath(SHARED_NOTE)).toBe("/n/owner-nine/no-slug-note"); // 新形字面（原 not.toBe 在 slug 恆字串後恆真）

    // #115：列高 `<md` 44px（觸控目標）、`md+` 回 28px——h-11 md:h-7 缺一即壞
    // （缺 md:h-7 寬螢幕列變胖；缺 h-11 窄視窗點不準）。
    selectTab("My notes");
    const touchRow = within(panel()).getByRole("link", { name: "Has A Slug" });
    expect(touchRow.closest("li")).toHaveClass("h-11", "md:h-7");
    // 觸控目標是 <Link> 不是 <li>：li 撐 44 高但 items-center 下錨點只有內容高
    // （~20px），上下各 12px 是死區——Link 要 self-stretch 吃滿列高才是真的 44px
    // 目標（審查抓到的「宣稱到不了的行為」形）。
    expect(touchRow).toHaveClass("self-stretch", "flex", "items-center");
  });

  it("shows a role badge only for shared (non-owner) notes; no delete button anywhere (moved to the ⋮ menu)", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    // 我的筆記 tab：owner 列沒有徽章。
    expect(screen.queryByText("Owner")).not.toBeInTheDocument();
    expect(screen.queryByText("Editor")).not.toBeInTheDocument();

    selectTab("Shared with me");
    expect(within(panel()).getByText("Editor")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).not.toBeInTheDocument();
  });

  // ── #122：active 高亮改吃 ActiveNoteContext（note.id 單一真相，URL 判斷退役） ──

  it("開頁亮：context 有 active id（NotePage 解析後 set）→ 該列 aria-current=page、恰一個", async () => {
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList({}, { activeId: OWNER_NOTE.id });

    const current = await within(panel()).findByRole("link", { current: "page" });
    expect(current).toHaveAccessibleName("Has A Slug");
    expect(screen.getAllByRole("link", { current: "page" })).toHaveLength(1);
    expect(within(panel()).getByRole("link", { name: "Third Owner Note" })).not.toHaveAttribute("aria-current");
  });

  // PR3：active 列跟主題色，且 hover 態要一起換成 brand（B3——twMerge 讓後出的
  // hover:bg-brand-soft-strong 蓋掉 hover:bg-brand-soft，同一個 variant 群組互斥）。
  // 握把：class 掛在 <li>，不是 <a>，因此用 getByRole("link").closest("li") 取。
  it("active 列套用主題色 tint（bg-brand-soft/text-brand-on-soft/hover:bg-brand-soft-strong）", async () => {
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList({}, { activeId: OWNER_NOTE.id });

    const activeLink = await within(panel()).findByRole("link", { current: "page" });
    const activeRow = activeLink.closest("li");
    expect(activeRow).toHaveClass("bg-brand-soft", "text-brand-on-soft", "font-medium", "hover:bg-brand-soft-strong");
    // twMerge 真的把基底的 `hover:bg-brand-soft` 換成 `hover:bg-brand-soft-strong`，
    // 不是兩者並存靠優先權僥倖對。
    expect(activeRow).not.toHaveClass("hover:bg-brand-soft");

    const inactiveRow = within(panel()).getByRole("link", { name: "Third Owner Note" }).closest("li");
    expect(inactiveRow).not.toHaveClass("bg-brand-soft");
    expect(inactiveRow).toHaveClass("hover:bg-brand-soft", "hover:text-brand-on-soft", "active:bg-brand-soft-strong");
    expect(inactiveRow).not.toHaveClass("hover:bg-accent/60");
  });

  it("點擊即亮：樂觀 set，不等任何解析", async () => {
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);

    renderNoteList();
    const link = await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);

    fireEvent.click(link);
    expect(within(panel()).getByRole("link", { name: "Has A Slug" })).toHaveAttribute("aria-current", "page");
  });

  it("換頁換：點另一篇 → 高亮移轉、不殘留", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();
    fireEvent.click(await within(panel()).findByRole("link", { name: "Has A Slug" }));
    selectTab("Shared with me");
    fireEvent.click(within(panel()).getByRole("link", { name: "No Slug Note" }));
    expect(within(panel()).getByRole("link", { name: "No Slug Note" })).toHaveAttribute("aria-current", "page");
    selectTab("My notes");
    expect(within(panel()).getByRole("link", { name: "Has A Slug" })).not.toHaveAttribute("aria-current");
  });

  it("修飾鍵點擊（cmd/ctrl/shift＋左鍵＝開新分頁）**不**樂觀 set", async () => {
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);

    renderNoteList();
    const link = await within(panel()).findByRole("link", { name: "Has A Slug" });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { shiftKey: true });
    expect(screen.queryAllByRole("link", { current: "page" })).toHaveLength(0);
  });

  it("active 以 id 為錨：**同一棵樹**上 title/slug 全變（模擬改標題後清單更新）→ 高亮不掉、恰一個", async () => {
    // 「跨 pattern 換頁」案延 Task 5b（plan gate m17——/n/ route 屆時才存在）。
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
    const { queryClient } = renderNoteList({}, { activeId: OWNER_NOTE.id });
    await within(panel()).findByRole("link", { current: "page" });

    // 同一個 QueryClient 就地換資料（不卸載）：id 相同、title 與 slug 都變——
    // 任何以 title/slug/URL 當判準的實作在這裡會掉高亮，id 錨定不會。
    const renamed = { ...OWNER_NOTE, title: "Renamed Entirely", slug: "renamed-entirely" };
    queryClient.setQueryData<NoteDto[]>(["notes"], [renamed, SHARED_NOTE]);

    const current = await within(panel()).findAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Renamed Entirely");
  });

  // ── tab 標題列（spec §5.1-4／§5.2） ──

  describe("NL1 標題列", () => {
    // PR-2c 起四個一般 tab 的標題列都多一顆「Select」（選取模式本身見 sidebar/SelectPanel.test.tsx）。
    it("我的筆記：標題＋「Select」＋常駐的「New personal note」鈕（不浮出）", async () => {
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList();
      await within(panel()).findByRole("link", { name: "Has A Slug" });
      expect(within(header()).getByText("My notes")).toHaveClass("truncate"); // ellipsis 要掛在文字元素上
      const plus = within(header()).getByRole("button", { name: "New personal note" });
      expect(plus).not.toHaveClass("opacity-0");
      expect(within(header()).getAllByRole("button")).toHaveLength(3);
      expect(within(header()).getAllByRole("button")[0]).toHaveAccessibleName("Select");
    });

    it("工作坊：標題＋「Select」＋「New group」鈕（常駐）", async () => {
      stubNotesFetch([OWNER_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      expect(within(header()).getByText("Workspace")).toBeInTheDocument();
      const plus = within(header()).getByRole("button", { name: "New group" });
      expect(plus).not.toHaveClass("opacity-0");
      expect(within(header()).getAllByRole("button")).toHaveLength(2);
      expect(within(header()).getAllByRole("button")[0]).toHaveAccessibleName("Select");
    });

    it("最近、與我共享：標題列只有「Select」", async () => {
      stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
      renderNoteList({}, { tab: "recent" });
      await within(panel()).findByRole("link", { name: startsWith("Has A Slug") });
      expect(within(header()).getByText("Recent")).toBeInTheDocument();
      expect(within(header()).queryAllByRole("button")).toHaveLength(1);
      expect(within(header()).getByRole("button")).toHaveAccessibleName("Select");

      selectTab("Shared with me");
      await within(panel()).findByRole("link", { name: "No Slug Note" });
      expect(within(header()).getByText("Shared with me")).toBeInTheDocument();
      expect(within(header()).queryAllByRole("button")).toHaveLength(1);
      expect(within(header()).getByRole("button")).toHaveAccessibleName("Select");
    });

    it("標題列「＋」：個人筆記 → onCreateNote(undefined)；disabled 跟 createNotePending", async () => {
      const onCreateNote = vi.fn();
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList({ onCreateNote });
      const plus = await within(header()).findByRole("button", { name: "New personal note" });
      expect(plus).toBeEnabled();
      expect(plus).toHaveAttribute("title", "New personal note");
      fireEvent.click(plus);
      expect(onCreateNote).toHaveBeenCalledTimes(1);
      expect(onCreateNote.mock.calls[0]).toEqual([undefined]);
    });

    it("createNotePending → 標題列「＋」disabled", async () => {
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList({ createNotePending: true });
      expect(await within(header()).findByRole("button", { name: "New personal note" })).toBeDisabled();
    });
  });

  // ── 我的筆記／與我共享／工作坊 ──

  it("NL2 我的筆記：只列個人筆記、順序同 server、每列 pl-2、每列有 ⋮；不含群組與共享筆記", async () => {
    stubNotesFetch([THIRD_OWNER_NOTE, MY_GROUP_NOTE, SHARED_NOTE, OWNER_NOTE], [GROUP_A]);

    renderNoteList();

    await within(panel()).findByRole("link", { name: "Has A Slug" });
    const titles = Array.from(panel().querySelectorAll('[data-node-kind="note"] a')).map((a) => a.textContent);
    expect(titles).toEqual(["Third Owner Note", "Has A Slug"]); // server 順序，不依標題排
    for (const note of [THIRD_OWNER_NOTE, OWNER_NOTE]) {
      const row = noteRow(note.id)!;
      expect(row).toHaveClass("pl-2", "pr-2");
      expect(row).not.toHaveClass("pl-6");
      expect(within(row).getByRole("button", { name: `Note actions for ${note.title}` })).toBeInTheDocument();
    }
    expect(within(panel()).queryByRole("link", { name: "Mine In A" })).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "No Slug Note" })).toBeNull();
  });

  it("NL3 與我共享：逐人分享（帶 Editor／Viewer 小字）＋孤兒群組筆記；不含個人筆記", async () => {
    const viewerShared: NoteDto = { ...SHARED_NOTE, id: "77777777-7777-7777-7777-777777777777", title: "Read Only Share", role: "viewer", permissions: VIEWER_PERMS };
    stubNotesFetch([OWNER_NOTE, SHARED_NOTE, viewerShared, ORPHAN_GROUP_NOTE, MY_GROUP_NOTE], [GROUP_A]);

    renderNoteList({}, { tab: "shared" });

    const orphan = await within(panel()).findByRole("link", { name: "Orphan" });
    expect(orphan).toHaveAttribute("href", `/g/${ORPHAN_GROUP_NOTE.group!.id}/orphan`);
    expect(within(noteRow(SHARED_NOTE.id)!).getByText("Editor")).toBeInTheDocument();
    expect(within(noteRow(viewerShared.id)!).getByText("Viewer")).toBeInTheDocument();
    // 孤兒群組筆記不標角色（#182）。
    expect(within(noteRow(ORPHAN_GROUP_NOTE.id)!).queryByText("Editor")).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "Has A Slug" })).toBeNull();
    expect(within(panel()).queryByRole("link", { name: "Mine In A" })).toBeNull();
  });

  describe("NL4 工作坊", () => {
    it("群組節點依 groups 順序；群組列不標角色；#175 §8.2：我的角色在群組內的筆記落群組", async () => {
      stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE, OTHERS_GROUP_NOTE, SHARED_NOTE, ORPHAN_GROUP_NOTE], [GROUP_B, GROUP_A]);
      renderNoteList({}, { tab: "workspace" });

      const groupA = await waitFor(() => {
        const node = groupNode(GROUP_A.id);
        expect(node).not.toBeNull();
        return node!;
      });
      const order = Array.from(panel().querySelectorAll('[data-node-kind="group"]')).map((el) => el.getAttribute("data-node-id"));
      expect(order).toEqual([GROUP_B.id, GROUP_A.id]);

      expect(within(groupA).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      expect(within(groupA).getByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
      // #182：群組列不標角色——角色看筆記頁頂端的徽章。
      expect(within(groupA).queryByText("Editor")).not.toBeInTheDocument();
      expect(within(groupA).queryByText("Viewer")).not.toBeInTheDocument();
      // 個人、共享、孤兒都不在工作坊 tab。
      expect(within(panel()).queryByRole("link", { name: "Has A Slug" })).toBeNull();
      expect(within(panel()).queryByRole("link", { name: "No Slug Note" })).toBeNull();
      expect(within(panel()).queryByRole("link", { name: "Orphan" })).toBeNull();
    });

    it("折疊：點群組 → aria-expanded=false、列消失、localStorage 寫 sidebar.collapsed.group:<id>=1；重掛後仍收合", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      const first = renderNoteList({}, { tab: "workspace" });
      const button = await within(panel()).findByRole("button", { name: "Workshop A", expanded: true });
      expect(within(panel()).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
      fireEvent.click(button);
      expect(within(panel()).getByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "false");
      expect(within(panel()).queryByRole("link", { name: "Mine In A" })).not.toBeInTheDocument();
      expect(window.localStorage.getItem(`sidebar.collapsed.group:${GROUP_A.id}`)).toBe("1");

      first.view.unmount();
      renderNoteList({}, { tab: "workspace" });
      expect(await within(panel()).findByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(within(panel()).getByRole("button", { name: "Workshop A" }));
      expect(window.localStorage.getItem(`sidebar.collapsed.group:${GROUP_A.id}`)).toBeNull();
      expect(within(panel()).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
    });

    it("RF4：localStorage 拋錯（隱私模式）→ 側欄照常、預設展開、本次 session 仍能折疊", async () => {
      const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("SecurityError");
      });
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      try {
        stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
        renderNoteList();
        selectTab("Workspace"); // 寫不進 storage，state 照換
        const button = await within(panel()).findByRole("button", { name: "Workshop A", expanded: true });
        fireEvent.click(button);
        expect(within(panel()).getByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "false");
        expect(within(panel()).queryByRole("link", { name: "Mine In A" })).not.toBeInTheDocument();
      } finally {
        getItem.mockRestore();
        setItem.mockRestore();
      }
    });

    it("折疊鍵名是 sidebar.collapsed.group:<id>（不是別的形）", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      fireEvent.click(await within(panel()).findByRole("button", { name: "Workshop A" }));
      expect(Object.keys(window.localStorage).filter((k) => k.startsWith("sidebar.collapsed."))).toEqual([
        `sidebar.collapsed.group:${GROUP_A.id}`,
      ]);
    });

    it("群組筆記列掛在導引線容器內（border-l），列左內距 pl-3；群組節點的父層不帶 pl-4", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      const row = (await waitFor(() => {
        const r = noteRow(MY_GROUP_NOTE.id);
        expect(r).not.toBeNull();
        return r!;
      })) as HTMLElement;
      const guide = row.closest("ul")?.parentElement as HTMLElement;
      expect(guide).toHaveClass("ml-[15px]", "border-l", "border-muted-foreground/35", "pl-2");
      const group = groupNode(GROUP_A.id)!;
      expect(group).toContainElement(guide);
      expect(row).toHaveClass("pl-3", "pr-2");
      expect(row).not.toHaveClass("pl-6");
      // 群組節點直接掛在清單的 ul 底下，沒有 pl-4 外包（讀碼發現 10）。
      expect(group.parentElement?.tagName).toBe("UL");
      expect(group.parentElement).not.toHaveClass("pl-4");
      expect(group.parentElement?.parentElement).toBe(list().firstElementChild);
    });

    it("#247 §4.10：群組列 hover 是品牌 tint，不是中性灰", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      const row = groupNode(GROUP_A.id)!.firstElementChild as HTMLElement; // `group/grouprow` 那一列
      expect(row).toHaveClass("group/grouprow", "hover:bg-brand-soft", "active:bg-brand-soft-strong");
      expect(row).not.toHaveClass("hover:bg-accent/60");
      // 文字色掛在子元素上（button 自帶 text-foreground、圖示槽自帶 text-muted-foreground，不繼承外層）。
      const button = within(row).getByRole("button", { name: GROUP_A.name });
      expect(button).toHaveClass("group-hover/grouprow:text-brand-on-soft");
      expect(button.firstElementChild).toHaveClass("group-hover/grouprow:text-brand-on-soft");
    });

    it("群組列前導槽：Users 平常顯示、hover／focus-visible／觸控換成 chevron；button 名稱只有群組名", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      const button = await within(panel()).findByRole("button", { name: "Workshop A", expanded: true });
      expect(button).toHaveAccessibleName("Workshop A");
      expect(button).toHaveClass("h-7", "gap-1.5", "px-2", "text-[13px]", "font-medium", "text-foreground");
      expect(button).not.toHaveClass("text-muted-foreground");
      expect(button.parentElement).toHaveClass("group/grouprow", "hover:bg-brand-soft");

      const users = button.querySelector('svg[data-icon="users"]');
      const chevron = button.querySelector('svg[data-icon="chevron-right"]');
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

      // 群組列的「＋」仍浮出，跟群組列走
      const plus = within(panel()).getByRole("button", { name: "New note in Workshop A" });
      expect(plus).toHaveClass(
        "opacity-0",
        "group-hover/grouprow:opacity-100",
        "group-has-[:focus-visible]/grouprow:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
      );
      expect(plus).not.toHaveClass("group-focus-within/grouprow:opacity-100");

      fireEvent.click(button);
      expect(button).toHaveAttribute("aria-expanded", "false");
      expect(chevron).not.toHaveClass("rotate-90");
    });

    // class 斷言，不是行為斷言：jsdom 沒有 CSS／hover，「真的滑過才浮出」要在瀏覽器看。
    it("群組列 ⋮（aria-label 含群組名）與「＋」同列、一起 hover 浮出（class 斷言）", async () => {
      stubNotesFetch([MY_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace" });
      const button = await within(panel()).findByRole("button", { name: "Workshop A" });
      const menu = within(panel()).getByRole("button", { name: "Group actions for Workshop A" });
      expect(menu.parentElement).toBe(button.parentElement);
      expect(within(panel()).getByRole("button", { name: "New note in Workshop A" }).parentElement).toBe(button.parentElement);
      expect(menu).toHaveClass(
        "opacity-0",
        "group-hover/grouprow:opacity-100",
        "group-has-[:focus-visible]/grouprow:opacity-100",
        "focus-visible:opacity-100",
        "[@media(hover:none)]:opacity-100",
        "data-[state=open]:opacity-100",
      );
    });

    it("群組列「＋」→ onCreateNote(群組 id)；群組取名「My notes」時與標題列的「＋」可及名稱不同（#103 PR3）", async () => {
      const onCreateNote = vi.fn();
      const lookalike: GroupDto = { ...GROUP_A, name: "My notes" };
      stubNotesFetch([OWNER_NOTE], [lookalike]);
      renderNoteList({ onCreateNote }, { tab: "workspace" });
      const groupPlus = await within(panel()).findByRole("button", { name: "New note in My notes" });
      fireEvent.click(groupPlus);
      expect(onCreateNote).toHaveBeenLastCalledWith(lookalike.id);
      // 標題列在工作坊 tab 只有「New group」
      expect(within(header()).queryByRole("button", { name: "New personal note" })).toBeNull();
    });

    it("#175 §8.2：群組列「＋」只在能建立且能編輯時渲染——不能建立的角色沒有「＋」，⋮ 照舊", async () => {
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
      renderNoteList({ onCreateNote }, { tab: "workspace" });

      const writersPlus = await within(panel()).findByRole("button", { name: "New note in Writers" });
      expect(within(panel()).queryByRole("button", { name: "New note in Readers" })).toBeNull();
      // 群組列本身與它的 ⋮（GroupMenu）仍在——只有「＋」隱藏。
      expect(within(panel()).getByRole("button", { name: "Readers" })).toBeInTheDocument();
      expect(within(panel()).getByRole("button", { name: "Group actions for Readers" })).toBeInTheDocument();
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
      renderNoteList({ onCreateNote: vi.fn() }, { tab: "workspace" });

      expect(await within(panel()).findByRole("button", { name: "New note in Writers" })).toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: "New note in Creators" })).toBeNull();
      expect(within(panel()).getByRole("button", { name: "Group actions for Creators" })).toBeInTheDocument();
    });

    it("#175：`myRole` 為 null 的群組（防禦；GET /api/groups 理論上不回）→ 不渲染「＋」、不丟錯", async () => {
      const orphanRoleGroup = groupDto({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "No Role" }, null);
      stubNotesFetch([OWNER_NOTE], [orphanRoleGroup]);
      renderNoteList({ onCreateNote: vi.fn() }, { tab: "workspace" });
      expect(await within(panel()).findByRole("button", { name: "No Role" })).toBeInTheDocument();
      expect(within(panel()).queryByRole("button", { name: "New note in No Role" })).toBeNull();
    });

    it("useGroups pending：notes 已到、groups 未到 → 工作坊面板顯示 Loading…（不閃空狀態句）；群組筆記暫依兜底列落與我共享", async () => {
      stubGroupsPending([OTHERS_GROUP_NOTE]);
      renderNoteList({}, { tab: "shared" });
      // 先等到兜底列：證明 notes 已到而 groups 仍 pending，才是要測的那個狀態。
      expect(await within(panel()).findByRole("link", { name: "Theirs In A" })).toBeInTheDocument();
      selectTab("Workspace");
      expect(within(list()).getByText("Loading…")).toBeInTheDocument();
      expect(within(list()).queryByText("You're not in any group yet.")).toBeNull();
    });

    it("群組背景 refetch 失敗：快取的群組與 role=alert 並列，群組不被藏掉", async () => {
      let groupsCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([MY_GROUP_NOTE]) }));
          if (url === "/api/groups" && method === "GET") {
            groupsCalls += 1;
            return groupsCalls === 1
              ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_A]) }))
              : Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }));
          }
          if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) }));
          throw new Error(`unexpected fetch: ${method} ${url}`);
        }),
      );
      const { queryClient } = renderNoteList({}, { tab: "workspace" });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      await queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      expect(within(list()).getByRole("button", { name: "Workshop A" })).toBeInTheDocument();
      expect(within(list()).getByRole("link", { name: "Mine In A" })).toBeInTheDocument();
    });

    it("useGroups 500：面板內 role=alert；我的筆記 tab 不受影響", async () => {
      stubGroupsError([OWNER_NOTE]);
      renderNoteList({}, { tab: "workspace" });
      await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      selectTab("My notes");
      expect(await within(panel()).findByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
      // groups 的錯誤句只屬於工作坊 tab，不跟到我的筆記。
      expect(within(list()).queryByRole("alert")).toBeNull();
    });

    it("群組背景 refetch 失敗（原本 0 個群組）：alert 與「You're not in any group yet.」並存", async () => {
      let groupsCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OWNER_NOTE]) }));
          if (url === "/api/groups" && method === "GET") {
            groupsCalls += 1;
            return groupsCalls === 1
              ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }))
              : Promise.resolve(fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }));
          }
          throw new Error(`unexpected fetch: ${method} ${url}`);
        }),
      );
      const { queryClient } = renderNoteList({}, { tab: "workspace" });
      await within(list()).findByText("You're not in any group yet.");
      await queryClient.invalidateQueries({ queryKey: GROUPS_QUERY_KEY });
      await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
      expect(within(list()).getByText("You're not in any group yet.")).toBeInTheDocument();
    });

    it("0 個群組 → 只有說明文字；整份 DOM 名稱為「New group」的按鈕恰一顆、在標題列內", async () => {
      stubNotesFetch([OWNER_NOTE], []);
      renderNoteList({}, { tab: "workspace" });
      expect(await within(list()).findByText("You're not in any group yet.")).toBeInTheDocument();
      const buttons = screen.getAllByRole("button", { name: "New group" });
      expect(buttons).toHaveLength(1);
      expect(buttons[0]!.closest("[data-sidebar-header]")).not.toBeNull();
    });

    it("標題列「＋」→ 新增群組對話框；建立成功後新群組列出現且展開、焦點回標題列「＋」", async () => {
      let groups: GroupDto[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = (init?.method ?? "GET").toUpperCase();
          if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
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
      renderNoteList({}, { tab: "workspace" });
      await within(list()).findByText("You're not in any group yet.");
      const plus = within(header()).getByRole("button", { name: "New group" });
      plus.focus(); // fireEvent.click 不會聚焦；真人是用鍵盤或滑鼠點到它才開的
      fireEvent.click(plus);
      const dialog = await screen.findByRole("dialog", { name: "New group" });
      fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Workshop A" } });
      fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "New group" })).not.toBeInTheDocument());
      expect(await within(panel()).findByRole("button", { name: "Workshop A" })).toHaveAttribute("aria-expanded", "true");
      await waitFor(() => expect(document.activeElement).toBe(plus));
    });
  });

  describe("NL5 最近", () => {
    /** 25 篇：`updatedAt` 依序遞增（Note 0 最舊）；Note 3 的 `lastEdited.at` 最新，要排最前。 */
    function manyNotes(): NoteDto[] {
      return Array.from({ length: 25 }, (_, i) => ({
        ...OWNER_NOTE,
        id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`,
        title: `Note ${i}`,
        slug: `note-${i}`,
        updatedAt: new Date(Date.UTC(2026, 2, 1 + i)).toISOString(),
        lastEdited: i === 3 ? { at: "2026-06-01T00:00:00.000Z", byHandle: "x", agentLabel: null } : null,
      }));
    }

    it("25 篇 → 20 列；順序照最後編輯時間（lastEdited.at 與 updatedAt 交錯）", async () => {
      stubNotesFetch(manyNotes());
      renderNoteList({}, { tab: "recent" });
      await within(panel()).findByRole("link", { name: startsWith("Note 24") });
      const rows = panel().querySelectorAll('[data-node-kind="note"]');
      expect(rows).toHaveLength(20);
      const titles = Array.from(rows).map((r) => r.querySelector("a div")?.textContent);
      expect(titles).toEqual(["Note 3", ...Array.from({ length: 19 }, (_, i) => `Note ${24 - i}`)]);
    });

    it("第二行依序是 My notes／Workspace › 群組名／Shared with me · 角色；群組列可及名稱＝標題＋位置；沒有 RoleBadge；每列有 ⋮", async () => {
      const mine = { ...OWNER_NOTE, updatedAt: "2026-03-03T00:00:00.000Z" };
      const group = { ...MY_GROUP_NOTE, updatedAt: "2026-03-02T00:00:00.000Z" };
      const shared = { ...SHARED_NOTE, updatedAt: "2026-03-01T00:00:00.000Z" };
      stubNotesFetch([shared, group, mine], [GROUP_A]);
      renderNoteList({}, { tab: "recent" });

      const groupLink = await within(panel()).findByRole("link", { name: startsWith("Mine In A") });
      await waitFor(() => expect(groupLink).toHaveAccessibleName("Mine In A Workspace › Workshop A"));
      const lines = Array.from(panel().querySelectorAll('[data-node-kind="note"]')).map((row) => ({
        title: row.querySelector("a div:nth-child(1)")?.textContent,
        place: row.querySelector("a div:nth-child(2)")?.textContent,
      }));
      expect(lines).toEqual([
        { title: "Has A Slug", place: "My notes" },
        { title: "Mine In A", place: "Workspace › Workshop A" },
        { title: "No Slug Note", place: "Shared with me · Editor" },
      ]);
      // 角色在位置行；沒有獨立的 RoleBadge 小字。
      expect(within(panel()).queryByText("Editor")).toBeNull();
      expect(within(panel()).queryByText("Viewer")).toBeNull();
      for (const title of ["Has A Slug", "Mine In A", "No Slug Note"]) {
        expect(within(panel()).getByRole("button", { name: `Note actions for ${title}` })).toBeInTheDocument();
      }
    });

    it("長標題：標題與位置元素 truncate、連結 min-w-0（兩行都在 Link 內，⋮ 在 Link 外）", async () => {
      stubNotesFetch([OWNER_NOTE]);
      renderNoteList({}, { tab: "recent" });
      const link = await within(panel()).findByRole("link", { name: startsWith("Has A Slug") });
      expect(link).toHaveClass("min-w-0", "py-1.5"); // 內距在 Link 上，觸控目標吃滿列高
      expect(link.parentElement).not.toHaveClass("py-1");
      expect(link.children).toHaveLength(2);
      expect(link.children[1]).toHaveClass("mt-0.5");
      for (const line of Array.from(link.children)) expect(line).toHaveClass("truncate");
      const menu = within(noteRow(OWNER_NOTE.id)!).getByRole("button", { name: "Note actions for Has A Slug" });
      expect(link.contains(menu)).toBe(false);
    });

    it("#182：群組筆記在最近 tab 也不標角色（位置行只有 Workspace › 群組）", async () => {
      stubNotesFetch([MY_GROUP_NOTE, OTHERS_GROUP_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "recent" });
      await within(panel()).findByRole("link", { name: startsWith("Mine In A") });
      expect(within(panel()).queryByText("Editor")).toBeNull();
      expect(within(panel()).queryByText("Viewer")).toBeNull();
    });
  });

  describe("NL6 空狀態", () => {
    it("最近 0 篇 → No notes yet.＋說明", async () => {
      stubNotesFetch([], []);
      renderNoteList({}, { tab: "recent" });
      expect(await within(list()).findByText("No notes yet.")).toBeInTheDocument();
      expect(within(list()).getByText("Create your first note to get started.")).toBeInTheDocument();
    });

    it("我的筆記：0 筆記 0 群組 → EmptyState 兩句", async () => {
      stubNotesFetch([], []);
      renderNoteList();
      expect(await within(list()).findByText("No notes yet.")).toBeInTheDocument();
      expect(within(list()).getByText("Create your first note to get started.")).toBeInTheDocument();
    });

    it("我的筆記：0 筆記但有群組 → No personal notes yet.（不是 EmptyState）", async () => {
      stubNotesFetch([], [GROUP_A]);
      renderNoteList();
      expect(await within(list()).findByText("No personal notes yet.")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("我的筆記：只有他人筆記（沒有個人筆記）→ No personal notes yet.", async () => {
      stubNotesFetch([SHARED_NOTE], []);
      renderNoteList();
      expect(await within(list()).findByText("No personal notes yet.")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("我的筆記：0 筆記且 /api/groups pending → Loading…（不是 EmptyState）", async () => {
      let notesFetched = false;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          if (String(input) === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
          if (String(input) === "/api/notes") {
            notesFetched = true;
            return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
          }
          return new Promise<Response>(() => {}); // /api/groups 永不 resolve
        }),
      );
      renderNoteList();
      await waitFor(() => expect(notesFetched).toBe(true));
      // notes 已 resolve 但群組未到：仍是 Loading…
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(within(list()).getByText("Loading…")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
      expect(screen.queryByText("No personal notes yet.")).not.toBeInTheDocument();
    });

    it("我的筆記：0 筆記且 /api/groups 500 → No personal notes yet.，不是 EmptyState", async () => {
      stubGroupsError([]);
      renderNoteList();
      expect(await within(list()).findByText("No personal notes yet.")).toBeInTheDocument();
      expect(screen.queryByText("No notes yet.")).not.toBeInTheDocument();
    });

    it("與我共享 0 篇 → Nothing has been shared with you yet.", async () => {
      stubNotesFetch([OWNER_NOTE], []);
      renderNoteList({}, { tab: "shared" });
      expect(await within(list()).findByText("Nothing has been shared with you yet.")).toBeInTheDocument();
    });
  });

  it("NL7 節點屬性：筆記列 data-node-kind／data-node-id、群組節點 data-node-kind／data-node-id", async () => {
    stubNotesFetch([OWNER_NOTE, MY_GROUP_NOTE], [GROUP_A]);
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    expect(noteRow(OWNER_NOTE.id)).not.toBeNull();
    expect(noteRow(OWNER_NOTE.id)).toHaveAttribute("data-node-kind", "note");

    selectTab("Workspace");
    await within(panel()).findByRole("button", { name: "Workshop A" });
    expect(groupNode(GROUP_A.id)).toHaveAttribute("data-node-kind", "group");
    expect(groupNode(GROUP_A.id)).toHaveAttribute("data-node-id", GROUP_A.id);
    expect(noteRow(MY_GROUP_NOTE.id)).toHaveAttribute("data-node-kind", "note");
  });

  it("NL8 切 tab 換新的清單元素（捲動位置回頂端）", async () => {
    stubNotesFetch([OWNER_NOTE], [GROUP_A]);
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Has A Slug" });
    const before = list();
    selectTab("Workspace");
    expect(list()).not.toBe(before);
    expect(before.isConnected).toBe(false);
  });

  it("NL9 頂層折疊已拿掉：舊的 sidebar.collapsed.myNotes=1 不再收起我的筆記，面板內沒有「My notes」折疊鈕", async () => {
    localStorage.setItem("sidebar.collapsed.myNotes", "1");
    stubNotesFetch([OWNER_NOTE, THIRD_OWNER_NOTE]);
    renderNoteList();
    expect(await within(panel()).findByRole("link", { name: "Has A Slug" })).toBeInTheDocument();
    expect(within(panel()).getByRole("link", { name: "Third Owner Note" })).toBeInTheDocument();
    expect(within(panel()).queryByRole("button", { name: "My notes" })).toBeNull();
  });

  describe("NL10 aria-current", () => {
    it("active＝群組筆記：在工作坊 tab 該列 aria-current=page，整份 DOM 恰一個", async () => {
      stubNotesFetch([MY_GROUP_NOTE, OWNER_NOTE], [GROUP_A]);
      renderNoteList({}, { tab: "workspace", activeId: MY_GROUP_NOTE.id });
      await within(panel()).findByRole("button", { name: "Workshop A" });
      const current = document.querySelectorAll('[aria-current="page"]');
      expect(current).toHaveLength(1);
      expect(groupNode(GROUP_A.id)).toContainElement(current[0] as HTMLElement);
    });

    it("active＝個人筆記、在最近 tab：最近那列 aria-current=page", async () => {
      stubNotesFetch([OWNER_NOTE, SHARED_NOTE]);
      renderNoteList({}, { tab: "recent", activeId: OWNER_NOTE.id });
      const link = await within(panel()).findByRole("link", { current: "page" });
      expect(link).toHaveAccessibleName(startsWith("Has A Slug"));
      expect(noteRow(OWNER_NOTE.id)).toContainElement(link);
      expect(document.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    });
  });

  it("NL11 順序：我的筆記面板照 server 順序（不依標題排序）", async () => {
    const zed: NoteDto = { ...OWNER_NOTE, id: "99999999-0000-0000-0000-000000000001", title: "Zed", slug: "zed" };
    const alpha: NoteDto = { ...OWNER_NOTE, id: "99999999-0000-0000-0000-000000000002", title: "Alpha", slug: "alpha" };
    stubNotesFetch([zed, alpha]);
    renderNoteList();
    await within(panel()).findByRole("link", { name: "Zed" });
    expect(Array.from(panel().querySelectorAll('[data-node-kind="note"] a')).map((a) => a.textContent)).toEqual(["Zed", "Alpha"]);
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
  tab?: SidebarTab,
) {
  if (tab) localStorage.setItem("sidebar.tab", tab);
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push(`${method} ${url}`);
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
      }
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      // 群組列的 ⋮（GroupMenu）用 useSession 拿自己的 id（只在傳了 groups 時會打）
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
      // 「已移到垃圾桶」toast 的復原（#181）：把送來的 id 原樣當作還原成功。
      if (url === "/api/trash/restore" && method === "POST") {
        const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
        const restored = notes.filter((n) => ids.includes(n.id));
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored, skipped: [] }) }));
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
            <SidebarTabProvider>
              <SidebarTabList idBase="t" />
              <div role="tabpanel">
                <NoteList />
              </div>
            </SidebarTabProvider>
            <RowMenuLocationProbe />
            <Toaster />
          </NotePageControlsContext.Provider>
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

/** 我的筆記 tab 裡 OWNER_NOTE 那列的 ⋮。 */
async function ownerRowTrigger(): Promise<HTMLElement> {
  return within(panel()).findByRole("button", { name: "Note actions for Has A Slug" });
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
    // 單一面板裡同一篇只有一顆 ⋮。
    expect(within(panel()).getAllByRole("button", { name: "Note actions for Has A Slug" })).toHaveLength(1);

    // 與我共享（editor）那列：順序＝標題、徽章、⋮。
    selectTab("Shared with me");
    const sharedTrigger = within(panel()).getByRole("button", { name: "Note actions for No Slug Note" });
    const badge = within(panel()).getByText("Editor");
    expect(badge.nextElementSibling).toBe(sharedTrigger);
    expect(sharedTrigger.closest("li")?.lastElementChild).toBe(sharedTrigger);
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

  it("別篇：移到垃圾桶 → 不確認、打 DELETE、不導頁、toast 有 Undo", async () => {
    const { calls } = renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
    // 位置斷言之前必須有一個 `await waitFor(...)`：少了它，「刪除後多補一次 navigate("/")」
    // 的錯法會存活〔棚內實測〕。
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(2));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("NM-T7 別篇：按 toast 的 Undo → 送 restore、網址不變（不是開著的那篇，不導過去）", async () => {
    const { calls } = renderRowMenu(null);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(calls).toContain("POST /api/trash/restore");
    // 復原後清單失效重抓（第 3 次 GET /api/notes）——等它落地再看網址，多補的 navigate 早已生效。
    await waitFor(() => expect(calls.filter((c) => c === "GET /api/notes")).toHaveLength(3));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/somewhere\|null$/);
  });

  it("別篇：刪除失敗（403）→ 錯誤 toast、沒有「已移到垃圾桶」、不導頁", async () => {
    const { calls } = renderRowMenu(null, [OWNER_NOTE, SHARED_NOTE], true);
    const menu = await openRowMenu(await ownerRowTrigger());
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
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
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
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
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(leavingRef.current).toBe(false);
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
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
    expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    // 同步：handler 的第一行就設閘門（早於 DELETE 回應）。
    expect(leavingRef.current).toBe(true);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/\|null$/));
    expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`);
  });

  // #175 §8.3（gate r1 B-N10）：側欄 ⋮ 與頁首共用 NoteMenuCore，但清單列的 `permissions` 來自
  // `GET /api/notes` 的 grouped 支欄位（規格落差 4）——另一條資料路徑，所以在清單列上各釘一次。
  it("#175：群組筆記列（role editor、permissions.delete true）的 ⋮ 有「Delete」，按下打 DELETE", async () => {
    const deletable = groupNote(
      { id: "77777777-7777-7777-7777-777777777777", title: "Group Deletable", slug: "group-deletable", groupId: GROUP_A.id, groupName: GROUP_A.name },
      "editor",
      { ...EDITOR_PERMS, delete: true },
    );
    const { calls } = renderRowMenu(null, [deletable], false, [GROUP_A], "workspace");
    const menu = await openRowMenu(await within(panel()).findByRole("button", { name: "Note actions for Group Deletable" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain(`DELETE /api/notes/${deletable.id}`));
  });

  it("#175：同一種群組筆記列但 permissions.delete false → ⋮ 沒有「Delete」（其餘項照舊）", async () => {
    const notDeletable = groupNote(
      { id: "88888888-8888-8888-8888-888888888888", title: "Group Kept", slug: "group-kept", groupId: GROUP_A.id, groupName: GROUP_A.name },
      "editor",
      { ...EDITOR_PERMS, delete: false },
    );
    renderRowMenu(null, [notDeletable], false, [GROUP_A], "workspace");
    const menu = await openRowMenu(await within(panel()).findByRole("button", { name: "Note actions for Group Kept" }));
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete" })).toBeNull();
  });

  it("最近 tab 的列也有 ⋮（Link 外的兄弟），移到垃圾桶照打 DELETE", async () => {
    const { calls } = renderRowMenu(null, [OWNER_NOTE], false, [], "recent");
    const trigger = await within(panel()).findByRole("button", { name: "Note actions for Has A Slug" });
    const menu = await openRowMenu(trigger);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await waitFor(() => expect(calls).toContain(`DELETE /api/notes/${OWNER_NOTE.id}`));
  });
});

// ── 資料夾樹（資料夾 PR-3b-1 T2；spec §6.2、§6.3、§6.4、§6.8、§6.9、§6.14）
describe("NoteList × 資料夾", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const FOLDERS: FolderDto[] = [
    folderDto({ id: "B", name: "B" }),
    folderDto({ id: "A1", name: "A1", parentId: "A" }),
    folderDto({ id: "A", name: "A" }),
    groupFolder({ id: "GF", name: "GF", groupId: "G" }),
    groupFolder({ id: "GF2", name: "GF2", groupId: "G", create: false }),
    sharedFolder({ id: "SF", name: "SF" }),
  ];
  const P1 = personalNote({ id: "p1", title: "P1", folderId: "A" });
  const P2 = personalNote({ id: "p2", title: "P2", folderId: "A1" });
  const P3 = personalNote({ id: "p3", title: "P3" });
  const G1 = selGroupNote({ id: "g1", title: "G1", group: G, folderId: "GF" });
  const G2 = selGroupNote({ id: "g2", title: "G2", group: G });
  const S1 = sharedNote({ id: "s1", title: "S1", folderId: "SF" });
  const S2 = sharedNote({ id: "s2", title: "S2" });
  const NOTES = [P1, P2, P3, G1, G2, S1, S2];

  type FolderReply = FolderDto[] | "error" | Promise<FolderDto[]>;

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function stubTree(opts: { notes?: NoteDto[]; folders?: FolderReply } = {}) {
    const folders = opts.folders ?? FOLDERS;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders") {
          if (folders === "error") return Promise.resolve(json({ error: { code: "internal", message: "boom" } }, 500));
          if (folders instanceof Promise) return folders.then((list) => json({ folders: list }));
          return Promise.resolve(json({ folders }));
        }
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json(opts.notes ?? NOTES));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  const folderRow = (id: string, root: HTMLElement = panel()) =>
    root.querySelector(`[data-node-kind="folder"][data-node-id="${id}"]`) as HTMLElement | null;
  const ids = (ul: Element | null | undefined) => Array.from(ul?.children ?? []).map((li) => li.getAttribute("data-node-id"));
  const topIds = () => ids(list().firstElementChild?.querySelector(":scope > ul"));
  const childIds = (row: HTMLElement | null) => ids(row?.querySelector(":scope > div > ul"));
  const mainButton = (id: string, root?: HTMLElement) => folderRow(id, root)!.querySelector(":scope > div > button[aria-expanded]") as HTMLElement;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("FR1 我的筆記：第一層 A、B、p3；A 下 A1、p1；A1 下 p2；主鈕 aria-expanded、可及名稱只有名稱、圖示 aria-hidden、title、列高 h-11 md:h-7", async () => {
    stubTree();
    renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(topIds()).toEqual(["A", "B", "p3"]);
    expect(childIds(folderRow("A"))).toEqual(["A1", "p1"]);
    expect(childIds(folderRow("A1"))).toEqual(["p2"]);
    const button = within(folderRow("A")!).getByRole("button", { name: "A" });
    expect(button).toBe(mainButton("A"));
    expect(button).toHaveAttribute("aria-expanded", "true");
    const icons = button.querySelectorAll("svg");
    expect(icons.length).toBe(2);
    for (const icon of icons) expect(icon).toHaveAttribute("aria-hidden", "true");
    expect(button.querySelector('[title="A"]')).toHaveTextContent("A");
    expect(button).toHaveClass("font-medium");
    expect(folderRow("A")!.firstElementChild).toHaveClass("h-11", "md:h-7");
  });

  it("FR2 工作坊：G 下 GF、GF2（資料夾）與 g2；GF 下 g1；導引線 class 逐字", async () => {
    stubTree();
    renderNoteList({}, { tab: "workspace" });
    await waitFor(() => expect(folderRow("GF")).not.toBeNull());
    expect(ids(groupNode("G")!.querySelector(":scope > div > ul"))).toEqual(["GF", "GF2", "g2"]);
    expect(childIds(folderRow("GF"))).toEqual(["g1"]);
    expect(folderRow("GF")!.lastElementChild!.className).toBe("ml-[15px] border-l border-muted-foreground/35 pl-2");
  });

  it("FR3 與我共享：根層 SF、s2；SF 下 s1", async () => {
    stubTree();
    renderNoteList({}, { tab: "shared" });
    await waitFor(() => expect(folderRow("SF")).not.toBeNull());
    expect(topIds()).toEqual(["SF", "s2"]);
    expect(childIds(folderRow("SF"))).toEqual(["s1"]);
  });

  it("FR4 折疊：寫 sidebar.collapsed.folder:A、子層離開 DOM；同一 QueryClient 卸掉再掛仍收合", async () => {
    stubTree();
    const { view, queryClient } = renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    fireEvent.click(mainButton("A"));
    expect(localStorage.getItem("sidebar.collapsed.folder:A")).toBe("1");
    expect(mainButton("A")).toHaveAttribute("aria-expanded", "false");
    expect(folderRow("A1")).toBeNull();
    expect(noteRow("p1")).toBeNull();
    view.unmount();
    renderNoteList({}, { queryClient });
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(mainButton("A")).toHaveAttribute("aria-expanded", "false");
    expect(folderRow("A1")).toBeNull();
  });

  it("FR4 靜態卡與抽屜兩份同時在 DOM：一處切換兩處同步", async () => {
    stubTree();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="" data-testid="inst-1">
                <NoteList />
              </div>
              <div data-sidebar-instance="" data-testid="inst-2">
                <NoteList />
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const one = screen.getByTestId("inst-1");
    const two = screen.getByTestId("inst-2");
    await waitFor(() => expect(folderRow("A", two)).not.toBeNull());
    fireEvent.click(mainButton("A", one));
    expect(mainButton("A", one)).toHaveAttribute("aria-expanded", "false");
    expect(mainButton("A", two)).toHaveAttribute("aria-expanded", "false");
    expect(within(two).queryByText("P1")).toBeNull();
  });

  it("FR5 空資料夾展開 → 子層一行「No notes」；只有子資料夾的資料夾不出現", async () => {
    stubTree({ folders: [...FOLDERS, folderDto({ id: "C", name: "C" }), folderDto({ id: "C1", name: "C1", parentId: "C" })] });
    renderNoteList();
    await waitFor(() => expect(folderRow("B")).not.toBeNull());
    expect(folderRow("B")!.lastElementChild).toHaveTextContent("No notes");
    expect(folderRow("C")!.querySelector(":scope > div > p")).toBeNull();
    expect(childIds(folderRow("C"))).toEqual(["C1"]);
    expect(within(folderRow("A")!.lastElementChild as HTMLElement).queryByText("No notes")).toBeNull();
  });

  it("FR6「在 X 建立筆記」：個人 (undefined, A)、群組資料夾 (G, GF)；共享資料夾與不能建立的群組資料夾沒有這顆", async () => {
    stubTree();
    const onCreateNote = vi.fn();
    renderNoteList({ onCreateNote });
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    const add = within(folderRow("A")!.firstElementChild as HTMLElement).getByRole("button", { name: "New note in A" });
    expect(add.className).toContain("group-hover/folderrow:opacity-100");
    fireEvent.click(add);
    expect(onCreateNote).toHaveBeenLastCalledWith(undefined, "A");

    selectTab("Workspace");
    await waitFor(() => expect(folderRow("GF")).not.toBeNull());
    fireEvent.click(within(folderRow("GF")!.firstElementChild as HTMLElement).getByRole("button", { name: "New note in GF" }));
    expect(onCreateNote).toHaveBeenLastCalledWith("G", "GF");
    expect(within(folderRow("GF2")!.firstElementChild as HTMLElement).queryByRole("button", { name: "New note in GF2" })).toBeNull();

    selectTab("Shared with me");
    await waitFor(() => expect(folderRow("SF")).not.toBeNull());
    expect(within(folderRow("SF")!.firstElementChild as HTMLElement).queryByRole("button", { name: "New note in SF" })).toBeNull();
  });

  it("FR7 等資料夾：pending 時我的筆記、工作坊、與我共享都顯示 Loading…；最近 tab 照常；放行後樹出現", async () => {
    let release: (list: FolderDto[]) => void = () => {};
    stubTree({ folders: new Promise<FolderDto[]>((resolve) => (release = resolve)) });
    const { queryClient } = renderNoteList();
    // 條件式等待：筆記與群組都已進快取，之後看到的 Loading… 只可能是在等資料夾（不靠固定毫秒）。
    await waitFor(() => expect(queryClient.getQueryData(["notes"])).toBeDefined());
    await waitFor(() => expect(queryClient.getQueryData(GROUPS_QUERY_KEY)).toBeDefined());
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(noteRow("p1")).toBeNull();
    selectTab("Workspace");
    // 群組已到也不平鋪：群組根層的 g2 不出現
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(noteRow("g2")).toBeNull();
    selectTab("Shared with me");
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    expect(noteRow("s2")).toBeNull();
    selectTab("Recent");
    await waitFor(() => expect(noteRow("p1")).not.toBeNull());
    selectTab("My notes");
    expect(within(list()).getByText("Loading…")).toBeInTheDocument();
    release(FOLDERS);
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(childIds(folderRow("A"))).toEqual(["A1", "p1"]);
  });

  it("FR8 資料夾失敗：清單有 role=alert、p1／p2／p3 都在根層（不崩）", async () => {
    stubTree({ folders: "error" });
    renderNoteList();
    await waitFor(() => expect(within(list()).getByRole("alert")).toHaveTextContent(i18n.t("errors.internal")));
    expect(folderRow("A")).toBeNull();
    expect(topIds()).toEqual(["p1", "p2", "p3"]);
  });

  it("FR8b 筆記清單本身失敗時只有一則錯誤（不疊資料夾的）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ error: { code: "internal", message: "boom" } }, 500))),
    );
    renderNoteList();
    await waitFor(() => expect(within(list()).getAllByRole("alert")).toHaveLength(1));
  });

  it("FR9 兜底：folderId 指向不存在的資料夾 → 根層", async () => {
    stubTree({ notes: [...NOTES, personalNote({ id: "p4", title: "P4", folderId: "gone" })] });
    renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(topIds()).toEqual(["A", "B", "p3", "p4"]);
  });

  it("FR10 排序生效：setFolderSort(A, name) 後不重掛，A 內筆記順序更新", async () => {
    const older = personalNote({ id: "pa", title: "Alpha", folderId: "B", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = personalNote({ id: "pb", title: "Beta", folderId: "B", updatedAt: "2026-03-01T00:00:00.000Z" });
    stubTree({ notes: [...NOTES, older, newer] });
    renderNoteList();
    await waitFor(() => expect(folderRow("B")).not.toBeNull());
    expect(childIds(folderRow("B"))).toEqual(["pb", "pa"]);
    act(() => {
      setFolderSort("B", "name");
    });
    expect(childIds(folderRow("B"))).toEqual(["pa", "pb"]);
  });

  it("FR11 最近 tab 路徑行：p2 第二行「My notes › A › A1」，title 同字", async () => {
    stubTree();
    renderNoteList({}, { tab: "recent" });
    await waitFor(() => expect(noteRow("p2")?.querySelector('[title="My notes › A › A1"]')).toHaveTextContent("My notes › A › A1"));
  });

  it("FR-W 清單包層：[data-sidebar-list] 恰有一個子元素且帶 overflow-x-clip px-2；清單本身不帶", async () => {
    stubTree();
    renderNoteList();
    await waitFor(() => expect(folderRow("A")).not.toBeNull());
    expect(list().children).toHaveLength(1);
    expect(list().firstElementChild).toHaveClass("overflow-x-clip", "px-2");
    expect(list()).not.toHaveClass("overflow-x-clip");
    expect(list()).not.toHaveClass("px-2");
  });
});

// ── 新增資料夾入口（資料夾 PR-3b-1 T3；spec §6.1、§6.3）
describe("NoteList × 新增資料夾", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const R: GroupDto = groupDto({ id: "R", name: "R" }, customRole());

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  function stubCreate() {
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders" && method === "POST") {
          posts.push(JSON.parse(String(init?.body)));
          return Promise.resolve(json(folderDto({ id: "new", name: "New one" }), 201));
        }
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json([OWNER_NOTE]));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G, R]));
        if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return posts;
  }

  const headerNames = () => within(header()).getAllByRole("button").map((button) => button.getAttribute("aria-label") ?? button.textContent);
  const rowNames = (id: string) =>
    Array.from(groupNode(id)!.querySelector(":scope > div")!.querySelectorAll("button")).map((button) => button.getAttribute("aria-label") ?? button.textContent);

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("FR12 我的筆記標題列依序 Select、New folder、New personal note；New folder 帶 folder-plus 圖示、24px；與我共享只有 Select；工作坊 Select、New group", async () => {
    stubCreate();
    renderNoteList();
    await within(panel()).findByRole("link", { name: OWNER_NOTE.title });
    expect(headerNames()).toEqual(["Select", "New folder", "New personal note"]);
    const newFolder = within(header()).getByRole("button", { name: "New folder" });
    expect(newFolder.querySelector('svg[data-icon="folder-plus"]')).not.toBeNull();
    expect(newFolder).toHaveClass("h-6", "w-6");
    selectTab("Shared with me");
    expect(headerNames()).toEqual(["Select"]);
    selectTab("Workspace");
    expect(headerNames()).toEqual(["Select", "New group"]);
  });

  it("FR13 按 New folder → 對話框（lazy）→ 送出 body space: personal", async () => {
    const posts = stubCreate();
    renderNoteList();
    await within(panel()).findByRole("link", { name: OWNER_NOTE.title });
    fireEvent.click(within(header()).getByRole("button", { name: "New folder" }));
    const input = await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.change(input, { target: { value: "Plans" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toEqual([{ name: "Plans", space: { kind: "personal" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("FR14 群組列 New folder in G：只在 edit 時渲染、在 New note in G 之前、hover 浮出；送出 body space: group G", async () => {
    const posts = stubCreate();
    renderNoteList({}, { tab: "workspace" });
    await waitFor(() => expect(groupNode("G")).not.toBeNull());
    const names = rowNames("G");
    expect(names.indexOf("New folder in G")).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("New folder in G")).toBeLessThan(names.indexOf("New note in G"));
    expect(rowNames("R")).not.toContain("New folder in R");
    const button = within(groupNode("G")!).getByRole("button", { name: "New folder in G" });
    expect(button.className).toContain("group-hover/grouprow:opacity-100");
    fireEvent.click(button);
    fireEvent.change(await screen.findByRole("textbox", { name: "Folder name" }), { target: { value: "Reports" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(posts).toEqual([{ name: "Reports", space: { kind: "group", groupId: "G" } }]));
  });
});
