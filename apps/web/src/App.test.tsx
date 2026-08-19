import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

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

const ADMIN_USER: UserDto = {
  id: "u1",
  email: "admin@example.com",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};

// Plan 4（spec §13.4）：既有 `/admin/users` route 改為
// `<Navigate to="/settings/users" replace/>`（書籤不斷）——功能併入設定總 modal 的
// 使用者區（Task 8 填實 `SettingsUsersSection`）。這支只釘轉址落點本身（`/admin/users`
// 深連結最終要看到 `/settings/users` 的內容、`RequireAdmin` 包裹沒被拿掉）——modal
// 與背景頁共存/切換不重掛/backgroundLocation 跨區塊保留等 modal-over-background
// 機制細節，守門在 `SettingsModal.test.tsx`（尤其案 1 與 backgroundLocation 那案），
// 不重複斷言在這裡。
describe("App route tree — /admin/users redirects to /settings/users (Plan 4 §13.4)", () => {
  function mockFetchForRedirect() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin 深連結 /admin/users → 轉址 /settings/users（RequireAdmin 包裹保留不動，主樹背景落在 HomePage）", async () => {
    vi.stubGlobal("fetch", mockFetchForRedirect());
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin/users"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());
    // Radix Dialog 開啟時背景兄弟節點會被標成 `aria-hidden`（focus trap），`getByRole`
    // 依可及性樹過濾會找不到——這裡改用不受影響的 `getByText`（見 SettingsModal.test.tsx
    // 同款斷言的說明），驗證主樹背景真的落在 HomePage。
    expect(screen.getByText("New note")).toBeInTheDocument();
  });
});
