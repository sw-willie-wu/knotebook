import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";

// 站台管理頁（`/admin/*`）：一律用真正的 `AppRoutes` 跑（同 SettingsModal.test.tsx 的
// 理由——驗的是 guard 串接與 layout route 有沒有接對，不是 AdminPage 單獨渲染）。

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
  handle: "admin",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};
const PLAIN_USER: UserDto = { ...ADMIN_USER, id: "u-plain", handle: "plain", displayName: "Plain", isAdmin: false };

function mockFetch(getUser: () => UserDto | null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth/me" && method === "GET") {
      const user = getUser();
      if (user) return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
      return Promise.resolve(
        fakeResponse({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "unauthorized", message: "no" } }),
        }),
      );
    }
    if (url === "/api/auth/config" && method === "GET") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true } }) }),
      );
    }
    if ((url === "/api/groups" || url === "/api/notes" || url === "/api/admin/users") && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    if (url.startsWith("/api/admin/ai/") && method === "GET") {
      const key = url.slice("/api/admin/ai/".length);
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ [key]: [] }) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <ActiveNoteProvider>
            <AppRoutes />
            <LocationProbe />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

async function expectLocation(expected: string) {
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(expected));
}

describe("AdminPage（/admin/*：站台管理獨立頁）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("側欄是管理導覽：「回筆記」＋使用者＋AI，沒有搜尋框與新增筆記；主區是使用者管理", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "User management" })).toBeInTheDocument());

    const nav = within(screen.getByRole("navigation", { name: "Site admin" }));
    expect(nav.getByRole("link", { name: "Back to notes" })).toHaveAttribute("href", "/");
    expect(nav.getByRole("link", { name: "Users" })).toHaveAttribute("href", "/admin/users");
    expect(nav.getByRole("link", { name: "AI" })).toHaveAttribute("href", "/admin/ai");
    expect(nav.getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    expect(nav.getByRole("link", { name: "AI" })).not.toHaveAttribute("aria-current");

    expect(screen.queryByRole("textbox", { name: "Search notes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).not.toBeInTheDocument();
    // 不是設定 modal。
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("點 AI → /admin/ai，主區換成 AI 設定；點「回筆記」→ /", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));

    const nav = within(await screen.findByRole("navigation", { name: "Site admin" }));
    fireEvent.click(nav.getByRole("link", { name: "AI" }));

    await expectLocation("/admin/ai");
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "AI providers & actions" })).toBeInTheDocument(),
    );

    fireEvent.click(within(screen.getByRole("navigation", { name: "Site admin" })).getByRole("link", { name: "Back to notes" }));
    await expectLocation("/");
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
  });

  it("窄視窗入口：內容卡有漢堡鈕（NarrowTopBar），抽屜裡也是管理導覽", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));

    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "User management" })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));

    const drawer = within(await screen.findByRole("dialog", { name: "Navigation" }));
    expect(drawer.getByRole("navigation", { name: "Site admin" })).toBeInTheDocument();
    expect(drawer.getByRole("link", { name: "AI" })).toHaveAttribute("href", "/admin/ai");
    expect(drawer.queryByRole("textbox", { name: "Search notes" })).not.toBeInTheDocument();
  });

  it("/admin（index）→ 轉 /admin/users", async () => {
    renderAt("/admin", mockFetch(() => ADMIN_USER));

    await expectLocation("/admin/users");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "User management" })).toBeInTheDocument());
  });

  it("非 admin 深連結 /admin/ai → 導 /（不打任何 admin API）", async () => {
    const fetchMock = mockFetch(() => PLAIN_USER);
    renderAt("/admin/ai", fetchMock);

    await expectLocation("/");
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(([input]) => String(input).startsWith("/api/admin/"))).toBe(false);
  });

  it("未登入深連結 /admin/ai → /login?next=%2Fadmin%2Fai", async () => {
    renderAt("/admin/ai", mockFetch(() => null));

    await expectLocation("/login?next=%2Fadmin%2Fai");
  });

  // 這案守的是「/admin/* 在 ChangePasswordGate 底下」（mustChangePassword 的 admin
  // 進來會落到 /change-password）。⚠ 守衛順序本身（Gate 與 RequireAdmin 誰在外層）
  // 觀察不到、不是這條在守：對調兩層，最終落點一樣是 /change-password。
  it("mustChangePassword 的 admin 深連結 /admin/users → 落到 /change-password", async () => {
    renderAt("/admin/users", mockFetch(() => ({ ...ADMIN_USER, mustChangePassword: true })));

    await expectLocation("/change-password");
  });
});
