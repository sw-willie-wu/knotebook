import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { AuthConfigDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// LoginPage 新增（Plan 5 Task 10）：react-query `['auth-config']` 讀
// `GET /api/auth/config`，`oidc.enabled` 決定要不要多渲染一顆 SSO 入口
// （純 `<a href="/api/auth/oidc/login">`，全頁跳轉，不走 `api()`——見 client.ts；
// 302 鏈須由瀏覽器頂層導航承載，spec §14.4）。`?error=` 走既有
// `t(`errors.${code}`, {defaultValue: t("errors.fallback")})` 機制，渲染在既有
// `role="alert"` 區。fetch 樁慣例比照 `SettingsUsersSection.test.tsx:89-101`
// （`vi.stubGlobal("fetch", …)`＋`afterEach` `vi.unstubAllGlobals()`）；不引 msw。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const AUTH_CONFIG_URL = "/api/auth/config";

/** `/login` 路由本身不掛在 `<RequireAuth>` 底下，因此本檔不需要 `/api/auth/me`
 * 樁——真正驗證「未登入時 /login 可直接渲染」的案例已在既有測試覆蓋，這裡只關心
 * SSO 入口與 `?error=` 映射。 */
function fetchMockWithAuthConfig(config: AuthConfigDto): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === AUTH_CONFIG_URL && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(config) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function renderAt(
  initialPath: string,
  fetchMock: ReturnType<typeof vi.fn>,
  queryClient: QueryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
): QueryClient {
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

describe("LoginPage（Plan 5 Task 10：SSO 入口＋?error= 映射）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("oidc.enabled:false → 不渲染 SSO 鈕", async () => {
    const fetchMock = fetchMockWithAuthConfig({ oidc: { enabled: false } });
    const queryClient = renderAt("/login", fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument());
    // post-settle 訊號（fix round 1 NIT-5）：不能只靠「fetchMock 被呼叫過」就斷言無
    // SSO 鈕——那只證明請求已發出，不保證回應已解析、component 已依 `{enabled:false}`
    // re-render 完成（若真的漏接、之後才补一顆連結，這種只驗證「呼叫過」的寫法還是會
    // 誤判通過）。改成等 query cache 裡真的寫進已解析的資料，才是貨真價實的 settle
    // 訊號。
    await waitFor(() => expect(queryClient.getQueryData(["auth-config"])).toEqual({ oidc: { enabled: false } }));
    expect(screen.queryByRole("link", { name: /sso/i })).not.toBeInTheDocument();
  });

  it("oidc.enabled:true → SSO 鈕存在且 href 指向 /api/auth/oidc/login（純 <a>，全頁跳轉）", async () => {
    const fetchMock = fetchMockWithAuthConfig({ oidc: { enabled: true } });
    renderAt("/login", fetchMock);

    const ssoLink = await screen.findByRole("link", { name: /sso/i });
    expect(ssoLink).toHaveAttribute("href", "/api/auth/oidc/login");
  });

  it("?error=oidc_email_unverified → alert 區出現對應文案", async () => {
    const fetchMock = fetchMockWithAuthConfig({ oidc: { enabled: false } });
    renderAt("/login?error=oidc_email_unverified", fetchMock);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Your identity provider hasn't verified your email address yet."),
    );
  });

  it("?error=not_a_real_code → 未知碼退回 errors.fallback 文案", async () => {
    const fetchMock = fetchMockWithAuthConfig({ oidc: { enabled: false } });
    renderAt("/login?error=not_a_real_code", fetchMock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred."));
  });

  // fix round 1 MAJOR-1：`?error=` 是任意 query string，直接餵給 `t()` 曾實測炸出
  // 兩種問題——`__proto__` 命中 `Object.prototype` 繼承屬性；`constructor` 讓 `t()`
  // 解析出 `errors` 物件的 `constructor`（一個 function）當翻譯結果，塞進 JSX 會是
  // 「Functions are not valid as a React child」執行期錯誤（`render()` 本身就會拋出，
  // 這裡不需要額外斷言「沒有 throw」——測試跑到 `waitFor` 這行沒有意外拋出，本身就是
  // 迴歸證據）。修法：先過 shared `ERROR_CODES` 白名單，不在集合內一律視為 `fallback`。
  it("?error=__proto__ → 不炸掉（Object.prototype 繼承屬性），退回 errors.fallback 文案", async () => {
    const fetchMock = fetchMockWithAuthConfig({ oidc: { enabled: false } });
    renderAt("/login?error=__proto__", fetchMock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred."));
  });

  it("?error=constructor → 不炸掉（Functions are not valid as a React child），退回 errors.fallback 文案", async () => {
    const fetchMock = fetchMockWithAuthConfig({ oidc: { enabled: false } });
    renderAt("/login?error=constructor", fetchMock);

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred."));
  });

  // fix round 1 NIT-6：`?error=` 帶進來的訊息現在直接餵進 `errorMessage` state 的
  // 初始值，因此 `handleSubmit` 一開頭既有的 `setErrorMessage(null)` 會自然蓋掉它——
  // 重新送出表單、進入等待回應的空窗期，畫面上不該閃回這則跟本次提交無關的舊 OIDC
  // 錯誤。用一個可控制何時 resolve 的 login 端點驗證「送出當下（回應還沒回來）」這個
  // 空窗期本身就已經看不到舊訊息，而不是等到新結果回來才看得到（那樣測不出「閃現」
  // 這個問題）。
  it("重新送出表單時，舊的 ?error= OIDC 錯誤訊息不會在等待回應期間閃現", async () => {
    let resolveLogin: (() => void) | undefined;
    const loginPending = new Promise<void>((resolve) => {
      resolveLogin = resolve;
    });
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === AUTH_CONFIG_URL && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ oidc: { enabled: false } }) }),
        );
      }
      if (url === "/api/auth/login" && method === "POST") {
        return loginPending.then(() =>
          fakeResponse({
            ok: false,
            status: 401,
            json: () => Promise.resolve({ error: { code: "invalid_credentials", message: "nope" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderAt("/login?error=oidc_email_unverified", fetchMock);

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Your identity provider hasn't verified your email address yet."),
    );

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "alice@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // 送出當下（login 回應仍卡在 `loginPending`，尚未 resolve）：舊的 OIDC 錯誤訊息
    // 已被 `setErrorMessage(null)` 蓋掉，alert 區應完全不存在。
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    resolveLogin?.();

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Incorrect email or password."));
  });
});
