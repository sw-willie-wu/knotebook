import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { AuthConfigDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import LoginPage from "./LoginPage";

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
    // re-render 完成（若真的漏接、之後才補一顆連結，這種只驗證「呼叫過」的寫法還是會
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

// ── #131：登入成功後回到 ?next=，SSO 連結把 next 轉交給 server ────────────────
//
// 這一族用**隔離的** harness（只掛 LoginPage ＋ catch-all 探針），不走 AppRoutes：
// next 的落點是任意路徑，走真實路由樹會把 NotePage 那整條資料路徑拖進來。
//
// ⚠ 代價要講清楚：本族**證明不了**「導過去之後那條路由在真實樹裡渲染得出來」——
// navigate 之後會經過 RequireAuth／ChangePasswordGate，本族一概繞過（catch-all 探針
// 什麼路徑都接）。那一段由 Task 7 的 e2e 覆蓋。特別是 mustChangePassword:true 的人
// 帶著 next 登入時，gate 會把他攔去 /change-password、改完落 `/`，next 靜默遺失——
// 那是 spec 明載接受的限制，不是本族的漏測。
//
// ⚠ queryClient.invalidateQueries({ queryKey: SESSION_QUERY_KEY }) 在這個 harness 裡
// **不會**打 /api/auth/me：TanStack v5 的 refetchType 預設 "active"，而這裡沒有任何
// 元件訂閱 ['me']（useSession 沒被掛載）→ 不 refetch，所以 fetch 樁不需要那條路由。
// （實測過整條登入流程只發出 GET /api/auth/config 與 POST /api/auth/login 兩發。）

const LOGIN_URL = "/api/auth/login";
const OIDC_LOGIN_URL = "/api/auth/oidc/login";

/** 落點探針：把 location 逐字印成單一 text node。同時掛在 /login 與 catch-all 底下，
 * 所以「還在登入頁但網址被改寫」與「已經導走」兩種情形都觀測得到。 */
function LocationProbe({ testId }: { testId: string }) {
  const location = useLocation();
  return <div data-testid={testId}>{`${location.pathname}${location.search}`}</div>;
}

/** auth-config（SSO 開關可調）＋ 成功的 POST /api/auth/login。 */
function fetchMockLoginOk(oidcEnabled = false): ReturnType<typeof vi.fn> {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === AUTH_CONFIG_URL && method === "GET") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ oidc: { enabled: oidcEnabled } }) }),
      );
    }
    if (url === LOGIN_URL && method === "POST") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            // 欄位與 UserDto 逐一對齊（含 #122 的 handle，且 "alice" 對得起各案用的
            // /n/alice/…）——不要「精簡」掉，多一欄少一欄都會讓樁對真實回應失真。
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              handle: "alice",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword: false,
              hasPassword: true,
            }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

/** 讓測試可以按「上一頁」，用來分辨 replace 與 push。 */
function BackButton() {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => void navigate(-1)}>
      back
    </button>
  );
}

function renderLoginWithProbe(initialPath: string, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route
            path="/login"
            element={
              <>
                <LoginPage />
                <LocationProbe testId="login-location" />
              </>
            }
          />
          <Route path="*" element={<LocationProbe testId="location" />} />
        </Routes>
        <BackButton />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** 文案照抄既有案：login.email="Email"、login.password="Password"、login.submit="Sign in"。
 * 三個 fireEvent 都是同步的——真正的等待在呼叫端的 expectLandedOn。 */
function submitLogin() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@example.com" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
}

async function expectLandedOn(expected: string) {
  await waitFor(() => {
    expect(screen.getByTestId("location").textContent).toBe(expected);
  });
}

describe("#131 登入後導回 next", () => {
  beforeEach(async () => {
    // ⚠ 既有的 beforeEach/afterEach 關在別的 describe 裡，這個新 describe 吃不到——
    // 自己帶一份。少了 changeLanguage，新案只是「碰巧」拿到英文（前一個 describe 的
    // 全域副作用），是靠執行順序的假綠。
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("合法 next → 登入成功後落在該路徑（含 query，逐字）", async () => {
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/n/alice/my-note?x=1");
  });

  it("next 內含百分比編碼 → 只解一次，逐字導過去（多解一次就會變 mojibake）", async () => {
    // 這是與 Task 3 產生端的接縫：guards 餵的是 location.pathname，而**它本身就是**
    // 百分比編碼形（#122 之後 /n/<handle>/<slug> 的 slug 常常是 %E7%AD%86… 這種），
    // 所以 guards 送出來的 next 值裡 % 已經被編成 %25。這裡若多做一次
    // decodeURIComponent，七個純 ASCII 的案子都察覺不到，只有這一案會紅。
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2F%25E7%25AD%2586", fetchMockLoginOk(true));

    const link = await screen.findByRole("link", { name: /sso/i });
    expect(link).toHaveAttribute("href", `${OIDC_LOGIN_URL}?next=%2Fn%2Falice%2F%25E7%25AD%2586`);

    submitLogin();

    await expectLandedOn("/n/alice/%E7%AD%86");
  });

  it("跨站 next → 落 /（safeNextPath 擋下，不得直接餵 navigate）", async () => {
    renderLoginWithProbe("/login?next=%2F%2Fevil.example", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/");
  });

  it("非 SPA 路徑的 next（/api/notes）→ 落 /（web 端也吃 isExcludedPath）", async () => {
    renderLoginWithProbe("/login?next=%2Fapi%2Fnotes", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/");
  });

  it("沒有 next → 落 /（既有行為不變）", async () => {
    renderLoginWithProbe("/login", fetchMockLoginOk());

    submitLogin();

    await expectLandedOn("/");
  });

  it("導向是 replace 不是 push：登入完按上一頁不會回到已登入狀態的登入頁", async () => {
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2Fmy-note", fetchMockLoginOk());

    submitLogin();
    await expectLandedOn("/n/alice/my-note");
    fireEvent.click(screen.getByRole("button", { name: "back" }));

    // replace：登入頁那一筆已被取代，歷史裡沒有可回去的項目 → 原地不動。
    // 若是 push：會回到 /login?next=…（此時已登入）＝死路。
    await expectLandedOn("/n/alice/my-note");
    expect(screen.queryByTestId("login-location")).not.toBeInTheDocument();
  });

  it("SSO 連結把合法 next 轉交給 server（encode 一次）", async () => {
    renderLoginWithProbe("/login?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1", fetchMockLoginOk(true));

    const link = await screen.findByRole("link", { name: /sso/i });
    expect(link).toHaveAttribute("href", `${OIDC_LOGIN_URL}?next=%2Fn%2Falice%2Fmy-note%3Fx%3D1`);
  });

  it("不合法的 next 不原樣透傳給 server——驗證不整個押在 server 端", async () => {
    renderLoginWithProbe("/login?next=%2F%2Fevil.example", fetchMockLoginOk(true));

    const link = await screen.findByRole("link", { name: /sso/i });
    expect(link).toHaveAttribute("href", OIDC_LOGIN_URL);
  });

  it("清掉一次性的 ?error= 時只刪那一個鍵：error 消失、next 留著", async () => {
    // 掛載時的 effect 會把 ?error= 從網址移除（既有行為，避免重新整理把舊錯誤帶回來）。
    // 兩半都要斷言：只驗「next 還在」的話，把整個 effect 刪掉本案照樣綠；只驗「error
    // 不見」的話，改成整個換掉 searchParams 也照樣綠。
    renderLoginWithProbe("/login?error=oidc_email_unverified&next=%2Fn%2Falice%2Fmy-note", fetchMockLoginOk(true));

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId("login-location").textContent).toBe("/login?next=%2Fn%2Falice%2Fmy-note");
    });
    const link = await screen.findByRole("link", { name: /sso/i });
    expect(link).toHaveAttribute("href", `${OIDC_LOGIN_URL}?next=%2Fn%2Falice%2Fmy-note`);

    // 清除本身是 replace：按上一頁不該回到那個帶 ?error= 的網址（否則使用者會看到
    // 一個早就消化完的舊錯誤）。
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    await waitFor(() => {
      expect(screen.getByTestId("login-location").textContent).toBe("/login?next=%2Fn%2Falice%2Fmy-note");
    });

    submitLogin();

    await expectLandedOn("/n/alice/my-note");
  });
});
