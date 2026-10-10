import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto, VersionSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// /admin/versions（spec §6.7、§8.5）：走真的 AppRoutes（AdminPage lazy chunk＋descendant route），
// 形比照 SettingsStorageSection.test.tsx。

function res(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true };
const AUTH_CONFIG = { providers: [], registration: { enabled: false }, passwordLogin: { enabled: true }, autoVersionsEnabled: true };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubAdmin({ settings, patchStatus }: { settings: VersionSettingsDto; patchStatus?: number }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ method, url, body });
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(res(200, ADMIN));
      if (url === "/api/auth/config" && method === "GET") return Promise.resolve(res(200, AUTH_CONFIG));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(res(200, []));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(res(200, []));
      if (url === "/api/admin/versions/settings" && method === "GET") return Promise.resolve(res(200, settings));
      if (url === "/api/admin/versions/settings" && method === "PATCH") {
        if (patchStatus !== undefined && patchStatus >= 400) {
          return Promise.resolve(res(patchStatus, { error: { code: "invalid_body", message: "x" } }));
        }
        return Promise.resolve(res(patchStatus ?? 200, { ...settings, ...(body as Partial<VersionSettingsDto>) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...renderResult, queryClient };
}

const SETTINGS: VersionSettingsDto = { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true };

describe("SettingsVersionsSection（/admin/versions，spec §6.7、§8.5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("載入：總開關與兩個天數照 GET 顯示", async () => {
    stubAdmin({ settings: SETTINGS });
    renderAt("/admin/versions");
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Keep all for (days)")).toHaveValue("7");
    expect(screen.getByLabelText("One a day until (days)")).toHaveValue("30");
    expect(screen.getByText(/All automatic versions from the last 7 days are kept; up to 30 days, one a day/)).toBeInTheDocument();
  });

  it("總開關關閉的設定 → switch aria-checked=false（與載入案區分）", async () => {
    stubAdmin({ settings: { ...SETTINGS, autoVersionsEnabled: false } });
    renderAt("/admin/versions");
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false");
  });

  it("切總開關 → PATCH 只帶 { autoVersionsEnabled:false }，並失效 ['auth-config']", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    const { queryClient } = renderAt("/admin/versions");
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    // gate r1 I-6：/admin/versions 上沒有任何元件訂閱 ['auth-config']，invalidate 只標 stale、不發請求——
    // 不能等 GET /api/auth/config。先種一份快取，再斷言它被標成 invalidated。
    queryClient.setQueryData(["auth-config"], AUTH_CONFIG);
    expect(queryClient.getQueryState(["auth-config"])?.isInvalidated).toBe(false);
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ autoVersionsEnabled: false }));
    await waitFor(() => expect(queryClient.getQueryState(["auth-config"])?.isInvalidated).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false"));
  });

  it("天數不合法（前者 > 後者、非整數、0、3651、空）→ 不發請求、行內錯誤（每一組各自出現）", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/versions");
    const keepAll = await screen.findByLabelText("Keep all for (days)");
    const daily = screen.getByLabelText("One a day until (days)");
    for (const [a, b] of [["40", "30"], ["1.5", "30"], ["0", "30"], ["7", "3651"], ["", "30"]]) {
      fireEvent.change(keepAll, { target: { value: a } });
      fireEvent.change(daily, { target: { value: b } });
      // 改欄位會清掉上一組的錯誤——所以下面的 alert 是這一組送出才出現的
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Use whole numbers with 1 ≤ first ≤ second ≤ 3650.");
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("天數合法（F = D 也可）→ PATCH { keepAllDays, dailyUntilDays }、toast", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/versions");
    fireEvent.change(await screen.findByLabelText("Keep all for (days)"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("One a day until (days)"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Version settings saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ keepAllDays: 14, dailyUntilDays: 14 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("server 回 400 invalid_body → 行內 errors.invalid_body", async () => {
    stubAdmin({ settings: SETTINGS, patchStatus: 400 });
    renderAt("/admin/versions");
    fireEvent.change(await screen.findByLabelText("Keep all for (days)"), { target: { value: "8" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
  });
});
