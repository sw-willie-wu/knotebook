import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { OauthRequestDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { expectCardControls44 } from "@/test/card-controls";

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
  autoVersions: true,
};

const REQUEST: OauthRequestDto = {
  clientName: "Claude Code",
  redirectHost: "127.0.0.1:5678",
  scope: "notes:read notes:write",
  scopes: ["notes:read", "notes:write"],
  replacesExisting: false,
  existingScope: null,
};

/** 落點探針：只要 location 逐字（同 App.test.tsx 的慣例）。 */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="app-location">{`${location.pathname}${location.search}`}</div>;
}

// ⚠ 刻意**不**在 harness 設 `retry: false`：410／404 案守的是 hook 自己的 `retry: false`
// ——在這裡蓋掉，hook 那行拿掉也全綠（正式站會多重試三次才顯示錯誤）。守法是**計次**：錯誤畫面
// 出現時 `/api/oauth/request` 恰被打一次（重試三次的話錯誤要等第四次失敗才出現，此時已是 4 次）。
// 不靠等待上限：react-query 預設退避 1+2+4≈7 秒，塞得進全域 asyncUtilTimeout，只看「多久出現」守不住。
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
    if (url === "/api/groups") return { ok: true, status: 200, json: async () => [] } as unknown as Response;
    if (url.startsWith("/api/auth/me")) return meHandler();
    if (url.startsWith("/api/auth/config"))
      return { ok: true, status: 200, json: async () => ({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) } as unknown as Response;
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
  // toast 跨案清空由 test/setup.ts 的全域 afterEach 負責（「decision 回 410」的 toast 與「410 → 錯誤頁」
  // 的頁內文案同字，沒清的話後者會撈到上一案的 toast 而假綠）。
});

describe("AuthorizePage", () => {
  it("顯示四要素：名稱、redirect host、scope 人話、登入身分、loopback 警語", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");

    // ⚠ 名稱與後綴是**兩個節點**（bidi 隔離的必要條件），testing-library 的 getNodeText
    // 只串接直接子文字節點，所以沒有任何節點同時含兩者——必須分開斷言。
    // 名稱節點的 textContent 必須**恰好**是名稱（regex 錨定）：後綴若被合併進同一個
    // isolate span，子字串比對仍會過，但 U+202E 就能把後綴一起反轉。
    // 本檔第一次載入 AuthorizePage lazy chunk
    expect(await screen.findByTestId("authorize-client-name")).toHaveTextContent(/^Claude Code$/);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Claude Code wants to access your Knotebook");
    expect(screen.getByText(/self-reported/)).toBeInTheDocument();
    expect(screen.getByText(/127\.0\.0\.1:5678/)).toBeInTheDocument();
    expect(screen.getByText("Read all of your notes")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Create and edit notes" })).toBeInTheDocument();
    expect(screen.getByText(/Signed in as alice/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not you? Sign out" })).toBeInTheDocument();
    expect(screen.getByText(/Only allow this if a program you just started/)).toBeInTheDocument();
    expect(screen.queryByText(/replace the previous authorization/)).not.toBeInTheDocument();
  });

  it("卡片頁例外：Allow、Deny 是 44px（h-11）；勾選框與「Not you?」文字鈕不放大", async () => {
    vi.stubGlobal("fetch", mockFetch(okRequest));
    renderAt("/authorize?req=abc");
    await screen.findByRole("button", { name: "Allow" });
    expect(expectCardControls44(undefined, "button.underline")).toBe(2);
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
            json: async () => ({
              ...REQUEST,
              scope: "notes:read",
              scopes: ["notes:read"],
              replacesExisting: true,
              existingScope: "notes:read notes:write",
            }),
          }) as unknown as Response
      )
    );
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/replace the previous authorization/)).toBeInTheDocument();
    expect(screen.getByText("Read all of your notes")).toBeInTheDocument();
    expect(screen.queryByText("Create and edit notes")).not.toBeInTheDocument();
  });

  it("允許 → POST decision 帶 allow＋勾選的 scope 並跳到 redirectTo", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(okRequest, () => redirectResponse("http://127.0.0.1:5678/cb?code=x"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");

    fireEvent.click(await screen.findByRole("checkbox", { name: "Create and edit notes" }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("http://127.0.0.1:5678/cb?code=x"));
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({
      req: "abc",
      decision: "allow",
      scope: "notes:read notes:write",
    });
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

  it("410 → 顯示「請從應用程式重新發起」且沒有按鈕；不重試（恰打一次）", async () => {
    const fetchMock = mockFetch(() => errorResponse(410, "oauth_request_invalid"));
    vi.stubGlobal("fetch", fetchMock);
    const requestCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/oauth/request")).length;
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/already been used or has expired/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    // hook 的 `retry: false` 守門（見 renderAt 上方註解）：重試的話錯誤出現時已打 4 次。
    expect(requestCalls()).toBe(1);
  });

  it("404 → 通用錯誤且沒有按鈕；不重試（恰打一次）", async () => {
    const fetchMock = mockFetch(() => errorResponse(404, "not_found"));
    vi.stubGlobal("fetch", fetchMock);
    const requestCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/oauth/request")).length;
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(/Couldn't load this authorization request/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow" })).not.toBeInTheDocument();
    expect(requestCalls()).toBe(1);
  });
});

// #239 W1（spec §9.2）：逐項勾選、預設勾選（W4'／W8）、連動、比既有權限窄的提示。
describe("AuthorizePage #239 逐項勾選", () => {
  const RWM = "notes:read notes:write notes:move" as const;
  const RW = "notes:read notes:write" as const;
  const EDIT = "Create and edit notes";
  const MOVE = "Move or copy notes into groups";
  const requestWith = (patch: Partial<OauthRequestDto>) => (): Response =>
    ({ ok: true, status: 200, json: async () => ({ ...REQUEST, ...patch }) }) as unknown as Response;
  const THREE = { scope: RWM, scopes: ["notes:read", "notes:write", "notes:move"] };
  /** 等 decision 送出後取它的 body。 */
  async function decisionBody(fetchMock: ReturnType<typeof mockFetch>): Promise<unknown> {
    const isDecision = ([url]: [RequestInfo | URL, RequestInit?]) => String(url).startsWith("/api/oauth/decision");
    await waitFor(() => expect(fetchMock.mock.calls.some(isDecision)).toBe(true));
    return JSON.parse(fetchMock.mock.calls.find(isDecision)![1]!.body as string);
  }

  it("(a) 第一次授權（existingScope null）、要求三項 → 標題是 scopesTitleChoose，兩框都不勾", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ ...THREE, existingScope: null, replacesExisting: false })));
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(i18n.t("authorize.scopesTitleChoose"))).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: EDIT })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).not.toBeChecked();
    expect(screen.queryByText(i18n.t("authorize.scopesTitle"))).not.toBeInTheDocument();
    expect(screen.queryByText("Currently granted")).not.toBeInTheDocument();
  });

  it("a11y：兩框在以標題命名的 group 裡；搬移框以 aria-describedby 帶後果說明", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ ...THREE, existingScope: null, replacesExisting: false })));
    renderAt("/authorize?req=abc");
    const group = await screen.findByRole("group", { name: i18n.t("authorize.scopesTitleChoose") });
    expect(within(group).getByRole("checkbox", { name: EDIT })).toBeInTheDocument();
    expect(within(group).getByRole("checkbox", { name: MOVE })).toHaveAccessibleDescription(
      i18n.t("settings.account.apiTokensScopeMoveHint")
    );
  });

  it("(b) 既有讀寫、要求三項 → 編輯預設勾、搬移不勾，「Currently granted」恰一處且在編輯那列", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ ...THREE, existingScope: RW, replacesExisting: true })));
    renderAt("/authorize?req=abc");
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    expect(edit).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).not.toBeChecked();
    const granted = screen.getAllByText("Currently granted");
    expect(granted).toHaveLength(1);
    expect(granted[0]!.parentElement).toContainElement(edit);
    expect(screen.queryByText(i18n.t("authorize.replacesWithLess"))).not.toBeInTheDocument();
  });

  it("(c) 既有讀寫搬移、只要求讀寫 → 編輯勾、沒有搬移框、出現 replacesWithLess；Allow 送讀寫（不超過要求）", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(
      requestWith({ scope: RW, scopes: ["notes:read", "notes:write"], existingScope: RWM, replacesExisting: true }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    expect(await screen.findByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: MOVE })).toBeNull();
    expect(screen.getByText(i18n.t("authorize.replacesWithLess"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("authorize.replacesWithLessReadOnly"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RW });
  });

  it("(d) 勾編輯→勾搬移→取消編輯 → 搬移 disabled 且清掉；Allow 送 notes:read", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const fetchMock = mockFetch(
      requestWith({ ...THREE, existingScope: null, replacesExisting: false }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    const move = screen.getByRole("checkbox", { name: MOVE });
    expect(move).toBeDisabled(); // 未勾編輯時搬移不可選
    fireEvent.click(edit);
    expect(move).toBeEnabled();
    fireEvent.click(move);
    expect(move).toBeChecked();
    fireEvent.click(edit);
    expect(move).toBeDisabled();
    expect(move).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "allow", scope: "notes:read" });
  });

  it("勾兩框 → Allow 送第三形", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(
      requestWith({ ...THREE, existingScope: null, replacesExisting: false }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    fireEvent.click(await screen.findByRole("checkbox", { name: EDIT }));
    fireEvent.click(screen.getByRole("checkbox", { name: MOVE }));
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url]) => String(url).startsWith("/api/oauth/decision"))).toBe(true)
    );
    const decisionCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("/api/oauth/decision"))!;
    expect(JSON.parse(decisionCall[1]!.body as string)).toEqual({ req: "abc", decision: "allow", scope: RWM });
  });

  it("(e) 既有讀寫、只要求唯讀 → 沒有勾選框、出現 replacesWithLessReadOnly、標題是 scopesTitle；Allow 送唯讀", async () => {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(
      requestWith({ scope: "notes:read", scopes: ["notes:read"], existingScope: RW, replacesExisting: true }),
      () => redirectResponse("http://127.0.0.1:5678/cb?code=x")
    );
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    expect(await screen.findByText(i18n.t("authorize.replacesWithLessReadOnly"))).toBeInTheDocument();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText(i18n.t("authorize.scopesTitle"))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t("authorize.scopesTitleChoose"))).not.toBeInTheDocument();
    expect(screen.queryByText(i18n.t("authorize.replacesWithLess"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: "notes:read" });
  });

  it("視窗重新取得焦點／重新連線不重抓 request（勾選初值與「Currently granted」標示來自同一份快照）", async () => {
    const fetchMock = mockFetch(requestWith({ ...THREE, existingScope: RW, replacesExisting: true }));
    vi.stubGlobal("fetch", fetchMock);
    const requestCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith("/api/oauth/request")).length;
    renderAt("/authorize?req=abc");
    await screen.findByRole("checkbox", { name: EDIT });
    expect(requestCalls()).toBe(1);
    try {
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(false);
        onlineManager.setOnline(true);
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(requestCalls()).toBe(1);
    } finally {
      focusManager.setFocused(undefined);
      onlineManager.setOnline(true);
    }
  });

  it("未知 scope 不渲染成「Read all of your notes」", async () => {
    vi.stubGlobal("fetch", mockFetch(requestWith({ scope: "notes:read", scopes: ["notes:read", "notes:admin"] })));
    renderAt("/authorize?req=abc");
    expect(await screen.findAllByText("Read all of your notes")).toHaveLength(1);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

// #181 PR-2d（spec §6.8.2）：第三框「刪除」——client 沒要求不渲染、預設不勾、取消編輯一起清、既有權限取交集。
describe("AuthorizePage #181 刪除勾選", () => {
  const R = "notes:read" as const;
  const RW = "notes:read notes:write" as const;
  const RWM = "notes:read notes:write notes:move" as const;
  const RWD = "notes:read notes:write notes:delete" as const;
  const RWMD = "notes:read notes:write notes:move notes:delete" as const;
  const EDIT = "Create and edit notes";
  const MOVE = "Move or copy notes into groups";
  const DELETE = "Move notes to the trash and restore them";
  // 刪除框的常駐說明＝S2＋「需同時勾選編輯」一句（fix round 1 m1，比照搬移說明的結尾）。兩語系逐字釘。
  const DELETE_HINT_EN =
    "Can't delete notes permanently, but notes left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app. Requires \"Create and edit notes\".";
  const DELETE_HINT_ZH =
    "不能永久刪除筆記；但留在垃圾桶的筆記之後仍可能被永久刪除（依站台的垃圾桶設定，或有人在網頁上刪除）。需同時勾選「建立與修改筆記」。";
  const ASK_RWM = { scope: RWM, scopes: ["notes:read", "notes:write", "notes:move"] };
  const ASK_ALL = { scope: RWMD, scopes: ["notes:read", "notes:write", "notes:move", "notes:delete"] };
  const requestWith = (patch: Partial<OauthRequestDto>) => (): Response =>
    ({ ok: true, status: 200, json: async () => ({ ...REQUEST, ...patch }) }) as unknown as Response;
  function setup(patch: Partial<OauthRequestDto>) {
    vi.stubGlobal("location", { ...window.location, assign: vi.fn() });
    const fetchMock = mockFetch(requestWith(patch), () => redirectResponse("http://127.0.0.1:5678/cb?code=x"));
    vi.stubGlobal("fetch", fetchMock);
    renderAt("/authorize?req=abc");
    return fetchMock;
  }
  async function decisionBody(fetchMock: ReturnType<typeof mockFetch>): Promise<unknown> {
    const isDecision = ([url]: [RequestInfo | URL, RequestInit?]) => String(url).startsWith("/api/oauth/decision");
    await waitFor(() => expect(fetchMock.mock.calls.some(isDecision)).toBe(true));
    return JSON.parse(fetchMock.mock.calls.find(isDecision)![1]!.body as string);
  }

  it("AP-D1：client 沒要求 notes:delete → 沒有刪除勾選框", async () => {
    setup({ ...ASK_RWM, existingScope: null });
    expect(await screen.findByRole("checkbox", { name: EDIT })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: MOVE })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: DELETE })).toBeNull();
  });

  it("AP-D2：要求四項、第一次授權 → 三框不勾；刪除在勾編輯前 disabled、帶後果說明；勾編輯＋刪除 → Allow 送 RWD", async () => {
    const fetchMock = setup({ ...ASK_ALL, existingScope: null });
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    const move = screen.getByRole("checkbox", { name: MOVE });
    const del = screen.getByRole("checkbox", { name: DELETE });
    expect(edit).not.toBeChecked();
    expect(move).not.toBeChecked();
    expect(del).not.toBeChecked();
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription(DELETE_HINT_EN);
    fireEvent.click(edit);
    expect(del).toBeEnabled();
    fireEvent.click(del);
    expect(del).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RWD });
  });

  it("AP-D3：既有 RWD、要求 RWM → 只勾編輯、沒有刪除框、出現 replacesWithLess；Allow 送 RW", async () => {
    const fetchMock = setup({ ...ASK_RWM, existingScope: RWD, replacesExisting: true });
    expect(await screen.findByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).not.toBeChecked();
    expect(screen.queryByRole("checkbox", { name: DELETE })).toBeNull();
    expect(screen.getByText(i18n.t("authorize.replacesWithLess"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RW });
  });

  it("AP-D4：既有 RWMD、要求四項 → 三框全勾、三處 Currently granted、沒有 replacesWithLess", async () => {
    setup({ ...ASK_ALL, existingScope: RWMD, replacesExisting: true });
    const del = await screen.findByRole("checkbox", { name: DELETE });
    expect(screen.getByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: MOVE })).toBeChecked();
    expect(del).toBeChecked();
    const granted = screen.getAllByText("Currently granted");
    expect(granted).toHaveLength(3);
    expect(granted.some(g => g.parentElement!.contains(del))).toBe(true);
    expect(screen.queryByText(i18n.t("authorize.replacesWithLess"))).not.toBeInTheDocument();
  });

  it("AP-D5：三框全勾後取消編輯 → 搬移、刪除都清掉且 disabled；Allow 送 R", async () => {
    const fetchMock = setup({ ...ASK_ALL, existingScope: null });
    const edit = await screen.findByRole("checkbox", { name: EDIT });
    const move = screen.getByRole("checkbox", { name: MOVE });
    const del = screen.getByRole("checkbox", { name: DELETE });
    fireEvent.click(edit);
    fireEvent.click(move);
    fireEvent.click(del);
    expect(move).toBeChecked();
    expect(del).toBeChecked();
    fireEvent.click(edit);
    expect(move).not.toBeChecked();
    expect(move).toBeDisabled();
    expect(del).not.toBeChecked();
    expect(del).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: R });
  });

  it("AP-D6：既有 RWM、要求 RWD（格上不可比）→ 只勾編輯、刪除不勾、Currently granted 只在編輯列、出現 replacesWithLess；勾刪除 → Allow 送 RWD", async () => {
    const fetchMock = setup({ scope: RWD, scopes: ["notes:read", "notes:write", "notes:delete"], existingScope: RWM, replacesExisting: true });
    const del = await screen.findByRole("checkbox", { name: DELETE });
    expect(screen.getByRole("checkbox", { name: EDIT })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: MOVE })).toBeNull();
    expect(del).not.toBeChecked();
    expect(screen.getAllByText("Currently granted")).toHaveLength(1);
    expect(screen.getByText(i18n.t("authorize.replacesWithLess"))).toBeInTheDocument();
    fireEvent.click(del);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await decisionBody(fetchMock)).toEqual({ req: "abc", decision: "allow", scope: RWD });
  });

  it("AP-D7（zh-TW）：刪除框的常駐說明以「需同時勾選「建立與修改筆記」。」收尾，並是框的可及描述", async () => {
    await i18n.changeLanguage("zh-TW");
    setup({ ...ASK_ALL, existingScope: null });
    const del = await screen.findByRole("checkbox", { name: "移到垃圾桶與還原" });
    expect(del).toBeDisabled();
    expect(del).toHaveAccessibleDescription(DELETE_HINT_ZH);
  });
});
