import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import "@/i18n";
import { RequireAuth, ChangePasswordGate } from "./guards";

// `ChangePasswordGate` 的 fetch-mocked 測試：不打真的 server，只驗證
// `/api/auth/me` 回傳不同組合時，路由最終落在哪個佔位頁面。

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

/** 已登入，且可指定 `mustChangePassword`——給 `ChangePasswordGate`
 * （spec rev 5.7）測試用。 */
function mockFetchMustChangePassword(mustChangePassword: boolean) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/api/auth/me") {
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword,
              hasPassword: true,
            }),
        }),
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** 多掛一條 `/change-password` 路由，且用 `<ChangePasswordGate>` 包住 `/*`
 * catch-all——與 `App.tsx` 的真實巢狀方式一致（`/change-password` 本身在
 * gate 外面，其餘路由在 gate 裡面）。 */
function renderChangePasswordGateAt(initialPath: string) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/change-password" element={<div>change-password-page</div>} />
            <Route element={<ChangePasswordGate />}>
              <Route path="/*" element={<div>home-page</div>} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** `/api/auth/me` 回 500——session query 進 error 分支（401 才是「未登入」）。 */
function mockFetchServerError(): ReturnType<typeof vi.fn> {
  return vi.fn(() =>
    Promise.resolve(
      fakeResponse({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
      }),
    ),
  );
}

function renderRequireAuth(existingClient?: QueryClient) {
  const queryClient = existingClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/"]}>
        <Routes>
          <Route path="/login" element={<div>login-page</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/*" element={<div>home-page</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

const SESSION_USER = {
  id: "u1",
  email: "a@example.com",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

function okSession(): Response {
  return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(SESSION_USER) });
}

function serverError(): Response {
  return fakeResponse({
    ok: false,
    status: 500,
    json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
  });
}

describe("session query 出錯（非 401）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("RequireAuth：500 → 顯示錯誤與重試出口，不停在 loading，也不誤導向 /login", async () => {
    vi.stubGlobal("fetch", mockFetchServerError());

    renderRequireAuth();

    await waitFor(() => expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument());
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(screen.queryByText("login-page")).not.toBeInTheDocument();
    expect(screen.queryByText("home-page")).not.toBeInTheDocument();
  });

  /**
   * 錯誤畫面只能用在「完全沒有 session 可用」的情況。已登入之後 session query 仍會
   * 反覆重查（`main.tsx` 用裸 `new QueryClient()`＝`refetchOnWindowFocus: true` +
   * `staleTime: 0`），server 重啟或網路抖一下就會讓 `["me"]` 落入 error 狀態，但快取
   * 裡的 user 還在。
   *
   * 實測（v5.101）的兩段語意，這條測試釘的是第二段：
   * - 失敗 refetch 的**當下**，既有 observer 仍回報 `status:"success"`＋原本的 data；
   * - 但此時任何**重新掛載**（換路由、開設定 modal——`App.tsx` 兩棵 Routes 樹都掛
   *   `RequireAuth`）會建立新的 observer，它看到的是 `status:"error"` 且 data 仍在。
   *
   * 這時若把整棵樹換成錯誤畫面，代價是卸載 NotePage → `useCollab` 執行
   * `provider.destroy(); doc.destroy();`，而專案沒有 y-indexeddb，還沒同步出去的編輯
   * 就永久消失了。有 session 可用就必須沿用。
   */
  it("session 在 error 狀態但快取仍有 user → 重新掛載後照常放行，不換成錯誤畫面", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(okSession()));
    vi.stubGlobal("fetch", fetchMock);

    const first = renderRequireAuth();
    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());

    fetchMock.mockImplementation(() => Promise.resolve(serverError()));
    await act(async () => {
      await first.queryClient.refetchQueries({ queryKey: ["me"] });
    });
    expect(first.queryClient.getQueryState(["me"])?.status).toBe("error"); // 前提成立
    first.unmount();

    // 同一個 QueryClient 重新掛載＝新的 observer，看到的是 error + 既有 data。
    renderRequireAuth(first.queryClient);

    expect(screen.getByText("home-page")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("按下重試 → 重新查 session，這次成功就正常放行", async () => {
    let failNext = true;
    const fetchMock = vi.fn(() => {
      if (failNext) {
        failNext = false;
        return Promise.resolve(
          fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }) }),
        );
      }
      return Promise.resolve(
        fakeResponse({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              id: "u1",
              email: "a@example.com",
              displayName: "Alice",
              isAdmin: false,
              mustChangePassword: false,
              hasPassword: true,
            }),
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    renderRequireAuth();

    const retry = await screen.findByRole("button", { name: "Try again" });
    fireEvent.click(retry);

    await waitFor(() => expect(screen.getByText("home-page")).toBeInTheDocument());
  });
});

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
