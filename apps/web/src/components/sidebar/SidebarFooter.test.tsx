import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, TrashItemDto, UserDto } from "@knotebook/shared";
import type { SidebarTab } from "@/lib/sidebar-tab";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, useSidebarTabActions } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { TRASH_ME, trashItem, trashList } from "@/test/trash-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { SidebarTabList } from "./SidebarTabList";
import { SidebarFooter } from "./SidebarFooter";
import { TrashPanel } from "./TrashPanel";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 側欄底部（plan T4）：新增筆記／垃圾桶保留天數說明；`useTrash()` 只在垃圾桶 tab 才掛（讀碼發現 28）。
// 垃圾桶選取模式的動作列（plan T5 SM8–SM10、SM15、SM17）。

afterEach(() => {
  localStorage.clear();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubTrash(retentionDays: number | null = 7, list?: "pending" | number) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      urls.push(`${method} ${url}`);
      if (url === "/api/trash" && method === "GET") {
        if (list === "pending") return new Promise<Response>(() => {});
        if (typeof list === "number") return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, list));
        return Promise.resolve(fakeResponse(trashList([], { retentionDays })));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return urls;
}

function renderFooter(tab: SidebarTab, props: { searching?: boolean; newNotePending?: boolean } = {}) {
  localStorage.setItem("sidebar.tab", tab);
  const onCreateNote = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SidebarTabProvider>
        <SidebarTabList idBase="t" />
        <SidebarFooter searching={props.searching ?? false} onCreateNote={onCreateNote} newNotePending={props.newNotePending ?? false} />
      </SidebarTabProvider>
    </QueryClientProvider>,
  );
  return { onCreateNote };
}

describe("SidebarFooter", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SF1 垃圾桶 tab：保留 7 天的說明句、沒有 New note", async () => {
    stubTrash(7);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 7 days after deletion$/);
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it("SF1 保留 1 天：單數", async () => {
    stubTrash(1);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^Permanently deleted 1 day after deletion$/);
  });

  it("SF1 不自動刪（null）", async () => {
    stubTrash(null);
    renderFooter("trash");
    expect(await screen.findByTestId("trash-footer")).toHaveTextContent(/^The trash isn't emptied automatically$/);
  });

  it("SF2 一般 tab：New note，按下呼叫 onCreateNote", async () => {
    stubTrash();
    const { onCreateNote } = renderFooter("myNotes");
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(onCreateNote).toHaveBeenCalledTimes(1);
  });

  it.each(["myNotes", "recent"] as const)("SF7 %s tab：有 New note", (tab) => {
    stubTrash();
    renderFooter(tab);
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it.each(["workspace", "shared"] as const)("SF7 %s tab：沒有 New note（它只建個人筆記）", (tab) => {
    stubTrash();
    renderFooter(tab);
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
  });

  it.each(["workspace", "shared"] as const)("SF7 %s tab 但搜尋中 → 仍有 New note（搜尋結果不分 tab）", (tab) => {
    stubTrash();
    renderFooter(tab, { searching: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
  });

  it("SF2 newNotePending → disabled", () => {
    stubTrash();
    renderFooter("myNotes", { newNotePending: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeDisabled();
  });

  it.each([
    ["載入中", "pending" as const],
    ["失敗", 500],
  ])("SF5 垃圾桶 tab %s → 沒有說明句、留 h-7 佔位（版面不跳）", async (_label, list) => {
    const urls = stubTrash(7, list);
    renderFooter("trash");
    await waitFor(() => expect(urls).toContain("GET /api/trash"));
    await act(async () => {});
    expect(screen.queryByTestId("trash-footer")).toBeNull();
    expect(document.querySelector("div.h-7")).not.toBeNull();
  });

  it("SF3 垃圾桶 tab 但搜尋中 → New note、沒有說明句", async () => {
    const urls = stubTrash();
    renderFooter("trash", { searching: true });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByTestId("trash-footer")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).not.toContain("GET /api/trash");
  });

  it("SF4 一般 tab 不打 GET /api/trash；切到垃圾桶才打一次", async () => {
    const urls = stubTrash();
    renderFooter("myNotes");
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(urls).not.toContain("GET /api/trash");

    fireEvent.click(screen.getByRole("tab", { name: "Trash" }));
    expect(await screen.findByTestId("trash-footer")).toBeInTheDocument();
    await waitFor(() => expect(urls.filter((url) => url === "GET /api/trash")).toHaveLength(1));
  });
});

/** 一般 tab 選取模式的底部（PR-2c T5，SF5／SF6）：選取由探針鈕開始／結束，動作列是 lazy 的 `SelectActionBar`。 */
describe("SidebarFooter — 一般 tab 選取模式", () => {
  function SelectionProbe() {
    const { updateSelection } = useSidebarTabActions();
    return (
      <>
        <button type="button" onClick={() => updateSelection({ type: "start" })}>
          probe-start
        </button>
        <button type="button" onClick={() => updateSelection({ type: "end" })}>
          probe-end
        </button>
      </>
    );
  }

  function renderSelectFooter(props: { searching?: boolean } = {}) {
    localStorage.setItem("sidebar.tab", "myNotes");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse([personalNote({ id: "p1", title: "p1" })]));
        if (url === "/api/groups") return Promise.resolve(fakeResponse([]));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <SidebarTabProvider>
            <SelectionProbe />
            <SidebarFooter searching={props.searching ?? false} onCreateNote={() => {}} newNotePending={false} />
          </SidebarTabProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("SF5 我的筆記、選取中 → 沒有 New note、動作列；結束選取 → New note 回來", async () => {
    renderSelectFooter();
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    expect(await screen.findByRole("button", { name: "Copy to" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "probe-end" }));
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy to" })).toBeNull();
  });

  it("SF6 搜尋中＋選取中 → New note、沒有動作列", async () => {
    renderSelectFooter({ searching: true });
    fireEvent.click(screen.getByRole("button", { name: "probe-start" }));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy to" })).toBeNull();
  });
});

const USER: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: TRASH_ME.handle,
  displayName: TRASH_ME.displayName,
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};
const RD = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "R&D" };
const AMY = { handle: "amy", displayName: "Amy" };
const P1 = trashItem({ id: "p1", title: "p1" }, { deletedDaysAgo: 0 });
const P2 = trashItem({ id: "p2", title: "p2" }, { deletedDaysAgo: 1 });
const W1 = trashItem({ id: "w1", title: "w1", group: RD, deletedBy: AMY }, { deletedDaysAgo: 2 });
const W2 = trashItem({ id: "w2", title: "w2", group: RD, deletedBy: AMY }, { deletedDaysAgo: 3 });

function restoredNote(item: TrashItemDto): NoteDto {
  return {
    id: item.id,
    title: item.title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: item.id,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
    folderId: null,
  };
}

/**
 * 清單＋restore／purge：預設把清單上有的當作成功並拿掉；`restoreStatus`／`purgeFail` 給了就回錯誤；
 * 有 `hold` 時 restore／purge 等它 resolve 才回（測送出中的狀態）。
 */
function stubTrashServer(
  initial: TrashItemDto[],
  opts: { restoreStatus?: number; purgeFail?: boolean; hold?: Promise<void> } = {},
) {
  let items = [...initial];
  const posts: { url: string; body: unknown }[] = [];
  const take = (ids: string[]) => {
    const hit = items.filter((item) => ids.includes(item.id));
    items = items.filter((item) => !ids.includes(item.id));
    return hit;
  };
  const after = (make: () => Response) => (opts.hold ? opts.hold.then(make) : Promise.resolve(make()));
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/trash" && method === "GET") return Promise.resolve(fakeResponse(trashList(items)));
      if (method === "POST") posts.push({ url, body });
      if (url === "/api/trash/restore" && method === "POST") {
        if (opts.restoreStatus) return Promise.resolve(fakeResponse({ error: { code: "internal", message: "x" } }, opts.restoreStatus));
        return after(() => fakeResponse({ restored: take((body as { ids: string[] }).ids).map(restoredNote), skipped: [] }));
      }
      if (url === "/api/trash/purge" && method === "POST") {
        if (opts.purgeFail) return Promise.resolve(fakeResponse({ error: { code: "server_busy", message: "x" } }, 409));
        return after(() => fakeResponse({ purged: take((body as { ids: string[] }).ids).map((item) => item.id), skipped: [] }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return {
    posts: (url: string) => posts.filter((post) => post.url === url).map((post) => post.body),
    /** 換掉伺服器端的清單（下一次 GET 生效）。 */
    setItems: (next: TrashItemDto[]) => {
      items = [...next];
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * 兩份外殼（同 AppShell 的靜態卡與抽屜：各自 `data-sidebar-instance`，裡面一份 TrashPanel＋SidebarFooter），共用同一份選取。
 * 焦點要回「發起那一份」的「選取」鈕——動作一律從第二份（`shell(1)`）發起，找錯外殼就會落到第一份。
 */
function renderShells() {
  localStorage.setItem("sidebar.tab", "trash");
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, USER);
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            {[0, 1].map((index) => (
              <div key={index} data-sidebar-instance="" data-testid={`shell-${index}`}>
                <div role="tabpanel">
                  <TrashPanel />
                </div>
                <SidebarFooter searching={false} onCreateNote={() => {}} newNotePending={false} />
              </div>
            ))}
            <input aria-label="outside" />
          </SidebarTabProvider>
          <Toaster />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient };
}

const shell = (index: number) => screen.getByTestId(`shell-${index}`);
const shellHeader = (index: number) => shell(index).querySelector("[data-sidebar-header]") as HTMLElement;
const shellBox = (index: number, id: string) =>
  shell(index).querySelector(`li[data-node-id="${id}"] input[type="checkbox"]`) as HTMLInputElement;
/** 動作列的鈕（確認框開著時背景是 aria-hidden，一律 hidden: true）。 */
const barButton = (index: number, name: string) => within(shell(index)).getByRole("button", { name, hidden: true });
const selectButton = (index: number) => within(shellHeader(index)).queryByRole("button", { name: "Select", hidden: true });

async function enterSelecting() {
  await waitFor(() => expect(shell(1).querySelector('li[data-node-id="w2"]')).not.toBeNull());
  fireEvent.click(selectButton(1) as HTMLElement);
}

describe("SidebarFooter — 垃圾桶選取模式的動作列", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("SM8 0 篇兩顆 disabled；亂序勾 w1、p1 → Restore 送清單順序、toast、離開選取、焦點回同一份的 Select", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    expect(barButton(1, "Restore")).toBeDisabled();
    expect(barButton(1, "Delete permanently")).toBeDisabled();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();

    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(shellBox(1, "p1"));
    expect(barButton(1, "Restore")).toBeEnabled();
    expect(barButton(1, "Delete permanently")).toBeEnabled();
    expect(barButton(1, "Restore").querySelector('svg[data-icon="restore"]')).not.toBeNull();
    // variant="brand"（主色 tint，button.tsx）。
    expect(barButton(1, "Restore")).toHaveClass("bg-brand-soft", "text-brand-on-soft");
    fireEvent.click(barButton(1, "Restore"));

    expect(await screen.findByText("Restored 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1", "w1"] }]);
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(within(shell(1)).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(selectButton(1)).toHaveFocus();
  });

  it("SM9 永久刪除：確認框篇數、確認送兩個 id、toast、離開選取、焦點回同一份的 Select", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w2"));
    fireEvent.click(shellBox(1, "p2"));
    expect(barButton(1, "Delete permanently").querySelector('svg[data-icon="trash"]')).not.toBeNull();
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 2 notes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText("Permanently deleted 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/purge")).toEqual([{ ids: ["p2", "w2"] }]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(selectButton(1)).toHaveFocus();
    // Radix 的關框焦點（setTimeout）跑完後仍在 Select。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(selectButton(1)).toHaveFocus();
  });

  it("SM9 取消：不送、仍在選取模式、選取不變、焦點回開框鈕", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w2"));
    fireEvent.click(shellBox(1, "p2"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 2 notes?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(within(shellHeader(1)).getByText("2 selected", { exact: true })).toBeInTheDocument();
    expect(shellBox(1, "p2")).toBeChecked();
    expect(shellBox(1, "w2")).toBeChecked();
    await waitFor(() => expect(barButton(1, "Delete permanently")).toHaveFocus());
  });

  it("SM10 還原失敗（500）：錯誤 toast、仍在選取模式、選取不變", async () => {
    const server = stubTrashServer([P1, P2, W1, W2], { restoreStatus: 500 });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(barButton(1, "Restore"));

    const title = await screen.findByText("Something went wrong. Please try again.", { exact: true });
    expect(title.closest("li")).toHaveClass("bg-destructive");
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1", "w1"] }]);
    await act(async () => {});
    expect(barButton(1, "Restore")).toBeEnabled();
    expect(within(shellHeader(1)).getByText("2 selected", { exact: true })).toBeInTheDocument();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
  });

  it("SM10b 永久刪除失敗（409）：框關、錯誤 toast、仍在選取模式、焦點回開框鈕", async () => {
    stubTrashServer([P1, P2, W1, W2], { purgeFail: true });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "w1"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByText("The server is busy. Please try again shortly.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
    await waitFor(() => expect(barButton(1, "Delete permanently")).toHaveFocus());
  });

  it("SM15 焦點在底部 Restore 上按 Esc：離開選取、焦點回同一份的 Select", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    const restore = barButton(1, "Restore");
    restore.focus();
    fireEvent.keyDown(restore, { key: "Escape" });

    expect(within(shell(1)).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(shell(1)).getByTestId("trash-footer")).toBeInTheDocument();
    expect(shell(1).querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
    expect(selectButton(1)).toHaveFocus();
  });

  it("SM8b 送出中兩顆 disabled；等回應期間焦點已移到外面 → 完成後不搶焦點（仍離開選取）", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(barButton(1, "Restore"));
    await waitFor(() => expect(barButton(1, "Restore")).toBeDisabled());
    expect(barButton(1, "Delete permanently")).toBeDisabled();
    const outside = screen.getByRole("textbox", { name: "outside" });
    outside.focus();

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
    expect(outside).toHaveFocus();
  });

  it("SM8c 回應前已按 Done 又重新進入選取：晚到的成功不結束新的一輪", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(barButton(1, "Restore"));
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "Done" }));
    fireEvent.click(selectButton(1) as HTMLElement);
    fireEvent.click(shellBox(1, "w2"));

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await act(async () => {});
    expect(within(shellHeader(1)).getByText("1 selected", { exact: true })).toBeInTheDocument();
    expect(shellBox(1, "w2")).toBeChecked();
    expect(within(shell(1)).queryByTestId("trash-footer")).toBeNull();
  });

  it("SM8d 連點 Restore 只送一次", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    const restore = barButton(1, "Restore");
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(server.posts("/api/trash/restore")).toEqual([{ ids: ["p1"] }]);
  });

  it("SM9b 送出中確認鈕 disabled；回應前取消 → 動作列仍 disabled（不能重開），回應回來照常離開選取", async () => {
    const hold = deferred();
    stubTrashServer([P1, P2, W1, W2], { hold: hold.promise });
    renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(shellBox(1, "p2"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 2 notes?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete permanently" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirm).toBeDisabled());

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(barButton(1, "Delete permanently")).toBeDisabled();

    await act(async () => {
      hold.resolve();
    });
    expect(await screen.findByText("Permanently deleted 2 notes", { exact: true })).toBeInTheDocument();
    expect(await within(shell(1)).findByTestId("trash-footer")).toBeInTheDocument();
  });

  it("SM9c 確認框開著時清單重抓、選的全不在了：確認不送、不 toast、框關、仍在選取", async () => {
    const server = stubTrashServer([P1, P2, W1, W2]);
    const { queryClient } = renderShells();
    await enterSelecting();
    fireEvent.click(shellBox(1, "p1"));
    fireEvent.click(barButton(1, "Delete permanently"));
    const dialog = await screen.findByRole("dialog", { name: "Permanently delete 1 note?" });

    server.setItems([P2, W1, W2]);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
    });
    expect(await screen.findByRole("dialog", { name: "Permanently delete 0 notes?" })).toBe(dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {});
    expect(server.posts("/api/trash/purge")).toEqual([]);
    expect(screen.queryByText(/^Permanently deleted/)).toBeNull();
    expect(within(shellHeader(1)).getByText("0 selected", { exact: true })).toBeInTheDocument();
  });

  it("SM17 永久刪除鈕：紅字、邊框、hover 紅底，不是 outline 的 brand-deep", async () => {
    stubTrashServer([P1, P2, W1, W2]);
    renderShells();
    await enterSelecting();
    const purge = barButton(1, "Delete permanently");
    expect(purge).toHaveClass("text-destructive", "hover:bg-destructive/10", "hover:text-destructive", "border");
    expect(purge).not.toHaveClass("hover:bg-brand-deep");
    // 換成 outline 時 twMerge 會讓 hover:bg-destructive/10 蓋掉 hover:bg-brand-deep，但按下態（active:…brand-deep…）與
    // hover:border-transparent 會留下：只看上一條抓不到。
    expect(purge.className).not.toMatch(/brand-deep|hover:border-transparent/);
  });
});
