import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, useNavigate, type MemoryRouterProps } from "react-router";
import * as Y from "yjs";
import type { GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { CollabState } from "@/collab/connection";
import { adminRole, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { clickOutside } from "@/test/outside-click";

// 設定總 modal（spec §13.4）：兩棵 Routes 樹＋modal-over-background 機制，一律用真正的
// `AppRoutes`（App.tsx 的唯一真相樹）跑，不拆開各自重建等價樹——驗證的是「有沒有接對」
// （guard 複用、backgroundLocation 相依、Dialog layout route 不重掛），而不只是
// `SettingsModal` 元件單獨渲染的行為。fetch mock 慣例同 `ChangePasswordPage.test.tsx`
// （mock 全域 fetch，不 mock hook 本身）。
//
// 背景頁若是 `/notes/:ref`，`NotePage` 需要 `useCollab`（Hocuspocus/WebSocket）與真正
// BlockNote 編輯器——兩者都不在 jsdom 測試範圍內（連線狀態機有 connection.test.ts
// 全覆蓋，編輯器本身留給手動驗證），這裡沿用 `NotePage.test.tsx` 既有的最小替身慣例：
// 只驗證「背景頁有沒有掛上」，不驗證編輯器/共編細節。

// PR2（BLK-1）：NoteEditor slot 化——這支替身沿用 NotePage.test.tsx 的最小替身慣例
// （兩處綁定，見該檔的 mock），改吃 headerSlot/footerSlot 並原樣渲染，否則
// `:239` 的 `getByLabelText("Note title")`（headerSlot 裡的 TitleInput）會落空。
vi.mock("@/components/NoteEditor", () => ({
  NoteEditor: ({
    editable,
    headerSlot,
    footerSlot,
  }: {
    editable: boolean;
    headerSlot?: ReactNode;
    footerSlot?: ReactNode;
  }) => (
    <div data-testid="note-editor" data-editable={String(editable)}>
      {headerSlot}
      {footerSlot}
    </div>
  ),
}));

// #201：群組角色區塊在本檔只拿來驗「區塊 chunk 載入失敗被 modal 內的 boundary 接住」——
// 替身直接丟 chunk 失敗的訊息（真實 lazy reject 經 Suspense 後也是以 render throw 抵達
// boundary；Vite preload 那條訊息見 ErrorBoundary.tsx 的白名單）。本檔其餘案子不碰這一區。
vi.mock("@/settings/SettingsGroupRolesSection", () => ({
  SettingsGroupRolesSection: () => {
    throw new Error("Failed to fetch dynamically imported module: https://x/assets/SettingsGroupRolesSection-abc.js");
  },
}));

function createStubProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    // issue #48：背景頁是一篇正常開著、已同步的筆記——NotePage 現在用 synced 閘住 editable。
    synced: true,
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
  };
}

const collab = vi.hoisted(() => ({
  state: { phase: "connecting" } as CollabState,
  onUnauthorized: undefined as (() => void) | undefined,
  doc: undefined as unknown as Y.Doc,
  provider: undefined as unknown as ReturnType<typeof createStubProvider>,
  /** #179：每次 render 傳進 useCollab 的 noteId（真實 useCollab 依它拆線／重連）。測試自行清空。 */
  noteIds: [] as (string | undefined)[],
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ noteId, onUnauthorized }: { noteId: string | undefined; onUnauthorized: () => void }) => {
    collab.noteIds.push(noteId);
    collab.onUnauthorized = onUnauthorized;
    return { state: collab.state, doc: collab.doc, provider: collab.provider, synced: collab.provider.synced };
  },
}));

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const ADMIN_USER: UserDto = {
  id: "u-admin",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};
const PLAIN_USER: UserDto = {
  id: "u-plain",
  email: "plain@example.com",
  handle: "tester",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u-plain",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
};

/** 基本 fetch mock：`/api/auth/me`（依
 * `getLoggedInAs` 回登入者或 401）、`/api/notes`（清單，空陣列）、`/api/notes/:ref`
 * （單篇，固定回 `NOTE`）、backlinks（空）——路由守衛與 HomePage/NotePage 共同需要
 * 這些。呼叫端可疊加其餘端點的處理（例如 `POST /api/auth/password`）。 */
function baseFetchHandlers(getLoggedInAs: () => UserDto | null) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      const user = getLoggedInAs();
      if (user) return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
      return fakeResponse({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
      });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/tokens" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) });
    }
    if (url === "/api/storage" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ usedBytes: 0, quotaBytes: 2147483648, planName: "Basic" }) });
    }
    if (url.endsWith("/backlinks") && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) });
    }
    if (url.startsWith("/api/notes/") && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(NOTE) });
    }
    // 站台管理頁（/admin/users）：`/settings/users` 轉址過去後會打這支。
    if (url === "/api/admin/users" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

/** 真實 location（MemoryRouter 內、兩棵 Routes 之外）——斷言轉址／關閉後的落點。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}</div>;
}

/** #179：模擬瀏覽器「上一頁」（MemoryRouter 的 navigate(-1)）。由 `HistoryNavHandle` 掛上。 */
const historyNav: { back?: () => void; push?: (to: string) => void } = {};
function HistoryNavHandle() {
  const navigate = useNavigate();
  useEffect(() => {
    historyNav.back = () => void navigate(-1);
    historyNav.push = (to) => void navigate(to);
    return () => {
      historyNav.back = undefined;
      historyNav.push = undefined;
    };
  }, [navigate]);
  return null;
}

function renderAt(
  initialEntries: NonNullable<MemoryRouterProps["initialEntries"]>,
  fetchMock: ReturnType<typeof vi.fn>,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={initialEntries}>
          <ActiveNoteProvider>
            <AppRoutes />
            <LocationProbe />
            <HistoryNavHandle />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** DropdownMenuTrigger（`UserMenu`）只掛 `onPointerDown`（見 `@radix-ui/react-dropdown-menu`
 * 原始碼），純 `fireEvent.click` 開不了——這裡跟 jsdom 對 pointer event 的相容性有關，
 * 不是 bug；已用一支即棄的 scratch 測試實測驗證過（開發過程中跑過、未留痕）。 */
function openUserMenu(userDisplayName: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: userDisplayName }), { button: 0 });
}

describe("SettingsModal（spec §13.4：兩棵 Routes 樹、modal-over-background）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
  });

  it("app 內從 /notes/x 開設定（UserMenu「Settings」入口）→ modal 與背景頁共存 DOM；關閉 → 回到背景 /notes/x", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/notes/my-note"], fetchMock);

    // timeout 3s：這裡等的是**真實** NotePage lazy import（整條 BlockNote 相依鏈）
    // ——全 suite 唯一用 waitFor 等真動態 import 的地方，預設 1s 在冷啟高負載下
    // 餘裕太薄，會間歇性紅（#69 審查實測；#66 那輪首跑的一次紅疑同源）。
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    // 背景頁（NotePage 的替身編輯器）仍在 DOM 裡——兩者共存，不是背景被卸載換成 modal。
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 關閉後仍落在背景 location（開設定前 NotePage 已把 /notes/my-note 收斂成 /n/tester/my-note，
    // #179 起收斂走 router，背景記的就是它）——編輯器替身仍在，不是被導去別處。
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
  });

  it("backgroundLocation 跨區塊切換仍保留：/notes/x 開設定 → 切到 Groups → 關閉 → 回到 /notes/x（不是回退到 /）", async () => {
    // 這一案專門守 `SettingsNavLink` 的 `state={backgroundLocation ? {...} : undefined}`
    // ——沒有它，區塊互切一次後 `location.state.backgroundLocation` 就會變 undefined，
    // 關閉時只能落回 `/`，靜默扯掉背景 `/notes/:ref` 的共編 provider。
    // （站台管理搬到 /admin/* 後，modal 只剩帳號／群組兩項，切的是 Groups。）
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/notes/my-note"], fetchMock);

    // 同前案：等真實 lazy import，3s（見上）
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });

    fireEvent.click(within(screen.getByRole("navigation")).getByText("Groups"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument(), {
      timeout: 3_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 3_000 });
    // 落在這篇筆記（背景已收斂成 /n/tester/my-note，見上一案），不是被錯誤地帶回 /：`AppShell`（HomePage 也用同一個殼）
    // 一律有「New note」按鈕，不能拿來分辨兩者，這裡改斷言 `NotePage` 特有的內容——
    // 編輯器替身仍在，且標題輸入框帶著這篇筆記的標題（HomePage 沒有這個欄位；
    // 若 backgroundLocation 中途丟失、落回 /，這個 label 會直接查不到）。
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
    expect(screen.getByLabelText("Note title")).toHaveValue("My Note");
  });

  it("直接深連結 /settings/account（無 state）→ 背景＝HomePage（主樹吃真實 location 落到 /* catch-all）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    // Radix Dialog 開啟時會把背景兄弟節點標成 `aria-hidden`（focus trap 的一部分），
    // `getByRole` 依可及性樹過濾會找不到——這裡改用不受 `aria-hidden` 影響的
    // `getByText`（同 `note-editor` testid 那組斷言的道理），驗證的是「HomePage 真的
    // 有掛上」，不是可及性樹的可見度。
    expect(screen.getByText("New note")).toBeInTheDocument();
  });

  // 站台管理搬到 /admin/*：舊的 /settings/users、/settings/ai 一律轉址過去（舊書籤、
  // 舊文件連結不斷），不先閃一下 modal；非 admin 轉過去後再被 /admin 的 RequireAdmin 導 /。
  for (const [from, to, heading] of [
    ["/settings/users", "/admin/users", "User management"],
    ["/settings/ai", "/admin/ai", "AI providers & actions"],
  ] as const) {
    it(`admin 深連結 ${from} → 轉址 ${to}（站台管理頁、不是設定 modal）`, async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
        if (res) return Promise.resolve(res);
        if (url.startsWith("/api/admin/ai/") && method === "GET") {
          const key = url.slice("/api/admin/ai/".length);
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ [key]: [] }) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      });

      // 「不先閃一下 modal」：最終畫面沒有 dialog 不夠（轉址掛在 SettingsModal 底下時
      // 最終也沒有），要看**過程中**有沒有任何 dialog 節點被掛進 DOM。記 addedNodes
      // 而不是回呼當下 querySelector——閃一下的節點可能在回呼跑之前就被移除了。
      let dialogEverMounted = false;
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (
              node instanceof Element &&
              (node.matches('[role="dialog"]') || node.querySelector('[role="dialog"]') !== null)
            ) {
              dialogEverMounted = true;
            }
          }
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      try {
        renderAt([from], fetchMock);

        await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(to));
        await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: heading })).toBeInTheDocument());
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      } finally {
        observer.disconnect();
      }
      expect(dialogEverMounted).toBe(false);
    });
  }

  it("非 admin 深連結 /settings/users → 轉 /admin/users → RequireAdmin 導 /（全程不開 modal）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/users"], fetchMock);

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalledWith("/api/admin/users", expect.anything());
  });

  it("admin 在 /admin/users 開設定 → modal 疊在管理頁上；關閉 → 回到 /admin/users", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/admin/users"], fetchMock);

    // 本檔第一次載入 AdminPage lazy chunk
    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());

    openUserMenu("Admin");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/account");
    // 背景仍是管理頁（Dialog 開著時背景 aria-hidden，用 getByText）。
    expect(screen.getByText("User management")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("location")).toHaveTextContent("/admin/users");
    expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument();
  });

  it("admin 深連結 /settings/account → 導覽只有帳號／群組，**看不到**使用者／AI（站台管理不在設定裡）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByText("Account")).toBeInTheDocument();
    expect(nav.queryByText("Users")).not.toBeInTheDocument();
    expect(nav.queryByText("AI")).not.toBeInTheDocument();
    // #103：群組頁所有登入者都看得到，admin 也不例外。
    expect(nav.getByText("Groups")).toBeInTheDocument();
    expect(nav.getAllByRole("link")).toHaveLength(2);
  });

  it("非 admin 深連結 /settings/account → 導覽只看得到帳號", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    const nav = within(screen.getByRole("navigation"));
    expect(nav.getByText("Account")).toBeInTheDocument();
    expect(nav.queryByText("Users")).not.toBeInTheDocument();
    expect(nav.queryByText("AI")).not.toBeInTheDocument();
    // #103：群組頁所有登入者都看得到，非 admin 也一樣。
    expect(nav.getByText("Groups")).toBeInTheDocument();
  });

  it("/settings/account ↔ /settings/groups 切換：Dialog DOM 節點不重掛（identity 不變）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    const dialogBefore = screen.getByRole("dialog");

    fireEvent.click(within(screen.getByRole("navigation")).getByText("Groups"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(dialogBefore);
  });

  it("點 modal 外面不關閉、inline 表單已輸入的文字仍在（Esc／X 照常關由 ui/dialog.test 守）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderAt(["/settings/account"], fetchMock);
    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "keep-me-typed" } });
    await clickOutside();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("Current password")).toHaveValue("keep-me-typed");
  });

  it("modal 內改密碼成功 → 不導航、modal 仍開、toast 出現（onSuccess=()=>toast(...)）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      if (url === "/api/auth/password" && method === "POST") {
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/account"], fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByText("Password updated.")).toBeInTheDocument());
    // 沒有導航：帳號區的標題與表單仍在——若走了強制頁那條 navigate("/") 分支，
    // 第二棵樹整個會不 match 而卸載，這個標題會消失。
    expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  const GROUP: GroupDto = groupDto(
    { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
    adminRole(),
  );

  /** 開列內 ⋮（`GroupMenu`）並點「Members & settings」——`DropdownMenuTrigger` 只聽
   * `onPointerDown`（同 `openUserMenu` 的道理），menuitem 用 `findByRole` 等 Radix 掛載。 */
  async function openGroupMembersAndSettings(groupName: string): Promise<void> {
    fireEvent.pointerDown(screen.getByRole("button", { name: `Group actions for ${groupName}` }), { button: 0 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Members & settings" }));
  }

  it("#103：/settings/groups 的 ⋮ →「Members & settings」→ 詳情頁；Esc 關閉 modal 回到原本的背景筆記頁（不是回到 /settings/groups）", async () => {
    // r1 I3 的形：`GroupMenu.goToSettings` 沒有正確轉傳既有 `backgroundLocation`
    // 時，Esc 會把 `/settings/groups` 又開回來、dialog 不消失。
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP]) }));
      }
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/notes/my-note"], fetchMock);

    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });

    openUserMenu("Admin");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });

    fireEvent.click(within(screen.getByRole("navigation")).getByText("Groups"));
    // 背景頁（NotePage 側欄的工作坊分段）吃同一份 `useGroups()` 快取，會重複渲染同樣的
    // 群組名字——一律 `within(dialog)` 才不會誤命中背景層。
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(GROUP.name)).toBeInTheDocument());

    await openGroupMembersAndSettings(GROUP.name);

    // 本檔第一次載入群組詳情區塊 lazy chunk
    await waitFor(() => expect(screen.getByRole("heading", { name: GROUP.name })).toBeInTheDocument());
    // 背景頁（NotePage 的替身編輯器）仍在 DOM 裡。
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
  });

  it("#103：深連結 /settings/groups（沒有 backgroundLocation）→ ⋮ → Members & settings → 一次 Esc 就沒有 dialog", async () => {
    // r2 M2 的形：深連結沒有 `backgroundLocation` 時若被誤轉傳成 undefined 以外的值，
    // Esc 可能要按兩次才關得掉。
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP]) }));
      }
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/groups"], fetchMock);

    // 深連結沒有 backgroundLocation：主樹 catch-all 落到 HomePage，側欄同樣重複渲染
    // 群組名字——同上，一律 `within(dialog)`。
    await waitFor(() => expect(within(screen.getByRole("dialog")).getByText(GROUP.name)).toBeInTheDocument());

    await openGroupMembersAndSettings(GROUP.name);

    await waitFor(() => expect(screen.getByRole("heading", { name: GROUP.name })).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("#201：設定區塊 chunk 載入失敗（額度已用過）→ 錯誤＋重試留在 modal 內容區，外框與導覽仍在（不冒到 app 級兜底）", async () => {
    // 先種 settings 額度旗標＝「已自動 reload 過」→ 直接進錯誤畫面（jsdom 的 location.reload
    // 不可 stub；自動 reload 那支由 ErrorBoundary.test 案 A 守）。
    sessionStorage.setItem("knotebook:chunk-reload:settings", "1");
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    try {
      renderAt(["/settings/groups/g1/roles"], fetchMock);

      const dialog = await screen.findByRole("dialog", {}, { timeout: 3_000 });
      await waitFor(
        () =>
          expect(
            within(dialog).getByText(
              "Couldn't load this page — check your connection, or a new version may have been deployed.",
            ),
          ).toBeInTheDocument(),
        { timeout: 3_000 },
      );
      expect(within(dialog).getByRole("button", { name: "Try again" })).toBeInTheDocument();
      // 外框與導覽仍在：boundary 在 modal 內容區，不是包整個 modal
      expect(within(dialog).getByRole("link", { name: "Account" })).toBeInTheDocument();
      expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
    } finally {
      sessionStorage.removeItem("knotebook:chunk-reload:settings");
    }
  });

  // ── #179：改標題換網址後開關設定 modal，網址不得退回改標題前 ──

  /** 可改名的單篇假 server：PATCH 標題時 slug 跟著標題重算（auto slug），之後所有單篇 GET
   * （by-path、:ref、:id）一律回現行這份——模擬 server 的 prev_slug 也解得回同一篇。 */
  function renameableFetch() {
    let current: NoteDto = { ...NOTE, slugIsCustom: false };
    /** 指定 URL 改回別篇（模擬舊 slug 被新筆記拿走）。 */
    const overrides = new Map<string, NoteDto>();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const override = method === "GET" ? overrides.get(url) : undefined;
      if (override) return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(override) }));
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { title: string };
        current = { ...current, title: body.title, slug: body.title.toLowerCase().replace(/\s+/g, "-") };
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(current) }));
      }
      if (url.startsWith("/api/notes/") && !url.endsWith("/backlinks") && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(current) }));
      }
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    return {
      fetchMock,
      rename: (slug: string) => (current = { ...current, slug }),
      override: (url: string, note: NoteDto) => overrides.set(url, note),
    };
  }

  it("#179（正式 AppRoutes 接線）：改名後舊 slug 被新筆記 B 拿走 → 以 PUSH 導到舊網址會落到 B（主樹的 useNavigationType 恆為 POP，要用真實的）", async () => {
    const { fetchMock, override } = renameableFetch();
    renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });

    const title = screen.getByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed Note" } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-note$/));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const NOTE_B: NoteDto = { ...NOTE, id: "33333333-3333-4333-8333-333333333333", title: "Note B", slug: "my-note" };
    override("/api/notes/by-path/tester/my-note", NOTE_B);
    override(`/api/notes/${NOTE_B.id}`, NOTE_B);
    await act(async () => {
      historyNav.push?.("/n/tester/my-note");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note$/);
  });

  it("#179：開設定 → 關閉 → 改標題（網址換成新 slug）→ 上一頁回到設定（背景記著改名前網址）→ 不重解析：共編不重連、不再打 by-path、編輯器不重掛", async () => {
    // 審查第 2 輪實測的形：上一頁那筆 entry 的 backgroundLocation 是改名前的 /n/tester/my-note，它既不是
    // resolvedFor.key（已跟到新網址）也不是現行 canonical——要靠「這一篇走過的網址」記錄認得它。
    const { fetchMock } = renameableFetch();
    renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });
    const editor = screen.getByTestId("note-editor");

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/my-note$/));

    const title = screen.getByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed Note" } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-note$/));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    collab.noteIds.length = 0;
    const byPathCalls = () =>
      fetchMock.mock.calls.filter((call) => String(call[0]).startsWith("/api/notes/by-path/")).length;
    const byPathBefore = byPathCalls();

    await act(async () => {
      historyNav.back?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/));
    expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    expect(collab.noteIds.length).toBeGreaterThan(0);
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(byPathCalls()).toBe(byPathBefore);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("#179：改標題（網址換成新 slug）→ 開設定 → 關閉 → 網址是新 slug，不退回舊網址；共編不拆線、編輯器不重掛", async () => {
    const { fetchMock } = renameableFetch();
    renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });
    const editor = screen.getByTestId("note-editor");
    collab.noteIds.length = 0;

    const title = screen.getByLabelText("Note title");
    fireEvent.change(title, { target: { value: "Renamed Note" } });
    fireEvent.blur(title);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/tester/renamed-note"));

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // 修好前：router location 停在舊網址，backgroundLocation 記的是它，關 modal 就導回 /n/tester/my-note。
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-note$/);
    // 換網址（改 params）沒有被當成換筆記：傳給 useCollab 的 noteId 一路是同一篇（真實 useCollab
    // 依 noteId 拆線重連），編輯器是同一個 DOM 節點（沒有換成佔位卡再重掛）。
    expect(collab.noteIds.length).toBeGreaterThan(0);
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("#179：設定 modal 開著時這篇被改名（重抓帶回新 slug）→ modal 不被關、真實網址不動；關閉後回到新 slug", async () => {
    const { fetchMock, rename } = renameableFetch();
    const queryClient = renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });
    const editor = screen.getByTestId("note-editor");

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    collab.noteIds.length = 0;

    rename("renamed-elsewhere");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });
    // 背景頁的 note 已換成新 slug；modal 開著時收斂 effect 不動網址（真實 entry 帶 backgroundLocation）。
    await waitFor(() =>
      expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.slug).toBe("renamed-elsewhere"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-elsewhere$/));
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });

  it("#179：modal 開著時被改名 → 切到 Groups 分頁 → 上一頁回到 Account → 不重解析（共編不重連、編輯器不重掛）；關閉後到新 slug", async () => {
    // 審查實測的形：若 modal 開著時去改寫當下 entry 的 backgroundLocation，上一頁回到的那筆仍記著
    // 舊網址，背景 params 與已跟上新網址的 resolvedFor.key 對不上 → 重解析。
    const { fetchMock, rename } = renameableFetch();
    const queryClient = renderAt(["/n/tester/my-note"], fetchMock);
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });
    const editor = screen.getByTestId("note-editor");

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    fireEvent.click(within(screen.getByRole("navigation")).getByText("Groups"));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/groups$/));
    collab.noteIds.length = 0;

    rename("renamed-elsewhere");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });
    await waitFor(() =>
      expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.slug).toBe("renamed-elsewhere"),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await act(async () => {
      historyNav.back?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/));
    expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument();
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/tester\/renamed-elsewhere$/));
    expect(collab.noteIds.filter((id) => id !== NOTE.id)).toEqual([]);
    expect(screen.getByTestId("note-editor")).toBe(editor);
  });
});
