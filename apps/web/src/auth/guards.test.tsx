import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import "@/i18n";
import { SetupGate, RequireAuth, ChangePasswordGate } from "./guards";

// §11.3 逐字守衛規則的 fetch-mocked 測試：不打真的 server，只驗證
// `/api/setup/status`、`/api/auth/me` 回傳不同組合時，路由最終落在哪個佔位頁面。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

function mockFetch(opts: { needed: boolean; loggedIn: boolean }) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/setup/status") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ needed: opts.needed }) }));
    }
    if (url === "/api/auth/me") {
      if (opts.loggedIn) {
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ id: "u1", email: "a@example.com", displayName: "Alice", isAdmin: false }),
          }),
        );
      }
      return Promise.resolve(
        fakeResponse({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** `/api/setup/status` 直接 reject（模擬網路失敗/500）；`/api/auth/me` 照常回 401——
 * 給 Important 2 的 fail-open 回歸測試用：setup-status 出錯不代表「不需要 setup」。 */
function mockFetchSetupStatusError() {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/setup/status") {
      return Promise.reject(new Error("network down"));
    }
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// 用宣告式 <MemoryRouter>/<Routes>/<Route>（非 data router）render，避開
// react-router v8 data router 內部 `createClientSideRequest` 在 jsdom 測試環境下
// 建構 `new Request(..., { signal })` 時 jsdom AbortSignal 與 undici AbortSignal
// 不同 realm 導致的 `instanceof` 失敗——production 用的 createBrowserRouter 不受
// 影響（真瀏覽器環境只有一份 AbortSignal），這裡守衛元件本身（Navigate/Outlet/
// useLocation）在兩種路由模式下行為一致，測的是守衛邏輯而非路由器種類。
function renderAt(initialPath: string, queryClient: QueryClient = new QueryClient()) {
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<SetupGate />}>
            <Route path="/setup" element={<div>setup-page</div>} />
            <Route path="/login" element={<div>login-page</div>} />
            <Route element={<RequireAuth />}>
              <Route path="/*" element={<div>home-page</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** `needed:false`、已登入，且可指定 `mustChangePassword`——給 `ChangePasswordGate`
 * （spec rev 5.7）測試用，其餘行為與 `mockFetch({needed:false, loggedIn:true})` 相同。 */
function mockFetchMustChangePassword(mustChangePassword: boolean) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/setup/status") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ needed: false }) }));
    }
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ id: "u1", email: "a@example.com", displayName: "Alice", isAdmin: false, mustChangePassword }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** 同 `renderAt`，但多掛一條 `/change-password` 路由，且用 `<ChangePasswordGate>`
 * 包住 `/*` catch-all——與 `App.tsx` 的真實巢狀方式一致（`/change-password` 本身在
 * gate 外面，其餘路由在 gate 裡面）。 */
function renderChangePasswordGateAt(initialPath: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<SetupGate />}>
            <Route path="/login" element={<div>login-page</div>} />
            <Route element={<RequireAuth />}>
              <Route path="/change-password" element={<div>change-password-page</div>} />
              <Route element={<ChangePasswordGate />}>
                <Route path="/*" element={<div>home-page</div>} />
              </Route>
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ChangePasswordGate（spec rev 5.7）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mustChangePassword:true 訪 / → 導向 /change-password", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(true));

    renderChangePasswordGateAt("/");

    await waitFor(() => expect(screen.getByText("change-password-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  it("mustChangePassword:false 訪 / → 不導向，正常放行", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(false));

    renderChangePasswordGateAt("/");

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
    expect(screen.queryByText("change-password-page")).not.toBeInTheDocument();
  });

  it("mustChangePassword:true 直接訪 /change-password → 停留原地，不會被導去別處（gate 在它外面）", async () => {
    vi.stubGlobal("fetch", mockFetchMustChangePassword(true));

    renderChangePasswordGateAt("/change-password");

    await waitFor(() => expect(screen.getByText("change-password-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });
});

describe("route guards (§11.3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("needed:true visiting / redirects to /setup", async () => {
    vi.stubGlobal("fetch", mockFetch({ needed: true, loggedIn: false }));

    renderAt("/");

    await waitFor(() => expect(screen.getByText("setup-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  it("needed:false, already logged in, visiting /setup redirects to /", async () => {
    vi.stubGlobal("fetch", mockFetch({ needed: false, loggedIn: true }));

    renderAt("/setup");

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
    expect(screen.queryByText("setup-page")).not.toBeInTheDocument();
  });

  it("needed:false, not logged in, visiting / redirects to /login", async () => {
    vi.stubGlobal("fetch", mockFetch({ needed: false, loggedIn: false }));

    renderAt("/");

    await waitFor(() => expect(screen.getByText("login-page")).toBeInTheDocument());
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  it("needed:false, not logged in, visiting /setup redirects to /login", async () => {
    vi.stubGlobal("fetch", mockFetch({ needed: false, loggedIn: false }));

    renderAt("/setup");

    await waitFor(() => expect(screen.getByText("login-page")).toBeInTheDocument());
    expect(screen.queryByText("setup-page")).not.toBeInTheDocument();
  });

  it("setup-status query error does NOT fail open to 'not needed' (Important 2)", async () => {
    vi.stubGlobal("fetch", mockFetchSetupStatusError());
    // retry:false——預設的 exponential-backoff retry 會讓這個測試等好幾秒才進 error 狀態。
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderAt("/", queryClient);

    await waitFor(() => expect(queryClient.getQueryState(["setup-status"])?.status).toBe("error"));

    // 不能落到 needed:false 那個分支：不可導向 /login（那裡沒有任何帳號可登入），
    // 也不可放行到 home-page；停在 loading 畫面才是安全的失敗模式。
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
    expect(screen.queryByText("setup-page")).not.toBeInTheDocument();
  });
});
