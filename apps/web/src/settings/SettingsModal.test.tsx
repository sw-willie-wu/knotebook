import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, type MemoryRouterProps } from "react-router";
import * as Y from "yjs";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { CollabState } from "@/collab/connection";

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
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ onUnauthorized }: { onUnauthorized: () => void }) => {
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
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};
const PLAIN_USER: UserDto = {
  id: "u-plain",
  email: "plain@example.com",
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
};

/** 基本 fetch mock：`/api/auth/me`（依
 * `getLoggedInAs` 回登入者或 401）、`/api/notes`（清單，空陣列）、`/api/notes/:ref`
 * （單篇，固定回 `NOTE`）、backlinks（空）——路由守衛與 HomePage/NotePage 共同需要
 * 這些。呼叫端可疊加其餘端點的處理（例如 `POST /api/auth/password`）。 */
function baseFetchHandlers(getLoggedInAs: () => UserDto | null) {
  return (url: string, method: string): Response | null => {
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
    if (url.endsWith("/backlinks") && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) });
    }
    if (url.startsWith("/api/notes/") && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(NOTE) });
    }
    return null;
  };
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
          <AppRoutes />
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
    // 關閉後仍落在背景 location（/notes/my-note）——編輯器替身仍在，不是被導去別處。
    expect(screen.getByTestId("note-editor")).toBeInTheDocument();
  });

  it("backgroundLocation 跨區塊切換仍保留：/notes/x 開設定 → 切到 Users → 關閉 → 回到 /notes/x（不是回退到 /）", async () => {
    // 這一案專門守 `SettingsNavLink` 的 `state={backgroundLocation ? {...} : undefined}`
    // ——沒有它，區塊互切一次後 `location.state.backgroundLocation` 就會變 undefined，
    // 關閉時只能落回 `/`，靜默扯掉背景 `/notes/:ref` 的共編 provider。用 ADMIN_USER
    // 才有第二個導覽項（Users）可切。
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => ADMIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/notes/my-note"], fetchMock);

    // 同前案：等真實 lazy import，3s（見上）
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument(), { timeout: 3_000 });

    openUserMenu("Admin");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });

    fireEvent.click(within(screen.getByRole("navigation")).getByText("Users"));
    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument(), {
      timeout: 3_000,
    });

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 3_000 });
    // 落在 /notes/my-note，不是被錯誤地帶回 /：`AppShell`（HomePage 也用同一個殼）
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

  it("非 admin 深連結 /settings/users → 導向 /（RequireAdmin 既有行為：!isAdmin 導 /）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const res = baseFetchHandlers(() => PLAIN_USER)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt(["/settings/users"], fetchMock);

    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("admin 深連結 /settings/account → 導覽看得到帳號／使用者／AI 三項", async () => {
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
    expect(nav.getByText("Users")).toBeInTheDocument();
    expect(nav.getByText("AI")).toBeInTheDocument();
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
  });

  it("/settings/account ↔ /settings/users 切換：Dialog DOM 節點不重掛（identity 不變）", async () => {
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

    fireEvent.click(within(screen.getByRole("navigation")).getByText("Users"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());
    expect(screen.getByRole("dialog")).toBe(dialogBefore);
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
});
