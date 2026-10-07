import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// SettingsAccountSection：`hasPassword === false` → 不渲染 `ChangePasswordForm`；帳密登入有效值開時
// 改渲染「加上密碼」表單、關時只有說明（#187 §8.5）。
// 走真正的 `AppRoutes`（同 SettingsModal.test.tsx/SettingsUsersSection.test.tsx 慣例，
// 不拆開重建等價樹）——驗證的是「有沒有接對」。fetch 樁比照
// `SettingsUsersSection.test.tsx:89-101`。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PASSWORD_USER: UserDto = {
  id: "u-password",
  email: "alice@example.com",
  handle: "tester",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const SSO_ONLY_USER: UserDto = {
  id: "u-sso",
  email: "bob@example.com",
  handle: "tester",
  displayName: "Bob",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: false,
};

function baseFetchHandlers(user: UserDto, passwordLoginEnabled = true) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/identities" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ identities: [], linkable: [], hasPassword: user.hasPassword, passwordLoginEnabled }) });
    }
    if (url === "/api/auth/tokens" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) });
    }
    return null;
  };
}

function renderAccountSettings(user: UserDto, passwordLoginEnabled = true) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const res = baseFetchHandlers(user, passwordLoginEnabled)(url, method);
    if (res) return Promise.resolve(res);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/account"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SettingsAccountSection（hasPassword／帳密登入有效值 三形）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hasPassword:true → 渲染 ChangePasswordForm", async () => {
    const queryClient = renderAccountSettings(PASSWORD_USER);

    // 本檔第一次載入帳號區塊 lazy chunk
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    // 「不存在」斷言的等待點：identities 已落地（有效值開）——否則關閉說明句本來就還沒出現，斷言空真。
    await waitFor(() => expect(queryClient.getQueryData(["identities"])).toBeDefined());
    expect(screen.queryByText(/This site only allows signing in through a sign-in service right now/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
  });

  it("hasPassword:false＋有效值開 →「Add a password」表單取代舊的 SSO-only 文案；沒有改密碼表單", async () => {
    renderAccountSettings(SSO_ONLY_USER);
    expect(await screen.findByRole("heading", { name: "Add a password" })).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();
  });

  it("hasPassword:false＋有效值關 → 只有說明、沒有表單（B22）", async () => {
    renderAccountSettings(SSO_ONLY_USER, false);
    expect(await screen.findByText("This site only allows signing in through a sign-in service right now.")).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("hasPassword:true＋有效值關 → 改密碼表單仍在＋說明句", async () => {
    renderAccountSettings(PASSWORD_USER, false);
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    // 說明句要等 identities 落地才出現（改密碼表單先以預設「開」渲染）——用 findBy 等。
    expect(await screen.findByText("This site only allows signing in through a sign-in service right now; your password is only used to prove it's you when linking an account.")).toBeInTheDocument();
  });
});

/**
 * #122 PR1 Task 5：帳號區的使用者名（handle）欄。
 * - 兩個分支（有密碼／SSO-only）都要渲染——OIDC 使用者正是 handle 派生自
 *   preferred_username、最可能想改名的族群（plan gate M5：早退分支要重構）。
 * - 成功後 invalidateQueries **全清**（handle 已反正規化進未來的 NoteDto，改名罕見、全清最保險）。
 * - 警語含 /n/、/p/ 網址形＝刻意提前（PR2/3 緊隨，文案一次寫全——非 drift）。
 */
describe("SettingsAccountSection——使用者名欄（#122 Task 5）", () => {
  const HANDLE_WARNING =
    "Your username appears in every /n/ and /p/ link you share (token links don't include it). After a rename those links stop working immediately, and the old name can never be used again — not even by you.";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWithProfilePatch(user: UserDto, patchResponse: () => Response) {
    // 可變的 me 樁（突變審查 F1）：/api/auth/me 讀 userRef.current——成功案把它翻成
    // 新值，才能斷言「全清 refetch 後畫面顯示新 handle」；固定樁下那個宣稱是假的。
    const userRef = { current: user };
    const patchBodies: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/profile" && method === "PATCH") {
        patchBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(patchResponse());
      }
      const res = baseFetchHandlers(userRef.current)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/settings/account"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    return { fetchMock, patchBodies, invalidateSpy, userRef };
  }

  it("顯示現行 handle 與警語（含 /n/、/p/ 網址形——刻意提前的完整文案）", async () => {
    renderWithProfilePatch(PASSWORD_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = (await screen.findByLabelText("Username")) as HTMLInputElement;
    expect(input.value).toBe("tester");
    expect(screen.getByText(HANDLE_WARNING)).toBeInTheDocument();
  });

  it("SSO-only（hasPassword=false）也看得到、可編輯（早退分支已重構——plan gate M5）", async () => {
    renderWithProfilePatch(SSO_ONLY_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = (await screen.findByLabelText("Username")) as HTMLInputElement;
    expect(input.value).toBe("tester");
    expect(input).not.toBeDisabled();
    // 「加上密碼」群組仍在（兩者並存，不互斥）
    expect(await screen.findByRole("heading", { name: "Add a password" })).toBeInTheDocument();
  });

  it("改名成功：PATCH body 正規化後送出、invalidateQueries **全清**（無過濾參數）、全清 refetch 後畫面顯示新值＋成功 toast", async () => {
    const updated: UserDto = { ...PASSWORD_USER, handle: "new-me" };
    const { patchBodies, invalidateSpy, userRef } = renderWithProfilePatch(PASSWORD_USER, () => {
      userRef.current = updated; // PATCH 落地＝server 端已改——之後的 /me 回新值
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) });
    });
    const input = (await screen.findByLabelText("Username")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New-Me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save username" }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ handle: "new-me" }); // 正規化（小寫）後送出
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidateSpy.mock.calls.some((args) => args.length === 0 || args[0] === undefined)).toBe(true);
    // 顯示新值（突變審查 F1）：靠 setValue(null) 回「顯示現值」＋setQueryData 寫入的新
    // session——少了 setValue(null) 欄位會停在原文 "New-Me" 而紅
    await waitFor(() => expect(input.value).toBe("new-me"));
    await screen.findByText("Username updated."); // 成功 toast（F2）
  });

  it("M1 釘：PATCH 落地即 setQueryData 更新 session——/me refetch **尚未回應**時也顯示新值（不閃回舊名一個 RTT）", async () => {
    const updated: UserDto = { ...PASSWORD_USER, handle: "new-me" };
    let meCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/profile" && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) }));
      }
      if (url === "/api/auth/me" && method === "GET") {
        meCalls += 1;
        if (meCalls === 1) {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PASSWORD_USER) }));
        }
        return new Promise<Response>(() => {}); // 之後的 refetch 永不回應——新值只能來自 setQueryData
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/tokens" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/settings/account"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    const input = (await screen.findByLabelText("Username")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New-Me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save username" }));
    await waitFor(() => expect(input.value).toBe("new-me")); // refetch 懸掛中——值來自 setQueryData
    await screen.findByText("Username updated.");
  });

  it("值未變（含只變大小寫）→ Save 鈕 disabled（no-op 改名不打端點——額度只計成功，前端就該擋）", async () => {
    renderWithProfilePatch(PASSWORD_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = await screen.findByLabelText("Username");
    expect(screen.getByRole("button", { name: "Save username" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "TESTER" } }); // 正規化後同值
    expect(screen.getByRole("button", { name: "Save username" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "different" } });
    expect(screen.getByRole("button", { name: "Save username" })).not.toBeDisabled();
  });

  it("409 handle_taken → 顯示對應文案", async () => {
    renderWithProfilePatch(PASSWORD_USER, () =>
      fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "handle_taken", message: "x" } }) }),
    );
    const input = await screen.findByLabelText("Username");
    fireEvent.change(input, { target: { value: "occupied" } });
    fireEvent.click(screen.getByRole("button", { name: "Save username" }));
    await waitFor(() => expect(screen.getByText("That username is already taken.")).toBeInTheDocument());
  });

  it("429 too_many_requests → 顯示對應文案（plan gate 注意事項 8）", async () => {
    renderWithProfilePatch(PASSWORD_USER, () =>
      fakeResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "too_many_requests", message: "x" } }) }),
    );
    const input = await screen.findByLabelText("Username");
    fireEvent.change(input, { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save username" }));
    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
  });

  it("非法格式：前端就地呈現、不打 API（plan gate m3）", async () => {
    const { fetchMock } = renderWithProfilePatch(PASSWORD_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = await screen.findByLabelText("Username");
    fireEvent.change(input, { target: { value: "Bad Name!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save username" }));
    await waitFor(() =>
      expect(
        screen.getByText("1–32 characters: lowercase letters, numbers and hyphens; hyphens can't lead, trail, or repeat."),
      ).toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls.some(([, init]) => (init?.method ?? "GET").toUpperCase() === "PATCH")).toBe(false);
  });
});

describe("SetPasswordForm（#187 §8.4）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  it("送出 → POST /api/auth/password/set {newPassword}、成功 toast；兩次不同就地錯誤不送；409 → 對應文案", async () => {
    const posts: unknown[] = [];
    let status = 204;
    const handlers = baseFetchHandlers(SSO_ONLY_USER);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/password/set" && method === "POST") {
        posts.push(JSON.parse(String(init!.body)));
        return Promise.resolve(status === 204 ? fakeResponse({ ok: true, status: 204 }) : fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code: "password_already_set", message: "x" } }) }));
      }
      const r = handlers(url, method);
      if (r) return Promise.resolve(r);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><MemoryRouter initialEntries={["/settings/account"]}><AppRoutes /></MemoryRouter></ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "brand-new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("The new password and confirmation don't match.")).toBeInTheDocument();
    expect(posts).toEqual([]);
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "brand-new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("Password added.")).toBeInTheDocument();
    expect(posts).toEqual([{ newPassword: "brand-new-password-1" }]);
    status = 409;
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "brand-new-password-2" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "brand-new-password-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("This account already has a password. Use Change password instead.")).toBeInTheDocument();
  });

  it("新密碼太短 → client 端擋下、不打 API", async () => {
    const posts: unknown[] = [];
    const handlers = baseFetchHandlers(SSO_ONLY_USER);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/password/set" && method === "POST") {
        posts.push(JSON.parse(String(init!.body)));
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      const r = handlers(url, method);
      if (r) return Promise.resolve(r);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><MemoryRouter initialEntries={["/settings/account"]}><AppRoutes /></MemoryRouter></ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("Password is too short.")).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});

describe("SetPasswordForm——送出後的狀態切換（#187 §8.4）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  /** /me 讀可變 userRef（比照 renderWithProfilePatch）：POST 落地＝server 已有密碼，之後的 /me 回 hasPassword:true。 */
  function renderSetPassword(postStatus: number) {
    const userRef = { current: SSO_ONLY_USER };
    const handlers = (url: string, method: string) => baseFetchHandlers(userRef.current)(url, method);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/password/set" && method === "POST") {
        userRef.current = { ...SSO_ONLY_USER, hasPassword: true };
        return Promise.resolve(postStatus === 204
          ? fakeResponse({ ok: true, status: 204 })
          : fakeResponse({ ok: false, status: postStatus, json: () => Promise.resolve({ error: { code: "password_already_set", message: "x" } }) }));
      }
      const r = handlers(url, method);
      if (r) return Promise.resolve(r);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><MemoryRouter initialEntries={["/settings/account"]}><AppRoutes /></MemoryRouter></ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    const identityGets = () => fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/auth/identities" && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET").length;
    return { identityGets };
  }

  async function submit(): Promise<void> {
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "brand-new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "brand-new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
  }

  it("成功 → session 與 identities 重抓：「Add a password」消失、改密碼表單出現", async () => {
    const { identityGets } = renderSetPassword(204);
    await waitFor(() => expect(identityGets()).toBe(1));
    await submit();
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
    await waitFor(() => expect(identityGets()).toBe(2));
  });

  it("409 password_already_set → 錯誤文案之外也重抓 session：畫面切到改密碼表單", async () => {
    const { identityGets } = renderSetPassword(409);
    await waitFor(() => expect(identityGets()).toBe(1));
    await submit();
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
    await waitFor(() => expect(identityGets()).toBe(2));
  });
});

