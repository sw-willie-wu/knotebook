import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ONLINE_WINDOW_MS, type AdminInviteDto, type StoragePlanDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { AdminUserDto } from "@/api/admin";
import { copyText } from "@/lib/clipboard";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

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
  hasPassword: true,
  passwordResetExpiresAt: null,
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
  hasPassword: true,
  passwordResetExpiresAt: null,
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
  hasPassword: true,
  passwordResetExpiresAt: null,
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
    if (url === "/api/folders") return new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } });
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
    if (url === "/api/admin/invites" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

/**
 * `/api/auth/config` 的預設回應，只在各 stub 丟 `unexpected fetch` 之前當 fallback 用：`InvitesGroup` 在群組頂層讀它（D2 提示），
 * 每個渲染使用者頁的案都會打。不放進 `baseFetchHandlers`——各 stub 先問 base、後判自己的 config，放進去會遮蔽各案自己的設定。
 */
function defaultAuthConfig(url: string, method: string): Response | null {
  if (url !== "/api/auth/config" || method !== "GET") return null;
  return fakeResponse({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }),
  });
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
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
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
    expect(within(dialog).getByRole("button", { name: "Create invitation" }).className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
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
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
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

  it("欄寬：主欄與 email 欄按 1 : 1.5 分配（主欄不再獨佔 2/3，擠壓 email）", async () => {
    renderUsersRoute(stub([ACTIVE_OTHER]));
    expect(await screen.findByText("alice@example.com")).toBeInTheDocument();
    expect(screen.getAllByRole("table")[0].style.getPropertyValue("--kb-table-cols")).toBe(
      "minmax(14ch,1fr) minmax(14ch,1.5fr) max-content max-content max-content max-content 2rem 3.5rem",
    );
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
    expect(within(screen.getByRole("row", { name: ACTIVE_OTHER.email })).getByText("Basic")).toBeInTheDocument();
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
      const config = defaultAuthConfig(url, method);
      if (config) return Promise.resolve(config);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }
  const posts = (fetchMock: ReturnType<typeof vi.fn>, url: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && (i as RequestInit | undefined)?.method === "POST");
  /** 使用者表的列名＝email（spec 2026-10-13 settings-table §3 #5：`nameColumn` 是 Email 欄）。 */
  const rowOf = (email: string) => screen.getByRole("row", { name: email });

  it("U1 欄位：User（顯示名稱＋灰字 @handle）、Email、Storage、Last active、Role、Plan、Actions、Enabled；沒有 Status 欄、沒有列尾文字鈕", async () => {
    renderUsersRoute(stubUsers(() => [SELF_ROW, ACTIVE_OTHER]));
    await screen.findByText(ACTIVE_OTHER.email);
    // spec 2026-10-13 settings-table §3 #5 的欄序：主欄 → 資訊欄（Email、Storage、最後活動）→ 可編輯欄（Role、Plan）→ 操作（#286）→ 啟用。
    expect(within(screen.getByRole("table", { name: "Users" })).getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "User",
      "Email",
      "Storage",
      "Last active",
      "Role",
      "Plan",
      "Actions",
      "Enabled",
    ]);
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

  it("U4 demote 409 last_site_admin → 下拉彈回管理員＋錯誤列的紅字是站台那句（不是群組的 last_admin 文案）", async () => {
    const fetchMock = stubUsers(() => [SELF_ROW, OTHER_ADMIN], (url, method) =>
      url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote` && method === "POST"
        ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) })
        : null,
    );
    renderUsersRoute(fetchMock);
    const carol = await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    fireEvent.change(carol, { target: { value: "user" } });
    // 列層級錯誤走資料列之後的錯誤列（spec §2.5 末），不放在角色那格（會撐寬 max-content 軌）。
    const errorRow = await screen.findByRole("row", { name: `${OTHER_ADMIN.email} error` });
    expect(within(rowOf(OTHER_ADMIN.email)).queryByRole("alert")).toBeNull();
    const alert = within(errorRow).getByRole("alert");
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

  it("U9 最後活動（#267）：視窗內顯示「Online」、更早顯示日期＋時間（toLocaleString(en, short/short)）、null 顯示「Not recorded」（不看 lastLoginAt）", async () => {
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
    // 依格的可及名稱（＝內容）找，不依欄序號（spec 2026-10-13 settings-table §5.2；欄序見 U1）。
    const lastActiveCell = (email: string, text: string) => within(rowOf(email)).getByRole("cell", { name: text });
    expect(lastActiveCell(SELF_ROW.email, dateTime("2026-10-01T09:12:00.000Z"))).toBeInTheDocument();
    expect(dateTime("2026-10-01T09:12:00.000Z")).toMatch(/\d{1,2}:\d{2}/); // 有時間，不只日期
    expect(lastActiveCell(ACTIVE_OTHER.email, "Online")).toBeInTheDocument();
    expect(lastActiveCell(DISABLED_OTHER.email, "Not recorded")).toBeInTheDocument();
    expect(lastActiveCell(OTHER_ADMIN.email, dateTime(justOutside))).toBeInTheDocument();
  });

  it("U10（RF4）角色變更失敗 → 錯誤列「＜email＞ error」；再改一次成功 → 錯誤列消失、不留空的 alert", async () => {
    let fail = true;
    let rows = [SELF_ROW, OTHER_ADMIN];
    const fetchMock = stubUsers(() => rows, (url, method) => {
      if (url !== `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote` || method !== "POST") return null;
      if (fail) return fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) });
      rows = rows.map((r) => (r.id === OTHER_ADMIN.id ? { ...r, isAdmin: false } : r));
      return fakeResponse({ ok: true, status: 204 });
    });
    renderUsersRoute(fetchMock);
    const carol = await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` });
    fireEvent.change(carol, { target: { value: "user" } });
    const errorRow = await screen.findByRole("row", { name: `${OTHER_ADMIN.email} error` });
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("The site needs at least one enabled admin.");
    await waitFor(() => expect(carol).not.toBeDisabled());
    expect(carol).toHaveValue("admin");

    fail = false;
    fireEvent.change(carol, { target: { value: "user" } });
    await waitFor(() => expect(screen.queryByRole("row", { name: `${OTHER_ADMIN.email} error` })).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(carol).toHaveValue("user"));
  });

  it("U11 錯誤狀態以使用者 id 為鍵：角色、啟用、停用確認三處的失敗各自只進自己那列的錯誤列；一列開始新動作只清自己那列", async () => {
    const notFound = () => fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "user_not_found", message: "x" } }) });
    const fetchMock = stubUsers(() => [SELF_ROW, ACTIVE_OTHER, OTHER_ADMIN, DISABLED_OTHER], (url, method) => {
      if (method !== "POST") return null;
      if (url === `${ADMIN_USERS_URL}/${OTHER_ADMIN.id}/demote`) {
        return fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_site_admin", message: "x" } }) });
      }
      if (url === `${ADMIN_USERS_URL}/${DISABLED_OTHER.id}/enable`) return notFound();
      if (url === `${ADMIN_USERS_URL}/${ACTIVE_OTHER.id}/disable`) return notFound();
      return null;
    });
    renderUsersRoute(fetchMock);
    const errorRowOf = (email: string) => screen.queryByRole("row", { name: `${email} error` });

    // 角色下拉的失敗：只有 carol 有錯誤列
    fireEvent.change(await screen.findByRole("combobox", { name: `Role for ${OTHER_ADMIN.email}` }), { target: { value: "user" } });
    await waitFor(() => expect(errorRowOf(OTHER_ADMIN.email)).not.toBeNull());
    expect(errorRowOf(ACTIVE_OTHER.email)).toBeNull();
    expect(errorRowOf(DISABLED_OTHER.email)).toBeNull();
    expect(errorRowOf(SELF_ROW.email)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(1);

    // 啟用開關（開）的失敗：bob 的錯誤列出現；bob 開始動作時清的是 bob 自己那列，carol 的錯誤列還在
    fireEvent.click(screen.getByRole("switch", { name: `Enabled ${DISABLED_OTHER.email}` }));
    await waitFor(() => expect(errorRowOf(DISABLED_OTHER.email)).not.toBeNull());
    expect(within(errorRowOf(DISABLED_OTHER.email)!).getByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(within(errorRowOf(OTHER_ADMIN.email)!).getByRole("alert")).toHaveTextContent("The site needs at least one enabled admin.");
    expect(errorRowOf(ACTIVE_OTHER.email)).toBeNull();

    // 停用確認後的失敗：alice 的錯誤列出現；另兩列的錯誤列不受影響
    fireEvent.click(screen.getByRole("switch", { name: `Enabled ${ACTIVE_OTHER.email}` }));
    const confirm = await screen.findByRole("dialog", { name: "Disable this user?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(errorRowOf(ACTIVE_OTHER.email)).not.toBeNull());
    expect(within(errorRowOf(ACTIVE_OTHER.email)!).getByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(errorRowOf(OTHER_ADMIN.email)).not.toBeNull();
    expect(errorRowOf(DISABLED_OTHER.email)).not.toBeNull();
    expect(errorRowOf(SELF_ROW.email)).toBeNull();
    expect(screen.getAllByRole("alert")).toHaveLength(3);
  });
});

describe("重設密碼（#286 A-15）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const SELF_ROW: AdminUserDto = { ...OTHER_ADMIN, id: ADMIN_USER.id, email: ADMIN_USER.email, handle: ADMIN_USER.handle, displayName: ADMIN_USER.displayName };
  const NO_PASSWORD: AdminUserDto = { ...ACTIVE_OTHER, id: "u-sso", email: "sso@example.com", handle: "u-sso-h", hasPassword: false };
  const PENDING_AT = "2030-05-06T07:08:00.000Z";
  const whenOf = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
  const resetUrl = (id: string) => `${ADMIN_USERS_URL}/${id}/password-reset`;
  const rowOf = (email: string) => screen.getByRole("row", { name: email });
  const calls = (fetchMock: ReturnType<typeof vi.fn>, url: string, method: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);
  const actionName = (email: string) => `Reset password for ${email}`;
  const openFor = async (email: string) => {
    fireEvent.click(await within(await screen.findByRole("row", { name: email })).findByRole("button", { name: actionName(email) }));
    return screen.findByRole("dialog", { name: "Reset password" });
  };

  function stub(
    getRows: () => AdminUserDto[],
    opts: { passwordLoginEnabled?: boolean; extra?: (url: string, method: string, init?: RequestInit) => Response | null } = {},
  ) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const custom = opts.extra?.(url, method, init) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(getRows()) }));
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: opts.passwordLoginEnabled ?? true } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  it("R1 hasPassword:false 的列沒有重設鈕；有密碼的列（含自己那列）有", async () => {
    renderUsersRoute(stub(() => [SELF_ROW, ACTIVE_OTHER, NO_PASSWORD]));
    await screen.findByText(NO_PASSWORD.email);
    expect(within(rowOf(NO_PASSWORD.email)).queryByRole("button", { name: actionName(NO_PASSWORD.email) })).toBeNull();
    expect(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) })).toBeInTheDocument();
    expect(within(rowOf(SELF_ROW.email)).getByRole("button", { name: actionName(SELF_ROW.email) })).toBeInTheDocument();
  });

  it("R2 停用列的鈕 aria-disabled＋title 說明原因；點了不開對話框", async () => {
    renderUsersRoute(stub(() => [SELF_ROW, DISABLED_OTHER]));
    const button = await within(await screen.findByRole("row", { name: DISABLED_OTHER.email })).findByRole("button", { name: actionName(DISABLED_OTHER.email) });
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("title", "This account is disabled. Enable it before resetting its password.");
    fireEvent.click(button);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull();
  });

  it("R3 主流程：選時數 → POST 確切 body → 結果畫面（連結、到期時間）→ 複製（成功／失敗 toast）→ 完成 → 再開回到表單、明文已消失", async () => {
    const expiresAt = "2030-01-02T03:04:00.000Z";
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ token: "knbp_TEST", expiresAt }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    expect(dialog).toHaveTextContent(ACTIVE_OTHER.email);
    const select = within(dialog).getByLabelText("Link expires after") as HTMLSelectElement;
    expect(select).toHaveValue("1");
    expect(within(select).getAllByRole("option")).toHaveLength(24);
    expect(within(select).getAllByRole("option")[0]).toHaveTextContent("1 hour");
    expect(within(select).getAllByRole("option")[1]).toHaveTextContent("2 hours");
    fireEvent.change(select, { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

    const result = await screen.findByRole("dialog", { name: "Password reset link" });
    const post = calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "POST");
    expect(post).toHaveLength(1);
    expect(JSON.parse(String((post[0][1] as RequestInit).body))).toEqual({ expiresInHours: 3 });
    const url = `${window.location.origin}/reset-password#token=knbp_TEST`;
    expect((within(result).getByLabelText("Link") as HTMLInputElement).value).toBe(url);
    expect(result).toHaveTextContent(`It works once and expires ${whenOf(expiresAt)}.`);

    fireEvent.click(within(result).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(url));
    expect(await screen.findByText("Link copied.")).toBeInTheDocument();
    vi.mocked(copyText).mockResolvedValueOnce(false);
    fireEvent.click(within(result).getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText("Couldn't copy automatically — select the link above and copy it by hand.")).toBeInTheDocument();

    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Password reset link" })).toBeNull());
    fireEvent.click(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) }));
    expect(await screen.findByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/knbp_/)).toBeNull();
    expect((screen.getByLabelText("Link expires after") as HTMLSelectElement).value).toBe("1");
  });

  it("R4 待用連結：顯示到期句；Cancel link 送 DELETE，重抓後那一行消失、對話框仍開著", async () => {
    let rows = [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }];
    const fetchMock = stub(() => rows, {
      extra: (url, method) => {
        if (url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE") {
          rows = [SELF_ROW, ACTIVE_OTHER];
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      },
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    const pending = `An unused link expires ${whenOf(PENDING_AT)}. Creating a new one cancels it.`;
    expect(within(dialog).getByText(pending)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "DELETE")).toHaveLength(1));
    await waitFor(() => expect(within(dialog).queryByText(pending)).toBeNull());
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
  });

  it("R5 帳密登入關閉：說明段、Create link disabled、待用連結改 pendingSuspended、Cancel link 仍可送", async () => {
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      passwordLoginEnabled: false,
      extra: (url, method) => (url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE" ? fakeResponse({ ok: true, status: 204 }) : null),
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    expect(await within(dialog).findByText("Password sign-in is off on this site, so password reset links can't be created or used.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create link" })).toBeDisabled();
    expect(within(dialog).getByText(`An unused link expires ${whenOf(PENDING_AT)}. It can't be used while password sign-in is off.`)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "DELETE")).toHaveLength(1));
  });

  it("R6 產生失敗（409 user_disabled）：對話框關閉、列錯誤顯示 errors.user_disabled", async () => {
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "user_disabled", message: "x" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    const errorRow = await screen.findByRole("row", { name: `${ACTIVE_OTHER.email} error` });
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("This account is disabled. Enable it before resetting its password.");
  });

  it("M1 產生請求進行中按 Esc 關閉：回應回來後結果被丟棄，再開是表單、沒有明文", async () => {
    let release: () => void = () => {};
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? (new Promise<Response>((resolve) => {
              release = () => resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ token: "knbp_LATE", expiresAt: PENDING_AT }) }));
            }) as unknown as Response)
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    release();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    fireEvent.click(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) }));
    expect(await screen.findByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Password reset link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbp_/)).toBeNull();
  });

  it.each([
    ["成功", () => fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ token: "knbp_LATE", expiresAt: PENDING_AT }) })],
    ["失敗", () => fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "user_disabled", message: "x" } }) })],
  ] as const)("N1 產生進行中關閉、回應前又重開：上一次開啟的請求%s晚到，不影響新開的對話框", async (_label, late) => {
    let release: () => void = () => {};
    const fetchMock = stub(() => [SELF_ROW, ACTIVE_OTHER], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "POST"
          ? (new Promise<Response>((resolve) => {
              release = () => resolve(late());
            }) as unknown as Response)
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, resetUrl(ACTIVE_OTHER.id), "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    fireEvent.click(within(rowOf(ACTIVE_OTHER.email)).getByRole("button", { name: actionName(ACTIVE_OTHER.email) }));
    const reopened = await screen.findByRole("dialog", { name: "Reset password" });
    release();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBe(reopened);
    expect(screen.queryByRole("dialog", { name: "Password reset link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbp_/)).toBeNull();
    expect(screen.queryByRole("row", { name: `${ACTIVE_OTHER.email} error` })).toBeNull();
  });

  it("M2 取消失敗（DELETE 404 user_not_found）：對話框關閉、列錯誤顯示 errors.user_not_found", async () => {
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      extra: (url, method) =>
        url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE"
          ? fakeResponse({ ok: false, status: 404, json: () => Promise.resolve({ error: { code: "user_not_found", message: "x" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Reset password" })).toBeNull());
    const errorRow = await screen.findByRole("row", { name: `${ACTIVE_OTHER.email} error` });
    expect(within(errorRow).getByRole("alert")).toHaveTextContent("We couldn't find that user.");
  });

  it("N2a 產生進行中：取消連結鈕也停用", async () => {
    const hang = () => new Promise<Response>(() => {}) as unknown as Response;
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      extra: (url, method) => (url === resetUrl(ACTIVE_OTHER.id) && (method === "POST" || method === "DELETE") ? hang() : null),
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel link" })).toBeDisabled());
  });

  it("N2b 取消進行中：產生連結鈕也停用", async () => {
    const fetchMock = stub(() => [SELF_ROW, { ...ACTIVE_OTHER, passwordResetExpiresAt: PENDING_AT }], {
      extra: (url, method) => (url === resetUrl(ACTIVE_OTHER.id) && method === "DELETE" ? (new Promise<Response>(() => {}) as unknown as Response) : null),
    });
    renderUsersRoute(fetchMock);
    const dialog = await openFor(ACTIVE_OTHER.email);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel link" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Create link" })).toBeDisabled());
  });

  it("R7 點對話框外面不關閉", async () => {
    renderUsersRoute(stub(() => [SELF_ROW, ACTIVE_OTHER]));
    await openFor(ACTIVE_OTHER.email);
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Reset password" })).toBeInTheDocument();
  });
});

describe("邀請（#285 B-17）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const INVITES_URL = "/api/admin/invites";
  const CREATE_DESCRIPTION =
    "Creates a one-time link someone can use to create their own account with an email and a password. Accounts created this way are regular users. Anyone who has the link can use it, with any email — send it only to the person you're inviting.";
  const EXPIRES_AT = "2030-01-02T03:04:00.000Z";
  const inv = (over: Partial<AdminInviteDto> & Pick<AdminInviteDto, "id">): AdminInviteDto => ({
    label: null,
    status: "pending",
    createdAt: "2026-10-20T08:00:00.000Z",
    expiresAt: EXPIRES_AT,
    usedAt: null,
    revokedAt: null,
    createdBy: { id: "u-admin", email: "admin@example.com" },
    usedBy: null,
    ...over,
  });
  const calls = (fetchMock: ReturnType<typeof vi.fn>, url: string, method: string) =>
    fetchMock.mock.calls.filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET") === method);
  const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as unknown;

  function stub(opts: { passwordLoginEnabled?: boolean; getInvites?: () => AdminInviteDto[]; extra?: (url: string, method: string) => Response | null } = {}) {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      // 邀請列表先於 base（base 的空陣列只給別組用）
      if (url === INVITES_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve((opts.getInvites ?? (() => []))()) }));
      const custom = opts.extra?.(url, method) ?? baseFetchHandlers()(url, method);
      if (custom) return Promise.resolve(custom);
      if (url === ADMIN_USERS_URL && method === "GET") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: opts.passwordLoginEnabled ?? true } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }
  const createdResponse = (extra: (url: string, method: string) => Response | null = () => null) => (url: string, method: string) =>
    url === INVITES_URL && method === "POST"
      ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ invite: inv({ id: "i-new" }), token: "knbi_TEST" }) })
      : extra(url, method);
  const openCreate = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Create invitation" }));
    return screen.findByRole("dialog", { name: "Create an invitation" });
  };

  it("I1 頁首有「Create invitation」鈕，沒有「Create user」", async () => {
    renderUsersRoute(stub());
    expect(await screen.findByRole("button", { name: "Create invitation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create user" })).toBeNull();
  });

  it("I2 主流程：預設 3 天、七個選項 → POST 確切 body → 結果畫面（連結）→ 邀請表重抓 → 完成 → 再開回到表單、明文已消失", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    expect(within(dialog).getByText(CREATE_DESCRIPTION)).toBeInTheDocument();
    const select = within(dialog).getByLabelText("Link expires after") as HTMLSelectElement;
    expect(select).toHaveValue("3");
    expect(within(select).getAllByRole("option")).toHaveLength(7);
    expect(within(select).getAllByRole("option")[0]).toHaveTextContent("1 day");
    expect(within(select).getAllByRole("option")[1]).toHaveTextContent("2 days");
    fireEvent.change(select, { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));

    const result = await screen.findByRole("dialog", { name: "Invitation link" });
    const post = calls(fetchMock, INVITES_URL, "POST");
    expect(post).toHaveLength(1);
    expect(bodyOf(post[0])).toEqual({ expiresInDays: 5 });
    expect((within(result).getByLabelText("Link") as HTMLInputElement).value).toBe(`${window.location.origin}/register#invite=knbi_TEST`);
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "GET")).toHaveLength(2));

    fireEvent.click(within(result).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByRole("dialog", { name: "Create an invitation" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/knbi_/)).toBeNull();
    expect((screen.getByLabelText("Link expires after") as HTMLSelectElement).value).toBe("3");
  });

  it("I3a 備註：原樣送出（trim 由 server 做）", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "  Alice  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(bodyOf(calls(fetchMock, INVITES_URL, "POST")[0])).toEqual({ expiresInDays: 3, label: "  Alice  " });
  });

  it("I3a' 備註只有空白：body 不帶 label", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(bodyOf(calls(fetchMock, INVITES_URL, "POST")[0])).toEqual({ expiresInDays: 3 });
  });

  it("I3b 備註以 code point 計：100 個 emoji（JS length 200）照常送出", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "😀".repeat(100) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1);
  });

  it("I3c 備註 101 字：顯示 labelTooLong、沒有 POST", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "字".repeat(101) } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect(await within(dialog).findByText("A note can be at most 100 characters.")).toBeInTheDocument();
    expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(0);
  });

  it("I4（D1）帳密關閉：對話框有說明、Create link disabled", async () => {
    renderUsersRoute(stub({ passwordLoginEnabled: false }));
    const dialog = await openCreate();
    expect(await within(dialog).findByText("Password sign-in is off on this site, so invitations can't be created or used.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Create link" })).toBeDisabled();
  });

  it("I5 點對話框外面不關閉、已填內容仍在", async () => {
    renderUsersRoute(stub());
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: "keep me" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Create an invitation" })).toBeInTheDocument();
    expect(screen.getByLabelText("Note (optional)")).toHaveValue("keep me");
    // N-5：提示文字以 aria-describedby 連到輸入框
    expect(screen.getByLabelText("Note (optional)")).toHaveAccessibleDescription("Only admins see it, in the invitations list. Up to 100 characters.");
  });

  const TABLE_ROWS: AdminInviteDto[] = [
    inv({ id: "i-p1", label: "Alice", createdAt: "2026-10-20T08:00:00.000Z" }),
    inv({ id: "i-p2", label: null, createdAt: "2026-10-20T08:15:07.000Z", createdBy: null }),
    inv({ id: "i-p3", label: null, createdAt: "2026-10-20T08:15:42.000Z" }),
    inv({ id: "i-used", label: "Bob", status: "used", usedAt: "2026-10-20T09:00:00.000Z", usedBy: { id: "u-bob", email: "bob@example.com" } }),
    inv({ id: "i-revoked", label: "Carol", status: "revoked", revokedAt: "2026-10-20T09:00:00.000Z", createdBy: null }),
    inv({ id: "i-expired", label: "Dave", status: "expired" }),
  ];

  it("I6 邀請表：表頭、狀態文字、使用的帳號、副標、只有 pending 有撤銷鈕（無備註鈕名到秒、彼此不同）", async () => {
    renderUsersRoute(stub({ getInvites: () => TABLE_ROWS }));
    const table = await screen.findByRole("table", { name: "Invitations" });
    expect(within(table).getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Invitation", "Status", "Expires", "Used by", "Actions"]);
    const row = (name: string | RegExp) => within(table).getByRole("row", { name });
    expect(within(row(/Alice/)).getByText("Unused")).toBeInTheDocument();
    expect(within(row(/Bob/)).getByText("Used")).toBeInTheDocument();
    // spec §6.1：非 pending 的狀態與「—」用 muted（前例 ApiTokensSection.test）
    expect(within(row(/Alice/)).getByText("Unused")).not.toHaveClass("text-muted-foreground");
    expect(within(row(/Bob/)).getByText("Used")).toHaveClass("text-muted-foreground");
    expect(within(row(/Dave/)).getByText("—")).toHaveClass("text-muted-foreground");
    expect(within(row(/Bob/)).getByText("bob@example.com")).not.toHaveClass("text-muted-foreground");
    // 到期欄的內容
    expect(within(row(/Alice/)).getByText(new Date(EXPIRES_AT).toLocaleString("en", { dateStyle: "short", timeStyle: "short" }))).toBeInTheDocument();
    expect(within(row(/Carol/)).getByText("Revoked")).toBeInTheDocument();
    expect(within(row(/Dave/)).getByText("Expired")).toBeInTheDocument();
    expect(within(row(/Bob/)).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(row(/Alice/)).getByText("—")).toBeInTheDocument();
    expect(within(row(/Dave/)).getByText("—")).toBeInTheDocument();
    // createdBy 為 null 的列，副標以 "Created " 開頭（不是 "Created by"）
    expect(within(row(/Carol/)).getByText(/^Created (?!by)/)).toBeInTheDocument();
    expect(within(row(/Alice/)).getByText(/^Created by admin@example\.com, /)).toBeInTheDocument();

    const revokes = within(table).getAllByRole("button", { name: /^Revoke invitation/ });
    expect(revokes).toHaveLength(3);
    const secs = (iso: string) => new Date(iso).toLocaleString("en", { dateStyle: "short", timeStyle: "medium" });
    const names = revokes.map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toContain("Revoke invitation Alice");
    expect(names).toContain(`Revoke invitation created ${secs("2026-10-20T08:15:07.000Z")}`);
    expect(names).toContain(`Revoke invitation created ${secs("2026-10-20T08:15:42.000Z")}`);
    expect(secs("2026-10-20T08:15:07.000Z")).not.toBe(secs("2026-10-20T08:15:42.000Z"));
    expect(within(row(/Bob/)).queryByRole("button", { name: /^Revoke invitation/ })).toBeNull();
    expect(within(row(/Carol/)).queryByRole("button", { name: /^Revoke invitation/ })).toBeNull();
    expect(within(row(/Dave/)).queryByRole("button", { name: /^Revoke invitation/ })).toBeNull();
  });

  it("I7 撤銷：確認框 → DELETE → 重抓", async () => {
    let rows = [inv({ id: "i-p1", label: "Alice" })];
    const fetchMock = stub({
      getInvites: () => rows,
      extra: (url, method) => {
        if (url === `${INVITES_URL}/i-p1` && method === "DELETE") {
          rows = [];
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      },
    });
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation Alice" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    expect(within(confirm).getByText("The link stops working right away. This can't be undone; create a new invitation if you need one.")).toBeInTheDocument();
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(calls(fetchMock, `${INVITES_URL}/i-p1`, "DELETE")).toHaveLength(1));
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "GET")).toHaveLength(2));
    expect(await screen.findByText("No invitations yet.")).toBeInTheDocument();
  });

  it("I7b 撤銷失敗（409 invite_used）：toast 為 errors.invite_used", async () => {
    const fetchMock = stub({
      getInvites: () => [inv({ id: "i-p1", label: "Alice" })],
      extra: (url, method) =>
        url === `${INVITES_URL}/i-p1` && method === "DELETE"
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "invite_used", message: "used" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation Alice" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("This invitation has already been used and can't be revoked.")).toBeInTheDocument();
  });

  const hangingPost = () => {
    let release: (res: Response) => void = () => {};
    const extra = (url: string, method: string) =>
      url === INVITES_URL && method === "POST" ? (new Promise<Response>((resolve) => { release = resolve; }) as unknown as Response) : null;
    return { extra, release: (res: Response) => release(res) };
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  const okCreated = () => fakeResponse({ ok: true, status: 201, json: () => Promise.resolve({ invite: inv({ id: "i-late" }), token: "knbi_LATE" }) });

  it("I10 建立請求進行中按 Esc 關閉：回應回來後結果被丟棄，再開是表單、沒有明文", async () => {
    const hang = hangingPost();
    const fetchMock = stub({ extra: hang.extra });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an invitation" })).toBeNull());
    hang.release(okCreated());
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    expect(await screen.findByRole("dialog", { name: "Create an invitation" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbi_/)).toBeNull();
  });

  it.each([
    ["成功", okCreated],
    ["失敗", () => fakeResponse({ ok: false, status: 403, json: () => Promise.resolve({ error: { code: "password_login_disabled", message: "x" } }) })],
  ] as const)("I11 送出後關閉、回應前又重開：上一次開啟的請求%s晚到，不影響新開的對話框", async (_label, late) => {
    const hang = hangingPost();
    const fetchMock = stub({ extra: hang.extra });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an invitation" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const reopened = await screen.findByRole("dialog", { name: "Create an invitation" });
    hang.release(late());
    await settle();
    expect(screen.getByRole("dialog", { name: "Create an invitation" })).toBe(reopened);
    expect(screen.queryByRole("dialog", { name: "Invitation link" })).toBeNull();
    expect(screen.queryByDisplayValue(/knbi_/)).toBeNull();
    expect(within(reopened).queryByRole("alert")).toBeNull();
  });

  it("I12 送出後關閉再重開（舊請求還沒回）：送出鈕是 Create link 且可按，不是 Creating…／disabled", async () => {
    const hang = hangingPost();
    const fetchMock = stub({ extra: hang.extra });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Creating…" })).toBeDisabled());
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create an invitation" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Create invitation" }));
    const reopened = await screen.findByRole("dialog", { name: "Create an invitation" });
    expect(within(reopened).getByRole("button", { name: "Create link" })).toBeEnabled();
    expect(within(reopened).queryByRole("button", { name: "Creating…" })).toBeNull();
  });

  it("I13 建立失敗（403 password_login_disabled）：對話框內 role=alert 顯示該錯誤，表單仍在", async () => {
    const fetchMock = stub({
      extra: (url, method) =>
        url === INVITES_URL && method === "POST"
          ? fakeResponse({ ok: false, status: 403, json: () => Promise.resolve({ error: { code: "password_login_disabled", message: "x" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("This site only allows signing in through a sign-in service.");
    expect(screen.getByRole("dialog", { name: "Create an invitation" })).toBe(dialog);
    expect(within(dialog).getByRole("button", { name: "Create link" })).toBeEnabled();
  });

  it("I14 長度檢查先 trim：前後空白不算字數（100 字加空白照常送出）", async () => {
    const fetchMock = stub({ extra: createdResponse() });
    renderUsersRoute(fetchMock);
    const dialog = await openCreate();
    fireEvent.change(within(dialog).getByLabelText("Note (optional)"), { target: { value: `  ${"a".repeat(100)}  ` } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await screen.findByRole("dialog", { name: "Invitation link" });
    expect(calls(fetchMock, INVITES_URL, "POST")).toHaveLength(1);
  });

  it("I7c 撤銷遇到 409 invite_used：toast 之後列表重抓", async () => {
    const fetchMock = stub({
      getInvites: () => [inv({ id: "i-p1", label: "Alice" })],
      extra: (url, method) =>
        url === `${INVITES_URL}/i-p1` && method === "DELETE"
          ? fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "invite_used", message: "used" } }) })
          : null,
    });
    renderUsersRoute(fetchMock);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke invitation Alice" }));
    const confirm = await screen.findByRole("dialog", { name: "Revoke this invitation?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Revoke" }));
    expect(await screen.findByText("This invitation has already been used and can't be revoked.")).toBeInTheDocument();
    await waitFor(() => expect(calls(fetchMock, INVITES_URL, "GET")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Revoke this invitation?" })).toBeNull());
  });

  const SUSPENDED = "Password sign-in is off, so unused invitations can't be used right now. Turn it back on and the ones that haven't expired work again.";

  it("I8（D2）帳密關閉 → 表上方 role=status 提示", async () => {
    renderUsersRoute(stub({ passwordLoginEnabled: false, getInvites: () => [inv({ id: "i-p1", label: "Alice" })] }));
    expect(await screen.findByRole("status")).toHaveTextContent(SUSPENDED);
  });

  it("I8b 帳密開啟 → 沒有提示（等 config 與邀請列都到了才判）", async () => {
    const fetchMock = stub({ getInvites: () => [inv({ id: "i-p1", label: "Alice" })] });
    renderUsersRoute(fetchMock);
    await screen.findByRole("button", { name: "Revoke invitation Alice" });
    await waitFor(() => expect(calls(fetchMock, "/api/auth/config", "GET").length).toBeGreaterThanOrEqual(1));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.queryByText(SUSPENDED)).toBeNull();
  });

  it("I9 沒有邀請 → No invitations yet.", async () => {
    renderUsersRoute(stub());
    expect(await screen.findByText("No invitations yet.")).toBeInTheDocument();
  });
});
