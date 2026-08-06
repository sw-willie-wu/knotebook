import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { AdminUserDto } from "@/api/admin";

// 同一套約定：mock 全域 fetch，讓真正的 useAdminUsers/useCreateAdminUser/…
// （react-query）打到假回應，不 mock hook 本身——見 NoteList.test.tsx/ShareDialog.test.tsx
// 的說明。route-level 的「非 admin 導 `/`」直接用真正的 `AppRoutes`（App.tsx 的唯一
// 真相樹）跑，驗證的是 `/admin/users` 這條路由真的掛在 `<RequireAdmin>` 底下，而不是
// 只測 `RequireAdmin` 元件本身（guards.test.tsx 已經測過那個，這裡測「有沒有接對」）。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const ADMIN_USER: UserDto = { id: "u-admin", email: "admin@example.com", displayName: "Admin", isAdmin: true };
const PLAIN_USER: UserDto = { id: "u-plain", email: "plain@example.com", displayName: "Plain", isAdmin: false };

const ACTIVE_OTHER: AdminUserDto = {
  id: "u-active",
  email: "alice@example.com",
  displayName: "Alice",
  isAdmin: false,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const DISABLED_OTHER: AdminUserDto = {
  id: "u-disabled",
  email: "bob@example.com",
  displayName: "Bob",
  isAdmin: false,
  disabledAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

/** 已是 admin、但不是目前登入者本人的一列——用來驗證「已是 admin 不出現 Promote 鈕」
 * 這條規則本身，跟「自己那列不出現 Disable/Enable 鈕」是兩件獨立的事，不能共用
 * 同一筆 fixture（用 ADMIN_USER 自己那列驗 Promote 隱藏，測到的其實是 self 規則，
 * 不是 admin 規則——沿用會重蹈 Important 1 的覆轍）。 */
const OTHER_ADMIN: AdminUserDto = {
  id: "u-other-admin",
  email: "carol@example.com",
  displayName: "Carol",
  isAdmin: true,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ADMIN_USERS_URL = "/api/admin/users";

/** 基本 fetch mock：`/api/setup/status`（一律 needed:false）、`/api/auth/me`
 * （依 `loggedInAs` 回登入者或 401）——路由守衛（SetupGate/RequireAuth/RequireAdmin）
 * 共同需要這兩支。呼叫端可疊加 admin-users 相關的處理。 */
function baseFetchHandlers(loggedInAs: UserDto | null) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/setup/status") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ needed: false }) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      if (loggedInAs) {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(loggedInAs) });
      }
      return fakeResponse({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
      });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

function renderAdminRoute(fetchMock: ReturnType<typeof vi.fn>, queryClient: QueryClient = new QueryClient()) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/users"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("AdminUsersPage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非 admin 造訪 /admin/users → 導向 /（route-level, via RequireAdmin）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(PLAIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    // 落在 HomePage（AppShell 的「New note」鈕），不是 admin 頁面。
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "User management" })).not.toBeInTheDocument();
  });

  it("admin 造訪 /admin/users → 渲染表格，disabled 徽章與 enable/disable 依狀態互斥", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([ACTIVE_OTHER, DISABLED_OTHER]) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());

    // 兩位使用者都渲染出來。
    await waitFor(() => expect(screen.getByText(ACTIVE_OTHER.email)).toBeInTheDocument());
    expect(screen.getByText(DISABLED_OTHER.email)).toBeInTheDocument();

    // disabled 徽章：只有 Bob 那列出現「Disabled」狀態文案。
    const bobRow = screen.getByText(DISABLED_OTHER.email).closest("tr");
    expect(bobRow).not.toBeNull();
    expect(bobRow && bobRow.textContent).toContain("Disabled");

    const aliceRow = screen.getByText(ACTIVE_OTHER.email).closest("tr");
    expect(aliceRow).not.toBeNull();
    expect(aliceRow && aliceRow.textContent).toContain("Active");

    // Alice（active）→ 只有 Disable 鈕，沒有 Enable 鈕。
    expect(aliceRow && within(aliceRow).queryByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(aliceRow && within(aliceRow).queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();

    // Bob（disabled）→ 只有 Enable 鈕，沒有 Disable 鈕。
    expect(bobRow && within(bobRow).queryByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(bobRow && within(bobRow).queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
  });

  it("目前登入的 admin 自己那列不出現 Disable 鈕", async () => {
    const selfRow: AdminUserDto = {
      id: ADMIN_USER.id,
      email: ADMIN_USER.email,
      displayName: ADMIN_USER.displayName,
      isAdmin: true,
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([selfRow]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(ADMIN_USER.email)).toBeInTheDocument());
    const selfRowEl = screen.getByText(ADMIN_USER.email).closest("tr");
    expect(selfRowEl).not.toBeNull();
    expect(selfRowEl && within(selfRowEl).queryByRole("button", { name: "Disable" })).not.toBeInTheDocument();
    expect(selfRowEl && within(selfRowEl).queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();
  });

  it("非 admin 那列出現 Promote 鈕", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([ACTIVE_OTHER]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTIVE_OTHER.email)).toBeInTheDocument());
    const row = screen.getByText(ACTIVE_OTHER.email).closest("tr");
    expect(row && within(row).queryByRole("button", { name: "Promote to admin" })).toBeInTheDocument();
  });

  it("已是 admin 的使用者那列（非自己）不出現 Promote 鈕", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OTHER_ADMIN]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(OTHER_ADMIN.email)).toBeInTheDocument());
    const row = screen.getByText(OTHER_ADMIN.email).closest("tr");
    expect(row && within(row).queryByRole("button", { name: "Promote to admin" })).not.toBeInTheDocument();
  });

  it("停用 disable 送出 POST /api/admin/users/:id/disable（confirm dialog 後）", async () => {
    let calledDisable = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve([calledDisable ? { ...ACTIVE_OTHER, disabledAt: "2026-01-03T00:00:00.000Z" } : ACTIVE_OTHER]),
          }),
        );
      }
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable` && method === "POST") {
        calledDisable = true;
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTIVE_OTHER.email)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Disable this user?" })).toBeInTheDocument());
    // confirm copy 警告立即踢下線。
    expect(screen.getByText(/signed out immediately/)).toBeInTheDocument();

    // dialog 打開後 Radix 會把背景整片標成 aria-hidden，確認鈕只能從 dialog 內找
    // （同 NoteList.test.tsx 刪除確認鈕的既有作法）。
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) =>
          String(reqUrl) === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable` &&
          (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
    });
  });

  it("建立使用者送出 POST /api/admin/users 的確切 body", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === ADMIN_USERS_URL && method === "POST") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 201,
            json: () =>
              Promise.resolve({
                id: "new-user",
                email: "new@example.com",
                displayName: "New Person",
                isAdmin: true,
                disabledAt: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(screen.getByLabelText("Email")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correcthorsebatterystaple" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "New Person" } });
    fireEvent.click(screen.getByLabelText("Administrator"));

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === ADMIN_USERS_URL && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({
        email: "new@example.com",
        password: "correcthorsebatterystaple",
        displayName: "New Person",
        isAdmin: true,
      });
    });
  });

  it("建立使用者密碼 <12 字元 → client 端擋下，不打 API", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(ADMIN_USER)(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAdminRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => expect(screen.getByLabelText("Email")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "short@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByText("Password is too short.")).toBeInTheDocument());
    const postCalls = fetchMock.mock.calls.filter(
      ([reqUrl, reqInit]) => String(reqUrl) === ADMIN_USERS_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });
});
