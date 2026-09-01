import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { canonicalNotePath, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";

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
};

/** 停在 `/n/:handle/:slug`（#122 新形）的替身頁——把解析到的兩段印出來，讓斷言看得到落點。 */
function NoteRouteProbe() {
  const { handle, slug } = useParams<{ handle: string; slug: string }>();
  return <div data-testid="note-route">{`${handle}/${slug}`}</div>;
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
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(CREATED) }));
        }
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

  it("shows an error toast and stays put when POST /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
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
// AppShell → NoteList 的 query 接線是否真的讓側欄清單縮減。兩篇 owner 筆記時
// 「最近」跟「我的筆記」會重複顯示同一篇（見 `NoteList` 檔頭），所以下面一律
// 用 `getAllByRole`/`queryAllByRole` 而不是單數版本，避免因重複命中而 throw。
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
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(notes) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  function renderShell() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <AppShell>home</AppShell>
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

  it("real path: typing in the search box actually shrinks the sidebar note list (AppShell → NoteList query wiring)", async () => {
    stubFetchWithNotes([ALPHA_NOTE, BETA_NOTE]);
    renderShell();

    const input = await screen.findByRole("textbox", { name: "Search notes" });
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Beta Note" }).length).toBeGreaterThan(0));

    fireEvent.change(input, { target: { value: "Alpha" } });

    await waitFor(() => expect(screen.queryAllByRole("link", { name: "Beta Note" })).toHaveLength(0));
    expect(screen.getAllByRole("link", { name: "Alpha Note" }).length).toBeGreaterThan(0);
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
  };

  function stubFetchWithNotes(notes: NoteDto[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
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
  function renderShell(children: ReactNode = <SidebarDrawerButton />) {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <AppShell>{children}</AppShell>
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
    // 同一篇筆記會同時落在「最近」與「我的筆記」兩組（NoteList 既有行為）——用複數查詢。
    expect(within(drawer).getAllByRole("link", { name: "Drawer Note" }).length).toBeGreaterThan(0);
  });

  it("點抽屜裡的筆記（route change）→ 抽屜關閉", async () => {
    stubFetchWithNotes([NOTE]);
    renderShell();

    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });

    fireEvent.click(within(drawer).getAllByRole("link", { name: "Drawer Note" })[0]);

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

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });

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
});
