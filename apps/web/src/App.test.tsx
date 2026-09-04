import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

const ADMIN_USER: UserDto = {
  id: "u1",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};

// Plan 4（spec §13.4）：既有 `/admin/users` route 改為
// `<Navigate to="/settings/users" replace/>`（書籤不斷）——功能併入設定總 modal 的
// 使用者區（Task 8 填實 `SettingsUsersSection`）。這支只釘轉址落點本身（`/admin/users`
// 深連結最終要看到 `/settings/users` 的內容、`RequireAdmin` 包裹沒被拿掉）——modal
// 與背景頁共存/切換不重掛/backgroundLocation 跨區塊保留等 modal-over-background
// 機制細節，守門在 `SettingsModal.test.tsx`（尤其案 1 與 backgroundLocation 那案），
// 不重複斷言在這裡。
describe("App route tree — /admin/users redirects to /settings/users (Plan 4 §13.4)", () => {
  function mockFetchForRedirect() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin 深連結 /admin/users → 轉址 /settings/users（RequireAdmin 包裹保留不動，主樹背景落在 HomePage）", async () => {
    vi.stubGlobal("fetch", mockFetchForRedirect());
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/admin/users"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByRole("heading", { name: "User management" })).toBeInTheDocument());
    // Radix Dialog 開啟時背景兄弟節點會被標成 `aria-hidden`（focus trap），`getByRole`
    // 依可及性樹過濾會找不到——這裡改用不受影響的 `getByText`（見 SettingsModal.test.tsx
    // 同款斷言的說明），驗證主樹背景真的落在 HomePage。
    expect(screen.getByText("New note")).toBeInTheDocument();
  });
});

// issue #19 的回歸釘用：把 NotePage 模組換成「2 秒後才 resolve 的 stub（不含 AppShell）」。
// vi.mock 是 hoisted 的、對整個檔案的 NotePage import 生效——但 factory 是惰性的：
// lazy 版的 App 只有在 /notes/:ref 真的 render 時才觸發 import()，於是 fallback 有整整
// 2 秒可以斷言；若有人把 NotePage 改回靜態 import（迴歸），stub 立刻頂上、fallback 從未
// 存在，下面對「New note」（AppShell 的招牌）的斷言在 stub 的空殼上永遠找不到 → 紅。
// 上面的 redirect 測試不 render NotePage，factory 不會被觸發，不受影響。
vi.mock("./pages/NotePage", async () => {
  await new Promise(resolve => setTimeout(resolve, 2_000));
  return { default: () => <p>notepage-stub-without-appshell</p> };
});

/**
 * issue #19（審查抓到的 blocking，補回歸釘）：NotePage 走 lazy 之後，Suspense fallback
 * **必須包 AppShell**——裸 <p> 會讓「從首頁點開第一篇筆記」的瞬間整個側欄/選單消失、
 * 白頁閃一下再長回來，恰好發生在切分要優化的路徑上。E2E 在 localhost 上 chunk 毫秒級
 * 解析、看不到 fallback；只有這裡把 chunk 的 resolve 拖住，才驗得到 fallback 的長相。
 *
 * ⚠ 不可用「doMock + await import("./App")」的寫法（第一版就是，假守衛）：檔頭的靜態
 * import 已經把 ./App 連同真 NotePage 快取住，測試內的動態 import 拿到同一份快取，
 * mock 根本沒生效——突變驗證（把 fallback 改回裸 <p>、甚至把 lazy 整個拿掉）照樣綠。
 * 現行寫法兩種突變都會紅（已實測）。
 */
describe("App route tree — NotePage lazy fallback 保留 AppShell（issue #19）", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("chunk 載入中：fallback 有 AppShell（New note 按鈕在），不是空白頁", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
        }
        if (url === "/api/notes") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        return Promise.resolve(fakeResponse({ ok: false, status: 404 }));
      }),
    );
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/11111111-1111-1111-1111-111111111111"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    // fallback 掛著（stub 2 秒後才 resolve）時，AppShell 的招牌元素必須在場——
    // waitFor 上限 1.5 秒 < stub 的 2 秒，斷言必然落在 fallback 期間內。
    await waitFor(() => expect(screen.getByText("New note")).toBeInTheDocument(), { timeout: 1_500 });
    // 「Loading…」可能同時出現在 fallback 本體與 NoteList 的載入態——至少一份
    //（AppShell 在場 + 載入文案在場＝fallback 的完整形狀）。
    expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
    // 反向釘：此刻還在 fallback，stub 不得已經頂上（若這裡紅，代表時序假設壞了，
    // 測試本身要修，不是放寬）。
    expect(screen.queryByText("notepage-stub-without-appshell")).not.toBeInTheDocument();
  });
});

// #131：`useSessionGate` 開始讀 `useLocation()` 之後，`App.tsx` 的兩棵 `<Routes>` 就
// 有了一個可觀測的分歧——主樹吃被覆寫的**背景** location、第二棵樹（只含
// `/settings/*`）吃**真實**網址，未登入時兩棵各自 render 一個 `<Navigate>`，目標不同。
// 兩者都是 replace，第二棵樹的 effect 後跑而覆寫前者，所以使用者落到的是真實網址那個。
//
// 這一案就是那個「後掛載者勝出」的守衛：把第二棵樹的 `/settings/*` 路由搬進主樹
// （或改變兩棵樹的順序），`next` 就會**靜默**退化成背景頁（`/notes/…`）而這裡會紅。
// ⚠ 它**不**守另一個方向：若有人改讓 guards 直接讀真實 location，這一案只會更綠。
// 理由鏈寫在 `App.tsx` 的兩棵樹 JSDoc。
describe("App route tree — #131：modal-over-background 未登入時，next 取真實網址而非背景頁", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 落在 /login 的探針：LoginPage 本身也會 render，但我們只要 location 逐字。 */
  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="app-location">{`${location.pathname}${location.search}`}</div>;
  }

  it("背景是 /notes/…、網址列是 /settings/account → /login?next=%2Fsettings%2Faccount", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 401,
              json: () => Promise.resolve({ error: { code: "unauthorized", message: "no" } }),
            }),
          );
        }
        if (url === "/api/auth/config") {
          return Promise.resolve(
            fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ oidc: { enabled: false } }) }),
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter
            initialEntries={[
              {
                pathname: "/settings/account",
                state: { backgroundLocation: { pathname: "/notes/note-1", search: "", hash: "", state: null, key: "bg" } },
              },
            ]}
          >
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("app-location").textContent).toBe("/login?next=%2Fsettings%2Faccount");
    });
  });
});
