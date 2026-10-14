import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto, VersionSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// 站台版本設定（spec §6.7、§8.5；#247 §7.0 起嵌在 `/admin/storage` 方案頁、方案表之後）：走真的 AppRoutes（站台管理 modal＋AdminSections lazy chunk），
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
      if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(res(200, { plans: [], defaults: { userPlanId: "", groupPlanId: "" } }));
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

const SETTINGS: VersionSettingsDto = { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 7 };

describe("站台版本設定（/admin/storage 內，#247 §7.0）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("V1 頁首只有方案頁一個（h1 Storage plans）；版本設定是 h2「Version history」區塊，接在方案表之後；沒有「How notes keep their versions on this site.」；說明含「版本不佔額度」", async () => {
    stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    await screen.findByRole("switch", { name: "Automatic versions" });
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Storage plans"]);
    const versions = screen.getByRole("heading", { level: 2, name: "Version history" });
    expect(versions.compareDocumentPosition(screen.getByRole("heading", { level: 1, name: "Storage plans" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.queryByText("How notes keep their versions on this site.")).not.toBeInTheDocument();
    expect(screen.getByText(/Versions and note text don't count toward storage/)).toBeInTheDocument();
  });

  it("載入：總開關、等待與兩個天數照 GET 顯示；等待說明帶 server 值", async () => {
    stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Wait before saving automatically (minutes)")).toHaveValue("7");
    expect(screen.getByText("After editing, if there is no new change for 7 minutes, a version is saved automatically.")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep all for (days)")).toHaveValue("7");
    expect(screen.getByLabelText("One a day until (days)")).toHaveValue("30");
    expect(screen.getByText(/All automatic versions from the last 7 days are kept; up to 30 days, one a day/)).toBeInTheDocument();
  });

  it("總開關關閉的設定 → switch aria-checked=false（與載入案區分）", async () => {
    stubAdmin({ settings: { ...SETTINGS, autoVersionsEnabled: false } });
    renderAt("/admin/storage");
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false");
  });

  it("切總開關 → PATCH 只帶 { autoVersionsEnabled:false }，並失效 ['auth-config']", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    const { queryClient } = renderAt("/admin/storage");
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    // gate r1 I-6：/admin/storage 上沒有任何元件訂閱 ['auth-config']，invalidate 只標 stale、不發請求——
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
    renderAt("/admin/storage");
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
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Keep all for (days)"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("One a day until (days)"), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Version settings saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ autoWaitMinutes: 7, keepAllDays: 14, dailyUntilDays: 14 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("server 回 400 invalid_body → 行內 errors.invalid_body", async () => {
    stubAdmin({ settings: SETTINGS, patchStatus: 400 });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Keep all for (days)"), { target: { value: "8" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
  });

  it("#272 等待不合法（0、61、abc、1.5、空）→ 不發請求、行內 waitInvalid（每一組各自出現）", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    const wait = await screen.findByLabelText("Wait before saving automatically (minutes)");
    for (const value of ["0", "61", "abc", "1.5", ""]) {
      fireEvent.change(wait, { target: { value } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("Use a whole number of minutes from 1 to 60.");
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("#272 等待與天數同時不合法 → 只顯示等待那一句（先驗等待）", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Wait before saving automatically (minutes)"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Keep all for (days)"), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use a whole number of minutes from 1 to 60.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Use whole numbers with 1 ≤ first ≤ second ≤ 3650.")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("#272 等待合法 → PATCH 帶 { autoWaitMinutes, keepAllDays, dailyUntilDays }、toast", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Wait before saving automatically (minutes)"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Version settings saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ autoWaitMinutes: 12, keepAllDays: 7, dailyUntilDays: 30 });
  });

  it("RF4：前後空白與前導零照收（「 9 」→ 9、「05」→ 5）；全形「５」→ waitInvalid、不送", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    const wait = await screen.findByLabelText("Wait before saving automatically (minutes)");
    fireEvent.change(wait, { target: { value: "５" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Use a whole number of minutes from 1 to 60.");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.change(wait, { target: { value: " 9 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ autoWaitMinutes: 9, keepAllDays: 7, dailyUntilDays: 30 }]));
    fireEvent.change(screen.getByLabelText("Wait before saving automatically (minutes)"), { target: { value: "05" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => (c.body as { autoWaitMinutes: number }).autoWaitMinutes)).toEqual([9, 5]));
  });
});
