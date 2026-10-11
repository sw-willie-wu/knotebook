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
import { clickOutside } from "@/test/outside-click";
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
  autoVersions: true,
};
const PASSWORD_USER: UserDto = { ...SSO_ONLY_USER, id: "u-pw", handle: "pw", hasPassword: true };

const PAT_ROW: ApiTokenDto = {
  id: "t-1",
  kind: "pat",
  name: "Script",
  agentLabel: "script",
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
  agentLabel: "claude",
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
    if (url === "/api/groups") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
    if (url === "/api/notes") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    if (url === "/api/auth/tokens" && method === "GET")
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens }) }));
    if (url === "/api/storage" && method === "GET")
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ usedBytes: 0, quotaBytes: 2147483648, planName: "Basic" }) }));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/authorization"]}>
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

  it("建立表單：點對話框外面不關閉、已填名稱仍在；Esc 仍可關（表單型守衛只擋點外面）", async () => {
    renderSettings(PASSWORD_USER, []);
    // 本檔第一次載入帳號區塊 lazy chunk
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }),
    );
    const nameLabel = i18n.t("settings.account.apiTokensNameLabel");
    fireEvent.change(screen.getByLabelText(nameLabel), { target: { value: "Keep" } });
    await clickOutside();
    expect(screen.getByLabelText(nameLabel)).toHaveValue("Keep");
    fireEvent.keyDown(screen.getByLabelText(nameLabel), { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(nameLabel)).toBeNull());
  });

  it("明文畫面：點對話框外面與 Esc 都不關閉（既有 issued 守衛與 dismissOnOutside 並存仍成立）", async () => {
    const created = { ...PAT_ROW, id: "t-g", name: "G", token: "knb_" + "z".repeat(43) };
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "G" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    const valueLabel = i18n.t("settings.account.apiTokensValueLabel");
    await screen.findByLabelText(valueLabel);
    await clickOutside();
    expect(screen.getByLabelText(valueLabel)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(valueLabel), { key: "Escape" });
    await clickOutside();
    expect(screen.getByLabelText(valueLabel)).toBeInTheDocument();
  });

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
    // #239 W7'：兩個開關預設都關，且都在「Access」那一組裡（#247 W22：建立對話框改用 toggle）。
    const access = screen.getByRole("group", { name: i18n.t("settings.account.apiTokensScopeLabel") });
    expect(within(access).getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") })).not.toBeChecked();
    expect(within(access).getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") })).not.toBeChecked();
    expect(within(access).getByText(i18n.t("settings.account.apiTokensScopeReadFixed"))).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensExpiryLabel")), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));

    const field = await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    expect(field).toHaveValue(created.token);
    expect(screen.getByText(i18n.t("settings.account.apiTokensOnceWarning"))).toBeInTheDocument();
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "New", scope: "notes:read notes:write", expiresInDays: 90 });
    await waitFor(() => {
      expect(calls.filter(c => c.url === "/api/auth/tokens" && c.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("建立：勾選後關掉對話框再重開 → 兩框回到未勾（reset 一併重設，#239）", async () => {
    renderSettings(PASSWORD_USER, []);
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") }));
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") }));
    const nameLabel = i18n.t("settings.account.apiTokensNameLabel");
    fireEvent.keyDown(screen.getByLabelText(nameLabel), { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(nameLabel)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    expect(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") })).not.toBeChecked();
    expect(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") })).not.toBeChecked();
  });

  it("建立：勾編輯與搬移 → 送第三形（#239）", async () => {
    const created = { ...PAT_ROW, id: "t-m", name: "M", token: "knb_" + "m".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "M" } });
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") }));
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "M", scope: "notes:read notes:write notes:move", expiresInDays: null });
  });

  it("建立：勾編輯→勾搬移→取消編輯 → 搬移 disabled 且清掉，送 notes:read（#239）", async () => {
    const created = { ...PAT_ROW, id: "t-u", name: "U", token: "knb_" + "u".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "U" } });
    const edit = screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") });
    const move = screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") });
    fireEvent.click(edit);
    fireEvent.click(move);
    expect(move).toBeChecked();
    fireEvent.click(edit);
    expect(move).toBeDisabled();
    expect(move).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "U", scope: "notes:read", expiresInDays: null });
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

describe("ApiTokensSection 表格與行內編輯（#247 §5.3、W22）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  const OVERRIDE: ApiTokenDto = {
    ...PAT_ROW, id: "t-o", name: "Claude Code laptop", agentLabel: "claude-laptop", scope: "notes:read notes:write notes:move",
  };
  const DERIVED: ApiTokenDto = { ...PAT_ROW, id: "t-d", name: "Claude Desktop", agentLabel: "claude", scope: "notes:read" };
  const WRITER: ApiTokenDto = { ...PAT_ROW, id: "t-w", name: "n8n bot", agentLabel: "n8n", scope: "notes:read notes:write" };
  const ROWS = [OVERRIDE, DERIVED, WRITER];

  const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
  const pills = (row: HTMLElement) => Array.from(row.querySelectorAll("[data-pill]")).map((p) => p.textContent);

  function withPatch(respond: (id: string, body: Record<string, unknown>) => Response) {
    const bodies: Array<{ id: string; body: Record<string, unknown> }> = [];
    const r = renderSettings(PASSWORD_USER, ROWS, (url, method, init) => {
      const m = /^\/api\/auth\/tokens\/([^/]+)$/.exec(url);
      if (m && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push({ id: decodeURIComponent(m[1]!), body });
        return respond(m[1]!, body);
      }
      return null;
    });
    return { ...r, bodies };
  }
  const ok = (id: string, body: Record<string, unknown>) =>
    fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...ROWS.find((t) => t.id === id)!, ...body }) });

  it("權限 pill 三種組合：讀取／讀取＋編輯／讀取＋編輯＋搬移（搬移是 destructive 淡底）", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    expect(pills(rowOf("Claude Desktop"))).toEqual(["Read"]);
    expect(pills(rowOf("n8n bot"))).toEqual(["Read", "Edit"]);
    expect(pills(rowOf("Claude Code laptop"))).toEqual(["Read", "Edit", "Move"]);
    expect(within(rowOf("Claude Code laptop")).getByText("Move")).toHaveClass("text-destructive");
  });

  it("label 等於 deriveAgentLabel(name) 時灰字、不等時一般字", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    expect(within(rowOf("Claude Desktop")).getByText("claude")).toHaveClass("text-muted-foreground");
    expect(within(rowOf("Claude Code laptop")).getByText("claude-laptop")).not.toHaveClass("text-muted-foreground");
  });

  it("鉛筆 → 編輯態：該列 bg-brand-soft、只有 label 一個輸入框（名稱不可改）、其他列鉛筆停用", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    const row = rowOf("Claude Desktop");
    expect(row).toHaveClass("bg-brand-soft");
    expect(within(row).getAllByRole("textbox")).toHaveLength(1);
    expect(within(row).getByRole("textbox", { name: "Label" })).toHaveValue("claude");
    expect(within(row).getByText("1–32 letters, digits, . _ or -. Leave empty to go back to “claude”, derived from the name.")).toBeInTheDocument();
    const other = within(rowOf("n8n bot")).getByRole("button", { name: "Edit" });
    expect(other).toHaveAttribute("aria-disabled", "true");
    expect(other).toHaveClass("pointer-events-none", "opacity-35");
  });

  it("取消不送請求、回顯示態", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" }), { target: { value: "x" } });
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Cancel" }));
    expect(within(rowOf("Claude Desktop")).queryByRole("textbox")).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it("只改 label → body 只有 agentLabel", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" }), { target: { value: "desk" } });
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-d", body: { agentLabel: "desk" } }]));
    // 儲存成功 → 回顯示態
    await waitFor(() => expect(within(rowOf("Claude Desktop")).queryByRole("textbox")).toBeNull());
  });

  it("正在編的那列在重抓後消失（別處撤銷）→ 不再卡住其他列的鉛筆", async () => {
    let rows: ApiTokenDto[] = ROWS;
    renderSettings(PASSWORD_USER, [], (url, method) => {
      if (url === "/api/auth/tokens" && method === "GET")
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: rows.map(r => ({ ...r })) }) });
      if (url === "/api/auth/tokens/t-w" && method === "DELETE") return fakeResponse({ ok: true, status: 204 });
      return null;
    });
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    expect(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-disabled", "true");
    // 撤銷另一列觸發重抓；重抓回來時正在編的 "Claude Desktop" 也已被別處撤銷。
    rows = [OVERRIDE];
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(screen.queryByText("Claude Desktop")).toBeNull());
    expect(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled");
  });

  it("只改權限 → body 只有 scope（scopeFromChecks 的落庫形）", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("switch", { name: "Create and edit notes" }));
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-d", body: { scope: "notes:read notes:write" } }]));
  });

  it("清空 label（原本是覆寫值）→ 送 agentLabel: null；Enter＝儲存", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Code laptop");
    fireEvent.click(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" }));
    const input = within(rowOf("Claude Code laptop")).getByRole("textbox", { name: "Label" });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(bodies).toEqual([{ id: "t-o", body: { agentLabel: null } }]));
  });

  it("什麼都沒改按儲存 → 不送請求、回顯示態", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(rowOf("n8n bot")).queryByRole("textbox")).toBeNull());
    expect(bodies).toHaveLength(0);
  });

  it("label 格式不合 → 列內紅字、不送請求", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" }), { target: { value: "has space" } });
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    expect(await within(rowOf("n8n bot")).findByRole("alert")).toHaveTextContent("A label can only use 1–32 letters, digits, . _ or -.");
    expect(bodies).toHaveLength(0);
  });

  it("關掉「編輯」→「搬移」disabled 且清為關；儲存送 notes:read", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Code laptop");
    fireEvent.click(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" }));
    const row = within(rowOf("Claude Code laptop"));
    expect(row.getByRole("switch", { name: "Move or copy notes into groups" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row.getByRole("switch", { name: "Create and edit notes" }));
    const move = row.getByRole("switch", { name: "Move or copy notes into groups" });
    expect(move).toHaveAttribute("aria-checked", "false");
    expect(move).toBeDisabled();
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-o", body: { scope: "notes:read" } }]));
  });

  it("行內編輯：「搬移」開時顯示搬移提示全文、關時不在", async () => {
    withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    const hint = i18n.t("settings.account.apiTokensScopeMoveHint");
    expect(within(rowOf("n8n bot")).queryByText(hint)).toBeNull();
    fireEvent.click(within(rowOf("n8n bot")).getByRole("switch", { name: "Move or copy notes into groups" }));
    expect(within(rowOf("n8n bot")).getByText(hint)).toBeInTheDocument();
  });

  it("PATCH 失敗 → 留在編輯態、列內 alert", async () => {
    withPatch(() => fakeResponse({ ok: false, status: 400, json: () => Promise.resolve({ error: { code: "invalid_body", message: "x" } }) }));
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" }), { target: { value: "bot2" } });
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    expect(await within(rowOf("n8n bot")).findByRole("alert")).toHaveTextContent("The request was malformed.");
    expect(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" })).toBeInTheDocument();
  });

  it("沒有 Esc 取消：label 輸入框按 Esc 會關掉整個設定面板（Radix 在 capture 階段吃 Escape）", async () => {
    withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("撤銷是列尾紅垃圾桶 icon 鈕，確認框照舊", async () => {
    withPatch(ok);
    await screen.findByText("n8n bot");
    const trash = within(rowOf("n8n bot")).getByRole("button", { name: "Revoke" });
    expect(trash).toHaveClass("text-destructive");
    expect(trash).toHaveAttribute("title", "Revoke");
    fireEvent.click(trash);
    expect(await screen.findByRole("dialog", { name: "Revoke this token?" })).toBeInTheDocument();
  });

  it("建立對話框：兩個 toggle 預設皆關；「搬移」開時出現搬移提示全文、關時不在", async () => {
    withPatch(ok);
    fireEvent.click(await screen.findByRole("button", { name: "Create API token" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Create API token" }));
    const edit = dialog.getByRole("switch", { name: "Create and edit notes" });
    const move = dialog.getByRole("switch", { name: "Move or copy notes into groups" });
    expect(edit).toHaveAttribute("aria-checked", "false");
    expect(move).toHaveAttribute("aria-checked", "false");
    const hint = i18n.t("settings.account.apiTokensScopeMoveHint");
    expect(dialog.queryByText(hint)).toBeNull();
    fireEvent.click(edit);
    fireEvent.click(move);
    expect(dialog.getByText(hint)).toBeInTheDocument();
    fireEvent.click(move);
    expect(dialog.queryByText(hint)).toBeNull();
  });
});
