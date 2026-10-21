import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { AuthConfigDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { AUTH_CONFIG_QUERY_KEY } from "@/api/authConfig";
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

  it("帳密表單；即使有會建帳的服務也沒有任何 SSO 註冊鈕或分隔線；恰一顆實心鈕", async () => {
    const { queryClient } = setup("/register", OPEN);
    // 表單在載入中就顯示，不能當等待點；等 config 落地再斷言「沒有 SSO 鈕」。
    await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
    expect(await screen.findByRole("button", { name: "Create account" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    expect(document.querySelector('[aria-hidden="true"].border-t')).toBeNull();
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

  it("帶合法 next → 成功後導過去、「Sign in」連結轉交 next", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", OPEN);
    const link = await screen.findByRole("link", { name: "Already have an account? Sign in" });
    expect(link.getAttribute("href")).toBe("/login?next=%2Fn%2Falice%2Fx");
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

  it("RG4：帳密自助註冊關 → 導回 /login；不顯示表單", async () => {
    setup("/register", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    // 等待點＝導向後的 LocationProbe（載入中先顯示表單，不能當等待點）。
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
  });

  it("RG4b：帶合法 next 的 /register 在帳密自助註冊不可用時 → 導回 /login?next=…", async () => {
    setup("/register?next=%2Fn%2Falice%2Fx", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login?next=%2Fn%2Falice%2Fx"));
  });

  it("RG4d：帳密自助註冊不可用＋不合法 next → 導到不帶 next 的 /login", async () => {
    setup("/register?next=%2F%2Fevil.example", { ...OPEN, registration: { enabled: false, providerIds: [] } });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toBe("/login"));
  });

  it("RG4c：config 讀取失敗（500）→ 不導走，照常顯示表單（server 是最終裁決）", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return fakeResponse(401, { error: { code: "unauthorized", message: "x" } });
      if (url === "/api/auth/config") return fakeResponse(500, { error: { code: "internal", message: "x" } });
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/register"]}>
          <Routes>
            <Route path="/register" element={<RegisterPage />} />
            <Route path="*" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(queryClient.getQueryState(AUTH_CONFIG_QUERY_KEY)?.status).toBe("error"));
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.queryByTestId("location")).not.toBeInTheDocument();
  });

  it("RG2：帳密登入有效值關、服務會建帳 → 導回 /login；沒有帳密表單、沒有 SSO 註冊鈕（B21）", async () => {
    setup("/register", { ...OPEN, passwordLogin: { enabled: false } });
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
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

    it("RG1：帳密自助可用、providerIds [A] → 有表單；沒有任何 Sign up with；沒有分隔線", async () => {
      const { queryClient } = setup("/register", cfg(true, true, [A]));
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("RG3：帳密自助關、帳密開、providerIds [A] → 導回 /login；沒有表單、沒有 Sign up with、沒有分隔線", async () => {
      setup("/register", cfg(false, true, [A]));
      await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/login"));
      expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("RG5：帳密自助可用、providerIds [] → 有表單；沒有 Sign up with；沒有分隔線", async () => {
      const { queryClient } = setup("/register", cfg(true, true, []));
      await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
      expect(await screen.findByLabelText("Email")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
      expect(divider()).toBeNull();
    });
    it("RG6（未載入）：config 永不回應 → 表單在（沒有導走）；沒有 Sign up with", async () => {
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
});
