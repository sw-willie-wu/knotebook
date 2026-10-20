import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { AppRoutes } from "@/App";
import ResetPasswordPage from "./ResetPasswordPage";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
const fail = (status: number, code: string) => fakeResponse(status, { error: { code, message: "x" } });

/** 實心鈕的 class（比照 `RegisterPage.test.tsx` 的 `SOLID_BG`）。 */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
const KEY = "knotebook:reset-token";
const TOKEN = "knbp_X";
const EXPIRES_AT = "2030-01-02T03:04:00.000Z";
const WHEN = new Date(EXPIRES_AT).toLocaleString("en", { dateStyle: "short", timeStyle: "short" });
const NEW_PASSWORD = "correct-horse-battery";
const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true };
const RESET_USER: UserDto = { id: "u-a", email: "a@example.com", handle: "a", displayName: "A", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };

const INVALID_TEXT = "This password reset link is invalid, already used, or expired. Ask the site administrator for a new one.";
const NOTICE_TEXT = "Setting it signs you out of every other browser. API tokens and connected apps keep working.";
const LOGIN_OFF_TEXT = "Password sign-in is turned off on this site right now, so this link can't be used. Ask the site administrator.";
const SIGNED_IN_TEXT = "You're signed in as me@example.com. Sign out to use this link.";
const TOO_MANY_TEXT = "Too many requests. Please slow down.";

/** 一直渲染在 `Routes` 旁邊：印 router 的 pathname＋search＋hash。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</div>;
}

let navigateFn: ((to: string) => void) | null = null;
function NavigateHandle() {
  const navigate = useNavigate();
  navigateFn = navigate;
  return null;
}

function Elsewhere() {
  return <p>elsewhere</p>;
}

interface Handlers {
  me?: () => Response;
  inspect?: () => Response;
  complete?: () => Response;
}

function stubFetch(handlers: Handlers) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url === "/api/auth/me") return (handlers.me ?? (() => fail(401, "unauthorized")))();
      if (url === "/api/auth/password-reset/inspect" && method === "POST") {
        return (handlers.inspect ?? (() => fakeResponse(200, { email: RESET_USER.email, expiresAt: EXPIRES_AT })))();
      }
      if (url === "/api/auth/password-reset" && method === "POST") return (handlers.complete ?? (() => fakeResponse(200, RESET_USER)))();
      if (url === "/api/auth/logout" && method === "POST") return fakeResponse(204);
      return fail(404, "not_found");
    }),
  );
  return calls;
}

function setup(path: string, handlers: Handlers = {}) {
  const calls = stubFetch(handlers);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="*" element={<Elsewhere />} />
        </Routes>
        <LocationProbe />
        <NavigateHandle />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient };
}

type Call = { url: string; method: string; body: unknown };
const inspectCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/password-reset/inspect");
const completeCalls = (calls: Call[]) => calls.filter((c) => c.url === "/api/auth/password-reset");
const tick = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });

async function submit(password: string, confirm: string) {
  fireEvent.change(await screen.findByLabelText("New password"), { target: { value: password } });
  fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: confirm } });
  fireEvent.click(screen.getByRole("button", { name: "Set password" }));
}

describe("ResetPasswordPage（#286 §5.2、A-16）", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    navigateFn = null;
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("P1 fragment 帶 token：router 的 hash 清掉、鍵寫入、inspect 帶 token、顯示帳號與到期、notice、兩個密碼欄", async () => {
    const { calls } = setup(`/reset-password#token=${TOKEN}`);
    expect(await screen.findByText(`For a@example.com. This link works once and expires ${WHEN}.`)).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(inspectCalls(calls)).toHaveLength(1);
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(screen.getByText(NOTICE_TEXT)).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("autocomplete", "new-password");
    expect(screen.getByLabelText("Confirm new password")).toHaveAttribute("type", "password");
  });

  it("P2 重新整理（沒有 fragment、鍵還在）→ inspect 帶存的 token、出現表單", async () => {
    sessionStorage.setItem(KEY, TOKEN);
    const { calls } = setup("/reset-password");
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
  });

  it("P3 沒有 fragment 也沒有鍵 → invalid 全文＋回登入連結，不打 inspect", async () => {
    const { calls } = setup("/reset-password");
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
    await tick();
    expect(inspectCalls(calls)).toHaveLength(0);
  });

  it("P3b `#token=` 空值 → 一樣清掉 fragment、invalid 全文、不打 inspect", async () => {
    const { calls } = setup("/reset-password#token=");
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/));
    await tick();
    expect(inspectCalls(calls)).toHaveLength(0);
  });

  it("P4 inspect 410 → invalid 全文，鍵被刪", async () => {
    setup(`/reset-password#token=${TOKEN}`, { inspect: () => fail(410, "reset_link_invalid") });
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to sign in" })).toHaveAttribute("href", "/login");
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("P5 inspect 403 password_login_disabled → passwordLoginOff 全文、沒有表單、鍵仍在（D2）", async () => {
    setup(`/reset-password#token=${TOKEN}`, { inspect: () => fail(403, "password_login_disabled") });
    expect(await screen.findByText(LOGIN_OFF_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });

  it("P6 已登入：只顯示 signedIn＋Sign out、不打 inspect、不寫鍵、hash 已清；登出後出現表單、鍵寫入", async () => {
    let me = () => fakeResponse(200, ME);
    const { calls } = setup(`/reset-password#token=${TOKEN}`, { me: () => me() });
    expect(await screen.findByText(SIGNED_IN_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    const signOut = screen.getByRole("button", { name: "Sign out" });
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
    await tick();
    expect(inspectCalls(calls)).toHaveLength(0);
    expect(sessionStorage.getItem(KEY)).toBeNull();
    expect(screen.queryByLabelText("New password")).toBeNull();

    me = () => fail(401, "unauthorized");
    fireEvent.click(signOut);
    await waitFor(() => expect(calls.some((c) => c.url === "/api/auth/logout" && c.method === "POST")).toBe(true));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls)[0]!.body).toEqual({ token: TOKEN });
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
  });

  it("P7 太短 → errors.password_too_short、不送；兩次不一致 → register.mismatch、不送", async () => {
    const { calls } = setup(`/reset-password#token=${TOKEN}`);
    await submit("short", "short");
    expect(await screen.findByRole("alert")).toHaveTextContent("Password is too short.");
    await submit(NEW_PASSWORD, `${NEW_PASSWORD}-x`);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The passwords don't match."));
    await tick();
    expect(completeCalls(calls)).toHaveLength(0);
  });

  it("P8 成功：完成請求 body 正確 → 導 /、session 快取寫入回應；寫入快取之前鍵已刪", async () => {
    const { calls, queryClient } = setup(`/reset-password#token=${TOKEN}`);
    // 鍵最後一定會被刪（已登入的 effect、卸載 cleanup 都會刪），所以看「寫入 session 快取的當下」鍵還在不在：
    // 成功路徑自己沒刪的話，那一刻鍵還在。這案釘的是 plan T5 規定的「刪鍵 → setQueryData」順序；spec §5.2-5
    // 沒有規定先後，照 spec 的列舉順序重排時這案會紅，是預期的。
    const keyAtSessionWrite: Array<string | null> = [];
    const setQueryData = queryClient.setQueryData.bind(queryClient);
    vi.spyOn(queryClient, "setQueryData").mockImplementation(((key: unknown, data: unknown) => {
      keyAtSessionWrite.push(sessionStorage.getItem(KEY));
      return setQueryData(key as never, data as never);
    }) as never);
    await submit(NEW_PASSWORD, NEW_PASSWORD);
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/$/));
    expect(completeCalls(calls)[0]!.body).toEqual({ token: TOKEN, newPassword: NEW_PASSWORD });
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toEqual(RESET_USER);
    expect(keyAtSessionWrite).toEqual([null]);
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("P9 完成回 429 → 表單上方 alert、鍵仍在；再送回 410 → invalid 全文、鍵被刪", async () => {
    let complete = () => fail(429, "too_many_requests");
    setup(`/reset-password#token=${TOKEN}`, { complete: () => complete() });
    await submit(NEW_PASSWORD, NEW_PASSWORD);
    expect(await screen.findByRole("alert")).toHaveTextContent(TOO_MANY_TEXT);
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);

    complete = () => fail(410, "reset_link_invalid");
    fireEvent.click(screen.getByRole("button", { name: "Set password" }));
    expect(await screen.findByText(INVALID_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("P10 表單出現後 SPA 導覽離開本頁 → 鍵被刪", async () => {
    setup(`/reset-password#token=${TOKEN}`);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
    act(() => navigateFn?.("/login"));
    expect(await screen.findByText("elsewhere")).toBeInTheDocument();
    expect(sessionStorage.getItem(KEY)).toBeNull();
  });

  it("P11 路由位置：AppRoutes 下未登入直接開 → 出現重設頁標題，沒有被導去 /login", async () => {
    stubFetch({});
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/reset-password#token=${TOKEN}`]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("heading", { name: "Set a new password" }, { timeout: 3_000 })).toBeInTheDocument();
    // 標題在每個狀態都有：再等到表單，確定走完 inspect、沒有被導去 /login。
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent(/^\/reset-password$/);
  });

  it("P12 表單畫面恰一顆實心鈕（Set password）", async () => {
    setup(`/reset-password#token=${TOKEN}`);
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    const solid = [...screen.getAllByRole("button"), ...screen.queryAllByRole("link")].filter((el) => SOLID_BG.test(el.className));
    expect(solid.map((el) => el.textContent)).toEqual(["Set password"]);
  });

  it("P13 /me 回 500 → sessionError＋Try again、不打 inspect；重試後 401 → 出現表單", async () => {
    let me = () => fail(500, "internal");
    const { calls } = setup(`/reset-password#token=${TOKEN}`, { me: () => me() });
    expect(await screen.findByText("Couldn't load your session.")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Set a new password" })).toBeInTheDocument();
    expect(inspectCalls(calls)).toHaveLength(0);
    me = () => fail(401, "unauthorized");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByLabelText("New password")).toBeInTheDocument();
    expect(inspectCalls(calls)).toHaveLength(1);
  });

  it("P14 inspect 429 → too_many_requests 全文、沒有表單、鍵仍在", async () => {
    setup(`/reset-password#token=${TOKEN}`, { inspect: () => fail(429, "too_many_requests") });
    expect(await screen.findByText(TOO_MANY_TEXT)).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).toBeNull();
    expect(screen.queryByText(INVALID_TEXT)).toBeNull();
    expect(sessionStorage.getItem(KEY)).toBe(TOKEN);
  });
});
