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

// 遷移自 Task 15 舊版 admin 使用者管理頁（獨立路由 `/admin/users`，已被 Task 7 刪除，
// 內容經 `git show <Task7 commit>^` 取回其舊路徑）——
// Task 8 審查交接：表格/dialog/mutation 邏輯零改動遷入 `SettingsUsersSection`，本檔逐案
// **有意識重寫**（不是機械改到綠，spec §13.5-5）：路徑鏈從 `/admin/users`（獨立頁）
// 改成 `/settings/users`（掛在 `SettingsModal` 底下的巢狀 route），因此每一案都要
// - 在 modal 內找元素（`within(screen.getByRole("dialog"))` 或直接查 heading/row，
//   Radix Dialog 開啟時背景兄弟節點會被標成 `aria-hidden`，不會誤命中背景頁）；
// - 背景頁 fetch mock（`/api/notes`）比照 `SettingsModal.test.tsx` 補上——第二棵
//   `/settings/*` Routes 樹掛載時，第一棵主樹仍會在背景 render `HomePage`（無
//   `backgroundLocation` 時 catch-all 落到 `/*`），沒補這支會直接炸未預期 fetch。
//
// 「非 admin → 導 `/`」這一案 Task 7 已在 `SettingsModal.test.tsx` 落地（route-level，
// 驗證的是 `RequireAdmin` 有接對），這裡不重複；本檔只覆蓋其餘 7 案＋一則 modal 內
// 渲染 smoke（確認真的掛在 Dialog 底下，不是退化成獨立頁）。

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
 * 同一筆 fixture（沿用原案的說明，見遷移前的舊版 admin 使用者頁測試檔）。 */
const OTHER_ADMIN: AdminUserDto = {
  id: "u-other-admin",
  email: "carol@example.com",
  displayName: "Carol",
  isAdmin: true,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const ADMIN_USERS_URL = "/api/admin/users";

/** 基本 fetch mock：`/api/auth/me`（一律回 `ADMIN_USER`——本檔
 * 每一案都需要 admin 才能通過 `RequireAdmin`，「非 admin」的路由層行為已在
 * `SettingsModal.test.tsx` 覆蓋，不重複）、`/api/notes`（背景 `HomePage` 需要）。 */
function baseFetchHandlers(): (url: string, method: string) => Response | null {
  return (url: string, method: string): Response | null => {
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

function renderUsersRoute(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/users"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("SettingsUsersSection（/settings/users，spec §13.4：舊版 admin 使用者頁邏輯遷入設定 modal）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("modal 內渲染 smoke：/settings/users 掛在 Dialog 底下，不是退化成獨立頁", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "User management" })).toBeInTheDocument();
    // 設定 modal 的左側導覽（`SettingsModal`）也在同一個 Dialog 裡，Users 項高亮。
    expect(within(screen.getByRole("navigation")).getByText("Users")).toBeInTheDocument();
  });

  it("admin 造訪 /settings/users → 渲染表格，disabled 徽章與 enable/disable 依狀態互斥", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([ACTIVE_OTHER, DISABLED_OTHER]) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());

    await waitFor(() => expect(screen.getByText(ACTIVE_OTHER.email)).toBeInTheDocument());
    expect(screen.getByText(DISABLED_OTHER.email)).toBeInTheDocument();

    const bobRow = screen.getByText(DISABLED_OTHER.email).closest("tr");
    expect(bobRow).not.toBeNull();
    expect(bobRow && bobRow.textContent).toContain("Disabled");

    const aliceRow = screen.getByText(ACTIVE_OTHER.email).closest("tr");
    expect(aliceRow).not.toBeNull();
    expect(aliceRow && aliceRow.textContent).toContain("Active");

    expect(aliceRow && within(aliceRow).queryByRole("button", { name: "Disable" })).toBeInTheDocument();
    expect(aliceRow && within(aliceRow).queryByRole("button", { name: "Enable" })).not.toBeInTheDocument();

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
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([selfRow]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

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
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([ACTIVE_OTHER]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTIVE_OTHER.email)).toBeInTheDocument());
    const row = screen.getByText(ACTIVE_OTHER.email).closest("tr");
    expect(row && within(row).queryByRole("button", { name: "Promote to admin" })).toBeInTheDocument();
  });

  it("已是 admin 的使用者那列（非自己）不出現 Promote 鈕", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([OTHER_ADMIN]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(OTHER_ADMIN.email)).toBeInTheDocument());
    const row = screen.getByText(OTHER_ADMIN.email).closest("tr");
    expect(row && within(row).queryByRole("button", { name: "Promote to admin" })).not.toBeInTheDocument();
  });

  it("停用 disable 送出 POST /api/admin/users/:id/disable（confirm dialog 後）", async () => {
    let calledDisable = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
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

    renderUsersRoute(fetchMock);

    await waitFor(() => expect(screen.getByText(ACTIVE_OTHER.email)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Disable this user?" })).toBeInTheDocument());
    expect(screen.getByText(/signed out immediately/)).toBeInTheDocument();

    // Radix Dialog 開啟後背景整片會標成 aria-hidden，確認鈕只能從（巢狀）dialog 內找
    // ——這裡有兩層 Dialog 疊著（SettingsModal 外殼＋確認 dialog），`getAllByRole` 取
    // 最後一個（最上層、最新掛載的那個）。
    const dialogs = screen.getAllByRole("dialog");
    const confirmDialog = dialogs[dialogs.length - 1];
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Disable" }));

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
      const base = baseFetchHandlers()(url, method);
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

    renderUsersRoute(fetchMock);

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
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderUsersRoute(fetchMock);

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
