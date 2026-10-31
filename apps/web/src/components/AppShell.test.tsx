import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { canonicalNotePath, type GroupDto, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { NotePageControlsContext } from "@/lib/note-page-controls";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { adminRole, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";

// `sidebar.tab` 的 localStorage 往外洩：一個案切了 tab，同檔後面找個人筆記的案會在錯的 tab 找不到。
afterEach(() => localStorage.removeItem("sidebar.tab"));

// 「新增筆記 → 導向新筆記頁」的接線案——#122 起導向的是 /n/<handle>/<slug> 新形，
// probe 掛在 /n/:handle/:slug 底下（新形 route 的承接由 App.resetKey.test control 3 守；
// 舊形由同檔主案/control 2 與 App.errorBoundary.test 案 11 守）。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

const CREATED: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "untitled-33333333",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

/** 停在 `/n/:handle/:slug`（#122 新形）的替身頁——把解析到的兩段印出來，讓斷言看得到落點。 */
function NoteRouteProbe() {
  const { handle, slug } = useParams<{ handle: string; slug: string }>();
  return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
}

/** 停在 `/g/:groupId/:slug`（#175 群組筆記）的替身頁。 */
function GroupNoteRouteProbe() {
  const { groupId, slug } = useParams<{ groupId: string; slug: string }>();
  return <div data-testid="group-note-route">{`${groupId}/${slug}`}</div>;
}

describe("AppShell — new note", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates to the created note's canonical path after POST /api/notes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(CREATED) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    // #122：新筆記吃 DB default 的 `untitled-<uuid8>` slug → canonical 是
    // `/n/<ownerHandle>/<slug>`（新形單一態）。
    const expectedSegments = canonicalNotePath(CREATED).replace("/n/", ""); // "handle/slug" 兩段
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent(expectedSegments));
  });

  it("#103／#175：群組段的「＋」以 groupId 建筆記並導向新筆記的 /g/ 網址", async () => {
    // #175 gate r1 B-M8：這個 fixture 以前沒標 `GroupDto`、`myRole: "admin"` 是字串——tsc 不報，
    // 但「＋」改看 `myRole.permissions.create` 之後會丟 TypeError。現在標型別並走共用 helper。
    const group: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
    // 群組筆記（#175）：無個人 owner、role 從不是 owner、canonical 是 `/g/<groupId>/<slug>`。
    const created: NoteDto = {
      ...CREATED,
      id: "77777777-7777-7777-7777-777777777777",
      ownerId: null,
      ownerHandle: null,
      role: "editor",
      slug: "untitled-77777777",
      groupId: group.id,
      group: { id: group.id, name: group.name },
      permissions: { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
    };
    let postBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([group]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          postBody = JSON.parse(String(init?.body));
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([CREATED]) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
                <Route path="/g/:groupId/:slug" element={<GroupNoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    // 群組列在「群組」tab（預設 tab 是「我的筆記」）。
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));
    fireEvent.click(await screen.findByRole("button", { name: "New note in Workshop A" }));

    await waitFor(() => expect(postBody).toEqual({ groupId: group.id }));
    expect(canonicalNotePath(created)).toBe(`/g/${group.id}/untitled-77777777`);
    await waitFor(() =>
      expect(screen.getByTestId("group-note-route")).toHaveTextContent(`${group.id}/untitled-77777777`),
    );
  });

  it("shows an error toast and stays put when POST /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
            }),
          );
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(screen.queryByTestId("note-route")).not.toBeInTheDocument();
  });
});

// AppShell 的搜尋框與 Ctrl/Cmd+K：聚焦搜尋框、Esc 清空+blur、以及
// AppShell → SearchResults 的 query 接線（搜尋中換成扁平結果視圖）。結果列的可及名稱是
// 「標題 位置」，所以以 `^標題` regex 取列，不用全字比對（全字比對的負向斷言會空轉）。
describe("AppShell — search box & Ctrl/Cmd+K", () => {
  const ALPHA_NOTE: NoteDto = {
    id: "44444444-4444-4444-4444-444444444444",
    title: "Alpha Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "alpha-note",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };

  const BETA_NOTE: NoteDto = {
    id: "55555555-5555-5555-5555-555555555555",
    title: "Beta Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2025-12-01T00:00:00.000Z",
    slug: "beta-note",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  function renderShell(inert?: boolean) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <AppShell inert={inert}>home</AppShell>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("Ctrl+K focuses the search box and prevents the browser's default (address-bar search)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(input).not.toHaveFocus();

    // `fireEvent` 回傳 `dispatchEvent` 的結果：cancelable 事件被 `preventDefault()`
    // 攔下時回傳 `false`——藉此在不碰內部實作的前提下斷言 `defaultPrevented`。
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).toHaveFocus();
    expect(notCanceled).toBe(false);
  });

  it("Cmd+K (metaKey) also focuses the search box", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(input).toHaveFocus();
  });

  // review B1：BlockNote 的建立連結工具在編輯器 DOM 上綁原生 keydown 監聽
  // Ctrl/Cmd+K，`preventDefault()` 但不 `stopPropagation()`，事件仍會冒泡到
  // `window`——若 AppShell 不放行會搶在編輯器前面把焦點拉去搜尋框。這裡直接在
  // dispatch 前呼叫 `event.preventDefault()`，模擬「已經有人處理過這個按鍵」
  // 抵達 AppShell 的 handler 時的狀態，不需要真的掛一個 NoteEditor。
  it("Ctrl+K is ignored when the event arrives already defaultPrevented (e.g. BlockNote's own create-link shortcut) — no focus", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const event = new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(input).not.toHaveFocus();
  });

  it("Ctrl+K is ignored while a [role=\"dialog\"] is open on the page — no focus, no preventDefault", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    // 不需要真的開一個 Radix Dialog——handler 只檢查 DOM 上有沒有這個選擇器。
    render(<div role="dialog">fake dialog</div>);

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).not.toHaveFocus();
    expect(notCanceled).toBe(true);
  });

  // 釘住 AppShell.tsx 檔頭「⋮ 選單是 role="menu"，不在這個判定範圍內」的宣稱：
  // ⋮ 選單開著時（`role="menu"`，不是 `role="dialog"`）Ctrl+K 仍會觸發並把焦點
  // 搶去搜尋框——跟上面 `role="dialog"` 那案是刻意的一組對照。
  it("Ctrl+K still triggers while a [role=\"menu\"] (⋮ dropdown) is open — only [role=\"dialog\"] is excluded", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    render(<div role="menu">fake ⋮ menu</div>);

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });

    expect(input).toHaveFocus();
    expect(notCanceled).toBe(false);
  });

  it("shortcut badge: Mac platform shows ⌘K, non-Mac shows Ctrl K", async () => {
    // AppShell 只讀 `navigator.platform`，最小替身即足——`{ ...navigator, … }`
    // 的 spread 是空的（jsdom 的 navigator 屬性全在原型鏈上，不是 own
    // property，object spread 拷貝不到），改用明確最小替身避免誤導。
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    vi.stubGlobal("navigator", { platform: "MacIntel" } as Navigator);
    const { unmount } = renderShell();
    expect(await screen.findByText("⌘K")).toBeInTheDocument();
    unmount();

    vi.stubGlobal("navigator", { platform: "Win32" } as Navigator);
    renderShell();
    expect(await screen.findByText("Ctrl K")).toBeInTheDocument();
  });

  it("按鍵語意刻意釘死：Ctrl+Shift+K 不觸發（嚴格比對 event.key===\"k\"，Shift 讓瀏覽器回報大寫 \"K\"）", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    const notCanceled = fireEvent.keyDown(window, { key: "K", ctrlKey: true, shiftKey: true });

    expect(input).not.toHaveFocus();
    expect(notCanceled).toBe(true);
  });

  it("Escape clears the search box and blurs it", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: "Alpha" } });
    input.focus();
    expect(input).toHaveValue("Alpha");
    expect(input).toHaveFocus();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
  });

  it("real path: typing in the search box actually shrinks the sidebar note list (AppShell → SearchResults query wiring)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(screen.getAllByRole("link", { name: /^Beta Note/ }).length).toBeGreaterThan(0));

    fireEvent.change(input, { target: { value: "Alpha" } });

    const results = await screen.findByTestId("sidebar-search");
    await within(results).findByRole("link", { name: /^Alpha Note/ });
    expect(screen.queryAllByRole("link", { name: /^Beta Note/ })).toHaveLength(0);
  });

  it("AS-S1：搜尋中 tab 列與 tabpanel 都不渲染；Esc 後 tablist 回來、原 tab 仍選中", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(input, { target: { value: "Alpha" } });
    await screen.findByTestId("sidebar-search");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tabpanel")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByTestId("sidebar-search")).toBeNull();
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  });

  it("AS-S2：清除鈕——空字串時沒有、有 Ctrl K 徽章；有字時換成清除鈕；點了清空、焦點留在輸入框、tablist 回來", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.getByText("Ctrl K")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));

    fireEvent.change(input, { target: { value: "Alpha" } });
    const clear = await screen.findByRole("button", { name: "Clear search" });
    expect(screen.queryByText("Ctrl K")).toBeNull();

    fireEvent.click(clear);
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(await screen.findByRole("tablist")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Groups" })).toHaveAttribute("aria-selected", "true");
  });

  it("只有空白也算搜尋中（現行行為）：換成搜尋視圖、出現清除鈕", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    fireEvent.change(input, { target: { value: " " } });
    await screen.findByTestId("sidebar-search");
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });

  it("AS-S3：點結果換頁後搜尋字串保留、搜尋視圖仍在（可連開好幾個結果）", async () => {
    const one: NoteDto = { ...ALPHA_NOTE, id: "77777777-7777-7777-7777-777777777771", title: "Alpha One", slug: "a" };
    const two: NoteDto = { ...ALPHA_NOTE, id: "77777777-7777-7777-7777-777777777772", title: "Alpha Two", slug: "b" };
    stubFetchWithNotes([one, two]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/n/tester/a"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route
                  path="/n/:handle/:slug"
                  element={
                    <AppShell>
                      <NoteRouteProbe />
                    </AppShell>
                  }
                />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const input = await screen.findByRole("textbox", { name: "Search notes" });
    expect(screen.getByTestId("note-route")).toHaveTextContent("tester/a");
    fireEvent.change(input, { target: { value: "alpha" } });
    const results = await screen.findByTestId("sidebar-search");
    fireEvent.click(await within(results).findByRole("link", { name: /^Alpha Two/ }));

    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent("tester/b"));
    expect(input).toHaveValue("alpha");
    expect(screen.getByTestId("sidebar-search")).toBeInTheDocument();
  });

  it("#229：inert 傳 true → AppShell 根 div 帶 inert 屬性；不傳 → 沒有", async () => {
    stubFetchWithNotes([ALPHA_NOTE]);
    const first = renderShell(true);
    await screen.findByRole("textbox", { name: "Search notes" });
    expect(first.container.querySelector(".h-screen")).toHaveAttribute("inert");
    first.unmount();
    const second = renderShell();
    await screen.findByRole("textbox", { name: "Search notes" });
    expect(second.container.querySelector(".h-screen")).not.toHaveAttribute("inert");
  });
});

/**
 * #115：側欄抽屜（<md 的導覽入口）。
 *
 * jsdom 沒有 CSS——`hidden`/`md:flex` 不影響可及性查詢，抽屜開著時 DOM 上同時有
 * 靜態與抽屜兩份 SidebarContent，因此本組查詢一律 `within(drawer)` 圈定，不用
 * 全域 byRole（spec §3a 雙實例定案）。
 *
 * matchMedia：`test/setup.ts` 的 stub 恆 `matches:false` 且 addEventListener 是
 * no-op——「Ctrl+K 窄分支」與「跨斷點 resize 關閉」兩案必須自己 stub 一個可控的
 * MediaQueryList（自持 listener 集合＋手動 dispatch change），否則寫出「掛了
 * listener 但永遠不會觸發」的實作照樣全綠（plan gate B2 的指名陷阱）。
 */
describe("AppShell — #115 側欄抽屜", () => {
  const NOTE: NoteDto = {
    id: "66666666-6666-6666-6666-666666666666",
    title: "Drawer Note",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "drawer-note",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  /** 可控 matchMedia stub：回傳「觸發 change」的把手。`matches` 是初值，之後由
   * dispatch 帶的值決定（實作讀 event.matches）。 */
  function stubControllableMatchMedia(initialMatches: boolean) {
    const listeners = new Set<(e: { matches: boolean }) => void>();
    const mql = {
      matches: initialMatches,
      media: "(width < 48rem)",
      addEventListener: (_: "change", fn: (e: { matches: boolean }) => void) => listeners.add(fn),
      removeEventListener: (_: "change", fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    vi.stubGlobal("matchMedia", vi.fn(() => mql));
    return {
      dispatchChange(matches: boolean) {
        mql.matches = matches;
        for (const fn of listeners) fn({ matches });
      },
      listenerCount: () => listeners.size,
    };
  }

  // 漢堡鈕在頁面層（NotePage 頁首／NarrowTopBar），AppShell 本體沒有——harness 自己
  // 當那個消費端，把 SidebarDrawerButton 放進 children。
  // `wrap`：要包在 `<AppShell>` **外面**的 provider（例如 NotePage 提供的 NotePageControlsContext）
  // ——children 插槽在 AppShell 裡面，放不進去。
  function renderShell(
    children: ReactNode = <SidebarDrawerButton />,
    wrap: (shell: ReactNode) => ReactNode = (shell) => shell,
  ) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              {wrap(<AppShell>{children}</AppShell>)}
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("點漢堡開抽屜：dialog 有可及名稱、掛 data-sidebar-drawer、bg-card flex flex-col；內容含搜尋框與筆記列", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    // 不變量四件套（spec §3a：缺底色透出 overlay 黑、缺 flex 脈絡長清單擠出鈕、
    // 缺屬性則 Ctrl+K 讓路判別失效）。
    expect(drawer).toHaveAttribute("data-sidebar-drawer");
    expect(drawer).toHaveClass("fixed", "inset-y-0", "left-0", "z-50", "flex", "w-64", "flex-col", "bg-card");
    // 漢堡開＝焦點落在抽屜容器本身（不聚焦搜尋框以免觸控彈鍵盤）——這一步武裝
    // Radix 的 focus trap；onOpenAutoFocus 只 preventDefault 不補聚焦的錯誤實作
    // 會讓焦點留在漢堡鈕、Tab 逃進 aria-hidden 背景（審查突變實證原本沒案子抓）。
    expect(drawer).toHaveFocus();

    expect(within(drawer).getByRole("textbox", { name: "Search notes" })).toBeInTheDocument();
    // 預設 tab 是「我的筆記」，個人筆記只列在那一個面板（單數查詢）。
    expect(await within(drawer).findByRole("link", { name: "Drawer Note" })).toBeInTheDocument();
  });

  it("點抽屜裡的筆記（route change）→ 抽屜關閉", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    fireEvent.click(await within(drawer).findByRole("link", { name: "Drawer Note" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("開抽屜→Esc 關→Ctrl+K 仍聚焦**靜態**搜尋框（兩實例 ref 不共用；共用 ref 會在抽屜 unmount 時被清成 null）", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    fireEvent.keyDown(drawer, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

    // 抽屜關了，畫面上只剩靜態那份搜尋框。
    const input = screen.getByRole("textbox", { name: "Search notes" });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(input).toHaveFocus();
  });

  it("Ctrl+K 窄分支（matchMedia matches:true）：開抽屜並聚焦抽屜內搜尋框", async () => {
    stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell();
    await screen.findByRole("button", { name: "Open navigation" });

    // 回傳 false＝事件被 preventDefault（窄視窗按 Ctrl+K 不能同時觸發瀏覽器網址列搜尋）。
    const notCanceled = fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(notCanceled).toBe(false);

    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    await waitFor(() => expect(within(drawer).getByRole("textbox", { name: "Search notes" })).toHaveFocus());
  });

  it("跨斷點 resize（change → matches:false）→ 抽屜關閉", async () => {
    const media = stubControllableMatchMedia(true);
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    await screen.findByRole("dialog", { name: "Navigation" });
    expect(media.listenerCount()).toBeGreaterThan(0);

    act(() => {
      media.dispatchChange(false);
    });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  });

  it("抽屜裡對開著的那篇按 AI 修改紀錄：呼叫 openEdits 並關抽屜（不導頁，所以 pathname effect 關不了它）", async () => {
    stubFetchWithNotes([NOTE]);
    const openEdits = vi.fn();
    renderShell(<SidebarDrawerButton />, (shell) => (
      <NotePageControlsContext.Provider
        value={{ noteId: NOTE.id, state: { phase: "connected", role: "owner" }, leavingRef: { current: false }, openEdits }}
      >
        {shell}
      </NotePageControlsContext.Provider>
    ));

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    const section = await within(drawer).findByRole("tabpanel");
    fireEvent.pointerDown(await within(section).findByRole("button", { name: "Note actions for Drawer Note" }), { button: 0 });
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "AI edit history" }));

    expect(openEdits).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.querySelector("[data-sidebar-drawer]")).toBeNull());
  });
});

// ── 在資料夾建立筆記（資料夾 PR-3b-1 T2；spec §6.4、§6.8）
describe("AppShell — 在資料夾建立筆記", () => {
  const G: GroupDto = groupDto({ id: "G", name: "G" }, adminRole());
  const FOLDERS = [folderDto({ id: "A", name: "A" }), groupFolder({ id: "GF", name: "GF", groupId: "G" })];

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    __resetCollapseForTests();
    __resetFolderSortForTests();
  });

  function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  /** `post`：POST /api/notes 的回應；每次 POST 的 body 記進回傳的陣列。 */
  function stubCreate(post: () => Response) {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/notes" && method === "POST") {
          bodies.push(JSON.parse(String(init?.body)));
          return Promise.resolve(post());
        }
        if (url === "/api/folders") return Promise.resolve(json({ folders: FOLDERS }));
        if (url === "/api/notes" && method === "GET") return Promise.resolve(json([]));
        if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G]));
        if (url === "/api/auth/me") return Promise.resolve(json(USER));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return bodies;
  }

  function renderShell() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>home</AppShell>} />
                <Route path="/n/:handle/:slug" element={<NoteRouteProbe />} />
                <Route path="/g/:groupId/:slug" element={<GroupNoteRouteProbe />} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  const fail = (status: number, code: string) => () => json({ error: { code, message: "x" } }, status);

  it("AS-F1 個人資料夾「＋」→ body {folderId}、導到新筆記、資料夾寫成展開", async () => {
    setCollapsed("folder:A", true);
    const bodies = stubCreate(() => json(CREATED, 201));
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "New note in A" }));
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent("tester/untitled-33333333"));
    expect(bodies).toEqual([{ folderId: "A" }]);
    expect(isCollapsed("folder:A")).toBe(false);
  });

  it("AS-F1 群組資料夾「＋」→ body {groupId, folderId}", async () => {
    const created: NoteDto = { ...CREATED, ownerId: null, ownerHandle: null, role: "editor", groupId: "G", group: { id: "G", name: "G" } };
    const bodies = stubCreate(() => json(created, 201));
    renderShell();
    fireEvent.click(await screen.findByRole("tab", { name: "Groups" }));
    fireEvent.click(await screen.findByRole("button", { name: "New note in GF" }));
    await waitFor(() => expect(bodies).toEqual([{ groupId: "G", folderId: "GF" }]));
    await waitFor(() => expect(screen.getByTestId("group-note-route")).toHaveTextContent(`G/${CREATED.slug}`));
  });

  it("AS-F2 404 folder_not_found → toast「Folder not found.」、失效 ['folders']、不導頁", async () => {
    stubCreate(fail(404, "folder_not_found"));
    const queryClient = renderShell();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(await screen.findByRole("button", { name: "New note in A" }));
    await waitFor(() => expect(screen.getByText("Folder not found.")).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith({ queryKey: ["folders"] });
    expect(screen.getByText("home")).toBeInTheDocument();
  });

  it("AS-F3 409 folder_too_deep → toast 帶入上限、不含 {{max}}", async () => {
    stubCreate(fail(409, "folder_too_deep"));
    renderShell();
    fireEvent.click(await screen.findByRole("button", { name: "New note in A" }));
    await waitFor(() => expect(screen.getByText("Folders can be at most 5 levels deep.")).toBeInTheDocument());
    expect(screen.queryByText(/\{\{max\}\}/)).toBeNull();
  });
});
