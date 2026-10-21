import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { AuthConfigDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import RegisterPage from "./RegisterPage";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
/** 實心鈕的 class（比照 `LinkAccountPage.test.tsx:62` 的 `SOLID_BG`）。 */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
const USER: UserDto = { id: "u1", email: "new@example.com", handle: "new", displayName: "New", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };
const OPEN: AuthConfigDto = {
  providers: [{ id: "11111111-1111-4111-8111-111111111111", displayName: '<b>Corp</b> & "Co"', icon: null }],
  registration: { enabled: true, providerIds: ["11111111-1111-4111-8111-111111111111"] },
  passwordLogin: { enabled: true },
  autoVersionsEnabled: true,
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function setup(path: string, config: AuthConfigDto, opts: { me?: UserDto | null; register?: () => Response } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    if (url === "/api/auth/me") return opts.me ? fakeResponse(200, opts.me) : fakeResponse(401, { error: { code: "unauthorized", message: "x" } });
    if (url === "/api/auth/config") return fakeResponse(200, config);
    if (url === "/api/auth/register" && method === "POST") return (opts.register ?? (() => fakeResponse(201, USER)))();
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}
async function fillAndSubmit(values: { email: string; displayName?: string; password: string; confirm: string }) {
  fireEvent.change(await screen.findByLabelText("Email"), { target: { value: values.email } });
  if (values.displayName !== undefined) fireEvent.change(screen.getByLabelText("Display name (optional)"), { target: { value: values.displayName } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: values.password } });
  fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: values.confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Create account" }));
}

describe("RegisterPage（#187 §9.4、S2）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => vi.unstubAllGlobals());

  it("帳密表單＋每個 provider 一顆「Sign up with X」（同一端點，B10；HTML 形名稱渲染為字面）；恰一顆實心鈕", async () => {
    setup("/register", OPEN);
    const link = await screen.findByRole("link", { name: 'Sign up with <b>Corp</b> & "Co"' });
    expect(link.getAttribute("href")).toBe("/api/auth/oidc/login/11111111-1111-4111-8111-111111111111");
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Already have an account? Sign in" }).getAttribute("href")).toBe("/login");
    const solid = [...screen.getAllByRole("button"), ...screen.getAllByRole("link")].filter(el => SOLID_BG.test(el.className));
    expect(solid.map(el => el.textContent)).toEqual(["Create account"]);
  });

  it("送出成功 → POST {email, password, displayName}、導向 /", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: "new@example.com", displayName: "New", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(calls.find(c => c.url === "/api/auth/register")!.body).toEqual({ email: "new@example.com", password: "correct-horse-battery", displayName: "New" });
  });

  it("顯示名留白 → body 沒有 displayName 鍵（server 以 email local-part 代入）", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: "new@example.com", displayName: "   ", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(calls.some(c => c.url === "/api/auth/register")).toBe(true));
    expect(calls.find(c => c.url === "/api/auth/register")!.body).toEqual({ email: "new@example.com", password: "correct-horse-battery" });
  });

  it("帶合法 next → 成功後導過去、SSO 鈕轉交 next；不合法 next（/login）→ 落 /", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", OPEN);
    const link = await screen.findByRole("link", { name: /^Sign up with/ });
    expect(link.getAttribute("href")).toBe("/api/auth/oidc/login/11111111-1111-4111-8111-111111111111?next=%2Fn%2Falice%2Fx");
    await fillAndSubmit({ email: "new@example.com", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/n/alice/x"));
  });

  it("疑點 4 上限：email 超過 254 字元、顯示名超過 100 個 code point → 就地錯誤、不送出；恰 100 個 code point → 送出", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: `${"a".repeat(243)}@example.com`, password: "correct-horse-battery", confirm: "correct-horse-battery" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Email can be at most 254 characters.");
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ok@example.com" } });
    fireEvent.change(screen.getByLabelText("Display name (optional)"), { target: { value: "😀".repeat(101) } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Display name can be at most 100 characters.");
    expect(calls.some(c => c.url === "/api/auth/register")).toBe(false);
    // 恰 100 個 code point（200 個 UTF-16 單位）要送得出去——以 UTF-16 計會把 51–100 個 emoji 誤擋（gate r2 N1）。
    fireEvent.change(screen.getByLabelText("Display name (optional)"), { target: { value: "😀".repeat(100) } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    await waitFor(() => expect(calls.some(c => c.url === "/api/auth/register")).toBe(true));
    expect((calls.find(c => c.url === "/api/auth/register")!.body as { displayName: string }).displayName).toBe("😀".repeat(100));
  });

  it("兩次密碼不同、太短 → 就地錯誤、不送出", async () => {
    const { calls } = setup("/register", OPEN);
    await fillAndSubmit({ email: "a@example.com", password: "correct-horse-battery", confirm: "different-horse-battery" });
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    expect(calls.some(c => c.url === "/api/auth/register")).toBe(false);
  });

  it("409 email_taken → errors.email_taken 文案", async () => {
    setup("/register", OPEN, { register: () => fakeResponse(409, { error: { code: "email_taken", message: "x" } }) });
    await fillAndSubmit({ email: "taken@example.com", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("That email is already in use."));
  });

  it("RG4：帳密自助註冊關、沒有會建帳的服務 → 「目前不開放註冊」＋回登入；沒有表單、沒有 SSO 註冊鈕", async () => {
    const { queryClient } = setup("/register", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    // 等 config 確實落地再斷言「不存在」：載入中就會出現的元素不能當等待點（Task 10 教訓）。
    await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
    expect(await screen.findByText("This site isn't accepting new accounts right now.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
  });

  it("RG2：帳密登入有效值關、服務會建帳 → 沒有帳密表單、SSO 註冊鈕照常（B21）", async () => {
    setup("/register", { ...OPEN, passwordLogin: { enabled: false } });
    await screen.findByRole("link", { name: /^Sign up with/ });
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-hidden="true"].border-t')).toBeNull();
    expect(screen.queryByText("This site isn't accepting new accounts right now.")).not.toBeInTheDocument();
  });

  it("不合法 next（/login）→ 註冊成功後落 /（web 層 safeNextPath）", async () => {
    setup("/register?next=%2Flogin", OPEN);
    await fillAndSubmit({ email: "new@example.com", password: "correct-horse-battery", confirm: "correct-horse-battery" });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });

  it("已登入＋不合法 next（//evil.example）→ 導 /", async () => {
    setup("/register?next=%2F%2Fevil.example", OPEN, { me: USER });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });

  it("已登入＋合法 next → 導 next", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", OPEN, { me: USER });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/n\/alice\/x$/));
  });

  it("已登入者打開 /register → 導 /（r2-N7）", async () => {
    setup("/register", OPEN, { me: USER });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
  });
  describe("註冊入口（PR-C §3.8、C-15）", () => {
    const A = "11111111-1111-4111-8111-111111111111";
    const B = "22222222-2222-4222-8222-222222222222";
    const TWO_P: AuthConfigDto["providers"] = [
      { id: A, displayName: "A", icon: null },
      { id: B, displayName: "B", icon: null },
    ];
    const cfg = (enabled: boolean, passwordEnabled: boolean, providerIds: string[]): AuthConfigDto => ({
      providers: TWO_P,
      registration: { enabled, providerIds },
      passwordLogin: { enabled: passwordEnabled },
      autoVersionsEnabled: true,
    });
    const divider = () => document.querySelector('[aria-hidden="true"].border-t');

    it("RG1：帳密自助可用、providerIds [A] → 有表單；只有 Sign up with A；有分隔線", async () => {
      setup("/register", cfg(true, true, [A]));
      await screen.findByRole("link", { name: "Sign up with A" });
      expect(screen.getByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Sign up with B" })).not.toBeInTheDocument();
      expect(divider()).not.toBeNull();
    });
    it("RG3：帳密自助關、帳密開、providerIds [A] → 沒有表單；有 Sign up with A；沒有分隔線、沒有 closed", async () => {
      setup("/register", cfg(false, true, [A]));
      await screen.findByRole("link", { name: "Sign up with A" });
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(divider()).toBeNull();
      expect(screen.queryByText("This site isn't accepting new accounts right now.")).not.toBeInTheDocument();
    });
    it("RG5：帳密自助可用、providerIds [] → 有表單；沒有 Sign up with；沒有分隔線", async () => {
      const { queryClient } = setup("/register", cfg(true, true, []));
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("RG6（未載入）：config 永不回應 → 表單在；沒有 closed、沒有 Sign up with", async () => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        if (String(input) === "/api/auth/me") return Promise.resolve(fakeResponse(401, { error: { code: "unauthorized", message: "x" } }));
        return new Promise<Response>(() => {});
      }));
      render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter initialEntries={["/register"]}>
            <Routes><Route path="/register" element={<RegisterPage />} /></Routes>
          </MemoryRouter>
        </QueryClientProvider>,
      );
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByText("This site isn't accepting new accounts right now.")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    });
    it("RG7（N6）：沒有 providerIds 鍵 → 視同 []：有表單、沒有 Sign up with、不拋錯", async () => {
      const noKey = { providers: TWO_P, registration: { enabled: true }, passwordLogin: { enabled: true }, autoVersionsEnabled: true } as unknown as AuthConfigDto;
      const { queryClient } = setup("/register", noKey);
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toEqual(noKey));
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    });
  });

  it("provider-icon V2：「Sign up with X」鈕文字前有圖示；icon null 不渲染", async () => {
    setup("/register", {
      ...OPEN,
      providers: [
        { id: "11111111-1111-4111-8111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "gitlab" } },
        { id: "22222222-2222-4222-8222-222222222222", displayName: "Plain", icon: null },
      ],
      registration: { enabled: true, providerIds: ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] },
    });
    const gitlab = await screen.findByRole("link", { name: "Sign up with GitLab" });
    expect(gitlab.firstChild).toBe(gitlab.querySelector('[data-provider-icon="gitlab"]'));
    expect(gitlab.textContent).toBe("Sign up with GitLab");
    expect(screen.getByRole("link", { name: "Sign up with Plain" }).querySelector("[data-provider-icon]")).toBeNull();
  });
});

describe("邀請模式（#285 B-18）", () => {
  const KEY = "knotebook:invite-token";
  const TOKEN = "knbi_X";
  const EXPIRES_AT = "2026-10-30T08:00:00.000Z";
  const RG4: AuthConfigDto = { ...OPEN, registration: { enabled: false, providerIds: [] } };
  const RG3: AuthConfigDto = { ...OPEN, registration: { enabled: false, providerIds: [OPEN.providers[0]!.id] } };
  const fail = (status: number, code: string) => fakeResponse(status, { error: { code, message: "x" } });
  const PASSWORD = "correct-horse-battery";

  function FullProbe() {
    const location = useLocation();
    return <div data-testid="full">{`${location.pathname}${location.search}${location.hash}`}</div>;
  }
  let navigateFn: ((to: string) => void) | null = null;
  function NavCapture() {
    const navigate = useNavigate();
    navigateFn = (to) => navigate(to);
    return null;
  }

  interface Handlers {
    me?: () => Response;
    inspect?: () => Response;
    accept?: () => Response | Promise<Response>;
  }
  function setupInvite(path: string, handlers: Handlers = {}, opts: { cfg?: AuthConfigDto; queryClient?: QueryClient } = {}) {
    const cfg = opts.cfg ?? RG4;
    const state = { me: handlers.me ?? (() => fail(401, "unauthorized")) };
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
        if (url === "/api/auth/me") return state.me();
        if (url === "/api/auth/config") return fakeResponse(200, cfg);
        if (url === "/api/auth/invite/inspect" && method === "POST") return (handlers.inspect ?? (() => fakeResponse(200, { expiresAt: EXPIRES_AT })))();
        if (url === "/api/auth/invite/accept" && method === "POST") return (handlers.accept ?? (() => fakeResponse(201, USER)))();
        if (url === "/api/auth/logout" && method === "POST") return fakeResponse(204);
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    const queryClient = opts.queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(AUTH_CONFIG_QUERY_KEY, cfg);
    const tree = (p: string) => (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[p]}>
          <FullProbe />
          <NavCapture />
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const view = render(tree(path));
    return { calls, queryClient, state, view, tree };
  }
  type Call = { url: string; method: string; body: unknown };
  const inspectCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/invite/inspect");
  const acceptCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/invite/accept");
  const fullPath = () => screen.getByTestId("full").textContent;

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    navigateFn = null;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it.each([
    ["RG4 形", RG4],
    ["OPEN", OPEN],
    ["RG3 形", RG3],
  ])("V1 掛載（config＝%s）：fragment 被清、鍵寫入、inspect body、邀請表單；沒有 closed 文字與 SSO 鈕", async (_name, cfg) => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`, {}, { cfg });
    expect(await screen.findByRole("heading", { name: "Create an account" })).toBeInTheDocument();
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    await waitFor(() => expect(fullPath()).toBe("/register"));
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(screen.getByText(/^This invitation works once and expires .+\.$/)).toBeInTheDocument();
    expect(screen.getByLabelText("Display name (optional)")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Confirm password")).toBeInTheDocument();
    expect(screen.queryByText("This site isn't accepting new accounts right now.")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
  });

  it("V2 重新整理：鍵已存在、網址只有 /register → inspect 帶存的 token、出現表單", async () => {
    sessionStorage.setItem(KEY, TOKEN);
    const { calls } = setupInvite("/register");
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
  });

  it("V3 已登入：只有「請先登出」提示、不呼叫 inspect、鍵不存在；登出後出現表單並寫入鍵", async () => {
    sessionStorage.setItem(KEY, "stale");
    const { calls, state } = setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) });
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    expect(screen.getByText("You're signed in as new@example.com. Sign out to use this invitation.")).toBeInTheDocument();
    expect(inspectCalls(calls)).toHaveLength(0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    await waitFor(() => expect(fullPath()).toBe("/register"));

    state.me = () => fail(401, "unauthorized");
    fireEvent.click(signOut);
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(calls.some((c) => c.url === "/api/auth/logout" && c.method === "POST")).toBe(true);
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("V4 登出後重新整理：以 /register 重新渲染 → 仍是邀請表單，不是一般註冊頁", async () => {
    const first = setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) });
    const signOut = await screen.findByRole("button", { name: "Sign out" });
    first.state.me = () => fail(401, "unauthorized");
    fireEvent.click(signOut);
    await screen.findByLabelText("Email");
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    first.view.unmount();
    vi.unstubAllGlobals();
    // 卸載 cleanup 會刪鍵；整頁重新整理不會跑 cleanup，所以這裡補回「重新整理後鍵還在」的前提。
    sessionStorage.setItem(KEY, TOKEN);
    setupInvite("/register");
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText("This site isn't accepting new accounts right now.")).not.toBeInTheDocument();
  });

  it("V5 SPA 離開：表單出現後導到 /login → 鍵被刪", async () => {
    setupInvite(`/register#invite=${TOKEN}`);
    await screen.findByLabelText("Email");
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    act(() => navigateFn!("/login"));
    await waitFor(() => expect(fullPath()).toBe("/login"));
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("V6 inspect 410：invite_invalid 全文＋回登入、鍵被刪", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(410, "invite_invalid") });
    expect(await screen.findByText("This invitation is invalid, already used, revoked, or expired. Ask the site administrator for a new one.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("V6 inspect 403：passwordLoginOff 全文、沒有表單、鍵仍在", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(403, "password_login_disabled") });
    expect(await screen.findByText("Password sign-in is turned off on this site right now, so this invitation can't be used. Ask the site administrator.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("V6 inspect 403 但碼不是 password_login_disabled（如 Origin 失敗的 forbidden）→ 一般錯誤文字、不顯示帳密關閉、鍵仍在", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(403, "forbidden") });
    expect(await screen.findByText("You don't have permission to do that.")).toBeInTheDocument();
    expect(screen.queryByText(/Password sign-in is turned off/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("I-1 A 送出中 → 同頁換成 B → A 晚回 410：B 的表單仍在、storage 鍵仍是 B（舊 token 的 forget 不刪新鍵）", async () => {
    let resolveAccept: (r: Response) => void = () => {};
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => new Promise<Response>((resolve) => (resolveAccept = resolve)) });
    await fillAndSubmit({ email: "a@example.com", password: PASSWORD, confirm: PASSWORD });
    await waitFor(() => expect(screen.getByRole("button", { name: "Creating account…" })).toBeInTheDocument());
    act(() => navigateFn!("/register#invite=knbi_B"));
    await waitFor(() => expect(sessionStorage.getItem(KEY)).toBe("knbi_B"));
    expect(await screen.findByRole("button", { name: "Create account" })).toBeInTheDocument();
    await act(async () => {
      resolveAccept(fail(410, "invite_invalid"));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByText(/^This invitation is invalid/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe("knbi_B");
  });

  it("V6 inspect 429：too_many_requests 全文、沒有 invite_invalid 文字、鍵仍在", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(429, "too_many_requests") });
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
    expect(screen.queryByText(/This invitation is invalid/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("V7 /me 回 500：錯誤文字＋Try again、沒有 checking；改回 401 後重試 → 出現表單", async () => {
    const { state } = setupInvite(`/register#invite=${TOKEN}`, { me: () => fail(500, "internal") });
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.queryByText("Checking the invitation…")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again.");
    expect(screen.queryByText("Couldn't load your session.")).not.toBeInTheDocument();
    state.me = () => fail(401, "unauthorized");
    fireEvent.click(retry);
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
  });

  it("V7 /me 失敗但不是 ApiFail（網路錯誤）→ errors.fallback 全文＋Try again", async () => {
    setupInvite(`/register#invite=${TOKEN}`, {
      me: () => {
        throw new TypeError("network");
      },
    });
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("alert")).toHaveTextContent("An unexpected error occurred.");
    expect(screen.queryByText("Couldn't load your session.")).not.toBeInTheDocument();
  });

  it("n-3 非表單畫面（載入錯誤、已登入、失效、帳密關閉）都有 h1「Create an account」", async () => {
    const heading = () => screen.getByRole("heading", { level: 1, name: "Create an account" });
    const first = setupInvite(`/register#invite=${TOKEN}`, { me: () => fail(500, "internal") });
    await screen.findByRole("button", { name: "Try again" });
    heading();
    first.view.unmount();
    const second = setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) });
    await screen.findByRole("button", { name: "Sign out" });
    heading();
    second.view.unmount();
    const third = setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(410, "invite_invalid") });
    await screen.findByText(/^This invitation is invalid/);
    heading();
    third.view.unmount();
    setupInvite(`/register#invite=${TOKEN}`, { inspect: () => fail(403, "password_login_disabled") });
    await screen.findByText(/^Password sign-in is turned off/);
    heading();
  });

  it("I-1 一般註冊頁 → 同頁改成 #invite=（貼新連結）：進邀請模式、inspect 帶新 token、鍵為新 token、hash 清掉", async () => {
    const { calls } = setupInvite("/register");
    expect(await screen.findByText("This site isn't accepting new accounts right now.")).toBeInTheDocument();
    act(() => navigateFn!(`/register#invite=${TOKEN}`));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(inspectCalls(calls).map((c) => c.body)).toEqual([{ token: TOKEN }]);
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    await waitFor(() => expect(fullPath()).toBe("/register"));
    expect(screen.queryByText("This site isn't accepting new accounts right now.")).not.toBeInTheDocument();
  });

  it("I-1 邀請 A 回 410 → 同頁換成 #invite=B：B 被 inspect、出現表單、不再顯示 A 的失效、鍵為 B", async () => {
    let n = 0;
    const { calls } = setupInvite(`/register#invite=${TOKEN}`, {
      inspect: () => (++n === 1 ? fail(410, "invite_invalid") : fakeResponse(200, { expiresAt: EXPIRES_AT })),
    });
    expect(await screen.findByText(/^This invitation is invalid/)).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
    act(() => navigateFn!("/register#invite=knbi_B"));
    expect(await screen.findByLabelText("Email")).toBeInTheDocument();
    expect(inspectCalls(calls).map((c) => c.body)).toEqual([{ token: TOKEN }, { token: "knbi_B" }]);
    expect(screen.queryByText(/^This invitation is invalid/)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe("knbi_B");
    await waitFor(() => expect(fullPath()).toBe("/register"));
  });

  it("I-1 換 token 重置表單 state：A 的表單有錯誤 → 換成 B 後欄位是空的、沒有舊錯誤", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => fail(409, "email_taken") });
    await fillAndSubmit({ email: "taken@example.com", password: PASSWORD, confirm: PASSWORD });
    expect(await screen.findByRole("alert")).toHaveTextContent("That email is already in use.");
    act(() => navigateFn!("/register#invite=knbi_B"));
    await waitFor(() => expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(""));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("V8 成功：不理 ?next、導 /、session 快取＝回應、鍵被刪，過程中從未閃出「已登入」", async () => {
    const seen: string[] = [];
    // 收被加進來的節點文字與 characterData 的新文字：同一個 task 內「加上又拿掉」的閃現，body.textContent 在 callback
    // 時已看不到；React 原地改同位置 <p> 的文字則只產生 characterData，不是 addedNodes。
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) seen.push(node.textContent ?? "");
        if (record.type === "characterData") seen.push(record.target.textContent ?? "");
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    try {
      const { calls, queryClient } = setupInvite(`/register?next=%2Fn%2Fabc#invite=${TOKEN}`);
      await fillAndSubmit({ email: "new@example.com", password: PASSWORD, confirm: PASSWORD });
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
      expect(acceptCalls(calls)[0]!.body).toEqual({ token: TOKEN, email: "new@example.com", password: PASSWORD });
      expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toEqual(USER);
      expect(sessionStorage.getItem(KEY)).toBeNull();
      expect(seen.some((text) => text.includes("You're signed in as"))).toBe(false);
    } finally {
      observer.disconnect();
    }
  });

  it("V8 顯示名有填 → accept body 帶 displayName", async () => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`);
    await fillAndSubmit({ email: "new@example.com", displayName: "New", password: PASSWORD, confirm: PASSWORD });
    await waitFor(() => expect(acceptCalls(calls)).toHaveLength(1));
    expect(acceptCalls(calls)[0]!.body).toEqual({ token: TOKEN, email: "new@example.com", password: PASSWORD, displayName: "New" });
  });

  it("V9 accept 410：無效狀態、鍵被刪", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => fail(410, "invite_invalid") });
    await fillAndSubmit({ email: "new@example.com", password: PASSWORD, confirm: PASSWORD });
    expect(await screen.findByText(/^This invitation is invalid/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("V9 accept 409 email_taken：表單上方 alert、表單仍在、鍵仍在", async () => {
    setupInvite(`/register#invite=${TOKEN}`, { accept: () => fail(409, "email_taken") });
    await fillAndSubmit({ email: "taken@example.com", password: PASSWORD, confirm: PASSWORD });
    expect(await screen.findByRole("alert")).toHaveTextContent("That email is already in use.");
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("V10 客戶端檢查：密碼太短、不一致 → 就地錯誤、沒有 accept", async () => {
    const { calls } = setupInvite(`/register#invite=${TOKEN}`);
    await fillAndSubmit({ email: "a@example.com", password: "short", confirm: "short" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "different-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("The passwords don't match.")).toBeInTheDocument();
    expect(acceptCalls(calls)).toHaveLength(0);
  });

  it("V11 同步取得：session 快取已是已登入、第一次 render 就是已登入提示，沒有被導去 /", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(SESSION_QUERY_KEY, USER);
    setupInvite(`/register#invite=${TOKEN}`, { me: () => fakeResponse(200, USER) }, { queryClient });
    const SIGNED_IN = "You're signed in as new@example.com. Sign out to use this invitation.";
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    expect(fullPath()).not.toBe("/");
    // 本案（fragment 來源）守 M7（已登入先 Navigate）：router 的更新在 transition 裡，晚一步的導向要等它落地才看得到。
    // M6（token 晚到）在這裡殺不到（清 fragment 的 navigate 會把路徑蓋回來），由下一案（storage 來源）守。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    expect(fullPath()).toBe("/register");
  });

  it("V11 同步取得（storage 來源）：沒有 fragment、鍵已存在、session 快取已是已登入 → 不會被導去 /", async () => {
    // 守 M6（token 晚到、第一次 render 為 null 而先 Navigate("/")）：fragment 來源的案子會被「清 fragment 的 navigate」
    // 蓋掉晚一步的誤導向，這條沒有 fragment，沒有東西蓋。（M7 由上一案守。）
    sessionStorage.setItem(KEY, TOKEN);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(SESSION_QUERY_KEY, USER);
    setupInvite("/register", { me: () => fakeResponse(200, USER) }, { queryClient });
    const SIGNED_IN = "You're signed in as new@example.com. Sign out to use this invitation.";
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(screen.getByText(SIGNED_IN)).toBeInTheDocument();
    expect(fullPath()).toBe("/register");
  });

  it("V12 無 token（RG4 形）：一般註冊頁顯示 closed、沒有 inspect 請求", async () => {
    const { calls } = setupInvite("/register");
    expect(await screen.findByText("This site isn't accepting new accounts right now.")).toBeInTheDocument();
    expect(inspectCalls(calls)).toHaveLength(0);
  });

  it("V13 邀請表單頁恰一顆實心鈕（Create account）", async () => {
    setupInvite(`/register#invite=${TOKEN}`);
    await screen.findByLabelText("Email");
    const solid = [...screen.getAllByRole("button"), ...screen.queryAllByRole("link")].filter((el) => SOLID_BG.test(el.className));
    expect(solid.map((el) => el.textContent)).toEqual(["Create account"]);
  });
});

describe("密碼長度提示的字數來自 shared 常數", () => {
  // 註冊頁與改密碼表單共用這條文案；數字寫死會在常數改動後說謊。拿掉代建對話框後，這是它僅剩的守衛。
  it.each(["en", "zh-TW"])("%s：changePassword.passwordHint 以 {{min}} 插值", (language) => {
    expect(i18n.getResource(language, "translation", "changePassword.passwordHint")).toContain("{{min}}");
  });
});
