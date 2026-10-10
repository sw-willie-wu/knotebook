import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { MIN_PASSWORD_LENGTH, type StoragePlanDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import type { AdminUserDto } from "@/api/admin";

// 歷程：Task 15 的獨立頁 `/admin/users` → Plan 4 併進設定 modal（`/settings/users`，
// Task 8 逐案有意識重寫，spec §13.5-5）→ 2026-09-30 搬回獨立頁 `/admin/users`
// （`pages/AdminPage.tsx` 的 `<Outlet/>`，殼是 `AppShell`）。元件本體沒改，本檔各案
// 直接查 heading/row 的寫法不依賴外殼，只換了進入網址與那一則外殼 smoke。
// - fetch mock 裡的 `/api/notes`、`/api/groups` 是設定 modal 時代留下的（當時主樹在
//   背景 render `HomePage`）；搬到 `/admin/users` 後側欄不再有 NoteList，留著無害。
// - 「停用」案的確認 dialog 現在是畫面上唯一一層 Dialog（不再疊在設定 modal 上）；
//   該案取最後一個 dialog 的寫法兩種情況都成立。
//
// 「非 admin → 導 `/`」與未登入導向在 `pages/AdminPage.test.tsx`（route-level，驗證
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
  storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648 },
};

/** 已是 admin、但不是目前登入者本人的一列——用來驗證「已是 admin 不出現 Promote 鈕」
 * 這條規則本身，跟「自己那列不出現 Disable/Enable 鈕」是兩件獨立的事，不能共用
 * 同一筆 fixture（沿用原案的說明，見遷移前的舊版 admin 使用者頁測試檔）。 */
const OTHER_ADMIN: AdminUserDto = {
  id: "u-other-admin",
  email: "carol@example.com",
  handle: "u-other-admin-h",
  displayName: "Carol",
  isAdmin: true,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
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

  it("外殼 smoke：/admin/users 掛在站台管理頁（AppShell＋管理導覽）底下，不是設定 modal", async () => {
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

    // 本檔第一次載入 AdminPage lazy chunk
    expect(await screen.findByRole("heading", { name: "User management" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // 側欄的管理導覽（`AdminNav`），Users 項是目前頁。
    expect(within(screen.getByRole("navigation", { name: "Site admin" })).getByRole("link", { name: "Users" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("admin 造訪 /admin/users → 渲染表格，disabled 徽章與 enable/disable 依狀態互斥", async () => {
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
      handle: ADMIN_USER.handle,
      displayName: ADMIN_USER.displayName,
      isAdmin: true,
      disabledAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648 },
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

    // Radix Dialog 開啟後背景整片會標成 aria-hidden，確認鈕只能從 dialog 內找。
    // `getAllByRole` 取最後一個（最上層、最新掛載的那個）——設定 modal 時代這裡疊著
    // 兩層 Dialog；搬到 /admin/users 後只剩確認 dialog 一層，寫法照樣成立。
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

// #122 PR1 Task 5：表格新增使用者名欄（AdminUserDto.handle）。fixture 的 handle 由
// 下面這案自帶（既有 fixture 未含 handle——AdminUserDto 收緊後 typecheck 會逼齊）。
describe("SettingsUsersSection——使用者名欄（#122 Task 5）", () => {
  it("表頭有 Username 欄、cell 顯示各列 handle", async () => {
    const withHandles = [
      { ...ACTIVE_OTHER, handle: "alice-h" },
      { ...DISABLED_OTHER, handle: "bob-h" },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(withHandles) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderUsersRoute(fetchMock);
    await screen.findByText("alice@example.com");
    expect(screen.getByRole("columnheader", { name: "Username" })).toBeInTheDocument();
    expect(screen.getByText("alice-h")).toBeInTheDocument();
    expect(screen.getByText("bob-h")).toBeInTheDocument();
  });

  it("長 email／username／顯示名稱版面守衛：三格 wrap-anywhere、角色／狀態／儲存空間不換行、操作欄 w-px 不換行（比照 #183）", async () => {
    // jsdom 不排版、量不到溢出，只能釘住決定溢出與否的 class token（`classList` 陣列比對）。
    const LONG_EMAIL = "firstnamelastnamewithnonaturalbreakpoints0123456789@averyveryverylongcompanydomainname.example";
    const LONG_HANDLE = "averylongusernamewithoutanyseparatorsatall0123456789abcdef";
    const LONG_NAME = "Averylongdisplaynamewithoutanyspacesorhyphensatall";
    const longUser = { ...ACTIVE_OTHER, id: "u-long", email: LONG_EMAIL, handle: LONG_HANDLE, displayName: LONG_NAME };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === ADMIN_USERS_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([longUser]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderUsersRoute(fetchMock);
    const emailCell = (await screen.findByText(LONG_EMAIL)).closest("td");
    const tokens = (el: Element | null) => [...(el?.classList ?? [])];
    // 三格同時要有 wrap-anywhere（可斷行）與 min-w-[14ch]（窄螢幕下限，否則被壓成一字寬直排）。
    expect(tokens(emailCell)).toEqual(expect.arrayContaining(["wrap-anywhere", "min-w-[14ch]"]));
    expect(tokens(screen.getByText(LONG_HANDLE).closest("td"))).toEqual(expect.arrayContaining(["wrap-anywhere", "min-w-[14ch]"]));
    expect(tokens(screen.getByText(LONG_NAME).closest("td"))).toEqual(expect.arrayContaining(["wrap-anywhere", "min-w-[14ch]"]));
    const cells = (emailCell?.closest("tr") as HTMLElement).querySelectorAll("td");
    expect(tokens(cells[3])).toContain("whitespace-nowrap");
    expect(tokens(cells[4])).toContain("whitespace-nowrap");
    expect(tokens(cells[5])).toContain("whitespace-nowrap"); // 儲存空間欄（W5 後插在狀態與方案之間）
    expect(tokens(cells[7])).toEqual(expect.arrayContaining(["w-px", "whitespace-nowrap"])); // 操作欄移到最後（索引 5→7）
    expect(tokens(screen.getByRole("columnheader", { name: "Actions" }))).toEqual(
      expect.arrayContaining(["w-px", "whitespace-nowrap"]),
    );
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
