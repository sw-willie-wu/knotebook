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

const LIVE: AdminAuthProviderDto = {
  id: "33333333-3333-4333-8333-333333333333",
  template: "oidc",
  displayName: "Corp SSO",
  issuerUrl: "https://idp.example.com",
  clientId: "corp-client",
  hasSecret: true,
  enabled: true,
  sortOrder: 2,
  legacyCallback: false,
  callbackUrl: "https://notes.example.com/api/auth/oidc/callback/33333333-3333-4333-8333-333333333333",
  insecureIssuer: false,
  issuerResolved: true,
  createdAt: "2026-10-06T00:00:00.000Z",
};

type Handler = (method: string, url: string, body: unknown) => Response | null;
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
    const region = within(await screen.findByRole("region", { name: "Corp SSO" }));
    fireEvent.click(region.getByRole("button", { name: "Edit" }));
    return { region, dialog: within(await screen.findByRole("dialog", { name: "Edit sign-in service" })) };
  }

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
    const { region, dialog } = await openEdit();
    fireEvent.change(dialog.getByLabelText("Issuer URL"), { target: { value: "https://other.example.com" } });
    expect(dialog.getByText("Changing the issuer clears the saved client secret and turns this service off.")).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText("Client secret"), { target: { value: "new-secret" } });
    expect(dialog.getByText("Changing the issuer turns this service off. Test it, then turn it back on.")).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(region.getByRole("switch", { name: "On" })).toHaveAttribute("aria-checked", "false"));
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
    const region = within(await screen.findByRole("region", { name: htmlName }));
    fireEvent.click(region.getByRole("button", { name: "Edit" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Edit sign-in service" }));
    expect(dialog.getByLabelText("Display name")).toHaveValue(htmlName);
    expect(document.querySelector("b")).toBeNull();
  });
});
