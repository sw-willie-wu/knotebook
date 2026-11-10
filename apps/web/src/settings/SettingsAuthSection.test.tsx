import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAuthProviderDto, SiteLimitItemDto, SiteLimitKey, SiteLimitsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { SITE_LIMITS_QUERY_KEY } from "@/api/siteLimits";
import { siteLimitsDto } from "@/test/site-limits-fixtures";
import { SettingsAuthSection } from "./SettingsAuthSection";

vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(async () => true) }));

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body),
  } as unknown as Response;
}

const LEGACY: AdminAuthProviderDto = {
  id: "11111111-1111-4111-8111-111111111111",
  template: "oidc",
  displayName: "SSO",
  issuerUrl: "http://idp.lan",
  clientId: "knotebook",
  hasSecret: true,
  enabled: true,
  autoCreateEnabled: true,
  sortOrder: 0,
  legacyCallback: true,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback",
  insecureIssuer: true,
  issuerResolved: true,
  createdAt: "2026-10-06T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "generic" },
};
const CUSTOM: AdminAuthProviderDto = {
  id: "22222222-2222-4222-8222-222222222222",
  template: "gitlab",
  displayName: "<b>Corp</b> & Co",
  issuerUrl: "https://gitlab.example.com",
  clientId: "corp-client",
  hasSecret: false,
  enabled: false,
  autoCreateEnabled: false,
  sortOrder: 1,
  legacyCallback: false,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback/22222222-2222-4222-8222-222222222222",
  insecureIssuer: false,
  issuerResolved: false,
  createdAt: "2026-10-06T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "gitlab" },
};

/** 站台限制：「登入期限與 token」組只用到這兩項，其餘照實放著。 */
const LIMITS: SiteLimitsDto = siteLimitsDto();
const limitsWith = (key: SiteLimitKey, patch: Partial<SiteLimitItemDto>): SiteLimitsDto => ({
  ...LIMITS,
  items: LIMITS.items.map((item) => (item.key === key ? { ...item, ...patch } : item)),
});

/** 回 Promise＝延後回應（測「進行中」狀態用）。 */
type Handler = (method: string, url: string, body: unknown) => Response | Promise<Response> | null;

/** 有狀態的假 server：GET 列表回目前的 `providers`；`on()` 掛額外端點；`calls` 記每一次請求。 */
function fakeServer(initial: AdminAuthProviderDto[]) {
  const state = { providers: [...initial], limits: LIMITS };
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const handlers: Handler[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    for (const handler of handlers) {
      const res = handler(method, url, body);
      if (res) return res;
    }
    if (method === "GET" && url === "/api/admin/auth/providers") return fakeResponse(200, { providers: state.providers });
    if (method === "GET" && url === "/api/admin/auth/settings") {
      return fakeResponse(200, { registrationEnabled: true, passwordLoginEnabled: true, passwordLoginForced: false, passwordLoginImpact: { usersWithoutSso: 0, actingAdminHasSso: true, enabledProviders: 1 } });
    }
    if (method === "GET" && url === "/api/admin/limits") return fakeResponse(200, state.limits);
    const impact = /^\/api\/admin\/auth\/providers\/([^/]+)\/impact$/.exec(url);
    if (method === "GET" && impact) {
      return fakeResponse(200, { linkedUsers: impact[1] === LEGACY.id ? 11 : 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { state, calls, fetchMock, on: (handler: Handler) => handlers.push(handler) };
}

function renderSection(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SettingsAuthSection />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** 一個登入服務＝以顯示名為名的資料列＋緊接的「＜名稱＞ details」明細列。 */
const row = (name: string) => within(screen.getByRole("row", { name }));
const details = (name: string) => within(screen.getByRole("row", { name: `${name} details` }));
/** 名稱元素（列的 aria-labelledby 指向它）；圖示是它的前一個兄弟。 */
const nameElementOf = (rowEl: HTMLElement) => document.getElementById(rowEl.getAttribute("aria-labelledby")!)!;

describe("SettingsAuthSection（#187 /admin/auth）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("列＋明細列：顯示名（HTML 形渲染為字面）、範本、legacy 標記、issuer（只在列上一份）、client id、回呼網址、secret 狀態、未連線提醒、http 警示", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await waitFor(() => expect(screen.getByRole("row", { name: "<b>Corp</b> & Co" })).toBeInTheDocument());
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("row", { name: "SSO" }).nextElementSibling).toBe(screen.getByRole("row", { name: "SSO details" }));

    const legacy = row("SSO");
    expect(legacy.getByText(/Custom OIDC/)).toBeInTheDocument();
    expect(legacy.getByText(/Imported from OIDC_\*/)).toBeInTheDocument();
    // Issuer 只在列上的 Issuer 欄：窄版重複段落已拿掉。
    expect(legacy.getByRole("cell", { name: "http://idp.lan" })).toBeInTheDocument();
    expect(screen.getAllByText("http://idp.lan")).toHaveLength(1);
    const legacyDetails = details("SSO");
    expect(legacyDetails.getByText("https://notes.example.com/api/auth/oidc/callback")).toBeInTheDocument();
    expect(legacyDetails.getByText("Client secret saved.")).toBeInTheDocument();
    expect(legacyDetails.getByText(/plain http/)).toBeInTheDocument();
    expect(legacyDetails.queryByText(/Hasn't connected successfully yet/)).toBeNull();

    const custom = row("<b>Corp</b> & Co");
    expect(custom.getByText(/GitLab/)).toBeInTheDocument();
    expect(custom.queryByText(/Imported from OIDC_\*/)).toBeNull();
    const customDetails = details("<b>Corp</b> & Co");
    expect(customDetails.getByText("corp-client")).toBeInTheDocument();
    expect(customDetails.getByText(CUSTOM.callbackUrl)).toBeInTheDocument();
    expect(customDetails.getByText(/No client secret yet/)).toBeInTheDocument();
    expect(customDetails.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
    expect(customDetails.queryByText(/plain http/)).toBeNull();
  });

  it("零個登入服務 → 空狀態文字", async () => {
    renderSection(fakeServer([]).fetchMock);
    await waitFor(() => expect(screen.getByText("No sign-in services yet.")).toBeInTheDocument());
  });

  it("複製回呼網址（明細列）→ copyText 收到 callbackUrl、toast", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    await screen.findByRole("row", { name: "<b>Corp</b> & Co details" });
    fireEvent.click(details("<b>Corp</b> & Co").getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(screen.getByText("Callback URL copied.")).toBeInTheDocument());
    expect(vi.mocked(copyText)).toHaveBeenCalledWith(CUSTOM.callbackUrl);
  });

  it("打開開關 → PATCH {enabled:true}；409 provider_secret_missing → toast、開關仍是關", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) =>
      method === "PATCH" && url === `/api/admin/auth/providers/${CUSTOM.id}`
        ? fakeResponse(409, { error: { code: "provider_secret_missing", message: "x" } })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(screen.getByText("Enter a client secret before turning this sign-in service on.")).toBeInTheDocument());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: true });
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false");
  });

  it("W8（#299 驗收 12）沒有 client ID 的服務打開開關 → 409 provider_client_id_missing → toast、開關仍是關", async () => {
    const server = fakeServer([{ ...CUSTOM, clientId: null, hasSecret: true }]);
    server.on((method, url) =>
      method === "PATCH" && url === `/api/admin/auth/providers/${CUSTOM.id}`
        ? fakeResponse(409, { error: { code: "provider_client_id_missing", message: "x" } })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(screen.getByText("Enter a client ID before turning this sign-in service on.")).toBeInTheDocument());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: true });
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false");
  });

  it("關掉開關 → 先開 dialog（不送 PATCH）、顯示人數與未連線提醒；確認 → PATCH {enabled:false}、重抓後開關變關", async () => {
    const enabledUnresolved = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabledUnresolved]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 5, lockedOutUsers: 2, issuerResolved: false, actingAdminLockedOut: false })
        : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabledUnresolved, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    await waitFor(() => expect(dialog.getByText("Linked accounts: 5")).toBeInTheDocument());
    expect(dialog.getByText("Of those, with no other way to sign in: 2")).toBeInTheDocument();
    expect(dialog.getByText(/these numbers may be off/)).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);

    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false"));
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: false });
  });

  it("停用 dialog 按取消 → 不送 PATCH、開關仍開", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false }) : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "true");
  });

  it("刪除：啟用中的刪除鈕 aria-disabled；停用中的 → dialog（legacy 有舊回呼網址說明；確認鈕是 destructive）→ DELETE → 重抓後列消失", async () => {
    const disabledLegacy = { ...LEGACY, enabled: false };
    const server = fakeServer([disabledLegacy, { ...CUSTOM, hasSecret: true, enabled: true }]);
    server.on((method, url) => {
      if (method !== "DELETE" || url !== `/api/admin/auth/providers/${LEGACY.id}`) return null;
      server.state.providers = server.state.providers.filter(p => p.id !== LEGACY.id);
      return fakeResponse(204);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    expect(custom.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(row("SSO").getByRole("button", { name: "Delete" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete this sign-in service?" }));
    expect(dialog.getByText(/uses the old callback URL/)).toBeInTheDocument();
    const confirm = dialog.getByRole("button", { name: "Delete" });
    expect(confirm.className).toMatch(/destructive/);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("row", { name: "SSO" })).toBeNull());
    expect(server.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
  });

  it("刪除鈕停用的原因：明細列看得到的文字＋`title`，以 aria-describedby 連到刪除鈕；停用服務後文字消失、刪除鈕可按", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false }) : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabled, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    const customDetails = details("<b>Corp</b> & Co");
    const hint = customDetails.getByText("Turn it off before deleting it.");
    const deleteButton = custom.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveAttribute("aria-disabled", "true");
    expect(hint.id).not.toBe("");
    expect(deleteButton).toHaveAttribute("aria-describedby", hint.id);
    expect(deleteButton).toHaveAccessibleDescription("Turn it off before deleting it.");

    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false"));
    expect(customDetails.queryByText("Turn it off before deleting it.")).toBeNull();
    expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-disabled");
    expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-describedby");
  });

  it("停用 dialog 與刪除 dialog 內的顯示名：HTML 形渲染為字面、不成為元素", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false }) : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabled, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));

    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const disableDialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(disableDialog.getByText("<b>Corp</b> & Co")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(disableDialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-disabled"));

    fireEvent.click(custom.getByRole("button", { name: "Delete" }));
    const deleteDialog = within(await screen.findByRole("dialog", { name: "Delete this sign-in service?" }));
    expect(deleteDialog.getByText("<b>Corp</b> & Co")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
  });

  it("測試連線（列上的鈕、結果在明細列）：成功顯示 issuer、warning、能力範圍說明，列表重抓後「未連線」提醒消失；502 → 錯誤文案", async () => {
    const server = fakeServer([{ ...LEGACY, issuerResolved: false }]);
    let fail = false;
    server.on((method, url) => {
      if (method !== "POST" || url !== `/api/admin/auth/providers/${LEGACY.id}/test`) return null;
      if (fail) return fakeResponse(502, { error: { code: "oidc_discovery_failed", message: "x" } });
      server.state.providers = [{ ...LEGACY, issuerResolved: true }]; // server 端 /test 成功會寫 resolved_issuer
      return fakeResponse(200, { issuer: "http://idp.lan", warnings: ["insecure_issuer", "client_secret_post_not_advertised"] });
    });
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("row", { name: "SSO" }));
    const legacyDetails = details("SSO");
    expect(legacyDetails.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacyDetails.queryByText(/Hasn't connected successfully yet/)).toBeNull());
    await waitFor(() => expect(legacyDetails.getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());
    expect(legacyDetails.getByText("The issuer uses plain http.")).toBeInTheDocument();
    expect(legacyDetails.getByText(/doesn't list client_secret_post/)).toBeInTheDocument();
    expect(legacyDetails.getByText(/can't tell whether the client ID or secret is right/)).toBeInTheDocument();

    fail = true;
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacyDetails.getByText("Couldn't read a usable OpenID Connect configuration from that issuer URL.")).toBeInTheDocument());
  });

  it("測試連線成功後，列表重抓回來的 issuer 變了 → 舊的「Connection OK」訊息消失（不與未連線提醒並存）", async () => {
    const server = fakeServer([{ ...LEGACY, issuerResolved: false }]);
    server.on((method, url) => {
      if (method !== "POST" || url !== `/api/admin/auth/providers/${LEGACY.id}/test`) return null;
      return fakeResponse(200, { issuer: "http://idp.lan", warnings: [] });
    });
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${LEGACY.id}/impact`
        ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false })
        : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LEGACY.id}`) return null;
      // 模擬編輯 issuer 的結果：issuer 換掉、resolved 清空、停用
      server.state.providers = [{ ...LEGACY, issuerUrl: "http://other.lan", issuerResolved: false, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("row", { name: "SSO" }));
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("SSO").getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());

    fireEvent.click(legacy.getByRole("switch", { name: "Enabled SSO" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));

    // Issuer 只在列上的 Issuer 欄一份（窄版重複段落已拿掉）。
    expect(await screen.findAllByText("http://other.lan")).toHaveLength(1);
    const refreshed = details("SSO");
    expect(refreshed.queryByText(/Connection OK/)).toBeNull();
    expect(refreshed.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
  });

  it("T2 兩列各自的測試結果：結果只出現在被測那一列的明細列；一列的設定變了只清掉那一列的結果", async () => {
    const corp = { ...CUSTOM, hasSecret: true };
    const server = fakeServer([LEGACY, corp]);
    server.on((method, url) => {
      if (method !== "POST") return null;
      if (url === `/api/admin/auth/providers/${LEGACY.id}/test`) return fakeResponse(200, { issuer: "http://idp.lan", warnings: [] });
      if (url === `/api/admin/auth/providers/${CUSTOM.id}/test`) return fakeResponse(502, { error: { code: "oidc_discovery_failed", message: "x" } });
      return null;
    });
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      // 打開 Corp 的同時 server 端 issuer 也換了（模擬另一處改了設定）：Corp 的測試結果過期，SSO 的不受影響。
      server.state.providers = [LEGACY, { ...corp, enabled: true, issuerUrl: "https://gitlab.other.example" }];
      return fakeResponse(200, server.state.providers[1]);
    });
    renderSection(server.fetchMock);
    const ok = "Connection OK. The identity provider reports issuer http://idp.lan.";
    const failed = "Couldn't read a usable OpenID Connect configuration from that issuer URL.";
    await screen.findByRole("row", { name: "SSO" });

    fireEvent.click(row("SSO").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("SSO").getByText(ok)).toBeInTheDocument());
    expect(details("<b>Corp</b> & Co").queryByText(ok)).toBeNull();

    fireEvent.click(row("<b>Corp</b> & Co").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("<b>Corp</b> & Co").getByText(failed)).toBeInTheDocument());
    expect(details("SSO").queryByText(failed)).toBeNull();
    expect(details("SSO").getByText(ok)).toBeInTheDocument();

    fireEvent.click(row("<b>Corp</b> & Co").getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(row("<b>Corp</b> & Co").getByRole("cell", { name: "https://gitlab.other.example" })).toBeInTheDocument());
    expect(details("<b>Corp</b> & Co").queryByText(failed)).toBeNull();
    expect(details("SSO").getByText(ok)).toBeInTheDocument();
  });

  it("T3 測試進行中（POST /test 未回）：「Testing…」只在被測那一列的明細列；回應後消失", async () => {
    const server = fakeServer([LEGACY, { ...CUSTOM, hasSecret: true }]);
    let release: (res: Response) => void = () => {};
    server.on((method, url) =>
      method === "POST" && url === `/api/admin/auth/providers/${LEGACY.id}/test`
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : null,
    );
    renderSection(server.fetchMock);
    await screen.findByRole("row", { name: "SSO" });

    fireEvent.click(row("SSO").getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("SSO").getByText("Testing…")).toBeInTheDocument());
    expect(details("<b>Corp</b> & Co").queryByText("Testing…")).toBeNull();

    release(fakeResponse(200, { issuer: "http://idp.lan", warnings: [] }));
    await waitFor(() => expect(details("SSO").getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());
    expect(details("SSO").queryByText("Testing…")).toBeNull();
  });

  it("停用 dialog：actingAdminLockedOut=true → 顯示「停用後你自己將無法用登入服務登入」", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: true })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(await dialog.findByText("After turning this off, you won't be able to sign in through a sign-in service yourself.")).toBeInTheDocument();
  });

  it("停用 dialog：actingAdminLockedOut=false → 不顯示該句（人數已落地後才斷言）", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 4, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false })
        : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(await dialog.findByText("Linked accounts: 4")).toBeInTheDocument();
    expect(dialog.queryByText("After turning this off, you won't be able to sign in through a sign-in service yourself.")).not.toBeInTheDocument();
  });

  it("provider-icon：名稱前有圖示（admin DTO 已換算的 icon）；upload 的 <img src> 等於 DTO icon.url；列名不變", async () => {
    const url = `/api/auth/providers/${CUSTOM.id}/icon?v=5`;
    const server = fakeServer([LEGACY, { ...CUSTOM, iconKind: "upload", icon: { type: "upload", url } }]);
    renderSection(server.fetchMock);
    // 等待點：列只在列表落地後才出現。
    const corp = await screen.findByRole("row", { name: "<b>Corp</b> & Co" });
    const corpIcon = nameElementOf(corp).previousElementSibling;
    expect(corpIcon?.tagName).toBe("IMG");
    expect(corpIcon).toHaveAttribute("src", url);
    expect(nameElementOf(screen.getByRole("row", { name: "SSO" })).previousElementSibling).toHaveAttribute("data-provider-icon", "generic");
  });

  // 「Icon」鈕是 RowIconButton：外觀（ghost、無實心底）由它自己的測試與 panel-no-solid-buttons 守，這裡只查名稱與行為。
  it("provider-icon：兩列都有「Icon」鈕，Edit／Delete 照在；點了開出圖示對話框", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await screen.findByRole("row", { name: "SSO" });
    for (const name of ["SSO", "<b>Corp</b> & Co"]) {
      const r = row(name);
      expect(r.getByRole("button", { name: "Icon" }), name).toBeInTheDocument();
      expect(r.getByRole("button", { name: "Edit" }), name).toBeInTheDocument();
      expect(r.getByRole("button", { name: "Delete" }), name).toBeInTheDocument();
    }
    fireEvent.click(row("SSO").getByRole("button", { name: "Icon" }));
    expect(await screen.findByRole("dialog", { name: "Sign-in service icon" })).toBeInTheDocument();
  });
});

describe("登入服務表格", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("L1 表名 Sign-in services；欄名 Service／Issuer／Linked／Creates accounts／Actions／Enabled；列內：Issuer、已連結人數、Test connection／Icon／Edit／Delete（依序）、「Enabled ＜名稱＞」開關", async () => {
    renderSection(fakeServer([LEGACY, CUSTOM]).fetchMock);
    const table = await screen.findByRole("table", { name: "Sign-in services" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Service", "Issuer", "Linked", "Creates accounts", "Actions", "Enabled"]);
    const legacyRow = within(table).getByRole("row", { name: "SSO" });
    expect(within(legacyRow).getByRole("cell", { name: "http://idp.lan" })).toBeInTheDocument();
    await waitFor(() => expect(within(legacyRow).getByRole("cell", { name: "11" })).toBeInTheDocument());
    expect(within(legacyRow).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Test connection",
      "Icon",
      "Edit",
      "Delete",
    ]);
    expect(within(legacyRow).getByRole("switch", { name: "Enabled SSO" })).toBeInTheDocument();
  });

  it("欄寬：服務欄與 Issuer 欄按 1 : 1.5 分配（真實掛載）", async () => {
    renderSection(fakeServer([LEGACY, CUSTOM]).fetchMock);
    const table = await screen.findByRole("table", { name: "Sign-in services" });
    expect(table.style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,1fr) minmax(14ch,1.5fr) max-content max-content 8.75rem 3.5rem");
  });

  it("L3 啟用中的 Delete：aria-disabled＋title 是「Turn it off before deleting it.」，點了不開刪除對話框", async () => {
    renderSection(fakeServer([LEGACY]).fetchMock);
    const del = within(await screen.findByRole("row", { name: "SSO" })).getByRole("button", { name: "Delete" });
    expect(del).toHaveAttribute("title", "Turn it off before deleting it.");
    fireEvent.click(del);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("dialog", { name: "Delete this sign-in service?" })).not.toBeInTheDocument();
  });

  it("L5 停用確認框是開框當下的快照：列上已載入的舊人數（A）不出現在框內，重抓完才顯示新人數（B）", async () => {
    const server = fakeServer([LEGACY]);
    let linkedUsers = 7;
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${LEGACY.id}/impact`
        ? fakeResponse(200, { linkedUsers, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false })
        : null,
    );
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("row", { name: "SSO" }));
    await waitFor(() => expect(legacy.getByRole("cell", { name: "7" })).toBeInTheDocument());

    linkedUsers = 3;
    fireEvent.click(legacy.getByRole("switch", { name: "Enabled SSO" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(dialog.queryByText("Linked accounts: 7")).toBeNull();
    expect(await dialog.findByText("Linked accounts: 3")).toBeInTheDocument();
    expect(dialog.queryByText("Linked accounts: 7")).toBeNull();
  });

  it("L4 「Add sign-in service」是 outline（面板層級動作）", async () => {
    renderSection(fakeServer([]).fetchMock);
    const add = await screen.findByRole("button", { name: "Add sign-in service" });
    expect(add.className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
  });
});

describe("client ID 尚未填入（#299）", () => {
  const NO_ID: AdminAuthProviderDto = { ...CUSTOM, id: "66666666-6666-4666-8666-666666666666", displayName: "No ID SSO", clientId: null, hasSecret: true };
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("W6 clientId 為 null 的列：明細顯示「尚未填入」全文、有 client ID 的列照舊顯示 client ID", async () => {
    renderSection(fakeServer([NO_ID, LEGACY]).fetchMock);
    await screen.findByRole("row", { name: "No ID SSO" });
    expect(details("No ID SSO").getByText("Not set yet. The service can't be turned on until a client ID is saved.")).toBeInTheDocument();
    expect(details("SSO").getByText("knotebook")).toBeInTheDocument();
  });

  it("W7 測試連線回 client_id_missing → 明細顯示提醒；補上 client ID 後列表重抓 → 測試結果消失", async () => {
    const server = fakeServer([NO_ID]);
    server.on((method, url) =>
      method === "POST" && url === `/api/admin/auth/providers/${NO_ID.id}/test`
        ? fakeResponse(200, { issuer: "https://gitlab.example.com", warnings: ["client_id_missing"] })
        : null,
    );
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${NO_ID.id}`) return null;
      // 只把 clientId 填上；issuerUrl 與 hasSecret 不變
      server.state.providers = [{ ...NO_ID, clientId: (body as { clientId: string }).clientId }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const noId = within(await screen.findByRole("row", { name: "No ID SSO" }));
    fireEvent.click(noId.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(details("No ID SSO").getByText("No client ID yet. Add it with Edit before turning the service on.")).toBeInTheDocument());

    fireEvent.click(noId.getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "x" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(details("No ID SSO").getByText("x")).toBeInTheDocument());
    expect(details("No ID SSO").queryByText(/No client ID yet/)).toBeNull();
    expect(details("No ID SSO").queryByText(/Connection OK/)).toBeNull();
  });
});

describe("登入期限與 token 組", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const group = async () => {
    const region = within(await screen.findByRole("region", { name: "Session and tokens" }));
    const input = (name: string) => region.getByLabelText(name, { selector: "input" });
    return { ...region, input };
  };
  const patches = (server: ReturnType<typeof fakeServer>) => server.calls.filter((c) => c.method === "PATCH" && c.url === "/api/admin/limits");

  it("登入服務表之外多一組：登入有效期以小時顯示、兩列各有小字，登入服務表照在", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const g = await group();
    expect(g.input("Web sign-in lasts")).toHaveValue("168");
    expect(g.input("Active API tokens per person")).toHaveValue("20");
    expect(g.getByText(/Only affects people who sign in afterwards/)).toBeInTheDocument();
    expect(g.getByText(/Lowering it does not revoke existing tokens/)).toBeInTheDocument();
    expect(g.getAllByRole("group").map((r) => r.getAttribute("data-limit-key"))).toEqual(["sessionTtlSeconds", "apiTokensPerUser"]);
    expect(await screen.findByRole("table", { name: "Sign-in services" })).toBeInTheDocument();
  });

  it("位置：在「允許自行註冊」開關之後、登入服務表之前", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const region = await screen.findByRole("region", { name: "Session and tokens" });
    const access = await screen.findByRole("switch", { name: "Allow self-registration with a password" });
    const table = await screen.findByRole("table", { name: "Sign-in services" });
    expect(access.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(region.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("改成 24 小時儲存 → PATCH 只送被改的那一項、以秒計", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) => (method === "PATCH" && url === "/api/admin/limits" ? fakeResponse(200, server.state.limits) : null));
    renderSection(server.fetchMock);
    const g = await group();
    fireEvent.change(g.input("Web sign-in lasts"), { target: { value: "24" } });
    fireEvent.click(g.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0]!.body).toEqual({ set: { sessionTtlSeconds: 86400 } });
  });

  it("已調整的 token 上限有「Restore default」，按下送 null", async () => {
    const server = fakeServer([CUSTOM]);
    server.state.limits = limitsWith("apiTokensPerUser", { value: 5, source: "admin", stored: 5 });
    server.on((method, url) => (method === "PATCH" && url === "/api/admin/limits" ? fakeResponse(200, LIMITS) : null));
    renderSection(server.fetchMock);
    const g = await group();
    expect(g.input("Active API tokens per person")).toHaveValue("5");
    fireEvent.click(g.getByRole("button", { name: "Restore default" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0]!.body).toEqual({ set: { apiTokensPerUser: null } });
  });

  it("超出範圍（0 小時）→ 不送、顯示範圍錯誤", async () => {
    const server = fakeServer([CUSTOM]);
    renderSection(server.fetchMock);
    const g = await group();
    fireEvent.change(g.input("Web sign-in lasts"), { target: { value: "0" } });
    fireEvent.click(g.getByRole("button", { name: "Save" }));
    expect(await g.findByRole("alert")).toHaveTextContent(/Enter a whole number from 1 to 720/);
    expect(patches(server)).toHaveLength(0);
  });

  it("已有資料時背景重抓失敗：輸入到一半的內容與整組都還在，不換成錯誤", async () => {
    const server = fakeServer([CUSTOM]);
    const queryClient = renderSection(server.fetchMock);
    const g = await group();
    fireEvent.change(g.input("Web sign-in lasts"), { target: { value: "24" } });
    server.on((method, url) => (method === "GET" && url === "/api/admin/limits" ? fakeResponse(500, { error: { code: "internal", message: "x" } }) : null));
    await queryClient.refetchQueries({ queryKey: SITE_LIMITS_QUERY_KEY });
    await waitFor(() => expect(queryClient.getQueryState(SITE_LIMITS_QUERY_KEY)?.fetchStatus).toBe("idle"));
    expect(queryClient.getQueryState(SITE_LIMITS_QUERY_KEY)?.status).toBe("error");
    expect(screen.getByRole("region", { name: "Session and tokens" })).toBeInTheDocument();
    expect(g.input("Web sign-in lasts")).toHaveValue("24");
    expect(g.queryByRole("alert")).toBeNull();
  });

  it("中文標題「登入期限與 token」", async () => {
    await i18n.changeLanguage("zh-TW");
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const region = within(await screen.findByRole("region", { name: "登入期限與 token" }));
    expect(region.getByText(/只影響之後新登入的人/)).toBeInTheDocument();
    expect(region.getByText(/調低不會撤銷既有 token/)).toBeInTheDocument();
  });

  it("載入失敗：顯示伺服器錯誤文案（跟站台限制分頁同一套），不是通用訊息", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) => (method === "GET" && url === "/api/admin/limits" ? fakeResponse(500, { error: { code: "limit_locked_by_env", message: "x" } }) : null));
    renderSection(server.fetchMock);
    expect(await screen.findByText(i18n.t("errors.limit_locked_by_env"))).toBeInTheDocument();
  });
});

describe("服務表的自動建帳開關", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const CUSTOM_PATH = `/api/admin/auth/providers/${CUSTOM.id}`;

  it("AC1 每列有「Create accounts on first sign-in with ＜名稱＞」開關，aria-checked 反映 autoCreateEnabled（名稱字面不當 HTML）", async () => {
    renderSection(fakeServer([LEGACY, CUSTOM]).fetchMock);
    await screen.findByRole("row", { name: "SSO" });
    expect(row("SSO").getByRole("switch", { name: "Create accounts on first sign-in with SSO" })).toHaveAttribute("aria-checked", "true");
    expect(row("<b>Corp</b> & Co").getByRole("switch", { name: "Create accounts on first sign-in with <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false");
  });

  it("AC2 點停用中服務的開關 → PATCH 恰 {autoCreateEnabled:true}；送出期間 disabled；成功重抓後 aria-checked=true；沒有任何 dialog", async () => {
    const server = fakeServer([CUSTOM]);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    server.on((method, url) => {
      if (method !== "PATCH" || url !== CUSTOM_PATH) return null;
      return gate.then(() => {
        server.state.providers = [{ ...CUSTOM, autoCreateEnabled: true }];
        return fakeResponse(200, server.state.providers[0]);
      });
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    const sw = custom.getByRole("switch", { name: "Create accounts on first sign-in with <b>Corp</b> & Co" });
    expect(CUSTOM.enabled).toBe(false);
    expect(sw).not.toBeDisabled();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    release();
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(sw).not.toBeDisabled();
    const patches = server.calls.filter(c => c.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe(CUSTOM_PATH);
    expect(patches[0]!.body).toEqual({ autoCreateEnabled: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("AC3 PATCH 回 500 → toast 顯示錯誤文案、開關仍 aria-checked=false", async () => {
    const server = fakeServer([CUSTOM]);
    server.on((method, url) =>
      method === "PATCH" && url === CUSTOM_PATH ? fakeResponse(500, { error: { code: "internal", message: "x" } }) : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("row", { name: "<b>Corp</b> & Co" }));
    const sw = custom.getByRole("switch", { name: "Create accounts on first sign-in with <b>Corp</b> & Co" });
    fireEvent.click(sw);
    expect(await screen.findByText("Something went wrong. Please try again.")).toBeInTheDocument();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("AC4 服務群組說明（en 全文）可見", async () => {
    renderSection(fakeServer([LEGACY]).fetchMock);
    expect(
      await screen.findByText(
        "When Creates accounts is on, anyone who can sign in to that identity provider and whose email has no account here yet gets one the first time they sign in. Keep it off for providers anyone can sign up at, such as Google or gitlab.com.",
      ),
    ).toBeInTheDocument();
  });
});
