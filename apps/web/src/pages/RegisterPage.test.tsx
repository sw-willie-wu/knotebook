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
const USER: UserDto = { id: "u1", email: "new@example.com", handle: "new", displayName: "New", isAdmin: false, mustChangePassword: false, hasPassword: true };
const OPEN: AuthConfigDto = {
  providers: [{ id: "11111111-1111-4111-8111-111111111111", displayName: '<b>Corp</b> & "Co"', icon: null }],
  registration: { enabled: true },
  passwordLogin: { enabled: true },
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

  it("「允許註冊」關 → 「目前不開放註冊」＋回登入；沒有表單、沒有 SSO 註冊鈕（W21）", async () => {
    const { queryClient } = setup("/register", { ...OPEN, registration: { enabled: false } });
    // 等 config 確實落地再斷言「不存在」：載入中就會出現的元素不能當等待點（Task 10 教訓）。
    await waitFor(() => expect(queryClient.getQueryData(AUTH_CONFIG_QUERY_KEY)).toBeDefined());
    expect(await screen.findByText("This site isn't accepting new accounts right now.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^Sign up with/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" }).getAttribute("href")).toBe("/login");
  });

  it("帳密登入有效值關 → 沒有帳密表單、SSO 註冊鈕照常（B21）", async () => {
    setup("/register", { ...OPEN, passwordLogin: { enabled: false } });
    await screen.findByRole("link", { name: /^Sign up with/ });
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create account" })).not.toBeInTheDocument();
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
  it("provider-icon V2：「Sign up with X」鈕文字前有圖示；icon null 不渲染", async () => {
    setup("/register", {
      ...OPEN,
      providers: [
        { id: "11111111-1111-4111-8111-111111111111", displayName: "GitLab", icon: { type: "builtin", name: "gitlab" } },
        { id: "22222222-2222-4222-8222-222222222222", displayName: "Plain", icon: null },
      ],
    });
    const gitlab = await screen.findByRole("link", { name: "Sign up with GitLab" });
    await waitFor(() => expect(gitlab.querySelector('[data-provider-icon="gitlab"]')).not.toBeNull());
    expect(gitlab.firstChild).toBe(gitlab.querySelector('[data-provider-icon="gitlab"]'));
    expect(gitlab.textContent).toBe("Sign up with GitLab");
    expect(screen.getByRole("link", { name: "Sign up with Plain" }).querySelector("[data-provider-icon]")).toBeNull();
  });
});
