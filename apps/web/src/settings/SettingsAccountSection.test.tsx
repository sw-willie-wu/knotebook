import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// SettingsAccountSection（Plan 5 Task 10）：`hasPassword === false`（OIDC-only 帳號）
// → 不渲染 `ChangePasswordForm`，改渲染 `settings.account.ssoOnly` 提示（spec §14.4）。
// 走真正的 `AppRoutes`（同 SettingsModal.test.tsx/SettingsUsersSection.test.tsx 慣例，
// 不拆開重建等價樹）——驗證的是「有沒有接對」。fetch 樁比照
// `SettingsUsersSection.test.tsx:89-101`。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PASSWORD_USER: UserDto = {
  id: "u-password",
  email: "alice@example.com",
  handle: "tester",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const SSO_ONLY_USER: UserDto = {
  id: "u-sso",
  email: "bob@example.com",
  handle: "tester",
  displayName: "Bob",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: false,
};

function baseFetchHandlers(user: UserDto) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

function renderAccountSettings(user: UserDto) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const res = baseFetchHandlers(user)(url, method);
    if (res) return Promise.resolve(res);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/account"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("SettingsAccountSection（Plan 5 Task 10：hasPassword===false → SSO-only 提示）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hasPassword:true → 渲染 ChangePasswordForm", async () => {
    renderAccountSettings(PASSWORD_USER);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByText("This account signs in with SSO.")).not.toBeInTheDocument();
  });

  it("hasPassword:false → 表單不渲染，改渲染 settings.account.ssoOnly 文案，且不與「Change your password」標題並存（fix round 1 MINOR-2）", async () => {
    renderAccountSettings(SSO_ONLY_USER);

    await waitFor(() => expect(screen.getByText("This account signs in with SSO.")).toBeInTheDocument());
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
    // 標題/描述只屬於改密碼表單那個分支——SSO-only 使用者不該同時看到「Change your
    // password」與「此帳號透過 SSO 登入」這兩則自相矛盾的訊息。
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();
    expect(screen.queryByText("Choose a new password for your account.")).not.toBeInTheDocument();
  });
});
