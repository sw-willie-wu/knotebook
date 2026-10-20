import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAuthProviderDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
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

const LIVE: AdminAuthProviderDto = {
  id: "33333333-3333-4333-8333-333333333333",
  template: "oidc",
  displayName: "Corp SSO",
  issuerUrl: "https://idp.example.com",
  clientId: "corp-client",
  hasSecret: true,
  enabled: true,
  autoCreateEnabled: false,
  sortOrder: 2,
  legacyCallback: false,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback/33333333-3333-4333-8333-333333333333",
  insecureIssuer: false,
  issuerResolved: true,
  createdAt: "2026-10-06T00:00:00.000Z",
  iconKind: "template",
  icon: { type: "builtin", name: "generic" },
};

type Handler = (method: string, url: string, body: unknown) => Response | Promise<Response> | null;
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

const AUTO: AdminAuthProviderDto = { ...LIVE, autoCreateEnabled: true };

async function openCreate() {
  fireEvent.click(await screen.findByRole("button", { name: "Add sign-in service" }));
  return within(await screen.findByRole("dialog", { name: "Add sign-in service" }));
}

describe("新增登入服務 dialog（#187 §9.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.mocked(copyText).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("點對話框外面不關閉、已填內容仍在（Willie 回報：隨便點周圍就關、已填內容全丟）", async () => {
    const server = fakeServer([]);
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    expect(dialog.getByText("New sign-in services start turned off, and don't create accounts on first sign-in. Test the connection, then turn it on.")).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Keep me" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Add sign-in service" })).toBeInTheDocument();
    expect(dialog.getByLabelText("Display name")).toHaveValue("Keep me");
  });

  it("零個服務時也看得到「新增」鈕（空狀態＋新增，r2-N7）", async () => {
    renderSection(fakeServer([]).fetchMock);
    await waitFor(() => expect(screen.getByText("No sign-in services yet.")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Add sign-in service" })).toBeInTheDocument();
  });

  it("範本預填：預設 GitLab（https://gitlab.com）；換 Google → https://accounts.google.com；換自訂 → 空白", async () => {
    renderSection(fakeServer([]).fetchMock);
    const dialog = await openCreate();
    expect(dialog.getByLabelText("Issuer URL")).toHaveValue("https://gitlab.com");
    expect(dialog.getByLabelText("Display name")).toHaveValue("GitLab");
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: "google" } });
    expect(dialog.getByLabelText("Issuer URL")).toHaveValue("https://accounts.google.com");
    expect(dialog.getByLabelText("Display name")).toHaveValue("Google");
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: "oidc" } });
    expect(dialog.getByLabelText("Issuer URL")).toHaveValue("");
    expect(dialog.getByLabelText("Display name")).toHaveValue("");
  });

  it("先試探 → POST /api/admin/auth/discover {issuerUrl}；顯示 issuer 與 warning；502 → 錯誤文案", async () => {
    const server = fakeServer([]);
    let fail = false;
    server.on((method, url) =>
      method === "POST" && url === "/api/admin/auth/discover"
        ? fail
          ? fakeResponse(502, { error: { code: "oidc_discovery_failed", message: "x" } })
          : fakeResponse(200, { issuer: "https://gitlab.com", warnings: ["client_secret_post_not_advertised"] })
        : null,
    );
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.click(dialog.getByRole("button", { name: "Check issuer" }));
    await waitFor(() => expect(dialog.getByText("Found issuer https://gitlab.com.")).toBeInTheDocument());
    expect(dialog.getByText(/doesn't list client_secret_post/)).toBeInTheDocument();
    expect(server.calls.find(c => c.url === "/api/admin/auth/discover")!.body).toEqual({ issuerUrl: "https://gitlab.com" });
    fail = true;
    fireEvent.click(dialog.getByRole("button", { name: "Check issuer" }));
    await waitFor(() => expect(dialog.getByText("Couldn't read a usable OpenID Connect configuration from that issuer URL.")).toBeInTheDocument());
  });

  it("issuer 帶帳密 → 欄位錯誤、不送出建立請求", async () => {
    const server = fakeServer([]);
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Corp SSO" } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://user:pass@idp.example.com" } });
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "corp-client" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect(await dialog.findByText("Issuer URL can't contain a username or password.")).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "POST" && c.url === "/api/admin/auth/providers")).toBe(false);
  });

  it("建立 → POST body（secret 留空就不帶這個鍵）→ 設定步驟顯示回呼網址並可複製、提醒貼 secret → 完成關閉", async () => {
    const server = fakeServer([]);
    const created: AdminAuthProviderDto = { ...LIVE, id: "44444444-4444-4444-8444-444444444444", enabled: false, hasSecret: false, issuerResolved: false, callbackUrl: "https://notes.example.com/api/auth/oidc/callback/44444444-4444-4444-8444-444444444444" };
    server.on((method, url) => {
      if (method !== "POST" || url !== "/api/admin/auth/providers") return null;
      server.state.providers = [created];
      return fakeResponse(201, created);
    });
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: "oidc" } });
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Corp SSO" } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://idp.example.com" } });
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "corp-client" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));

    const steps = within(await screen.findByRole("dialog", { name: "Finish setting it up" }));
    expect(server.calls.find(c => c.method === "POST" && c.url === "/api/admin/auth/providers")!.body).toEqual({
      template: "oidc",
      displayName: "Corp SSO",
      issuerUrl: "https://idp.example.com",
      clientId: "corp-client",
    });
    expect(steps.getByText(created.callbackUrl)).toBeInTheDocument();
    expect(steps.getByText(/paste it here with Edit/)).toBeInTheDocument();
    fireEvent.click(steps.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(created.callbackUrl));
    fireEvent.click(steps.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("建立時帶了 secret → body 有 clientSecret（原樣、不 trim）、設定步驟不再提醒貼 secret；400 → 錯誤留在 dialog", async () => {
    const server = fakeServer([]);
    let reject = true;
    server.on((method, url) => {
      if (method !== "POST" || url !== "/api/admin/auth/providers") return null;
      if (reject) return fakeResponse(400, { error: { code: "invalid_body", message: "issuer 網址必須以小寫 http:// 或 https:// 開頭" } });
      return fakeResponse(201, { ...LIVE, enabled: false });
    });
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "c" } });
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "  s3cret  " } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    await waitFor(() => expect(dialog.getByRole("alert")).toHaveTextContent("The request was malformed."));
    reject = false;
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    const steps = within(await screen.findByRole("dialog", { name: "Finish setting it up" }));
    expect(steps.queryByText(/paste it here with Edit/)).toBeNull();
    const posts = server.calls.filter(c => c.method === "POST" && c.url === "/api/admin/auth/providers");
    expect((posts[1]!.body as { clientSecret?: string }).clientSecret).toBe("  s3cret  ");
  });

  it("欄位檢查與 server 對齊：全空白顯示名、大寫 HTTPS://、41 個 emoji → 欄位旁錯誤不送出；30 個 emoji（UTF-16 60）可送出；設定步驟標題取得焦點", async () => {
    const server = fakeServer([]);
    const created: AdminAuthProviderDto = { ...LIVE, enabled: false, hasSecret: false };
    server.on((method, url) => {
      if (method !== "POST" || url !== "/api/admin/auth/providers") return null;
      server.state.providers = [created];
      return fakeResponse(201, created);
    });
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Template"), { target: { value: "oidc" } });
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "   " } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "HTTPS://idp.example.com" } });
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "c" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect(await dialog.findByText("Enter a display name.")).toBeInTheDocument();
    expect(dialog.getByText("Issuer URL must start with lowercase http:// or https://.")).toBeInTheDocument();
    expect(dialog.getByLabelText("Issuer URL")).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "😀".repeat(41) } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://idp.example.com" } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect(await dialog.findByText("Display name can be at most 40 characters.")).toBeInTheDocument();
    expect(dialog.queryByText(/Issuer URL must start/)).toBeNull();
    expect(server.calls.some(c => c.method === "POST")).toBe(false);

    const emojiName = "😀".repeat(30);
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: emojiName } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    await screen.findByRole("dialog", { name: "Finish setting it up" });
    expect((server.calls.find(c => c.method === "POST")!.body as { displayName: string }).displayName).toBe(emojiName);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Finish setting it up" })).toHaveFocus());
  });

  it("secret 只有空白 → 欄位旁錯誤、不送出（不默默丟掉）", async () => {
    const server = fakeServer([]);
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "c" } });
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "   " } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect(await dialog.findByText("Client secret can't be only spaces.")).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "POST")).toBe(false);
  });
});

describe("編輯登入服務 dialog（#187 §9.4、§5.2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function openEdit() {
    // 登入服務是以顯示名為名的資料列（spec 2026-10-13 settings-table §3 #4）；Edit 與開關都在這一列。
    const row = within(await screen.findByRole("row", { name: "Corp SSO" }));
    fireEvent.click(row.getByRole("button", { name: "Edit" }));
    return { row, dialog: within(await screen.findByRole("dialog", { name: "Edit sign-in service" })) };
  }

  it("編輯：點對話框外面不關閉、已改內容仍在（表單型守衛）", async () => {
    renderSection(fakeServer([LIVE]).fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Edited name" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Edit sign-in service" })).toBeInTheDocument();
    expect(dialog.getByLabelText("Display name")).toHaveValue("Edited name");
  });

  it("RF5 只改顯示名：不出現警示；PATCH body 只有 displayName（不帶原 issuer、沒有 clientSecret 鍵）；secret 欄是唯寫（空白＋已儲存提示）", async () => {
    const server = fakeServer([LIVE]);
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LIVE.id}`) return null;
      server.state.providers = [{ ...LIVE, ...(body as object) }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    const secret = dialog.getByLabelText("Client secret");
    expect(secret).toHaveValue("");
    expect(secret).toHaveAttribute("type", "password");
    expect(secret).toHaveAttribute("placeholder", "Saved. Leave blank to keep it.");
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Corp SSO 2" } });
    expect(dialog.queryByText(/Changing the issuer/)).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // fix round 1 I1：只送改過的欄位——帶著舊 issuer 送出，並發時會被 §5.2 當成「改 issuer」而把別人的改動蓋回去。
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ displayName: "Corp SSO 2" });
  });

  it("舊資料 issuer 帶帳密、編輯時沒動 issuer → 不擋，PATCH 只送改過的欄位", async () => {
    const legacy = { ...LIVE, issuerUrl: "https://user:pass@idp.example.com" };
    const server = fakeServer([legacy]);
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LIVE.id}`) return null;
      server.state.providers = [{ ...legacy, ...(body as object) }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Corp SSO 2" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ displayName: "Corp SSO 2" });
  });

  it("編輯時把 issuer 改成帶帳密 → 欄位錯誤、不發 PATCH", async () => {
    const server = fakeServer([LIVE]);
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://user:pass@idp.example.com" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await dialog.findByText("Issuer URL can't contain a username or password.")).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
  });

  it("什麼都沒改就按儲存 → 不發請求、dialog 關閉", async () => {
    const server = fakeServer([LIVE]);
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
  });

  it("baseline issuer 帶尾端空白（env 匯入）：什麼都沒改 → 無警示、不發請求；只改顯示名 → body 只有 {displayName}", async () => {
    const PADDED = { ...LIVE, issuerUrl: "https://idp.example/ " };
    const server = fakeServer([PADDED]);
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LIVE.id}`) return null;
      server.state.providers = [{ ...PADDED, ...(body as object) }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const first = await openEdit();
    expect(first.dialog.getByLabelText("Issuer URL")).toHaveValue("https://idp.example/ ");
    expect(first.dialog.queryByText(/Changing the issuer/)).toBeNull();
    fireEvent.click(first.dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);

    const second = await openEdit();
    fireEvent.change(second.dialog.getByLabelText("Display name"), { target: { value: "Corp SSO 2" } });
    expect(second.dialog.queryByText(/Changing the issuer/)).toBeNull();
    fireEvent.click(second.dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.filter(c => c.method === "PATCH").map(c => c.body)).toEqual([{ displayName: "Corp SSO 2" }]);
  });

  it("打了 secret → 按 Esc 關閉 → 重開時 secret 欄是空的", async () => {
    renderSection(fakeServer([LIVE]).fetchMock);
    const first = await openEdit();
    fireEvent.change(first.dialog.getByLabelText("Client secret"), { target: { value: "typed-secret" } });
    fireEvent.keyDown(first.dialog.getByLabelText("Client secret"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const second = await openEdit();
    expect(second.dialog.getByLabelText("Client secret")).toHaveValue("");
  });

  it("secret 只有空白 → 欄位旁錯誤、不送出（不默默丟掉）", async () => {
    const server = fakeServer([LIVE]);
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "   " } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await dialog.findByText("Client secret can't be only spaces.")).toBeInTheDocument();
    expect(dialog.getByLabelText("Client secret")).toHaveAttribute("aria-invalid", "true");
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
  });

  it("停用中的服務改 issuer：只說會清 secret、不說會停用；同時填了 secret → 不警示", async () => {
    renderSection(fakeServer([{ ...LIVE, enabled: false }]).fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://other.example.com" } });
    expect(dialog.getByText("Changing the issuer clears the saved client secret.")).toBeInTheDocument();
    expect(dialog.queryByText(/turns this service off/)).toBeNull();
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "new-secret" } });
    expect(dialog.queryByText(/Changing the issuer/)).toBeNull();
  });

  it("改 issuer：secret 留空 → 「會清 secret 並停用」；填了 secret → 「會停用」；送出後回 enabled=false → 開關跟著關、toast", async () => {
    const server = fakeServer([LIVE]);
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LIVE.id}`) return null;
      server.state.providers = [{ ...LIVE, issuerUrl: (body as { issuerUrl: string }).issuerUrl, enabled: false, issuerResolved: false }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const { row, dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://other.example.com" } });
    expect(dialog.getByText("Changing the issuer clears the saved client secret and turns this service off.")).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "new-secret" } });
    expect(dialog.getByText("Changing the issuer turns this service off. Test it, then turn it back on.")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(row.getByRole("switch", { name: `Enabled ${LIVE.displayName}` })).toHaveAttribute("aria-checked", "false"));
    expect(screen.getByText("This sign-in service was turned off.")).toBeInTheDocument();
    expect((server.calls.find(c => c.method === "PATCH")!.body as { clientSecret?: string }).clientSecret).toBe("new-secret");
  });

  it("顯示順序不是 0 以上整數 → 不送出、顯示錯誤", async () => {
    const server = fakeServer([LIVE]);
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Display order"), { target: { value: "-1" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await dialog.findByText("Display order must be a whole number from 0 to 100000.")).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
  });

  it("顯示順序上限 100000（同 server）：100001 → 不送出、顯示錯誤；100000 → PATCH {sortOrder:100000}", async () => {
    const server = fakeServer([LIVE]);
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${LIVE.id}`) return null;
      server.state.providers = [{ ...LIVE, ...(body as object) }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const { dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Display order"), { target: { value: "100001" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await dialog.findByText("Display order must be a whole number from 0 to 100000.")).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
    fireEvent.change(dialog.getByLabelText("Display order"), { target: { value: "100000" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ sortOrder: 100000 });
  });

  it("顯示名是 HTML 形：編輯 dialog 只把它放進輸入框的值（字面）、不成為元素", async () => {
    const htmlName = "<b>Corp</b> & Co";
    renderSection(fakeServer([{ ...LIVE, displayName: htmlName }]).fetchMock);
    const row = within(await screen.findByRole("row", { name: htmlName }));
    fireEvent.click(row.getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    expect(dialog.getByLabelText("Display name")).toHaveValue(htmlName);
    expect(document.querySelector("b")).toBeNull();
  });
});

const HINT_EN =
  "Optional for now. Some identity providers, such as GitLab, give you a client ID only after you register a callback URL — you'll see this service's callback URL once it's added.";
const CLIENT_ID_STEP_EN = "Copy its client ID (GitLab calls it Application ID), then enter it here with Edit.";

describe("client ID 選填（#299）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function serverCreating(dto: AdminAuthProviderDto) {
    const server = fakeServer([]);
    server.on((method, url) => {
      if (method !== "POST" || url !== "/api/admin/auth/providers") return null;
      server.state.providers = [dto];
      return fakeResponse(201, dto);
    });
    return server;
  }
  const NEW_DTO: AdminAuthProviderDto = { ...LIVE, id: "55555555-5555-4555-8555-555555555555", enabled: false, issuerResolved: false };

  it("W1 client ID 留空送出 → POST body 沒有 clientId 鍵；設定步驟依序 callback、scopes、client、clientId、secret、finish，callback URL 與複製鈕照舊", async () => {
    const created = { ...NEW_DTO, clientId: null, hasSecret: false };
    const server = serverCreating(created);
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    const steps = within(await screen.findByRole("dialog", { name: "Finish setting it up" }));
    const post = server.calls.find(c => c.method === "POST" && c.url === "/api/admin/auth/providers")!;
    expect(post.body).not.toHaveProperty("clientId");
    const items = steps.getAllByRole("listitem").map(li => li.textContent ?? "");
    expect(items).toHaveLength(6);
    expect(items[0]).toContain("Register this callback URL:");
    expect(items[0]).toContain(created.callbackUrl);
    expect(items[1]).toContain("Allow the scopes openid, email and profile.");
    expect(items[2]).toContain("confidential client");
    expect(items[3]).toBe(CLIENT_ID_STEP_EN);
    expect(items[4]).toContain("paste it here with Edit");
    expect(items[5]).toContain("press Test connection");
    fireEvent.click(steps.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith(created.callbackUrl));
  });

  it("W2 client ID 填 \"  abc  \" → body clientId 為 \"abc\"；server 回有 client ID 的 DTO → 沒有 clientId 那一步", async () => {
    const server = serverCreating({ ...NEW_DTO, clientId: "abc", hasSecret: false });
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "  abc  " } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    const steps = within(await screen.findByRole("dialog", { name: "Finish setting it up" }));
    expect(server.calls.find(c => c.method === "POST" && c.url === "/api/admin/auth/providers")!.body).toMatchObject({ clientId: "abc" });
    const items = steps.getAllByRole("listitem").map(li => li.textContent ?? "");
    expect(items).toHaveLength(5);
    expect(items.some(text => text === CLIENT_ID_STEP_EN)).toBe(false);
  });

  it("W3 (a) 新增的 client ID 輸入框：說明文字接在 aria-describedby、沒有 aria-required", async () => {
    renderSection(fakeServer([]).fetchMock);
    const dialog = await openCreate();
    const input = dialog.getByLabelText("Client ID");
    expect(input).toHaveAccessibleDescription(HINT_EN);
    expect(input).not.toHaveAttribute("aria-required");
  });

  it("W3 (b) client ID 超過 512 字 → 欄位錯誤、不送出；輸入框的描述同時含錯誤與說明", async () => {
    const server = fakeServer([]);
    renderSection(server.fetchMock);
    const dialog = await openCreate();
    const input = dialog.getByLabelText("Client ID");
    fireEvent.change(input, { target: { value: "x".repeat(513) } });
    fireEvent.click(dialog.getByRole("button", { name: "Add" }));
    expect(await dialog.findByText("Client ID can be at most 512 characters.")).toBeInTheDocument();
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription(expect.stringContaining("Client ID can be at most 512 characters."));
    expect(input).toHaveAccessibleDescription(expect.stringContaining(HINT_EN));
    expect(server.calls.some(c => c.method === "POST")).toBe(false);
  });

  async function openEditOf(provider: AdminAuthProviderDto) {
    const server = fakeServer([provider]);
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== `/api/admin/auth/providers/${provider.id}`) return null;
      server.state.providers = [{ ...provider, ...(body as object) }];
      return fakeResponse(200, server.state.providers[0]);
    });
    renderSection(server.fetchMock);
    const row = within(await screen.findByRole("row", { name: provider.displayName }));
    fireEvent.click(row.getByRole("button", { name: "Edit" }));
    return { server, dialog: within(await screen.findByRole("dialog", { name: "Edit sign-in service" })) };
  }
  const NO_ID: AdminAuthProviderDto = { ...LIVE, clientId: null, enabled: false, hasSecret: false };

  it("W4 沒有 client ID 的服務：什麼都不改按儲存 → 不發請求；沒有 aria-required", async () => {
    const { server, dialog } = await openEditOf(NO_ID);
    expect(dialog.getByLabelText("Client ID")).toHaveValue("");
    expect(dialog.getByLabelText("Client ID")).not.toHaveAttribute("aria-required");
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
  });

  it("W4 沒有 client ID 的服務：欄位只打空白並改顯示名 → PATCH body 只有 displayName", async () => {
    const { server, dialog } = await openEditOf(NO_ID);
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "   " } });
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Corp SSO 2" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ displayName: "Corp SSO 2" });
  });

  it("W4 沒有 client ID 的服務：填 \"x\" → PATCH body 為 {clientId:\"x\"}", async () => {
    const { server, dialog } = await openEditOf(NO_ID);
    fireEvent.change(dialog.getByLabelText("Client ID"), { target: { value: "x" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.calls.find(c => c.method === "PATCH")!.body).toEqual({ clientId: "x" });
  });

  it("W5 有 client ID 的服務把欄位清空 → 欄位錯誤「Enter a client ID.」、不發請求；輸入框有 aria-required", async () => {
    const { server, dialog } = await openEditOf(LIVE);
    const input = dialog.getByLabelText("Client ID");
    expect(input).toHaveAttribute("aria-required", "true");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    expect(await dialog.findByText("Enter a client ID.")).toBeInTheDocument();
    expect(server.calls.some(c => c.method === "PATCH")).toBe(false);
  });
});

describe("改 issuer 的自動建帳確認框（PR-C C-14）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const PATH = `/api/admin/auth/providers/${LIVE.id}`;
  const NEW_ISSUER = "https://other.example.com";
  const CONFIRM_TITLE = "Keep creating accounts after changing the issuer?";

  /** PATCH 成功：把 body 合進服務並回 DTO。 */
  function patchOk(server: ReturnType<typeof fakeServer>, base: AdminAuthProviderDto): void {
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== PATH) return null;
      server.state.providers = [{ ...base, ...(body as Partial<AdminAuthProviderDto>) }];
      return fakeResponse(200, server.state.providers[0]);
    });
  }

  async function openEditChangeIssuer(opts: { rename?: boolean } = {}) {
    const row = within(await screen.findByRole("row", { name: "Corp SSO" }));
    fireEvent.click(row.getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    if (opts.rename === true) fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Renamed" } });
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: NEW_ISSUER } });
    return { row, dialog };
  }
  const patches = (server: ReturnType<typeof fakeServer>) => server.calls.filter(c => c.method === "PATCH");
  const confirmDialog = async () => within(await screen.findByRole("dialog", { name: CONFIRM_TITLE }));

  it("K1 開關開著、改 issuer 並同時改顯示名 → Save 跳確認框（說明用改前的名稱），尚未送 PATCH", async () => {
    const server = fakeServer([AUTO]);
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer({ rename: true });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    const confirm = await confirmDialog();
    expect(confirm.getByText(/Corp SSO creates accounts on first sign-in\./)).toBeInTheDocument();
    expect(confirm.getByText(/Turn it off unless only your people can sign in there\./)).toBeInTheDocument();
    expect(patches(server)).toHaveLength(0);
  });

  // 「確認框消失」由 K7 守（失敗路徑只剩編輯對話框）；這裡成功後整組 dialog 都關，斷言不到確認框單獨消失。
  it("K2 「Turn off and save」→ 恰一個 PATCH 帶 autoCreateEnabled:false；成功後編輯對話框關閉", async () => {
    const server = fakeServer([AUTO]);
    patchOk(server, AUTO);
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer({ rename: true });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    fireEvent.click((await confirmDialog()).getByRole("button", { name: "Turn off and save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patches(server)).toHaveLength(1);
    expect(patches(server)[0]!.body).toEqual({ displayName: "Renamed", issuerUrl: NEW_ISSUER, autoCreateEnabled: false });
  });

  it("K3 「Keep on and save」→ PATCH 的 autoCreateEnabled 為 true", async () => {
    const server = fakeServer([AUTO]);
    patchOk(server, AUTO);
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer({ rename: true });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    fireEvent.click((await confirmDialog()).getByRole("button", { name: "Keep on and save" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(patches(server)[0]!.body).toEqual({ displayName: "Renamed", issuerUrl: NEW_ISSUER, autoCreateEnabled: true });
  });

  it("K4 「Cancel」→ 零個 PATCH；確認框消失；編輯對話框仍開著、Issuer URL 欄的值保留", async () => {
    const server = fakeServer([AUTO]);
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    fireEvent.click((await confirmDialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONFIRM_TITLE })).not.toBeInTheDocument());
    const edit = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    expect(edit.getByLabelText("Issuer URL")).toHaveValue(NEW_ISSUER);
    expect(patches(server)).toHaveLength(0);
  });

  it("K4b 「Cancel」關閉確認框後，焦點在編輯對話框的 Issuer URL 欄", async () => {
    const server = fakeServer([AUTO]);
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    fireEvent.click((await confirmDialog()).getByRole("button", { name: "Cancel" }));
    const edit = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    await waitFor(() => expect(edit.getByLabelText("Issuer URL")).toHaveFocus());
  });

  it("K5 開關開著、只改顯示名 → 不跳確認框；body 沒有 autoCreateEnabled 鍵", async () => {
    const server = fakeServer([AUTO]);
    patchOk(server, AUTO);
    renderSection(server.fetchMock);
    const row = within(await screen.findByRole("row", { name: "Corp SSO" }));
    fireEvent.click(row.getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    fireEvent.change(dialog.getByLabelText("Display name"), { target: { value: "Renamed" } });
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: CONFIRM_TITLE })).not.toBeInTheDocument();
    expect(patches(server)[0]!.body).toEqual({ displayName: "Renamed" });
  });

  it("K6 開關本來關、改 issuer → 不跳確認框；body 明帶 autoCreateEnabled:false", async () => {
    const server = fakeServer([LIVE]);
    patchOk(server, LIVE);
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches(server)).toHaveLength(1));
    expect(screen.queryByRole("dialog", { name: CONFIRM_TITLE })).not.toBeInTheDocument();
    expect(patches(server)[0]!.body).toEqual({ issuerUrl: NEW_ISSUER, autoCreateEnabled: false });
  });

  it("K7 儲存失敗（409）→ 確認框已消失；錯誤顯示在編輯對話框的 alert；Issuer URL 欄的值仍在", async () => {
    const server = fakeServer([AUTO]);
    server.on((method, url) =>
      method === "PATCH" && url === PATH ? fakeResponse(409, { error: { code: "provider_secret_missing", message: "x" } }) : null,
    );
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    fireEvent.click((await confirmDialog()).getByRole("button", { name: "Turn off and save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: CONFIRM_TITLE })).not.toBeInTheDocument());
    const edit = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    await waitFor(() => expect(edit.getByRole("alert")).toHaveTextContent("Enter a client secret before turning this sign-in service on."));
    expect(edit.getByLabelText("Issuer URL")).toHaveValue(NEW_ISSUER);
  });

  it("K8 送出中：編輯對話框的儲存鈕顯示「Saving…」並 disabled，再點不會多送；resolve 後 PATCH 恰一個", async () => {
    const server = fakeServer([AUTO]);
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    server.on((method, url, body) => {
      if (method !== "PATCH" || url !== PATH) return null;
      return gate.then(() => {
        server.state.providers = [{ ...AUTO, ...(body as Partial<AdminAuthProviderDto>) }];
        return fakeResponse(200, server.state.providers[0]);
      });
    });
    renderSection(server.fetchMock);
    const { dialog } = await openEditChangeIssuer();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    fireEvent.click((await confirmDialog()).getByRole("button", { name: "Keep on and save" }));
    const saving = await screen.findByRole("button", { name: "Saving…" });
    expect(saving).toBeDisabled();
    fireEvent.click(saving);
    release();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(patches(server)).toHaveLength(1);
  });
});
