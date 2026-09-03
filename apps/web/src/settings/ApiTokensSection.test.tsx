/**
 * #130 Task 11：設定→帳號的「API token」段。
 *
 * 沿用 SettingsAccountSection.test.tsx 的 render helper 形：走真 AppRoutes、stub fetch、
 * retry: false、掛 Toaster。fetch 樁對未預期 URL 一律 throw——那是「元件多打了一發
 * 沒人知道的 API」的守衛，不要改成回 404。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiTokenDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

const SSO_ONLY_USER: UserDto = {
  id: "u-sso",
  email: "sso@example.com",
  handle: "sso",
  displayName: "S",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: false,
};
const PASSWORD_USER: UserDto = { ...SSO_ONLY_USER, id: "u-pw", handle: "pw", hasPassword: true };

const PAT_ROW: ApiTokenDto = {
  id: "t-1",
  kind: "pat",
  name: "Script",
  scope: "notes:read notes:write",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  clientId: null,
};
const OAUTH_ROW: ApiTokenDto = {
  id: "t-2",
  kind: "oauth",
  name: "Claude Code",
  scope: "notes:read notes:write",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-03T00:00:00.000Z",
  clientId: "c-1",
};

function fakeResponse(init: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: init.json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

type Call = { url: string; method: string; body?: unknown };

function renderSettings(
  user: UserDto,
  tokens: ApiTokenDto[],
  extra?: (url: string, method: string, init?: RequestInit) => Response | null
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const custom = extra?.(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
    if (url === "/api/notes") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    if (url === "/api/auth/tokens" && method === "GET")
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens }) }));
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
    </QueryClientProvider>
  );
  return { calls };
}

describe("ApiTokensSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("空狀態", async () => {
    renderSettings(PASSWORD_USER, []);
    expect(await screen.findByText(i18n.t("settings.account.apiTokensEmpty"))).toBeInTheDocument();
  });

  it("載入中不顯示空狀態（空狀態只在確定拿到空清單後才出現）", async () => {
    // 空狀態案的 findByText 在載入中就匹配得到——顯示條件寫反（data 未定義才顯示）照樣綠。
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "GET"
        ? fakeResponse({ ok: true, status: 200, json: () => new Promise(() => {}) })
        : null
    );
    await screen.findByRole("heading", { name: i18n.t("settings.account.apiTokensTitle") });
    expect(screen.queryByText(i18n.t("settings.account.apiTokensEmpty"))).not.toBeInTheDocument();
  });

  it("只填名稱就送出 → scope 預設 read、expiresInDays 預設 null（D4：PAT 預設不到期）", async () => {
    // D4 在前端的唯一落點就是這兩個預設值；建立成功案把兩個 select 都顯式改掉，守不到。
    const created = { ...PAT_ROW, id: "t-d", name: "D", token: "knb_" + "y".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "D", scope: "notes:read", expiresInDays: null });
  });

  it("SSO-only 帳號也看得到這一段（在 hasPassword 三元式之外）", async () => {
    renderSettings(SSO_ONLY_USER, []);
    expect(
      await screen.findByRole("heading", { name: i18n.t("settings.account.apiTokensTitle") })
    ).toBeInTheDocument();
  });

  it("列表：oauth 列標示「未經驗證」且名稱容器有 dir=ltr，pat 列沒有旁註", async () => {
    renderSettings(PASSWORD_USER, [PAT_ROW, OAUTH_ROW]);
    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    const oauthName = screen.getByText("Claude Code");
    expect(oauthName).toHaveAttribute("dir", "ltr");
    expect(oauthName).toHaveClass("[unicode-bidi:isolate]"); // spec §9.3：dir 與 isolate 樣式都要
    // pat 列的名稱同樣要 bidi 隔離——名稱是使用者輸入，不只 oauth 列是外部字串
    expect(screen.getByText("Script")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Script")).toHaveClass("[unicode-bidi:isolate]");
    expect(screen.getAllByText(i18n.t("settings.account.apiTokensUnverifiedName"))).toHaveLength(1);
  });

  it("列表：每列顯示自己的 scope 文案（read 列與 write 列不同）", async () => {
    const readRow: ApiTokenDto = { ...PAT_ROW, id: "t-r", name: "Reader", scope: "notes:read" };
    renderSettings(PASSWORD_USER, [PAT_ROW, readRow]);
    const writeLi = (await screen.findByText("Script")).closest("li")!;
    const readLi = screen.getByText("Reader").closest("li")!;
    expect(within(writeLi).getByText(new RegExp(i18n.t("settings.account.apiTokensScopeWrite")))).toBeInTheDocument();
    expect(within(readLi).getByText(new RegExp(i18n.t("settings.account.apiTokensScopeRead")))).toBeInTheDocument();
    expect(within(readLi).queryByText(new RegExp(i18n.t("settings.account.apiTokensScopeWrite")))).not.toBeInTheDocument();
  });

  it("列表：過期的列標示 Expired，不到期的列標示 No expiry", async () => {
    const expiredRow: ApiTokenDto = { ...PAT_ROW, id: "t-exp", name: "Old", expiresAt: "2020-01-01T00:00:00.000Z" };
    renderSettings(PASSWORD_USER, [PAT_ROW, expiredRow]);
    expect(await screen.findByText(i18n.t("settings.account.apiTokensExpired"))).toBeInTheDocument();
    expect(screen.getByText(i18n.t("settings.account.apiTokensNoExpiry"))).toBeInTheDocument();
  });

  it("建立成功 → 同位置一次性顯示明文，且列表 API 被重抓；送出的 body 形狀正確", async () => {
    const created = { ...PAT_ROW, id: "t-new", name: "New", token: "knb_" + "x".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "New" } });
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensScopeLabel")), { target: { value: "notes:write" } });
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensExpiryLabel")), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));

    const field = await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    expect(field).toHaveValue(created.token);
    expect(screen.getByText(i18n.t("settings.account.apiTokensOnceWarning"))).toBeInTheDocument();
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "New", scope: "notes:write", expiresInDays: 90 });
    await waitFor(() => {
      expect(calls.filter(c => c.url === "/api/auth/tokens" && c.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("建立失敗（409 token_limit）→ 停留在表單並 toast 錯誤，不顯示明文欄", async () => {
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { code: "token_limit", message: "limit" } }),
          })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    // 錯誤 toast 用 errors.<code> 的文案（有專屬 key），不是 fallback
    await screen.findByText(i18n.t("errors.token_limit"));
    expect(screen.queryByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel"))).toBeInTheDocument();
  });

  it("撤銷：確認後才送 DELETE", async () => {
    const { calls } = renderSettings(PASSWORD_USER, [PAT_ROW], (url, method) =>
      url === `/api/auth/tokens/${PAT_ROW.id}` && method === "DELETE" ? fakeResponse({ ok: true, status: 204 }) : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensRevoke") }));
    // 先等確認對話框真的出現，再斷言「還沒送 DELETE」——直接同步斷言是假守衛：
    // 即使實作在點下 trigger 就送出，fetch 也要一個 microtask 才會進 calls。
    const confirm = await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensRevokeConfirm") });
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(calls.some(c => c.method === "DELETE" && c.url === `/api/auth/tokens/${PAT_ROW.id}`)).toBe(true)
    );
    // 成功後對話框要關、列表要重抓（建立路徑有守，撤銷路徑原本沒有）
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: i18n.t("settings.account.apiTokensRevokeConfirm") })).not.toBeInTheDocument()
    );
    await waitFor(() => {
      expect(calls.filter(c => c.url === "/api/auth/tokens" && c.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("明文畫面按 Esc 不會關閉（誤觸會讓 token 報銷）；按 Done 關閉後重開是乾淨表單", async () => {
    const created = { ...PAT_ROW, id: "t-new", name: "New", token: "knb_" + "z".repeat(43) };
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    const field = await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensDone") }));
    await waitFor(() =>
      expect(screen.queryByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).not.toBeInTheDocument()
    );
    // 重開：明文不殘留、name 清空（I2 的行為守衛）
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    expect(screen.queryByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel"))).toHaveValue("");
  });
});
