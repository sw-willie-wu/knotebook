import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from "react-router";
import type { GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import type { CollabState } from "@/collab/connection";
import { ActiveNoteProvider } from "@/lib/active-note";
import { NotePageControlsContext, type NotePageControls } from "@/lib/note-page-controls";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { SidebarFooter } from "@/components/sidebar/SidebarFooter";
import { adminRole, customRole, groupDto } from "@/test/fixtures";
import { clickOutside } from "@/test/outside-click";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";
import type { FolderDto } from "@knotebook/shared";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";

// 一般 tab 選取模式的動作列、目的地框、確認框與三種流程（#181 PR-2c T5，SA1–SA24b）。
// 兩份外殼（同 AppShell 的靜態卡與抽屜）共用同一份選取；動作一律從第二份（shell 1）發起，找錯外殼焦點就會落到第一份。

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const ME: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: "tester",
  displayName: "Tester",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

const GA: GroupDto = groupDto({ id: "ga", name: "A" }, adminRole());
const GB: GroupDto = groupDto({ id: "gb", name: "B" }, customRole({ permissions: { ...customRole().permissions, create: true } }));
const P1 = personalNote({ id: "p1", title: "p1" });
const P2 = personalNote({ id: "p2", title: "p2" });
const P3 = personalNote({ id: "p3", title: "p3" });
const GA1 = groupNote({ id: "ga1", title: "ga1", group: GA });
const GA2 = groupNote({ id: "ga2", title: "ga2", group: GA });
/** 能刪不能編輯（§6.10.7）。 */
const GA3 = groupNote({ id: "ga3", title: "ga3", group: GA, edit: false });
/** 不能刪。 */
const GA4 = groupNote({ id: "ga4", title: "ga4", group: GA, delete: false });
const S1 = sharedNote({ id: "s1", title: "s1", role: "viewer" });
const ALL = [P1, P2, P3, GA1, GA2, GA3, GA4, S1];

interface Call {
  key: string;
  body: unknown;
}

/**
 * 假 server：清單與群組照 `box`；DELETE／move／copy 預設成功並改 `box.notes`（下一次 GET 生效），restore 還回被刪的篇。
 * `fail(key, status, code)` 讓某支回錯誤；`hold(key)` 讓某支等放行才回（回傳放行函式）。
 */
function stubServer(initial: { notes?: NoteDto[]; groups?: GroupDto[]; folders?: FolderDto[] } = {}) {
  const box = { notes: [...(initial.notes ?? ALL)], groups: initial.groups ?? [GA] };
  const trashed = new Map<string, NoteDto>();
  const calls: Call[] = [];
  const failures = new Map<string, { status: number; code: string }>();
  const gates = new Map<string, Promise<void>>();
  const listeners: ((key: string) => void)[] = [];

  function perform(method: string, url: string, body: unknown): Response {
    const key = `${method} ${url}`;
    const failure = failures.get(key);
    if (failure) return fakeResponse({ error: { code: failure.code, message: "x" } }, failure.status);
    const id = decodeURIComponent(url.split("/")[3] ?? "");
    const note = box.notes.find((n) => n.id === id);
    if (method === "DELETE" && note) {
      box.notes = box.notes.filter((n) => n.id !== id);
      trashed.set(id, note);
      return fakeResponse(undefined, 204);
    }
    if (url.endsWith("/move") && note) {
      const group = box.groups.find((g) => g.id === (body as { groupId: string }).groupId) as GroupDto;
      const moved: NoteDto = { ...note, ownerId: null, ownerHandle: null, role: "editor", groupId: group.id, group: { id: group.id, name: group.name } };
      box.notes = box.notes.map((n) => (n.id === id ? moved : n));
      return fakeResponse(moved);
    }
    if (url.endsWith("/copy") && note) {
      const groupId = (body as { groupId?: string }).groupId;
      const group = box.groups.find((g) => g.id === groupId);
      const copy: NoteDto = group
        ? { ...note, id: `${id}-copy`, ownerId: null, ownerHandle: null, groupId: group.id, group: { id: group.id, name: group.name } }
        : personalNote({ id: `${id}-copy`, title: `${note.title} copy` });
      box.notes = [...box.notes, copy];
      return fakeResponse(copy);
    }
    if (url === "/api/trash/restore") {
      const restored = (body as { ids: string[] }).ids.flatMap((rid) => {
        const hit = trashed.get(rid);
        return hit ? [hit] : [];
      });
      box.notes = [...box.notes, ...restored];
      return fakeResponse({ restored, skipped: [] });
    }
    return fakeResponse({ error: { code: "not_found", message: "x" } }, 404);
  }

  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method === "GET") {
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(initial.folders === undefined ? FOLDER_LIST_EMPTY : { folders: initial.folders }), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes") return Promise.resolve(fakeResponse(box.notes));
        if (url === "/api/groups") return Promise.resolve(fakeResponse(box.groups));
        if (url === "/api/auth/me") return Promise.resolve(fakeResponse(ME));
        return Promise.resolve(fakeResponse({ error: { code: "not_found", message: "x" } }, 404));
      }
      const key = `${method} ${url}`;
      calls.push({ key, body });
      for (const listener of listeners) listener(key);
      const gate = gates.get(key);
      return gate ? gate.then(() => perform(method, url, body)) : Promise.resolve(perform(method, url, body));
    }),
  );

  return {
    box,
    /** 非 GET 的請求（依送出順序）。 */
    keys: () => calls.map((call) => call.key),
    bodies: (key: string) => calls.filter((call) => call.key === key).map((call) => call.body),
    fail: (key: string, status: number, code: string) => {
      failures.set(key, { status, code });
    },
    hold: (key: string): (() => Promise<void>) => {
      let open = () => {};
      gates.set(
        key,
        new Promise<void>((resolve) => {
          open = resolve;
        }),
      );
      return async () => {
        await act(async () => {
          open();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
      };
    },
    onRequest: (listener: (key: string) => void) => {
      listeners.push(listener);
    },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

interface RenderOpts {
  tab?: SidebarTab;
  controls?: NotePageControls;
  path?: string;
  outside?: ReactNode;
}

/** NotePage 的替身：controls 可在測試中途換（同一個 NotePage 實例換篇＝同一個 leavingRef、noteId 換掉），也給測試一個 navigate。 */
interface PageHost {
  setControls: (controls: NotePageControls) => void;
  navigate: NavigateFunction;
}

function ControlsHost({ initial, host, children }: { initial: NotePageControls; host: { current: PageHost | null }; children: ReactNode }) {
  const [controls, setControls] = useState(initial);
  const navigate = useNavigate();
  host.current = { setControls, navigate };
  return <NotePageControlsContext.Provider value={controls}>{children}</NotePageControlsContext.Provider>;
}

function renderShells(opts: RenderOpts = {}) {
  const host: { current: PageHost | null } = { current: null };
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const shells = (
    <SidebarTabProvider>
      {[0, 1].map((index) => (
        <div key={index} data-sidebar-instance="" data-testid={`shell-${index}`}>
          <div role="tabpanel">
            <NoteList />
          </div>
          <SidebarFooter searching={false} onCreateNote={() => {}} newNotePending={false} />
        </div>
      ))}
      {opts.outside}
    </SidebarTabProvider>
  );
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[opts.path ?? "/"]}>
        <ActiveNoteProvider>
          {opts.controls ? (
            <ControlsHost initial={opts.controls} host={host}>
              {shells}
            </ControlsHost>
          ) : (
            shells
          )}
          <LocationProbe />
          <Toaster />
        </ActiveNoteProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, host };
}

const shell = (index: number) => screen.getByTestId(`shell-${index}`);
const shellHeader = (index: number) => shell(index).querySelector("[data-sidebar-header]") as HTMLElement;
const bar = (index = 1) => shell(index).querySelector("[data-select-action-bar]") as HTMLElement;
/** 對話框開著時背景是 aria-hidden，一律 hidden: true。 */
const barButton = (name: string | RegExp, index = 1) => within(bar(index)).getByRole("button", { name, hidden: true });
const selectButton = (index = 1) => within(shellHeader(index)).queryByRole("button", { name: "Select", hidden: true });
const doneButton = (index = 1) => within(shellHeader(index)).getByRole("button", { name: "Done", hidden: true });
const box = (id: string, index = 1) => shell(index).querySelector(`input[type="checkbox"][data-selection-key="note:${id}"]`) as HTMLInputElement;
const checkedIds = (index = 1) =>
  Array.from(shell(index).querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
    .filter((input) => input.checked)
    .map((input) => input.dataset.selectionKey?.replace(/^note:/, ""));
const location = () => screen.getByTestId("location").textContent;
const toastRoot = (title: string) => screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
const selecting = (index = 1) => within(shellHeader(index)).queryByRole("button", { name: "Done", hidden: true }) !== null;
const tick = (...ids: string[]) => {
  for (const id of ids) fireEvent.click(box(id));
};
const settleTimers = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

/** 等「選取」可按 → 按 → 等 lazy chunk 的標題列、勾選框與動作列。 */
async function enterSelecting(index = 1): Promise<void> {
  await waitFor(() => expect(selectButton(index)).toBeEnabled());
  fireEvent.click(selectButton(index) as HTMLElement);
  await within(shellHeader(index)).findByText("0 selected");
  await waitFor(() => expect(shell(index).querySelector('input[type="checkbox"]')).not.toBeNull());
  await waitFor(() => expect(bar(index)).not.toBeNull());
}

async function pickDestination(name: string): Promise<HTMLElement> {
  const picker = await screen.findByRole("dialog", { name: /^(Move to|Copy to)$/ });
  fireEvent.click(within(picker).getByRole("button", { name }));
  return screen.findByRole("dialog", { name: /^(Move into group|Copy to my notes|Copy into group)$/ });
}

describe("SelectActionBar（PR-2c T5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  describe("SA1 各 tab 的鈕", () => {
    it("我的筆記：Move to、Copy to、Delete 0 selected items；0 篇全 disabled；勾一篇可按；樣式；底部沒有 New note", async () => {
      stubServer();
      renderShells();
      await enterSelecting();
      expect(within(bar()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual([
        "Move to",
        "Copy to",
        "Delete 0 selected items",
      ]);
      for (const name of ["Move to", "Copy to", "Delete 0 selected items"]) expect(barButton(name)).toBeDisabled();
      tick("p1");
      expect(barButton("Move to")).toBeEnabled();
      expect(barButton("Copy to")).toBeEnabled();
      const del = barButton("Delete 1 selected item");
      expect(del).toBeEnabled();
      expect(del).toHaveAttribute("title", "Delete 1 selected item");
      expect(barButton("Move to").querySelector('svg[data-icon="folder-input"]')).not.toBeNull();
      expect(barButton("Copy to").querySelector('svg[data-icon="copy"]')).not.toBeNull();
      expect(del.querySelector('svg[data-icon="trash"]')).not.toBeNull();
      expect(del).toHaveClass("text-destructive", "border", "hover:bg-destructive/10");
      // 不是 outline（它的 hover 填 brand-deep、active 混 brand-deep；hover:bg 被 twMerge 蓋掉，所以看整串）。
      expect(del.className).not.toContain("brand-deep");
      expect(del.className).not.toContain("hover:border-transparent");
      expect(within(shell(1)).queryByRole("button", { name: "New note" })).toBeNull();
      // 版面契約（T5 review r1 I1；真瀏覽器量測見報告）：兩顆文字鈕能縮（min-w-0）、字截斷但 DOM 仍是全文（可及名稱完整）、title 給全文。
      for (const name of ["Move to", "Copy to"]) {
        const button = barButton(name);
        expect(button).toHaveClass("min-w-0", "flex-1", "px-1.5");
        expect(button).toHaveAttribute("title", name);
        expect(button.querySelector("span.truncate")).toHaveTextContent(name);
        // 列寬不到 14.5rem 時圖示讓位給字（按鈕列是 @container）。
        expect(button.querySelector("svg")).toHaveClass("hidden", "@min-[14.5rem]:block");
      }
      expect(barButton("Move to").parentElement).toHaveClass("@container");
      expect(del).toHaveClass("w-9", "shrink-0");
    });

    it.each([
      ["recent" as const, ["Copy to", "Delete 0 selected items"]],
      ["workspace" as const, ["Copy to", "Delete 0 selected items"]],
      ["shared" as const, ["Copy to"]],
    ])("%s：%j", async (tab, names) => {
      stubServer();
      renderShells({ tab });
      await enterSelecting();
      expect(within(bar()).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent)).toEqual(names);
    });
  });

  it("SA2 沒有可移入的群組（只有只能新建的 B）→ Move to disabled", async () => {
    stubServer({ groups: [GB] });
    renderShells();
    await enterSelecting();
    tick("p1");
    await waitFor(() => expect(barButton("Copy to")).toBeEnabled());
    expect(barButton("Move to")).toBeDisabled();
  });

  it("SA3 移動：亂序勾 p2、p1 → A → 確認框篇數與四條通用句 → 依序送 → toast → 離開選取、焦點在同一份的 Select", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p2", "p1");
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    expect(confirm).toHaveAccessibleName("Move into group");
    expect(confirm).toHaveAccessibleDescription('Move 2 notes into "A"?');
    expect(within(confirm).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Any per-person sharing is removed; anyone not in the group loses access.",
      "Any public links are turned off.",
      "Their addresses change to /g/…; the old addresses forward to the new ones for a month.",
      "You will no longer own them — what you can do with them then depends on your role in the group.",
    ]);
    const submit = within(confirm).getByRole("button", { name: "Move into group" });
    expect(submit).toHaveClass("bg-destructive");
    fireEvent.click(submit);
    expect(await screen.findByText('Moved 2 notes into "A"', { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p1/move", "POST /api/notes/p2/move"]);
    expect(server.bodies("POST /api/notes/p1/move")).toEqual([{ groupId: "ga" }]);
    await waitFor(() => expect(selecting()).toBe(false));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(selectButton(1)).toHaveFocus();
    await settleTimers();
    expect(selectButton(1)).toHaveFocus();
  });

  it("SA3b 選完目的地：開框鈕收到 0 次 focus、焦點在確認框內", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    const moveTo = barButton("Move to");
    fireEvent.click(moveTo);
    const picker = await screen.findByRole("dialog", { name: "Move to" });
    const spy = vi.fn();
    moveTo.addEventListener("focus", spy);
    fireEvent.click(within(picker).getByRole("button", { name: "A" }));
    const confirm = await screen.findByRole("dialog", { name: "Move into group" });
    await settleTimers();
    expect(spy).toHaveBeenCalledTimes(0);
    expect(confirm.contains(document.activeElement)).toBe(true);
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("SA3c 快照：第一支回來後清單少一篇，送出中描述仍是 2 篇、第二支照送", async () => {
    const server = stubServer();
    const releaseP2 = server.hold("POST /api/notes/p2/move");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    fireEvent.click(within(confirm).getByRole("button", { name: "Move into group" }));
    await waitFor(() => expect(server.keys()).toEqual(["POST /api/notes/p1/move", "POST /api/notes/p2/move"]));
    // p1 已移入群組、清單重抓後不在我的筆記。
    await waitFor(() => expect(box("p1")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Move into group" })).toHaveAccessibleDescription('Move 2 notes into "A"?');
    await releaseP2();
    expect(await screen.findByText('Moved 2 notes into "A"', { exact: true })).toBeInTheDocument();
  });

  it("SA4 移動遇 server 略過（403）→ 1 篇成功 1 篇略過、離開選取", async () => {
    const server = stubServer();
    server.fail("POST /api/notes/p2/move", 403, "forbidden");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Move to"));
    fireEvent.click(within(await pickDestination("A")).getByRole("button", { name: "Move into group" }));
    expect(await screen.findByText('Moved 1 note into "A", 1 skipped (no permission, or it no longer exists)', { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
  });

  it("SA5 複製到我的筆記：確認框、body {}、toast", async () => {
    const server = stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("My notes");
    expect(confirm).toHaveAccessibleName("Copy to my notes");
    expect(confirm).toHaveAccessibleDescription(
      "This creates a copy in My notes; the original stays as it is. AI edit history and backlinks are not copied.",
    );
    const submit = within(confirm).getByRole("button", { name: "Copy to my notes" });
    expect(submit).not.toHaveClass("bg-destructive");
    fireEvent.click(submit);
    expect(await screen.findByText("Copied 1 note to My notes", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/notes/ga1/copy")).toEqual([{}]);
    await waitFor(() => expect(selecting()).toBe(false));
  });

  it("SA5 複製到群組：body {groupId}、toast", async () => {
    const server = stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1", "ga2");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("A");
    expect(confirm).toHaveAccessibleName("Copy into group");
    expect(confirm).toHaveAccessibleDescription(
      'This creates 2 copies in "A"; the originals stay as they are. AI edit history and backlinks are not copied.',
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Copy into group" }));
    expect(await screen.findByText('Copied 2 notes into "A"', { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/notes/ga1/copy")).toEqual([{ groupId: "ga" }]);
  });

  it("SA6 刪除：不確認、依清單順序兩支 DELETE、toast＋Undo → 還原整批", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p2", "p1");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
    expect(toastRoot("Moved 2 notes to the trash")).not.toHaveClass("bg-destructive");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 2 notes", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/trash/restore")).toEqual([{ ids: ["p1", "p2"] }]);
  });

  it("SA-F1 刪除依樹序送出（資料夾在前）：server 序 [根層 fp3, 資料夾 A 裡的 fp1] → DELETE fp1、fp3", async () => {
    const fp3 = personalNote({ id: "fp3", title: "fp3" });
    const fp1 = personalNote({ id: "fp1", title: "fp1", folderId: "A" });
    const server = stubServer({ notes: [fp3, fp1], folders: [folderDto({ id: "A", name: "A" })] });
    renderShells();
    await enterSelecting();
    await waitFor(() => expect(box("fp1")).not.toBeNull());
    tick("fp3", "fp1");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/fp1", "DELETE /api/notes/fp3"]);
    __resetFolderSortForTests();
  });

  it("SA7 最近 tab 刪除混共享：只送 p1、toast 報 1 篇略過、有 Undo", async () => {
    const server = stubServer();
    renderShells({ tab: "recent" });
    await enterSelecting();
    tick("p1", "s1");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 1 note to the trash, 1 skipped (no permission, or it no longer exists)", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/p1"]);
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("SA8 一篇都不能刪 → 刪除 disabled；再勾一篇可刪的 → enabled", async () => {
    stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga4");
    expect(barButton("Delete 1 selected item")).toBeDisabled();
    expect(barButton("Copy to")).toBeEnabled();
    tick("ga1");
    expect(barButton("Delete 2 selected items")).toBeEnabled();
  });

  it("SA8 最近 tab 只勾共享（viewer）→ 刪除 disabled、Copy to enabled", async () => {
    stubServer();
    renderShells({ tab: "recent" });
    await enterSelecting();
    tick("s1");
    expect(barButton("Delete 1 selected item")).toBeDisabled();
    expect(barButton("Copy to")).toBeEnabled();
  });

  it("SA9 兩篇都能編輯＋刪除 → 有 Undo", async () => {
    stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1", "ga2");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("SA10 混一篇能刪不能編輯 → 沒有 Undo、帶說明句（A2-12）", async () => {
    stubServer();
    renderShells({ tab: "workspace" });
    await enterSelecting();
    tick("ga1", "ga3");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Members of the group whose role can both edit and delete notes can restore it.", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("SA11 複製遇 429：停在第二篇、錯誤 toast＋已完成 1 篇、留在選取只留未處理的兩篇", async () => {
    const server = stubServer();
    server.fail("POST /api/notes/p2/copy", 429, "too_many_requests");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Copy to"));
    fireEvent.click(within(await pickDestination("My notes")).getByRole("button", { name: "Copy to my notes" }));
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Too many requests. Please slow down.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 note was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p1/copy", "POST /api/notes/p2/copy"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selecting()).toBe(true);
    expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["p2", "p3"]);
  });

  it("SA12 移動第一篇就 404 group_not_found：0 篇完成、兩篇仍勾", async () => {
    const server = stubServer();
    server.fail("POST /api/notes/p1/move", 404, "group_not_found");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Move to"));
    fireEvent.click(within(await pickDestination("A")).getByRole("button", { name: "Move into group" }));
    expect(await screen.findByText("We couldn't find that group.", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("0 notes were done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["POST /api/notes/p1/move"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(checkedIds()).toEqual(["p1", "p2"]);
    // 停下：焦點回開框鈕（Move to 已恢復可用）。
    expect(barButton("Move to")).toHaveFocus();
  });

  it("SA13 刪除第二篇 500：錯誤句當標題、已完成 1 篇、仍帶 Undo（只還原第一篇）、2 selected", async () => {
    const server = stubServer();
    server.fail("DELETE /api/notes/p2", 500, "internal");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    const del = barButton("Delete 3 selected items");
    fireEvent.click(del);
    expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Something went wrong. Please try again.")).toHaveClass("bg-destructive");
    expect(screen.getByText("1 note was done; the rest weren't processed.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument());
    expect(barButton("Delete 2 selected items")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(server.bodies("POST /api/trash/restore")).toEqual([{ ids: ["p1"] }]);
  });

  it("SA13b 停下時焦點已移到外部輸入框 → 不搬回刪除鈕", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    server.fail("DELETE /api/notes/p2", 500, "internal");
    renderShells({ outside: <input aria-label="probe" /> });
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    const probe = screen.getByRole("textbox", { name: "probe" });
    probe.focus();
    await releaseP1();
    expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(shellHeader(1)).getByText("2 selected")).toBeInTheDocument());
    await settleTimers();
    expect(probe).toHaveFocus();
  });

  describe("開著的那篇", () => {
    function controlsFor(state: CollabState) {
      const leavingRef = { current: false };
      const controls: NotePageControls = { noteId: "p2", state, leavingRef, openEdits: () => {} };
      return { controls, leavingRef };
    }

    it("SA14 排到最後、送它前設 leavingRef；一則 toast、導回首頁；Undo 還原三篇並導回它", async () => {
      const server = stubServer();
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      const leavingAt: Record<string, boolean> = {};
      server.onRequest((key) => {
        leavingAt[key] = leavingRef.current;
      });
      renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p2", "p1", "p3");
      fireEvent.click(barButton("Delete 3 selected items"));
      expect(await screen.findByText("Moved 3 notes to the trash", { exact: true })).toBeInTheDocument();
      expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p3", "DELETE /api/notes/p2"]);
      expect(leavingAt).toEqual({ "DELETE /api/notes/p1": false, "DELETE /api/notes/p3": false, "DELETE /api/notes/p2": true });
      // 參考（不是守衛：NotePage 沒掛，不會有它的終態 toast）。
      expect(document.querySelectorAll("li[data-swipe-direction]")).toHaveLength(1);
      await waitFor(() => expect(location()).toBe("/"));
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
      expect(await screen.findByText("Restored 3 notes", { exact: true })).toBeInTheDocument();
      expect(server.bodies("POST /api/trash/restore")).toEqual([{ ids: ["p1", "p3", "p2"] }]);
      await waitFor(() => expect(location()).toBe("/n/tester/note-p2"));
    });

    it("SA15 開著的那篇失敗、共編非終態 → leavingRef 撥回 false、不導頁", async () => {
      const server = stubServer();
      server.fail("DELETE /api/notes/p2", 500, "internal");
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
      expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
      expect(leavingRef.current).toBe(false);
      await settleTimers();
      expect(location()).toBe("/n/tester/note-p2");
    });

    it("SA15 開著的那篇失敗、共編已終態（deleted）→ 導回首頁、只有批次那一則 toast", async () => {
      const server = stubServer();
      server.fail("DELETE /api/notes/p2", 500, "internal");
      const { controls, leavingRef } = controlsFor({ phase: "deleted" });
      renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
      await waitFor(() => expect(location()).toBe("/"));
      expect(leavingRef.current).toBe(true);
      expect(document.querySelectorAll("li[data-swipe-direction]")).toHaveLength(1);
    });

    it("SA14b 批次中途在同一個 NotePage 換到別篇：送原那篇時不設（已屬於新篇的）leavingRef、成功後不導回首頁（T5 review r1 M1）", async () => {
      const server = stubServer();
      const releaseP1 = server.hold("DELETE /api/notes/p1");
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      const leavingAt: Record<string, boolean> = {};
      server.onRequest((key) => {
        leavingAt[key] = leavingRef.current;
      });
      const { host } = renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
      // Ctrl+K／wikilink 換篇：NotePage 不重掛，同一個 leavingRef、noteId 換成 p9。
      act(() => {
        void host.current?.navigate("/n/tester/note-p9");
        host.current?.setControls({ ...controls, noteId: "p9" });
      });
      expect(location()).toBe("/n/tester/note-p9");
      await releaseP1();
      expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
      expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
      expect(leavingAt["DELETE /api/notes/p2"]).toBe(false);
      expect(leavingRef.current).toBe(false);
      await settleTimers();
      expect(location()).toBe("/n/tester/note-p9");
    });

    it("SA14c 換篇後原那篇失敗：不動新篇的 leavingRef（新篇自己的單篇刪除正在走閘門）", async () => {
      const server = stubServer();
      const releaseP1 = server.hold("DELETE /api/notes/p1");
      server.fail("DELETE /api/notes/p2", 500, "internal");
      const { controls, leavingRef } = controlsFor({ phase: "connected", role: "owner" });
      const { host } = renderShells({ controls, path: "/n/tester/note-p2" });
      await enterSelecting();
      tick("p1", "p2");
      fireEvent.click(barButton("Delete 2 selected items"));
      await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
      act(() => host.current?.setControls({ ...controls, noteId: "p9" }));
      leavingRef.current = true;
      await releaseP1();
      expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
      expect(leavingRef.current).toBe(true);
    });
  });

  it("SA16 焦點在 Copy to 按 Esc → 離開選取、焦點在同一份的 Select", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    const copy = barButton("Copy to");
    copy.focus();
    fireEvent.keyDown(copy, { key: "Escape" });
    await waitFor(() => expect(selecting()).toBe(false));
    expect(selectButton(1)).toHaveFocus();
  });

  it("SA16b 目的地框開著按 Esc → 只關框、仍在選取", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Copy to"));
    const picker = await screen.findByRole("dialog", { name: "Copy to" });
    fireEvent.keyDown(document.activeElement ?? picker, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selecting()).toBe(true);
    expect(checkedIds()).toEqual(["p1"]);
  });

  it("SA17 確認框 Cancel → 仍在選取、沒有請求、焦點回開框鈕", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Move to"));
    const confirm = await pickDestination("A");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(server.keys()).toEqual([]);
    expect(selecting()).toBe(true);
    expect(barButton("Move to")).toHaveFocus();
  });

  it("SA17b 目的地框 Cancel → 焦點回 Move to（setTimeout 之後仍在）", async () => {
    stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Move to"));
    const picker = await screen.findByRole("dialog", { name: "Move to" });
    fireEvent.click(within(picker).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await settleTimers();
    expect(barButton("Move to")).toHaveFocus();
  });

  it("SA18 刪除進行中再按 → 只跑一輪", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    const del = barButton("Delete 2 selected items");
    fireEvent.click(del);
    fireEvent.click(del);
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(server.keys()).toEqual(["DELETE /api/notes/p1", "DELETE /api/notes/p2"]);
  });

  it("SA19 zh-TW：移動到、複製到、刪除選取的 2 項、已移到垃圾桶 2 篇", async () => {
    await i18n.changeLanguage("zh-TW");
    stubServer();
    renderShells();
    await waitFor(() => expect(within(shellHeader(1)).getByRole("button", { name: "選取" })).toBeEnabled());
    fireEvent.click(within(shellHeader(1)).getByRole("button", { name: "選取" }));
    await within(shellHeader(1)).findByText("已選 0 項");
    await waitFor(() => expect(bar()).not.toBeNull());
    tick("p1", "p2");
    expect(barButton("移動到")).toBeInTheDocument();
    expect(barButton("複製到")).toBeInTheDocument();
    fireEvent.click(barButton("刪除選取的 2 項"));
    expect(await screen.findByText("已移到垃圾桶 2 篇", { exact: true })).toBeInTheDocument();
    await i18n.changeLanguage("en");
  });

  it("SA20 進度：Working… 0 of 3 → 1 of 3 → 完成消失；aria-busy、三顆鈕 disabled", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    const releaseP2 = server.hold("DELETE /api/notes/p2");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent("Working… 0 of 3"));
    expect(bar()).toHaveAttribute("aria-busy", "true");
    for (const name of ["Move to", "Copy to", "Delete 3 selected items"]) expect(barButton(name)).toBeDisabled();
    // 另一份動作列也顯示（同一個 provider）。
    expect(within(bar(0)).getByRole("status")).toHaveTextContent("Working… 0 of 3");
    await releaseP1();
    await waitFor(() => expect(within(bar()).getByRole("status")).toHaveTextContent("Working… 1 of 3"));
    await releaseP2();
    expect(await screen.findByText("Moved 3 notes to the trash", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
    expect(shell(1).querySelector("[data-select-action-bar]")).toBeNull();
  });

  it("SA20 進度列結束後消失（停下仍在選取時）、aria-busy 回 false", async () => {
    const server = stubServer();
    server.fail("DELETE /api/notes/p2", 500, "internal");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    expect(await screen.findByText("Something went wrong. Please try again.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(within(bar()).queryByRole("status")).toBeNull());
    expect(bar()).toHaveAttribute("aria-busy", "false");
  });

  it("SA21 全被 server 略過（兩支 403）→ Nothing was done…（destructive）、沒有 Undo、離開選取", async () => {
    const server = stubServer();
    server.fail("DELETE /api/notes/p1", 403, "forbidden");
    server.fail("DELETE /api/notes/p2", 403, "forbidden");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    const title = "Nothing was done; 2 skipped (no permission, or they no longer exist)";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    await waitFor(() => expect(selecting()).toBe(false));
  });

  it("SA22 送出中確認框關不掉（Esc、✕、點框外）、框內有進度；放行後才關、toast、離開選取、焦點在 Select", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("POST /api/notes/p1/copy");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("My notes");
    fireEvent.click(within(confirm).getByRole("button", { name: "Copy to my notes" }));
    await waitFor(() => expect(within(confirm).getByRole("status")).toHaveTextContent("Working… 0 of 3"));

    fireEvent.keyDown(document.activeElement ?? confirm, { key: "Escape" });
    await settleTimers();
    expect(screen.getByRole("dialog", { name: "Copy to my notes" })).toBe(confirm);

    fireEvent.click(within(confirm).getByRole("button", { name: "Close" }));
    await settleTimers();
    expect(screen.getByRole("dialog", { name: "Copy to my notes" })).toBe(confirm);

    // 點框外：送出中由 progress 包裝（onOpenChange(false) 一律忽略）與 dismissOnOutside={false} 兩道都擋；後者單獨由 SA22c 守。
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Copy to my notes" })).toBe(confirm);
    expect(within(confirm).getByRole("button", { name: "Copy to my notes" })).toBeDisabled();
    expect(within(confirm).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(selecting()).toBe(true);

    await releaseP1();
    expect(await screen.findByText("Copied 3 notes to My notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(selecting()).toBe(false);
    expect(selectButton(1)).toHaveFocus();
    await settleTimers();
    expect(selectButton(1)).toHaveFocus();
  });

  it("SA22c 送出前點確認框外面不關框（dismissOnOutside={false}）；Cancel 才關", async () => {
    const server = stubServer();
    renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Copy to"));
    const confirm = await pickDestination("My notes");
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Copy to my notes" })).toBe(confirm);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.keys()).toEqual([]);
  });

  it("SA22b 成功時焦點已移到外部輸入框 → 選取結束、焦點仍在外部", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells({ outside: <main><input aria-label="probe" /></main> });
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    const probe = screen.getByRole("textbox", { name: "probe" });
    probe.focus();
    await releaseP1();
    expect(await screen.findByText("Moved 3 notes to the trash", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(selecting()).toBe(false));
    await settleTimers();
    expect(probe).toHaveFocus();
  });

  it("SA22d 中途按 Done（動作列卸載）後焦點移到同一側欄的筆記連結 → 成功結束時不搶焦點（mountedRef）", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
    fireEvent.click(doneButton());
    await waitFor(() => expect(selecting()).toBe(false));
    const link = await within(shell(1)).findByRole("link", { name: "p3" });
    link.focus();
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    await settleTimers();
    expect(link).toHaveFocus();
  });

  it("SA25 批次中途丟例外：鎖照樣釋放、確認框關掉、動作列恢復（收尾在 finally）", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("POST /api/notes/p1/copy");
    const { queryClient } = renderShells();
    await enterSelecting();
    tick("p1");
    fireEvent.click(barButton("Copy to"));
    fireEvent.click(within(await pickDestination("My notes")).getByRole("button", { name: "Copy to my notes" }));
    await waitFor(() => expect(within(bar()).getByRole("status", { hidden: true })).toHaveTextContent("Working… 0 of 1"));
    // 批次自己的 finally（整批失效）丟例外 → runBatch reject；拿走 vitest 的 unhandledRejection 監聽、只收這一個。
    const boom = new Error("boom");
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(() => {
      throw boom;
    });
    const caught: unknown[] = [];
    const saved = process.listeners("unhandledRejection");
    process.removeAllListeners("unhandledRejection");
    process.on("unhandledRejection", (reason) => {
      caught.push(reason);
    });
    try {
      await releaseP1();
      await waitFor(() => expect(caught).toEqual([boom]));
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const listener of saved) process.on("unhandledRejection", listener);
      vi.mocked(queryClient.invalidateQueries).mockRestore();
    }
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(bar()).queryByRole("status")).toBeNull();
    expect(bar()).toHaveAttribute("aria-busy", "false");
    expect(barButton("Copy to")).toBeEnabled();
    expect(selecting()).toBe(true);
  });

  it("SA24 中途 Done 又 Select、勾 p3 → 舊那輪停下也不覆蓋新的選取", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    server.fail("DELETE /api/notes/p2", 429, "too_many_requests");
    renderShells();
    await enterSelecting();
    tick("p1", "p2", "p3");
    fireEvent.click(barButton("Delete 3 selected items"));
    await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
    fireEvent.click(doneButton());
    await waitFor(() => expect(selecting()).toBe(false));
    await enterSelecting();
    tick("p3");
    await releaseP1();
    expect(await screen.findByText("Too many requests. Please slow down.", { exact: true })).toBeInTheDocument();
    await settleTimers();
    expect(within(shellHeader(1)).getByText("1 selected")).toBeInTheDocument();
    expect(checkedIds()).toEqual(["p3"]);
  });

  it("SA24b Done→Select 後新掛的動作列在舊那輪跑完前顯示進度、不能按；放行後恢復", async () => {
    const server = stubServer();
    const releaseP1 = server.hold("DELETE /api/notes/p1");
    renderShells();
    await enterSelecting();
    tick("p1", "p2");
    fireEvent.click(barButton("Delete 2 selected items"));
    await waitFor(() => expect(server.keys()).toEqual(["DELETE /api/notes/p1"]));
    fireEvent.click(doneButton());
    await waitFor(() => expect(selecting()).toBe(false));
    await enterSelecting();
    tick("p3");
    expect(within(bar()).getByRole("status")).toHaveTextContent("Working… 0 of 2");
    expect(bar()).toHaveAttribute("aria-busy", "true");
    for (const name of ["Move to", "Copy to", "Delete 1 selected item"]) expect(barButton(name)).toBeDisabled();
    fireEvent.click(barButton("Delete 1 selected item"));
    expect(server.keys()).toEqual(["DELETE /api/notes/p1"]);
    await releaseP1();
    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    // 舊那輪的 session 已換：新選取不被結束；鈕恢復可按。
    await waitFor(() => expect(within(bar()).queryByRole("status")).toBeNull());
    expect(selecting()).toBe(true);
    expect(checkedIds()).toEqual(["p3"]);
    expect(barButton("Delete 1 selected item")).toBeEnabled();
    expect(barButton("Move to")).toBeEnabled();
  });
});
