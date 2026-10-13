import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { MIN_PASSWORD_LENGTH, ONLINE_WINDOW_MS, type StoragePlanDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { AdminUserDto } from "@/api/admin";

// 歷程：Task 15 的獨立頁 `/admin/users` → Plan 4 併進設定 modal（`/settings/users`，
// Task 8 逐案有意識重寫，spec §13.5-5）→ 2026-09-30 搬回獨立頁 `/admin/users`
// （`pages/AdminPage.tsx`，殼是 `AppShell`）→ #247 改回 modal（第二棵樹的 `AdminModal`）。
// 本檔各案直接查 heading/row 的寫法不依賴外殼，只換了那一則外殼 smoke。
// - fetch mock 裡的 `/api/notes`、`/api/groups`：站台管理 modal 疊在主樹的背景 `HomePage` 上，
//   背景側欄的 NoteList 會打這兩支。
// - #247 §7.0：狀態欄與列尾文字鈕（Disable／Enable／Promote）改為角色下拉＋啟用 toggle，舊的按鈕案由檔尾 U 系列取代；
//   停用確認 dialog 疊在站台管理 modal 上，U6／U7 以 dialog 名稱「Disable this user?」定位。
//
// 「非 admin → 導 `/`」與未登入導向在 `components/admin/AdminModal.test.tsx`（route-level，驗證
// `RequireAdmin` 有接對），這裡不重複。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const BASIC_ID = "11111111-1111-4111-8111-111111111111";
const BIG_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_META = { overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
const BASIC_PLAN: StoragePlanDto = { ...PLAN_META, id: BASIC_ID, name: "Basic", quotaBytes: 2147483648, userCount: 3, groupCount: 0 };
const BIG_PLAN: StoragePlanDto = { ...PLAN_META, id: BIG_ID, name: "Big", quotaBytes: null, userCount: 0, groupCount: 0 };

const ADMIN_USER: UserDto = {
  id: "u-admin",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

const ACTIVE_OTHER: AdminUserDto = {
  id: "u-active",
  email: "alice@example.com",
  handle: "u-active-h",
  displayName: "Alice",
  isAdmin: false,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  lastActiveAt: null,
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648 },
};

const DISABLED_OTHER: AdminUserDto = {
  id: "u-disabled",
  email: "bob@example.com",
  handle: "u-disabled-h",
  displayName: "Bob",
  isAdmin: false,
  disabledAt: "2026-01-02T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  lastActiveAt: null,
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648 },
};

/** 已是 admin、但不是目前登入者本人的一列——降級（demote）與 `last_site_admin` 案要的是
 * 「別人的管理員列」，跟「自己那列 disabled」是兩件獨立的事，不能共用同一筆 fixture。 */
const OTHER_ADMIN: AdminUserDto = {
  id: "u-other-admin",
  email: "carol@example.com",
  handle: "u-other-admin-h",
  displayName: "Carol",
  isAdmin: true,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastLoginAt: null,
  lastActiveAt: null,
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648 },
};

const ADMIN_USERS_URL = "/api/admin/users";

/** 基本 fetch mock：`/api/auth/me`（一律回 `ADMIN_USER`——本檔
 * 每一案都需要 admin 才能通過 `RequireAdmin`，「非 admin」的路由層行為已在
 * `SettingsModal.test.tsx` 覆蓋，不重複）、`/api/notes`（背景 `HomePage` 需要）。 */
function baseFetchHandlers(): (url: string, method: string) => Response | null {
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/admin/storage-plans" && method === "GET") {
      return fakeResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ plans: [BASIC_PLAN, BIG_PLAN], defaults: { userPlanId: BASIC_ID, groupPlanId: BASIC_ID } }),
      });
    }
    return null;
  };
}

function renderUsersRoute(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/users"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("SettingsUsersSection（/admin/users：站台管理頁的使用者區）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("外殼 smoke：/admin/users 在站台管理 modal（dialog 名為 Site admin）裡", async () => {
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

    // 本檔第一次載入 AdminSections lazy chunk
    expect(await screen.findByRole("heading", { name: "User management" })).toBeInTheDocument();
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    // 站台管理 modal 左卡的項次導覽，Users 項是目前頁。
    expect(within(within(dialog).getByRole("navigation", { name: "Site admin" })).getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(dialog).getByRole("button", { name: "Create user" }).className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
  });

  it("建立使用者 dialog：點對話框外面不關閉、已填內容仍在（表單型守衛）", async () => {
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
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "keep@example.com" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Create user" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toHaveValue("keep@example.com");
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

  /**
   * 提示文案的數字必須來自 shared 的 `MIN_PASSWORD_LENGTH`，不能各自寫死——server 端
   * 常數一改，畫面上的提示就會說謊。這條把文案與常數釘在一起。
   */
  it("密碼提示的字數來自 shared 常數（改常數，文案跟著動）", async () => {
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
    expect(screen.getByText(`At least ${MIN_PASSWORD_LENGTH} characters.`)).toBeInTheDocument();
    // 上面那條單獨看不出鑑別力（常數目前就是 12，硬編也會過）——這條釘的是「文案用
    // 插值而不是寫死數字」，把數字寫回去就會紅。
    for (const language of ["en", "zh-TW"]) {
      expect(i18n.getResource(language, "translation", "admin.passwordHint")).toContain("{{min}}");
      expect(i18n.getResource(language, "translation", "changePassword.passwordHint")).toContain("{{min}}");
    }
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

describe("SettingsUsersSection——#187 §9.5：帳密登入關閉時代建的說明", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); configServed = false; });
  afterEach(() => vi.unstubAllGlobals());

  const NOTICE = "Password sign-in is turned off on this site: the temporary password is only used when the new person links their account the first time they sign in through a sign-in service.";
  // configServed：/api/auth/config 的回應已交給 react-query。純保險——實測（reviewer R3）拿掉這兩行等待案仍紅，因為 dialog 文字出現時 config 早已落地。
  let configServed = false;
  const fetchWith = (passwordLoginEnabled: boolean) =>
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => {
              configServed = true;
              return Promise.resolve({ providers: [], registration: { enabled: true }, passwordLogin: { enabled: passwordLoginEnabled } });
            },
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

  it("有效值關 → 建帳 dialog 內有說明", async () => {
    renderUsersRoute(fetchWith(false));
    fireEvent.click(await screen.findByRole("button", { name: "Create user" }));
    expect(await within(await screen.findByRole("dialog", { name: "Create user" })).findByText(NOTICE)).toBeInTheDocument();
  });

  it("有效值開 → 沒有說明", async () => {
    renderUsersRoute(fetchWith(true));
    fireEvent.click(await screen.findByRole("button", { name: "Create user" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Create user" }));
    await dialog.findByText("The new account will be required to change its password on first login.");
    await waitFor(() => expect(configServed).toBe(true));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(dialog.queryByText(NOTICE)).not.toBeInTheDocument();
  });
});

describe("W5 使用者表的儲存空間與方案（spec §9.3）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  const OVER: AdminUserDto = { ...ACTIVE_OTHER, id: "u-over", email: "over@example.com", storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576 } };
  const FREE: AdminUserDto = { ...OTHER_ADMIN, storage: { planId: BIG_ID, planName: "Big", usedBytes: 5 * 1048576, quotaBytes: null } };

  function stub(rows: AdminUserDto[], extra: (url: string, method: string, init?: RequestInit) => Response | null = () => null) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const custom = extra(url, method, init) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(rows) }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  it("用量格：一般／無上限／已超過、恰好等於（警示色，>=——起草裁定 4）", async () => {
    const FULL: AdminUserDto = { ...ACTIVE_OTHER, id: "u-full", email: "full@example.com", storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 1048576, quotaBytes: 1048576 } };
    renderUsersRoute(stub([ACTIVE_OTHER, OVER, FREE, FULL]));
    expect(await screen.findByText("over@example.com")).toBeInTheDocument();
    expect(screen.getByText("3 MB of 2 MB")).toHaveClass("text-destructive");
    expect(screen.getByText("1 MB of 1 MB")).toHaveClass("text-destructive");
    expect(screen.getByText("5 MB (no limit)")).not.toHaveClass("text-destructive");
    expect(screen.getByText("0 B of 2 GB")).not.toHaveClass("text-destructive");
  });

  it("改方案：PATCH {planId}；成功後該列下拉顯示新方案", async () => {
    const updated = { ...ACTIVE_OTHER, storage: { planId: BIG_ID, planName: "Big", usedBytes: 0, quotaBytes: null } };
    const fetchMock = stub([ACTIVE_OTHER], (url, method) =>
      url === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && method === "PATCH" ? fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) }) : null);
    renderUsersRoute(fetchMock);
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    expect(select).toHaveValue(BASIC_ID);
    fireEvent.change(select, { target: { value: BIG_ID } });
    await waitFor(() => expect(select).toHaveValue(BIG_ID));
    const patch = fetchMock.mock.calls.find(([u, i]) => String(u) === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && (i as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ planId: BIG_ID });
    expect(screen.getByText("0 B (no limit)")).toBeInTheDocument();
    // m2：成功後方案清單（人數）要重抓——PATCH 之後 GET storage-plans 又發了一次
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/admin/storage-plans" && ((i as RequestInit | undefined)?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2));
  });

  it("儲存中（PATCH 未回）：下拉 disabled 且顯示剛選的方案，不彈回舊方案", async () => {
    renderUsersRoute(stub([ACTIVE_OTHER], (url, method) =>
      url === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && method === "PATCH" ? (new Promise(() => undefined) as unknown as Response) : null));
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    fireEvent.change(select, { target: { value: BIG_ID } });
    await waitFor(() => expect(select).toBeDisabled());
    expect(select).toHaveValue(BIG_ID);
  });

  it("改方案失敗（404 storage_plan_not_found）：toast，下拉留在原方案", async () => {
    const fetchMock = stub([ACTIVE_OTHER], (url, method) =>
      url === `/api/admin/users/${ACTIVE_OTHER.id}/storage-plan` && method === "PATCH"
        ? fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "storage_plan_not_found", message: "x" } }) })
        : null);
    renderUsersRoute(fetchMock);
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    fireEvent.change(select, { target: { value: BIG_ID } });
    expect(await screen.findByText("Plan not found")).toBeInTheDocument();
    expect(select).toHaveValue(BASIC_ID);
    // m5：失敗也重抓方案清單（方案可能剛被刪）
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
  });

  it("RF4：列上的方案不在清單裡 → 下拉仍顯示該方案（補一個 option），不是清單第一個", async () => {
    const NEWPLAN_ID = "99999999-9999-4999-8999-999999999999";
    const row: AdminUserDto = { ...ACTIVE_OTHER, storage: { planId: NEWPLAN_ID, planName: "Brand new", usedBytes: 0, quotaBytes: 1048576 } };
    renderUsersRoute(stub([row]));
    const select = await screen.findByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` });
    await waitFor(() => expect(select).toHaveValue(NEWPLAN_ID));
    expect(within(select).getByRole("option", { name: "Brand new" })).toBeInTheDocument();
  });

  it("方案清單失敗：方案欄只顯示方案名、沒有下拉", async () => {
    const fetchMock = stub([ACTIVE_OTHER], (url, method) =>
      url === "/api/admin/storage-plans" && method === "GET" ? fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }) : null);
    renderUsersRoute(fetchMock);
    expect(await screen.findByText(ACTIVE_OTHER.email)).toBeInTheDocument();
    // 等待點（review I2）：清單 pending 時 plans 也是 undefined、「沒有下拉」恆真——先等請求真的發出，再讓失敗結果落地
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/admin/storage-plans")).toBe(true));
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(screen.queryByRole("combobox", { name: `Storage plan for ${ACTIVE_OTHER.email}` })).not.toBeInTheDocument();
    expect(within(screen.getByText(ACTIVE_OTHER.email).closest("tr")!).getByText("Basic")).toBeInTheDocument();
  });
});

describe("使用者表（#247 §7.0，W27）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SELF_ROW: AdminUserDto = { ...OTHER_ADMIN, id: ADMIN_USER.id, email: ADMIN_USER.email, handle: ADMIN_USER.handle, displayName: ADMIN_USER.displayName, lastLoginAt: "2026-10-01T09:12:00.000Z", lastActiveAt: "2026-10-01T09:12:00.000Z" };

  function stubUsers(getRows: () => AdminUserDto[], extra: (url: string, method: string, init?: RequestInit) => Response | Promise<Response> | null = () => null) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const custom = extra(url, method, init) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(getRows()) }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }
  const posts = (fetchMock: ReturnType<typeof vi.fn>, url: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && (i as RequestInit | undefined)?.method === "POST");
  const rowOf = (email: string) => screen.getByText(email).closest("tr") as HTMLElement;

  it("U1 欄位：User（顯示名稱＋灰字 @handle）、Email、Role、Plan、Storage、Last active、Enabled；沒有 Status 欄、沒有列尾文字鈕", async () => {
    renderUsersRoute(stubUsers(() => [SELF_ROW, ACTIVE_OTHER]));
    await screen.findByText(ACTIVE_OTHER.email);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["User", "Email", "Role", "Plan", "Storage", "Last active", "Enabled"]);
    // 啟用 switch 的可及名稱＝表頭「Enabled」＋該列 email（aria-labelledby 兩個 id）
    expect(within(rowOf(ACTIVE_OTHER.email)).getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` })).toBeInTheDocument();
    const row = within(rowOf(ACTIVE_OTHER.email));
    expect(row.getByText("Alice")).toBeInTheDocument();
    expect(row.getByText(`@${ACTIVE_OTHER.handle}`)).toBeInTheDocument();
    expect(row.queryByRole("button", { name: /^(Disable|Enable|Promote to admin)$/ })).not.toBeInTheDocument();
  });

  it("U2 角色下拉：一般 → 管理員送 promote；管理員 → 一般送 demote（bodyless POST）", async () => {
    let rows = [SELF_ROW, ACTIVE_OTHER, OTHER_ADMIN];
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (method !== "POST") return null;
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`) {
        rows = rows.map((r) => (r.id === ACTIVE_OTHER.id ? { ...r, isAdmin: true } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      if (url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote`) {
        rows = rows.map((r) => (r.id === OTHER_ADMIN.id ? { ...r, isAdmin: false } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });
    renderUsersRoute(fetchMock);
    const alice = await screen.findByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` });
    expect(alice).toHaveValue("user");
    fireEvent.change(alice, { target: { value: "admin" } });
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)).toHaveLength(1));
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)[0][1]).not.toHaveProperty("body");
    await waitFor(() => expect(alice).toHaveValue("admin"));

    const carol = screen.getByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    fireEvent.change(carol, { target: { value: "user" } });
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote`)).toHaveLength(1));
    await waitFor(() => expect(carol).toHaveValue("user"));
  });

  it("U2b promote 204 之後、名單重抓（GET）延遲期間：下拉值恆為 admin（不先彈回 user）", async () => {
    let rows = [SELF_ROW, ACTIVE_OTHER];
    let holdGet = false;
    let releaseGet: () => void = () => {};
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote` && method === "POST") {
        rows = rows.map((r) => (r.id === ACTIVE_OTHER.id ? { ...r, isAdmin: true } : r));
        holdGet = true;
        return fakeResponse({ ok: true, status: 204 });
      }
      if (url === ADMIN_USERS_URL && method === "GET" && holdGet) {
        holdGet = false;
        return new Promise<Response>((resolve) => (releaseGet = () => resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(rows) }))));
      }
      return null;
    });
    renderUsersRoute(fetchMock);
    const alice = await screen.findByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` });
    fireEvent.change(alice, { target: { value: "admin" } });
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)).toHaveLength(1));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === ADMIN_USERS_URL && ((i as RequestInit | undefined)?.method ?? "GET") === "GET").length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(alice).toHaveValue("admin");
    releaseGet();
    await waitFor(() => expect(alice).not.toBeDisabled());
    expect(alice).toHaveValue("admin");
  });

  it("U3 自己那列：角色下拉 disabled＋title「You can't remove your own admin role.」", async () => {
    renderUsersRoute(stubUsers(() => [SELF_ROW, ACTIVE_OTHER]));
    const mine = await screen.findByRole("combobox", { name: `Role for ${SELF_ROW.email}` });
    expect(mine).toBeDisabled();
    expect(mine).toHaveAttribute("title", "You can't remove your own admin role.");
  });

  it("U4 demote 409 last_site_admin → 下拉彈回管理員＋列內紅字是站台那句（不是群組的 last_admin 文案）", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, OTHER_ADMIN], (url, method) =>
      url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote` && method === "POST"
        ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) })
        : null,
    );
    renderUsersRoute(fetchMock);
    const carol = await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    fireEvent.change(carol, { target: { value: "user" } });
    const alert = await within(rowOf(OTHER_ADMIN.email)).findByRole("alert");
    expect(alert).toHaveTextContent("The site needs at least one enabled admin.");
    expect(alert).not.toHaveTextContent(i18n.t("errors.last_admin"));
    expect(carol).toHaveValue("admin");
  });

  it("U5（Review Focus 4）角色 pending 時下拉 disabled、顯示剛選的值；再改一次不送第二發", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER], (url, method) =>
      url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote` && method === "POST" ? new Promise<Response>(() => {}) : null,
    );
    renderUsersRoute(fetchMock);
    const alice = await screen.findByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` });
    fireEvent.change(alice, { target: { value: "admin" } });
    await waitFor(() => expect(alice).toBeDisabled());
    expect(alice).toHaveValue("admin");
    fireEvent.change(alice, { target: { value: "user" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/demote`)).toHaveLength(0);
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/promote`)).toHaveLength(1);
  });

  it("U6 啟用 toggle：關 → 先開確認框（不送）→ 確認 → POST disable、重抓後 toggle 為關；開（已停用者）→ 直接 POST enable", async () => {
    let rows = [SELF_ROW, ACTIVE_OTHER, DISABLED_OTHER];
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (method !== "POST") return null;
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`) {
        rows = rows.map((r) => (r.id === ACTIVE_OTHER.id ? { ...r, disabledAt: "2026-10-11T00:00:00.000Z" } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      if (url === `${ADMIN_USERS_URL}/${DISABLED_OTHER.id}/enable`) {
        rows = rows.map((r) => (r.id === DISABLED_OTHER.id ? { ...r, disabledAt: null } : r));
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });
    renderUsersRoute(fetchMock);
    const aliceSwitch = await screen.findByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` });
    expect(aliceSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(aliceSwitch);
    const confirm = await screen.findByRole("dialog", { name: "Disable this user?" });
    expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`)).toHaveLength(0);
    fireEvent.click(within(confirm).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` })).toHaveAttribute("aria-checked", "false"));

    const bobSwitch = screen.getByRole("switch", { name: `Enabled ${DISABLED_OTHER.email}` });
    expect(bobSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(bobSwitch);
    await waitFor(() => expect(posts(fetchMock, `${ADMIN_USERS_URL}/${DISABLED_OTHER.id}/enable`)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: "Disable this user?" })).not.toBeInTheDocument();
  });

  it("U7（Review Focus 4）停用確認框按取消 → 不送任何請求、toggle 留在開", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER]);
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` }));
    const confirm = await screen.findByRole("dialog", { name: "Disable this user?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disable this user?" })).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` })).toHaveAttribute("aria-checked", "true");
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("U8 自己那列的啟用 toggle：照常渲染、恆為開、aria-disabled＋title「You can't disable your own account.」；按下不送、不開確認框", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER]);
    renderUsersRoute(fetchMock);
    const mine = await screen.findByRole("switch", { name: `Enabled ${SELF_ROW.email}` });
    expect(mine).toHaveAttribute("aria-checked", "true");
    expect(mine).toHaveAttribute("aria-disabled", "true");
    expect(mine).toHaveAttribute("title", "You can't disable your own account.");
    fireEvent.click(mine);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Disable this user?" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([, i]) => (i as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
  });

  it("U9 最後活動（#267）：視窗內顯示「Online」、更早顯示日期＋時間（toLocaleString(en, short/short)）、null 顯示「Not recorded」（不看 lastLoginAt）；長 email／使用者格 wrap-anywhere、其餘欄不換行", async () => {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    const justOutside = ago(ONLINE_WINDOW_MS + 60_000);
    const dateTime = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
    renderUsersRoute(stubUsers(() => [
      SELF_ROW,
      { ...ACTIVE_OTHER, lastLoginAt: "2026-09-01T00:00:00.000Z", lastActiveAt: ago(3 * 60_000) }, // 寫入間隔（1 分鐘）之外、上線視窗（5 分鐘）之內
      { ...DISABLED_OTHER, lastLoginAt: "2026-09-01T00:00:00.000Z", lastActiveAt: null },
      { ...OTHER_ADMIN, lastActiveAt: justOutside },
    ]));
    await screen.findByText(ACTIVE_OTHER.email);
    const lastActiveCell = (email: string) => within(rowOf(email)).getAllByRole("cell")[5]!.textContent;
    expect(lastActiveCell(SELF_ROW.email)).toBe(dateTime("2026-10-01T09:12:00.000Z"));
    expect(lastActiveCell(SELF_ROW.email)).toMatch(/\d{1,2}:\d{2}/); // 有時間，不只日期
    expect(lastActiveCell(ACTIVE_OTHER.email)).toBe("Online");
    expect(lastActiveCell(DISABLED_OTHER.email)).toBe("Not recorded");
    expect(lastActiveCell(OTHER_ADMIN.email)).toBe(dateTime(justOutside));
    const tokens = (el: Element | null) => [...(el?.classList ?? [])];
    expect(tokens(screen.getByText(ACTIVE_OTHER.email).closest("td"))).toContain("wrap-anywhere");
    expect(tokens(screen.getByText("Alice").closest("td"))).toContain("wrap-anywhere");
    expect(tokens(screen.getByRole("combobox", { name: `Role for ${ACTIVE_OTHER.email}` }).closest("td"))).toContain("whitespace-nowrap");
  });
});
