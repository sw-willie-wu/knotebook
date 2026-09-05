import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { OauthRequestDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// 同 ChangePasswordPage.test.tsx 的約定：mock 全域 fetch，走真正的 AppRoutes——驗的是
// 「route 有沒有接對」（掛在 RequireAuth 底下）而不只是元件單獨渲染。

const USER: UserDto = {
  id: "u1",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const REQUEST: OauthRequestDto = {
  clientName: "Claude Code",
  redirectHost: "127.0.0.1:5678",
  scope: "notes:read notes:write",
  scopes: ["notes:read", "notes:write"],
  replacesExisting: false,
};

/** 落點探針：只要 location 逐字（同 App.test.tsx 的慣例）。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="app-location">{`${location.pathname}${location.search}`}</div>;
}

// ⚠ 刻意**不**在 harness 設 `retry: false`：410／404 案的即時性要靠 hook 自己的
// `retry: false`——在這裡蓋掉，hook 那行拿掉也全綠（正式站會多重試三次才顯示錯誤）。
function renderAt(path: string, me: () => Response = () => okMe()) {
  const client = new QueryClient();
  meHandler = me;
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <LocationProbe />
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>
  );
}

type Handler = () => Response | Promise<Response>;

const okMe = (): Response => ({ ok: true, status: 200, json: async () => USER }) as unknown as Response;
/** `/api/auth/me` 的回應由 renderAt 的第二參數決定（預設登入中）；request／decision 由每案指定。 */
let meHandler: () => Response = okMe;

function mockFetch(requestHandler: Handler, decisionHandler?: Handler) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/auth/me")) return meHandler();
    if (url.startsWith("/api/auth/config"))
      return { ok: true, status: 200, json: async () => ({ oidc: { enabled: false } }) } as unknown as Response;
    if (url.startsWith("/api/oauth/request")) return requestHandler();
    if (url.startsWith("/api/oauth/decision")) {
      expect(init?.method).toBe("POST");
      return decisionHandler!();
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const okRequest = (): Response => ({ ok: true, status: 200, json: async () => REQUEST }) as unknown as Response;
const errorResponse = (status: number, code: string): Response =>
  ({ ok: false, status, json: async () => ({ error: { code, message: code } }) }) as unknown as Response;
const redirectResponse = (redirectTo: string): Response =>
  ({ ok: true, status: 200, json: async () => ({ redirectTo }) }) as unknown as Response;

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  meHandler = okMe;
});

describe("AuthorizePage", () => {
  it("顯示四要素：名稱、redirect host、scope 人話、登入身分、loopback 警語", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");

    // ⚠ 名稱與後綴是**兩個節點**（bidi 隔離的必要條件），testing-library 的 getNodeText
    // 只串接直接子文字節點，所以沒有任何節點同時含兩者——必須分開斷言。
    // 名稱節點的 textContent 必須**恰好**是名稱（regex 錨定）：後綴若被合併進同一個
    // isolate span，子字串比對仍會過，但 U+202E 就能把後綴一起反轉。
    expect(await screen.findByTestId("authorize-client-name")).toHaveTextContent(/^Claude Code$/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Claude Code wants to access your Knotebook");
    expect(screen.getByText(/self-reported/)).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1:5678/)).toBeInTheDocument();
    expect(screen.getByText("Read all of your notes")).toBeInTheDocument();
    expect(screen.getByText("Create and modify your notes")).toBeInTheDocument();
    expect(screen.getByText(/Signed in as alice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not you? Sign out" })).toBeInTheDocument();
    expect(screen.getByText(/Only allow this if a program you just started/)).toBeInTheDocument();
    expect(screen.queryByText(/replace the previous authorization/)).not.toBeInTheDocument();
  });

  // I-3：route 掛哪一層要有守衛。兩案分別殺「移到 RequireAuth 外」與「移到 ChangePasswordGate 外」。
  it("未登入 → /login?next=%2Fauthorize%3Freq%3Dabc（含 query，#131 才接得回來）", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc", () => errorResponse(401, "unauthorized"));
    await waitFor(() => {
      expect(screen.getByTestId("app-location").textContent).toBe("/login?next=%2Fauthorize%3Freq%3Dabc");
    });
  });

  it("mustChangePassword → 先去 /change-password，看不到同意頁", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt(
      "/authorize?req=abc",
      () => ({ ok: true, status: 200, json: async () => ({ ...USER, mustChangePassword: true }) }) as unknown as Response
    );
    await waitFor(() => {
      expect(screen.getByTestId("app-location").textContent).toBe("/change-password");
    });
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("client 名稱以 dir=ltr 與 bidi isolate 渲染", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");
    const name = await screen.findByTestId("authorize-client-name");
    expect(name).toHaveAttribute("dir", "ltr");
    expect(name.className).toContain("unicode-bidi:isolate");
  });

  it("replacesExisting 時多一行取代提示；唯讀 scope 只列一條", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(
        () =>
          ({
            ok: true,
            status: 200,
            json: async () => ({ ...REQUEST, scope: "notes:read", scopes: ["notes:read"], replacesExisting: true }),
          }) as unknown as Response
      )
    );
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/replace the previous authorization/)).toBeInTheDocument();
    expect(screen.getByText("Read all of your notes")).toBeInTheDocument();
    expect(screen.queryByText("Create and modify your notes")).not.toBeInTheDocument();
  });

  it("允許 → POST decision 帶 allow 並跳到 redirectTo", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?code=x"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5678/cb?code=x"));
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "allow" });
  });

  it("拒絕 → POST decision 帶 deny 並跳轉", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?error=access_denied"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5678/cb?error=access_denied"));
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "deny" });
  });

  it("decision 回 409 token_limit → 顯示「撤銷後從應用程式重新發起」的 toast，不跳轉", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal("fetch", mockFetch(okRequest, () => errorResponse(409, "token_limit")));
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    // 專屬片段：`denyHint` 也含 "start again from the application"，用它斷言會匹配到
    // 一直都在的那段而不是 toast
    expect(await screen.findByText(/Token limit reached/)).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load this authorization request/)).not.toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("decision 回 410 → 「已使用或已過期」的 toast（不是載入失敗的通用文案）", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    vi.stubGlobal("fetch", mockFetch(okRequest, () => errorResponse(410, "oauth_request_invalid")));
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    expect(await screen.findByText(/already been used or has expired/)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it("送出成功後兩個按鈕都鎖住（導頁還在飛的空窗期）", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    vi.stubGlobal("fetch", mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?code=x")));
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  it("缺 req → 顯示錯誤且沒有按鈕，也不打 request 端點", async () => {
    const fetchMock = mockFetch(() => {
      throw new Error("should not fetch request");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize");
    expect(await screen.findByText(/missing the authorization request id/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/oauth/request"))).toBe(false);
  });

  it("`?req=`（空字串）視同缺席：不打端點", async () => {
    const fetchMock = mockFetch(() => {
      throw new Error("should not fetch request");
    });
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=");
    expect(await screen.findByText(/missing the authorization request id/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/oauth/request"))).toBe(false);
  });

  it("410 → 顯示「請從應用程式重新發起」且沒有按鈕", async () => {
    vi.stubGlobal("fetch", mockFetch(() => errorResponse(410, "oauth_request_invalid")));
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/already been used or has expired/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });

  it("404 → 通用錯誤且沒有按鈕", async () => {
    vi.stubGlobal("fetch", mockFetch(() => errorResponse(404, "not_found")));
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/Couldn't load this authorization request/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
  });
});
