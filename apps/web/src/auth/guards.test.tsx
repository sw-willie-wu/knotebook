import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
            Promise.resolve({ id: "u1", email: "a@example.com", displayName: "Alice", isAdmin: false, mustChangePassword }),
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
