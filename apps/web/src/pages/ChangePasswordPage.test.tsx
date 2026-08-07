import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// 同 AdminUsersPage.test.tsx 的約定：mock 全域 fetch，走真正的 `AppRoutes`
// （App.tsx 的唯一真相樹），不 mock ChangePasswordPage 本身——驗證的是「有沒有接對」
// （route 掛在 <RequireAuth> 底下、成功後 ['me'] refetch 到 mustChangePassword:false
// 並落在 /，登出按鈕真的能逃出這頁），而不只是元件單獨渲染的行為。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER_MUST_CHANGE: UserDto = {
  id: "u1",
  email: "alice@example.com",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: true,
};

const CHANGE_PASSWORD_URL = "/api/auth/password";

/** 基本 fetch mock：`/api/setup/status`（needed:false）、`/api/auth/me`（回傳
 * `loggedInAs`，可隨後續呼叫變動——用一個 getter 而非固定值，讓「改密碼成功/登出後
 * 下一次 me query 的回應會變」這件事有得測，而不是整個測試檔固定死一個回應）。 */
function baseFetchHandlers(getLoggedInAs: () => UserDto | null) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/setup/status") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ needed: false }) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      const user = getLoggedInAs();
      if (user) {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
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

function renderAt(initialPath: string, fetchMock: ReturnType<typeof vi.fn>, queryClient: QueryClient = new QueryClient()) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("ChangePasswordPage（spec rev 5.7）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mustChangePassword:true 使用者訪 /change-password → 渲染表單（不被 gate 導開）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
  });

  it("新密碼 <12 字元 → client 端擋下，不打 API", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByText("Password is too short.")).toBeInTheDocument());
    const postCalls = fetchMock.mock.calls.filter(
      ([reqUrl, reqInit]) => String(reqUrl) === CHANGE_PASSWORD_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("新密碼與確認新密碼不一致 → client 端擋下，不打 API", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => USER_MUST_CHANGE)(url, method);
      if (base) return Promise.resolve(base);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password-here" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    await waitFor(() => expect(screen.getByText("The new password and confirmation don't match.")).toBeInTheDocument());
    const postCalls = fetchMock.mock.calls.filter(
      ([reqUrl, reqInit]) => String(reqUrl) === CHANGE_PASSWORD_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("成功流程（模擬真實 server 行為：204 重簽新 cookie，仍算登入）→ me refetch 回 mustChangePassword:false → 導向 /（gate 自然放行，不落在 change-password 或 login）", async () => {
    // `routes/auth.ts` 的 POST /api/auth/password 成功時會替這次 request 重簽一顆新
    // session cookie（見該檔說明）——使用者並未被登出。之後的 GET /api/auth/me（本頁
    // `invalidateQueries` 觸發的 refetch）理應回 200，且 mustChangePassword 已被
    // server 清成 false。這裡用一個 closure 旗標模擬這個狀態轉換，而不是直接 mock 死
    // 「改密碼後 401」——那樣測的是與 production 相反的行為（round 1 review 指出的
    // test-integrity 問題）。
    let mustChange = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => ({ ...USER_MUST_CHANGE, mustChangePassword: mustChange }))(url, method);
      if (base) return Promise.resolve(base);
      if (url === CHANGE_PASSWORD_URL && method === "POST") {
        mustChange = false; // server 端已清旗標；cookie 仍有效（重簽），不是登出
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByLabelText("Current password")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "new-correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));

    // 落在首頁（AppShell 的「New note」按鈕）——不是改密碼表單，也不是登入頁；使用者
    // 全程沒有被登出過。
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();

    // 送出的 body 正確（不含 confirmNewPassword）。
    const call = fetchMock.mock.calls.find(
      ([reqUrl, reqInit]) => String(reqUrl) === CHANGE_PASSWORD_URL && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(call).toBeDefined();
    const [, init] = call as [RequestInfo, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      currentPassword: "correct-horse-battery",
      newPassword: "new-correct-horse-battery",
    });

    // ['me'] 快取反映了 refetch 到的新狀態：仍是同一個使用者、mustChangePassword 已清
    // false——正是這個值的變化驅動 ChangePasswordGate 放行，不是頁面自己硬導航繞過 gate。
    expect(queryClient.getQueryData(["me"])).toMatchObject({ id: USER_MUST_CHANGE.id, mustChangePassword: false });

    // 成功 toast 有顯示，且不再提「請重新登入」（真的沒有登出）。
    expect(screen.getByText("Password updated.")).toBeInTheDocument();
  });

  it("忘記目前密碼：改密碼頁上的登出按鈕會登出並導向 /login（Important 1：避免使用者被永久卡在此頁）", async () => {
    let loggedInAs: UserDto | null = USER_MUST_CHANGE;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers(() => loggedInAs)(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/auth/logout" && method === "POST") {
        loggedInAs = null;
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const queryClient = renderAt("/change-password", fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();

    const logoutCall = fetchMock.mock.calls.find(
      ([reqUrl, reqInit]) => String(reqUrl) === "/api/auth/logout" && (reqInit as RequestInit | undefined)?.method === "POST",
    );
    expect(logoutCall).toBeDefined();
    expect(queryClient.getQueryData(["me"])).toBeNull();
  });
});
