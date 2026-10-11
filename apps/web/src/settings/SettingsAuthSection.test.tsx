import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAuthProviderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
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
  sortOrder: 1,
  legacyCallback: false,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback/22222222-2222-4222-8222-222222222222",
  insecureIssuer: false,
  issuerResolved: false,
  createdAt: "2026-10-06T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "gitlab" },
};

type Handler = (method: string, url: string, body: unknown) => Response | null;

/** 有狀態的假 server：GET 列表回目前的 `providers`；`on()` 掛額外端點；`calls` 記每一次請求。 */
function fakeServer(initial: AdminAuthProviderDto[]) {
  const state = { providers: [...initial] };
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
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SettingsAuthSection />
      <Toaster />
    </QueryClientProvider>,
  );
}

const card = (name: string) => within(screen.getByRole("region", { name }));

describe("SettingsAuthSection（#187 §9.4 /admin/auth）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("卡片：顯示名（HTML 形渲染為字面）、範本、legacy 標記、issuer、client id、回呼網址、secret 狀態、未連線提醒、http 警示", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await waitFor(() => expect(screen.getByRole("region", { name: "<b>Corp</b> & Co" })).toBeInTheDocument());
    expect(document.querySelector("b")).toBeNull();

    const legacy = card("SSO");
    expect(legacy.getByText(/Custom OIDC/)).toBeInTheDocument();
    expect(legacy.getByText(/Imported from OIDC_\*/)).toBeInTheDocument();
    // Issuer：格線列的 Issuer 欄＋明細區窄視窗那一行（`md:hidden`，jsdom 不套媒體查詢）各一份。
    expect(legacy.getAllByText("http://idp.lan")).toHaveLength(2);
    expect(legacy.getByText("https://notes.example.com/api/auth/oidc/callback")).toBeInTheDocument();
    expect(legacy.getByText("Client secret saved.")).toBeInTheDocument();
    expect(legacy.getByText(/plain http/)).toBeInTheDocument();
    expect(legacy.queryByText(/Hasn't connected successfully yet/)).toBeNull();

    const custom = card("<b>Corp</b> & Co");
    expect(custom.getByText(/GitLab/)).toBeInTheDocument();
    expect(custom.queryByText(/Imported from OIDC_\*/)).toBeNull();
    expect(custom.getByText("corp-client")).toBeInTheDocument();
    expect(custom.getByText(CUSTOM.callbackUrl)).toBeInTheDocument();
    expect(custom.getByText(/No client secret yet/)).toBeInTheDocument();
    expect(custom.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
    expect(custom.queryByText(/plain http/)).toBeNull();
  });

  it("零個登入服務 → 空狀態文字", async () => {
    renderSection(fakeServer([]).fetchMock);
    await waitFor(() => expect(screen.getByText("No sign-in services yet.")).toBeInTheDocument());
  });

  it("複製回呼網址 → copyText 收到 callbackUrl、toast", async () => {
    renderSection(fakeServer([CUSTOM]).fetchMock);
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("button", { name: "Copy" }));
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    await waitFor(() => expect(screen.getByText("Enter a client secret before turning this sign-in service on.")).toBeInTheDocument());
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
    expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "true");
  });

  it("刪除：啟用中的刪除鈕 disabled；停用中的 → dialog（legacy 有舊回呼網址說明；確認鈕是 destructive）→ DELETE → 重抓後卡片消失", async () => {
    const disabledLegacy = { ...LEGACY, enabled: false };
    const server = fakeServer([disabledLegacy, { ...CUSTOM, hasSecret: true, enabled: true }]);
    server.on((method, url) => {
      if (method !== "DELETE" || url !== `/api/admin/auth/providers/${LEGACY.id}`) return null;
      server.state.providers = server.state.providers.filter(p => p.id !== LEGACY.id);
      return fakeResponse(204);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    expect(custom.getByRole("button", { name: "Delete" })).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(card("SSO").getByRole("button", { name: "Delete" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete this sign-in service?" }));
    expect(dialog.getByText(/uses the old callback URL/)).toBeInTheDocument();
    const confirm = dialog.getByRole("button", { name: "Delete" });
    expect(confirm.className).toMatch(/destructive/);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("region", { name: "SSO" })).toBeNull());
    expect(server.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
  });

  it("刪除鈕停用的原因：看得到的文字＋`title`，以 aria-describedby 連到刪除鈕；停用服務後文字消失、刪除鈕可按", async () => {
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    const hint = custom.getByText("Turn it off before deleting it.");
    const deleteButton = custom.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveAttribute("aria-disabled", "true");
    expect(hint.id).not.toBe("");
    expect(deleteButton).toHaveAttribute("aria-describedby", hint.id);
    expect(deleteButton).toHaveAccessibleDescription("Turn it off before deleting it.");

    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" })).toHaveAttribute("aria-checked", "false"));
    expect(custom.queryByText("Turn it off before deleting it.")).toBeNull();
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));

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

  it("測試連線：成功顯示 issuer、warning、能力範圍說明，列表重抓後「未連線」提醒消失；502 → 錯誤文案", async () => {
    const server = fakeServer([{ ...LEGACY, issuerResolved: false }]);
    let fail = false;
    server.on((method, url) => {
      if (method !== "POST" || url !== `/api/admin/auth/providers/${LEGACY.id}/test`) return null;
      if (fail) return fakeResponse(502, { error: { code: "oidc_discovery_failed", message: "x" } });
      server.state.providers = [{ ...LEGACY, issuerResolved: true }]; // server 端 /test 成功會寫 resolved_issuer
      return fakeResponse(200, { issuer: "http://idp.lan", warnings: ["insecure_issuer", "client_secret_post_not_advertised"] });
    });
    renderSection(server.fetchMock);
    const legacy = within(await screen.findByRole("region", { name: "SSO" }));
    expect(legacy.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacy.queryByText(/Hasn't connected successfully yet/)).toBeNull());
    await waitFor(() => expect(legacy.getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());
    expect(legacy.getByText("The issuer uses plain http.")).toBeInTheDocument();
    expect(legacy.getByText(/doesn't list client_secret_post/)).toBeInTheDocument();
    expect(legacy.getByText(/can't tell whether the client ID or secret is right/)).toBeInTheDocument();

    fail = true;
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacy.getByText("Couldn't read a usable OpenID Connect configuration from that issuer URL.")).toBeInTheDocument());
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
    const legacy = within(await screen.findByRole("region", { name: "SSO" }));
    fireEvent.click(legacy.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(legacy.getByText("Connection OK. The identity provider reports issuer http://idp.lan.")).toBeInTheDocument());

    fireEvent.click(legacy.getByRole("switch", { name: "Enabled SSO" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));

    // 格線列的 Issuer 欄＋明細區窄視窗那一行（`md:hidden`，jsdom 不套媒體查詢）各一份。
    expect(await screen.findAllByText("http://other.lan")).toHaveLength(2);
    const refreshed = within(screen.getByRole("region", { name: "SSO" }));
    expect(refreshed.queryByText(/Connection OK/)).toBeNull();
    expect(refreshed.getByText(/Hasn't connected successfully yet/)).toBeInTheDocument();
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
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
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "Enabled <b>Corp</b> & Co" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(await dialog.findByText("Linked accounts: 4")).toBeInTheDocument();
    expect(dialog.queryByText("After turning this off, you won't be able to sign in through a sign-in service yourself.")).not.toBeInTheDocument();
  });
  it("provider-icon V5：卡片標題前有圖示（admin DTO 已換算的 icon）；upload 的 <img src> 等於 DTO icon.url；region 名不變", async () => {
    const url = `/api/auth/providers/${CUSTOM.id}/icon?v=5`;
    const server = fakeServer([LEGACY, { ...CUSTOM, iconKind: "upload", icon: { type: "upload", url } }]);
    renderSection(server.fetchMock);
    // 等待點：region 只在列表落地後才出現。
    const corp = await screen.findByRole("region", { name: "<b>Corp</b> & Co" });
    const corpIcon = within(corp).getByRole("heading", { name: "<b>Corp</b> & Co" }).previousElementSibling;
    expect(corpIcon?.tagName).toBe("IMG");
    expect(corpIcon).toHaveAttribute("src", url);
    expect(card("SSO").getByRole("heading", { name: "SSO" }).previousElementSibling).toHaveAttribute("data-provider-icon", "generic");
  });

  it("provider-icon：兩張卡片都有「Icon」鈕（ghost：無實心底、無 outline 外框），Edit／Delete 照在；點了開出圖示對話框", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await screen.findByRole("region", { name: "SSO" });
    for (const name of ["SSO", "<b>Corp</b> & Co"]) {
      const c = card(name);
      const icon = c.getByRole("button", { name: "Icon" });
      expect(icon.className, name).not.toMatch(/(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/);
      expect(icon.className, name).not.toMatch(/(^|\s)border-input(\s|$)/);
      expect(c.getByRole("button", { name: "Edit" }), name).toBeInTheDocument();
      expect(c.getByRole("button", { name: "Delete" }), name).toBeInTheDocument();
    }
    const iconButton = card("SSO").getByRole("button", { name: "Icon" });
    fireEvent.click(iconButton);
    expect(await screen.findByRole("dialog", { name: "Sign-in service icon" })).toBeInTheDocument();
  });
});

describe("登入服務表格列（#247 §7.0，W21／W27）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("L1 表頭：Service／Issuer／Linked／（動作）／Enabled；每列第一行依序是圖示＋名稱、Issuer、已連結人數、動作鈕、啟用 switch", async () => {
    const server = fakeServer([LEGACY, CUSTOM]);
    renderSection(server.fetchMock);
    await screen.findByRole("region", { name: "SSO" });
    const header = screen.getByTestId("auth-provider-table-header");
    expect(header).toHaveTextContent(/Service.*Issuer.*Linked.*Enabled/);
    const legacyRow = within(screen.getByRole("region", { name: "SSO" })).getByTestId("auth-provider-row");
    expect(within(legacyRow).getByText("http://idp.lan")).toBeInTheDocument();
    await waitFor(() => expect(within(legacyRow).getByText("11")).toBeInTheDocument());
    expect(within(legacyRow).getByRole("switch", { name: "Enabled SSO" })).toBeInTheDocument();
  });

  it("L1n 窄視窗（<md）：格線只在 md 以上；Issuer 欄 hidden md:block、名稱格 min-w-0；表頭 hidden md:grid（390px 不把名稱／Issuer 壓到 0）", async () => {
    const server = fakeServer([LEGACY]);
    renderSection(server.fetchMock);
    const rowEl = within(await screen.findByRole("region", { name: "SSO" })).getByTestId("auth-provider-row");
    expect(rowEl).toHaveClass("flex", "flex-wrap", "md:grid");
    expect(rowEl).not.toHaveClass("grid");
    const [name, issuer] = Array.from(rowEl.children);
    expect(name).toHaveTextContent("SSO");
    expect(name).toHaveClass("min-w-0");
    expect(issuer).toHaveTextContent("http://idp.lan");
    expect(issuer).toHaveClass("hidden", "md:block");
    // 資訊不丟：窄視窗由明細區補一行 Issuer（md 以上隱藏）。
    const regionEl = screen.getByRole("region", { name: "SSO" });
    const narrowIssuer = within(regionEl).getAllByText("http://idp.lan").find((el) => !rowEl.contains(el));
    expect(narrowIssuer).toHaveClass("md:hidden");
    const header = screen.getByTestId("auth-provider-table-header");
    expect(header).toHaveClass("hidden", "md:grid");
    expect(header).not.toHaveClass("grid");
  });

  it("L2 列尾四顆 icon 鈕：Test connection（插頭）、Edit（鉛筆）、Icon（圖片）、Delete（紅垃圾桶）；都是 ghost size icon、帶 title，沒有可見文字", async () => {
    const server = fakeServer([LEGACY]);
    renderSection(server.fetchMock);
    const row = within(within(await screen.findByRole("region", { name: "SSO" })).getByTestId("auth-provider-row"));
    for (const name of ["Test connection", "Edit", "Icon", "Delete"]) {
      const button = row.getByRole("button", { name });
      expect(button, name).toHaveClass("h-8", "w-8");
      expect(button, name).toHaveAttribute("title");
      expect(button.textContent, name).toBe("");
    }
    expect(row.getByRole("button", { name: "Delete" })).toHaveClass("text-destructive");
  });

  it("L3 啟用中的 Delete：aria-disabled＋title 是「Turn it off before deleting it.」，點了不開刪除對話框", async () => {
    const server = fakeServer([LEGACY]);
    renderSection(server.fetchMock);
    const del = within(await screen.findByRole("region", { name: "SSO" })).getByRole("button", { name: "Delete" });
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
    const legacy = within(await screen.findByRole("region", { name: "SSO" }));
    await waitFor(() => expect(within(legacy.getByTestId("auth-provider-row")).getByText("7")).toBeInTheDocument());

    linkedUsers = 3;
    fireEvent.click(legacy.getByRole("switch", { name: "Enabled SSO" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(dialog.queryByText("Linked accounts: 7")).toBeNull();
    expect(await dialog.findByText("Linked accounts: 3")).toBeInTheDocument();
    expect(dialog.queryByText("Linked accounts: 7")).toBeNull();
  });

  it("L4 「Add sign-in service」是 outline（面板層級動作，§4.8）", async () => {
    const server = fakeServer([]);
    renderSection(server.fetchMock);
    const add = await screen.findByRole("button", { name: "Add sign-in service" });
    expect(add.className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
  });
});
