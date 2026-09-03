import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// SettingsAccountSection（Plan 5 Task 10）：`hasPassword === false`（OIDC-only 帳號）
// → 不渲染 `ChangePasswordForm`，改渲染 `settings.account.ssoOnly` 提示（spec §14.4）。
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

function baseFetchHandlers(user: UserDto) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/tokens" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) });
    }
    return null;
  };
}

function renderAccountSettings(user: UserDto) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const res = baseFetchHandlers(user)(url, method);
    if (res) return Promise.resolve(res);
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
}

describe("SettingsAccountSection（Plan 5 Task 10：hasPassword===false → SSO-only 提示）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hasPassword:true → 渲染 ChangePasswordForm", async () => {
    renderAccountSettings(PASSWORD_USER);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument());
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByText("This account signs in with SSO.")).not.toBeInTheDocument();
  });

  it("hasPassword:false → 表單不渲染，改渲染 settings.account.ssoOnly 文案，且不與「Change your password」標題並存（fix round 1 MINOR-2）", async () => {
    renderAccountSettings(SSO_ONLY_USER);

    await waitFor(() => expect(screen.getByText("This account signs in with SSO.")).toBeInTheDocument());
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change password" })).not.toBeInTheDocument();
    // 標題/描述只屬於改密碼表單那個分支——SSO-only 使用者不該同時看到「Change your
    // password」與「此帳號透過 SSO 登入」這兩則自相矛盾的訊息。
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();
    expect(screen.queryByText("Choose a new password for your account.")).not.toBeInTheDocument();
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
    // SSO 提示仍在（兩者並存，不互斥）
    expect(screen.getByText(/single sign-on|SSO/i)).toBeInTheDocument();
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
