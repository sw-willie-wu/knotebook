import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { PendingLinkDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

interface Call { method: string; url: string; body: unknown }

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}
const err = (status: number, code: string, extra: Record<string, unknown> = {}) => fakeResponse(status, { error: { code, message: "x" }, ...extra });

const PENDING: PendingLinkDto = {
  pendingId: "pid-1",
  email: "u@example.com",
  providerDisplayName: "Corp IdP",
  methods: { password: true, providers: [{ id: "11111111-1111-1111-1111-111111111111", displayName: "GitLab" }] },
};
const USER = { id: "u1", email: "u@example.com", handle: "u", displayName: "U", isAdmin: false, mustChangePassword: false, hasPassword: true };

/** 依「METHOD url」回應；沒列到的回 404 JSON（不 throw——導向後的頁面可能打別的 API）。 */
function mockFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: Call[] = [];
  const fn = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url = String(input);
    calls.push({ method, url, body: init?.body !== undefined ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${url}`];
    return Promise.resolve(handler ? handler() : err(404, "not_found"));
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{`${location.pathname}${location.search}`}</div>;
}

function renderAt(path: string): QueryClient {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}
const loc = () => screen.getByTestId("loc").textContent;
/** `button.tsx` 的實心變體（default／destructive／brandSolid／brandDeep）的底色 class——同 `SettingsGroupRolesSection.test.tsx:143` 的判法。 */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
/** errors.oidc_link_expired 的英文（Task 1）。LoginPage 掛載時會以 replace 把 ?error= 從網址清掉，所以「導到 /login?error=…」
 * 只能用「登入頁顯示了這則文案、網址最後是 /login」來斷言（gate r1 t8-13 I2）。 */
const LINK_EXPIRED_TEXT = "This linking request has expired or was replaced. Please sign in again.";

describe("LinkAccountPage（#187 §9.4 /link-account）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("顯示 email 與 provider 名；methods 決定密碼欄與 SSO 鈕；一顆實心鈕（密碼確認）", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account");
    expect(await screen.findByText(/This email \(u@example\.com\) already has an account/)).toBeInTheDocument();
    expect(screen.getByText(/Corp IdP/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password for this account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm with password and link" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm by signing in with GitLab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    // 一個畫面至多一顆實心鈕（button.tsx 檔頭規範；gate r1 t8-13 M4）：只有密碼確認是實心，SSO 與取消是 outline。
    const solid = screen.getAllByRole("button").filter(b => SOLID_BG.test(b.className));
    expect(solid.map(b => b.textContent)).toEqual(["Confirm with password and link"]);
  });

  it("methods.password=false → 沒有密碼欄，只有 SSO 鈕", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, { ...PENDING, methods: { password: false, providers: PENDING.methods.providers } }) });
    renderAt("/link-account");
    await screen.findByRole("button", { name: "Confirm by signing in with GitLab" });
    expect(screen.queryByLabelText("Password for this account")).not.toBeInTheDocument();
  });

  it("密碼送出：body 帶 password 與 pendingId；成功寫 ['me'] 並導向**回應的** next（不讀網址參數）", async () => {
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => fakeResponse(200, { user: USER, next: "/change-password" }),
      "GET /api/auth/me": () => fakeResponse(200, USER),
    });
    const qc = renderAt("/link-account?next=%2Fevil");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "pw-123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    await waitFor(() => expect(loc()).toBe("/change-password"));
    expect(calls.find(c => c.url === "/api/auth/oidc/pending/confirm")!.body).toEqual({ password: "pw-123456789012", pendingId: "pid-1" });
    expect(qc.getQueryData(["me"])).toEqual(USER);
  });

  it("錯密碼 → alert 顯示 invalid_credentials 文案、留在本頁；429 too_many_attempts → 附等待秒數", async () => {
    let n = 0;
    mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => (++n === 1 ? err(401, "invalid_credentials") : err(429, "too_many_attempts", { retryAfterMs: 4200 })),
    });
    renderAt("/link-account");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect email or password.");
    expect(loc()).toBe("/link-account");
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try again in 5s."));
  });

  it("confirm 回 409 oidc_link_expired → 導 /login?error=oidc_link_expired（登入頁顯示該文案、網址的 error 隨後被清掉）", async () => {
    mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => err(409, "oidc_link_expired"),
      "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true } }),
    });
    renderAt("/link-account");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "pw-123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(LINK_EXPIRED_TEXT);
    await waitFor(() => expect(loc()).toBe("/login"));
  });

  it("SSO 鈕 → POST prove/<id> 帶 pendingId，回 {url} 後整頁導過去", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/prove/11111111-1111-1111-1111-111111111111": () => fakeResponse(200, { url: "https://gitlab.example/authorize?x=1" }),
    });
    renderAt("/link-account");
    fireEvent.click(await screen.findByRole("button", { name: "Confirm by signing in with GitLab" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://gitlab.example/authorize?x=1"));
    expect(calls.find(c => c.url.includes("/prove/"))!.body).toEqual({ pendingId: "pid-1" });
  });

  it("取消 → POST cancel、toast 說明、導 /login", async () => {
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/cancel": () => fakeResponse(204),
      "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true } }),
    });
    renderAt("/link-account");
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(loc()).toBe("/login"));
    expect(calls.some(c => c.method === "POST" && c.url === "/api/auth/oidc/pending/cancel")).toBe(true);
    expect(await screen.findByText(/This email is already in use/)).toBeInTheDocument();
  });

  it("沒有可用證明方式（409 oidc_link_no_proof_method）→ 只顯示說明與「回登入頁」", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => err(409, "oidc_link_no_proof_method") });
    renderAt("/link-account");
    expect(await screen.findByText(/has no way to prove it's yours right now/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to sign in" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Password for this account")).not.toBeInTheDocument();
  });

  it("?error=oidc_link_proof_mismatch → 顯示該文案、網址的 error 被清掉；不在白名單的碼 → fallback", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account?error=oidc_link_proof_mismatch");
    expect(await screen.findByRole("alert")).toHaveTextContent("The identity you signed in with isn't one already linked to this account.");
    await waitFor(() => expect(loc()).toBe("/link-account"));
  });

  it("?error=constructor（不在白名單）→ fallback 文案、不炸", async () => {
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING) });
    renderAt("/link-account?error=constructor");
    expect(await screen.findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
  });

  it("RF5：沒有 pending（401）→ 安靜導 /login、不送任何 confirm；帶著 ?error=oidc_link_expired 時一起轉（r3-N6）", async () => {
    for (const [path, expectAlert] of [["/link-account", false], ["/link-account?error=oidc_link_expired", true]] as const) {
      const calls = mockFetch({
        "GET /api/auth/oidc/pending": () => err(401, "unauthorized"),
        "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true } }),
      });
      renderAt(path);
      expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
      if (expectAlert) {
        // 一起轉過去的 ?error= 由 LoginPage 顯示——網址上的 error 會被它以 replace 清掉，所以斷言文案（gate r1 t8-13 I2）。
        expect(await screen.findByRole("alert")).toHaveTextContent(LINK_EXPIRED_TEXT);
      } else {
        expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      }
      await waitFor(() => expect(loc()).toBe("/login"));
      expect(calls.some(c => c.method === "POST")).toBe(false);
      cleanup();
    }
  });

  it("RF3w：provider 已被刪（providerDisplayName null）→ 以通用名稱顯示；HTML 形的 provider 名渲染成字面", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    mockFetch({ "GET /api/auth/oidc/pending": () => fakeResponse(200, { ...PENDING, providerDisplayName: null, methods: { password: false, providers: [{ id: "22222222-2222-2222-2222-222222222222", displayName: evil }] } }) });
    renderAt("/link-account");
    expect(await screen.findByText(/To link this sign-in service to it/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Confirm by signing in with ${evil}` })).toBeInTheDocument();
    expect(document.querySelector("img[src='x']")).toBeNull();
  });

  it("fix r1 I1：GET pending 回 409 oidc_link_expired（帳號已刪／email 已改）→ 導 /login、登入頁顯示該文案，不停在 Loading", async () => {
    const calls = mockFetch({
      "GET /api/auth/oidc/pending": () => err(409, "oidc_link_expired"),
      "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true } }),
    });
    renderAt("/link-account");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(LINK_EXPIRED_TEXT);
    await waitFor(() => expect(loc()).toBe("/login"));
    expect(calls.some(c => c.method === "POST")).toBe(false);
  });

  it("fix r1 M-b：先密碼 429（附倒數）再按 SSO 且 prove 失敗 → 只顯示 prove 的錯誤，不殘留倒數", async () => {
    mockFetch({
      "GET /api/auth/oidc/pending": () => fakeResponse(200, PENDING),
      "POST /api/auth/oidc/pending/confirm": () => err(429, "too_many_attempts", { retryAfterMs: 4200 }),
      "POST /api/auth/oidc/pending/prove/11111111-1111-1111-1111-111111111111": () => err(503, "oidc_unavailable"),
    });
    renderAt("/link-account");
    fireEvent.change(await screen.findByLabelText("Password for this account"), { target: { value: "pw-123456789012" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm with password and link" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Try again in 5s."));
    fireEvent.click(screen.getByRole("button", { name: "Confirm by signing in with GitLab" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Single sign-on is unavailable right now."));
    expect(screen.getByRole("alert")).not.toHaveTextContent("Try again in");
  });

  it("fix r1 M-c：GET pending 遇到 401／409 以外的失敗（500、網路錯誤）→ 顯示通用錯誤與 outline 的「回登入頁」，不停在 Loading", async () => {
    for (const fail of [() => err(500, "internal"), () => Promise.reject(new TypeError("Failed to fetch"))]) {
      mockFetch({
        "GET /api/auth/oidc/pending": fail,
        "POST /api/auth/oidc/pending/cancel": () => fakeResponse(204),
        "GET /api/auth/config": () => fakeResponse(200, { providers: [], registration: { enabled: true } }),
      });
      renderAt("/link-account");
      expect(await screen.findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
      expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
      const back = screen.getByRole("button", { name: "Back to sign in" });
      expect(SOLID_BG.test(back.className)).toBe(false);
      fireEvent.click(back);
      await waitFor(() => expect(loc()).toBe("/login"));
      cleanup();
    }
  });
});
