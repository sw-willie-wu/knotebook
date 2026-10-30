import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { ThemeProvider } from "@/theme";
import { AppShell } from "@/components/AppShell";
import { NoteList, type NoteListProps } from "@/components/NoteList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { adminRole, customRole, groupDto } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "./collapse";
import { liveNotesUnder } from "./folder-index";
import { __resetFolderSortForTests, setFolderSort } from "./folder-sort";

// 數 `liveNotesUnder` 呼叫次數（FM10：選單關著時不掃筆記）；行為照原本（包真函式）。
vi.mock("@/components/sidebar/folder-index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/sidebar/folder-index")>();
  return { ...actual, liveNotesUnder: vi.fn(actual.liveNotesUnder) };
});

// 資料夾列 ⋮（資料夾 PR-3b-1 T4，spec §6.5）：照真實掛法渲染在 NoteList 內。
afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

const ME = { id: "u1", email: "a@example.com", handle: "tester", displayName: "Ann", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };
const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
const R: GroupDto = groupDto({ id: "R", name: "R" }, customRole());

function json(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface Server {
  notes?: NoteDto[];
  folders?: FolderDto[];
  groups?: GroupDto[];
  post?: () => Response | Promise<Response>;
}

function stubServer(opts: Server = {}) {
  const calls: Array<{ key: string; body: unknown }> = [];
  // 有狀態：DELETE 之後重抓的資料夾清單不含被刪的那個（FM8 才走得到「⋮ 已卸載」）。
  let folders = opts.folders ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (method === "GET") {
        if (url === "/api/notes") return Promise.resolve(json(opts.notes ?? []));
        if (url === "/api/folders") return Promise.resolve(json({ folders }));
        if (url === "/api/groups") return Promise.resolve(json(opts.groups ?? []));
        if (url === "/api/trash") return Promise.resolve(json({ retentionDays: 7, items: [], truncated: false }));
        if (url === "/api/auth/me") return Promise.resolve(json(ME));
        return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
      }
      calls.push({ key: `${method} ${url}`, body });
      if (url === "/api/notes" && method === "POST") return Promise.resolve(opts.post ? opts.post() : json(personalNote({ id: "created", title: "Untitled" }), 201));
      if (url === "/api/folders" && method === "POST") return Promise.resolve(json(folderDto({ id: "X", name: "X" }), 201));
      if (url.startsWith("/api/folders/") && method === "PATCH") return Promise.resolve(json(folderDto({ id: "A", name: "B" })));
      if (url.startsWith("/api/folders/") && method === "DELETE") {
        const id = decodeURIComponent(url.split("/")[3] ?? "");
        folders = folders.filter((folder) => folder.id !== id);
        return Promise.resolve(json({ trashedNoteIds: [], deletedFolderIds: [id] }));
      }
      return Promise.resolve(json({ error: { code: "not_found", message: "x" } }, 404));
    }),
  );
  return calls;
}

function renderList(props: Partial<NoteListProps> = {}, opts: { tab?: SidebarTab; queryClient?: QueryClient } = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div role="tabpanel">
              <NoteList {...props} />
            </div>
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { view, queryClient };
}

const trigger = (name: string) => screen.findByRole("button", { name: `Folder menu for ${name}` });
async function openMenu(name: string): Promise<HTMLElement> {
  // Radix DropdownMenu 的 trigger 只聽 pointerdown。
  fireEvent.pointerDown(await trigger(name), { button: 0 });
  return screen.findByRole("menu");
}
/** 選單內容的骨架：menuitem／menuitemradio 用名稱，分隔線 `—`、小標 `[label]`。 */
function skeleton(menu: HTMLElement): string[] {
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="separator"], [role="group"] > [id], div[id]:not([role])'))
    .filter((el) => el.closest('[role="menu"]') === menu)
    .map((el) => {
      const role = el.getAttribute("role");
      if (role === "separator") return "—";
      if (role === "menuitem" || role === "menuitemradio") return el.getAttribute("aria-labelledby") ? (document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent ?? "") : (el.textContent ?? "");
      return `[${el.textContent}]`;
    });
}

const A = folderDto({ id: "A", name: "A" });

describe("FolderMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
    await i18n.changeLanguage("en");
  });

  it("FM1 個人資料夾：項目順序、排序小標與三項（Last modified 已選）、每個 menuitem 有圖示、刪除紅字", async () => {
    stubServer({ folders: [A] });
    renderList();
    const menu = await openMenu("A");
    expect(skeleton(menu)).toEqual(["New note", "New subfolder", "Rename", "—", "[Sort by]", "Name", "Last modified", "Size", "—", "Delete folder"]);
    expect(within(menu).getByRole("menuitemradio", { name: "Last modified" })).toHaveAttribute("aria-checked", "true");
    for (const item of within(menu).getAllByRole("menuitem")) expect(item.querySelector("svg")).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Delete folder" })).toHaveClass("text-destructive");
    expect(within(menu).getByRole("group")).toHaveAttribute("aria-labelledby");
  });

  it("FM2 共享私人：沒有 New note；刪除項叫 Remove folder", async () => {
    stubServer({ folders: [sharedFolder({ id: "SF", name: "SF" })] });
    renderList({}, { tab: "shared" });
    const menu = await openMenu("SF");
    expect(within(menu).queryByRole("menuitem", { name: "New note" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Remove folder" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete folder" })).toBeNull();
  });

  it("FM3 群組資料夾、自訂角色「刪除、不能編輯」（manage false、deleteNotes true）：只有排序小標與三項（沒有落單的分隔線）", async () => {
    stubServer({ groups: [R], folders: [groupFolder({ id: "RF", name: "RF", groupId: "R", edit: false, create: false, delete: true })] });
    renderList({}, { tab: "workspace" });
    const menu = await openMenu("RF");
    expect(skeleton(menu)).toEqual(["[Sort by]", "Name", "Last modified", "Size"]);
  });

  it("FM4 第 5 層：New subfolder 不可執行（aria-disabled、名稱只有項目名、說明在描述、沒有 data-disabled、點了不開框）；第 4 層可按", async () => {
    stubServer({ folders: folderChain("L", 5) });
    renderList();
    let menu = await openMenu("L5");
    const item = within(menu).getByRole("menuitem", { name: "New subfolder" });
    expect(item).toHaveAttribute("aria-disabled", "true");
    expect(item).toHaveAccessibleName("New subfolder");
    expect(item).toHaveAccessibleDescription("Folders can be nested up to 5 levels");
    expect(item).not.toHaveAttribute("data-disabled");
    fireEvent.click(item);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    menu = await openMenu("L4");
    const ok = within(menu).getByRole("menuitem", { name: "New subfolder" });
    expect(ok).not.toHaveAttribute("aria-disabled");
    expect(ok).not.toHaveAttribute("aria-describedby");
    expect(within(ok).queryByText("Folders can be nested up to 5 levels")).toBeNull();
  });

  it("FM5 群組資料夾 manage 但不能刪筆記、子樹有活筆記 → Delete folder 不可執行；子樹沒有活筆記 → 可按", async () => {
    const GF = groupFolder({ id: "GF", name: "GF", groupId: "G", delete: false });
    const GE = groupFolder({ id: "GE", name: "GE", groupId: "G", delete: false });
    stubServer({ groups: [G], folders: [GF, GE], notes: [groupNote({ id: "g1", title: "g1", group: G, folderId: "GF" })] });
    renderList({}, { tab: "workspace" });
    let menu = await openMenu("GF");
    const blocked = within(menu).getByRole("menuitem", { name: "Delete folder" });
    expect(blocked).toHaveAttribute("aria-disabled", "true");
    expect(blocked).toHaveAccessibleName("Delete folder");
    expect(blocked).toHaveAccessibleDescription("This folder has notes you can't delete");
    fireEvent.click(blocked);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    menu = await openMenu("GE");
    const ok = within(menu).getByRole("menuitem", { name: "Delete folder" });
    expect(ok).not.toHaveAttribute("aria-disabled");
    fireEvent.click(ok);
    expect(await screen.findByRole("dialog", { name: "Delete folder “GE”?" })).toBeInTheDocument();
  });

  it("FM6 排序：選 Name → 存 localStorage、選單仍開、Name 已選、清單順序變；卸載重掛仍是 Name", async () => {
    const older = personalNote({ id: "pa", title: "Alpha", folderId: "A", updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = personalNote({ id: "pb", title: "Beta", folderId: "A", updatedAt: "2026-03-01T00:00:00.000Z" });
    stubServer({ folders: [A], notes: [older, newer] });
    const { view, queryClient } = renderList();
    const order = () => Array.from(document.querySelectorAll('[data-node-kind="folder"][data-node-id="A"] [data-node-kind="note"]')).map((li) => li.getAttribute("data-node-id"));
    await waitFor(() => expect(order()).toEqual(["pb", "pa"]));
    const menu = await openMenu("A");
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Name" }));
    expect(localStorage.getItem("sidebar.sort.folder:A")).toBe("name");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(within(screen.getByRole("menu")).getByRole("menuitemradio", { name: "Name" })).toHaveAttribute("aria-checked", "true");
    expect(order()).toEqual(["pa", "pb"]);
    view.unmount();
    renderList({}, { queryClient });
    await waitFor(() => expect(order()).toEqual(["pa", "pb"]));
    const again = await openMenu("A");
    expect(within(again).getByRole("menuitemradio", { name: "Name" })).toHaveAttribute("aria-checked", "true");
  });

  it("FM7 New note → onCreateNote(undefined, A)；New subfolder → 建立框、body {name: X, parentId: A}；Rename → 預填；Delete folder → 確認框", async () => {
    const calls = stubServer({ folders: [A] });
    const onCreateNote = vi.fn();
    renderList({ onCreateNote });
    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "New note" }));
    expect(onCreateNote).toHaveBeenCalledWith(undefined, "A");

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "New subfolder" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Folder name" }), { target: { value: "X" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(calls).toEqual([{ key: "POST /api/folders", body: { name: "X", parentId: "A" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Rename" }));
    expect(await screen.findByRole("textbox", { name: "Folder name" })).toHaveValue("A");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Delete folder" }));
    expect(await screen.findByRole("dialog", { name: "Delete folder “A”?" })).toBeInTheDocument();
  });

  it("FM8 框關閉後焦點回 ⋮（再讓出兩輪事件迴圈仍在）；刪除成功後 ⋮ 已卸載 → 不丟錯", async () => {
    stubServer({ folders: [A] });
    renderList();
    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const menuButton = await trigger("A");
    await waitFor(() => expect(menuButton).toHaveFocus());
    // 讓出兩輪（0 ms 的 timer 只是讓 Radix 卸載後的焦點處理跑完，不是等時間）
    for (let i = 0; i < 2; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
    expect(menuButton).toHaveFocus();

    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Delete folder" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete folder “A”?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Folder deleted", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // 重抓後 A 不在了：⋮ 已卸載（不搶焦點的 isConnected 那條路），焦點不會停在脫離 DOM 的節點上
    await waitFor(() => expect(screen.queryByRole("button", { name: "Folder menu for A" })).toBeNull());
    expect(menuButton.isConnected).toBe(false);
    expect(document.activeElement?.isConnected).toBe(true);
  });

  it("FM10 刪除擋下的判斷只在選單內容掛載時才算：選單關著時 liveNotesUnder 0 次、打開後 ≥ 1 次", async () => {
    const GF = groupFolder({ id: "GF", name: "GF", groupId: "G", delete: false });
    stubServer({ groups: [G], folders: [GF], notes: [groupNote({ id: "g1", title: "g1", group: G, folderId: "GF" })] });
    renderList({}, { tab: "workspace" });
    await trigger("GF");
    await screen.findByRole("link", { name: "g1" });
    const calls = vi.mocked(liveNotesUnder);
    calls.mockClear();
    // 寫排序 store：每份 FolderMenu 自己訂閱它（useFolderSort）而重繪，NoteList 也因 useFolderSortOf 換新函式而重組節點；選單一直關著
    act(() => {
      setFolderSort("GF", "name");
    });
    expect(screen.getByRole("link", { name: "g1" })).toBeInTheDocument();
    expect(calls).not.toHaveBeenCalled();
    const menu = await openMenu("GF");
    expect(within(menu).getByRole("menuitem", { name: "Delete folder" })).toHaveAttribute("aria-disabled", "true");
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("FM11 建立中：⋮ 的 New note 暫時不能按（Radix disabled，同列上的「＋」）", async () => {
    stubServer({ folders: [A] });
    renderList({ createNotePending: true });
    const menu = await openMenu("A");
    const item = within(menu).getByRole("menuitem", { name: "New note" });
    expect(item).toHaveAttribute("data-disabled");
    // 讀屏也要知道不能按（Radix 在 disabled 時設的 aria-disabled 不得被蓋掉）
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("FM12 從 ⋮ 開框（含 chunk 已快取的第二次起）：輸入框拿到焦點，選單關閉時不把焦點搶回 ⋮", async () => {
    stubServer({ folders: [A] });
    renderList();
    for (const item of ["Rename", "New subfolder", "Rename"]) {
      fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: item }));
      const input = await screen.findByRole("textbox", { name: "Folder name" });
      await waitFor(() => expect(input).toHaveFocus());
      // 再讓出兩輪：Radix 選單卸載後的還焦點若會搶，在這裡出現
      for (let i = 0; i < 2; i++) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
      expect(input).toHaveFocus();
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.getByRole("button", { name: "Folder menu for A" })).toHaveFocus());
    }
  });

  it("FM13 開過框之後，Esc 關選單仍把焦點還給 ⋮（「不還焦點」只限開框那一次）", async () => {
    stubServer({ folders: [A] });
    renderList();
    fireEvent.click(within(await openMenu("A")).getByRole("menuitem", { name: "Rename" }));
    await screen.findByRole("textbox", { name: "Folder name" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const menuButton = await trigger("A");
    await waitFor(() => expect(menuButton).toHaveFocus());
    const menu = await openMenu("A");
    await waitFor(() => expect(menuButton).not.toHaveFocus());
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(menuButton).toHaveFocus());
  });

  it("FM9 zh：可及名稱「A 的資料夾選單」、三個排序字、「已達最多 5 層」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubServer({ folders: folderChain("L", 5) });
    renderList();
    fireEvent.pointerDown(await screen.findByRole("button", { name: "L5 的資料夾選單" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    expect(within(menu).getAllByRole("menuitemradio").map((el) => el.textContent)).toEqual(["名稱", "最近修改", "文件大小"]);
    expect(within(menu).getByRole("menuitem", { name: "新增子資料夾" })).toHaveAccessibleDescription("已達最多 5 層");
  });
});

// T2 審查 n-4：⋮「新增筆記」在 A1 建立時，A1 與祖先 A 都寫成展開（AppShell.handleNewNote 的祖先展開）。
describe("FolderMenu × AppShell：⋮ 新增筆記展開祖先", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function NoteRoute() {
    const { handle, slug } = useParams();
    return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
  }

  it("FM7b A1 的 ⋮ → New note；POST 回來前 A、A1 都被收合 → 成功後兩者都展開、導到新筆記", async () => {
    let release: () => void = () => {};
    const held = new Promise<Response>((resolve) => (release = () => resolve(json(personalNote({ id: "created", title: "Untitled" }), 201))));
    const calls = stubServer({ folders: [A, folderDto({ id: "A1", name: "A1", parentId: "A" })], post: () => held });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRoute />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(within(await openMenu("A1")).getByRole("menuitem", { name: "New note" }));
    await waitFor(() => expect(calls.map((c) => c.key)).toEqual(["POST /api/notes"]));
    expect(calls[0]!.body).toEqual({ folderId: "A1" });
    act(() => {
      setCollapsed("folder:A", true);
      setCollapsed("folder:A1", true);
    });
    release();
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent("tester/note-created"));
    expect(isCollapsed("folder:A")).toBe(false);
    expect(isCollapsed("folder:A1")).toBe(false);
  });
});
