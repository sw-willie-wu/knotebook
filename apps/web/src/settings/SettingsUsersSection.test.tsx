import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { MIN_PASSWORD_LENGTH, type UserDto } from "@knotebook/shared";
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

const ADMIN_USER: UserDto = {
  id: "u-admin",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};

const ACTIVE_OTHER: AdminUserDto = {
  id: "u-active",
  email: "alice@example.com",
  handle: "u-active-h",
  displayName: "Alice",
  isAdmin: false,
  disabledAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const DISABLED_OTHER: AdminUserDto = {
  id: "u-disabled",
  email: "bob@example.com",
  handle: "u-disabled-h",
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
  handle: "u-other-admin-h",
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
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
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

  it("長 email／username／顯示名稱版面守衛：三格 wrap-anywhere、角色狀態不換行、操作欄 w-px 不換行（比照 #183）", async () => {
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
    expect(tokens(emailCell)).toContain("wrap-anywhere");
    expect(tokens(screen.getByText(LONG_HANDLE).closest("td"))).toContain("wrap-anywhere");
    expect(tokens(screen.getByText(LONG_NAME).closest("td"))).toContain("wrap-anywhere");
    const cells = (emailCell?.closest("tr") as HTMLElement).querySelectorAll("td");
    expect(tokens(cells[3])).toContain("whitespace-nowrap");
    expect(tokens(cells[4])).toContain("whitespace-nowrap");
    expect(tokens(cells[5])).toEqual(expect.arrayContaining(["w-px", "whitespace-nowrap"]));
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
