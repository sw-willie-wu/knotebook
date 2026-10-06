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
    expect(legacy.getByText("http://idp.lan")).toBeInTheDocument();
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
    fireEvent.click(custom.getByRole("switch", { name: "On" }));
    await waitFor(() => expect(screen.getByText("Enter a client secret before turning this sign-in service on.")).toBeInTheDocument());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: true });
    expect(custom.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "false");
  });

  it("關掉開關 → 先開 dialog（不送 PATCH）、顯示人數與未連線提醒；確認 → PATCH {enabled:false}、重抓後開關變關", async () => {
    const enabledUnresolved = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabledUnresolved]);
    server.on((method, url) =>
      method === "GET" && url === `/api/admin/auth/providers/${CUSTOM.id}/impact`
        ? fakeResponse(200, { linkedUsers: 5, lockedOutUsers: 2, issuerResolved: false })
        : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabledUnresolved, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "On" }));

    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    await waitFor(() => expect(dialog.getByText("Linked accounts: 5")).toBeInTheDocument());
    expect(dialog.getByText("Of those, with no other way to sign in: 2")).toBeInTheDocument();
    expect(dialog.getByText(/these numbers may be off/)).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);

    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "false"));
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ enabled: false });
  });

  it("停用 dialog 按取消 → 不送 PATCH、開關仍開", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true }) : null,
    );
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));
    fireEvent.click(custom.getByRole("switch", { name: "On" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
    expect(custom.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "true");
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
    expect(custom.getByRole("button", { name: "Delete" })).toBeDisabled();

    fireEvent.click(card("SSO").getByRole("button", { name: "Delete" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Delete this sign-in service?" }));
    expect(dialog.getByText(/uses the old callback URL/)).toBeInTheDocument();
    const confirm = dialog.getByRole("button", { name: "Delete" });
    expect(confirm.className).toMatch(/destructive/);
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.queryByRole("region", { name: "SSO" })).toBeNull());
    expect(server.calls.filter(c => c.method === "DELETE")).toHaveLength(1);
  });

  it("刪除鈕停用的原因是看得到的文字（不靠 title）、以 aria-describedby 連到刪除鈕；停用服務後文字消失、刪除鈕可按", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 0, lockedOutUsers: 0, issuerResolved: true }) : null,
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
    expect(deleteButton).toBeDisabled();
    expect(deleteButton).not.toHaveAttribute("title");
    expect(hint.id).not.toBe("");
    expect(deleteButton).toHaveAttribute("aria-describedby", hint.id);
    expect(deleteButton).toHaveAccessibleDescription("Turn it off before deleting it.");

    fireEvent.click(custom.getByRole("switch", { name: "On" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(custom.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "false"));
    expect(custom.queryByText("Turn it off before deleting it.")).toBeNull();
    expect(custom.getByRole("button", { name: "Delete" })).toBeEnabled();
    expect(custom.getByRole("button", { name: "Delete" })).not.toHaveAttribute("aria-describedby");
  });

  it("停用 dialog 與刪除 dialog 內的顯示名：HTML 形渲染為字面、不成為元素", async () => {
    const enabled = { ...CUSTOM, hasSecret: true, enabled: true };
    const server = fakeServer([enabled]);
    server.on((method, url) =>
      method === "GET" && url.endsWith("/impact") ? fakeResponse(200, { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true }) : null,
    );
    server.on((method, url) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${CUSTOM.id}`) return null;
      server.state.providers = [{ ...enabled, enabled: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const custom = within(await screen.findByRole("region", { name: "<b>Corp</b> & Co" }));

    fireEvent.click(custom.getByRole("switch", { name: "On" }));
    const disableDialog = within(await screen.findByRole("dialog", { name: "Turn this sign-in service off?" }));
    expect(disableDialog.getByText("<b>Corp</b> & Co")).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    fireEvent.click(disableDialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(custom.getByRole("button", { name: "Delete" })).toBeEnabled());

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
});
