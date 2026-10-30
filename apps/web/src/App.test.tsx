import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
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
  autoVersions: true,
};

// 站台管理（#247 起是第二棵樹裡的 modal）：`/settings/users`（舊書籤）轉 `/admin/users`；`/admin/*` 不在主樹——
// 主樹對它落在 `/*` 的 HomePage 當背景。guard 串接、轉址與導覽的細節守在 `components/admin/AdminModal.test.tsx`。
describe("App route tree — /settings/users → /admin/users（站台管理 modal，#247）", () => {
  function mockFetchForRedirect() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/admin/users" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/admin/invites" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) }));
      }
      if (url === "/api/admin/storage-plans" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ plans: [], defaults: { userPlanId: "", groupPlanId: "" } }) }));
      }
      if (url === "/api/admin/trash/settings" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ retentionDays: 7 }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
  }

  function LocationProbe() {
    const location = useLocation();
    return <div data-testid="redirect-location">{location.pathname}</div>;
  }

  function renderAt(path: string) {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
            <LocationProbe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin 深連結 /settings/users → 轉址 /admin/users（站台管理 modal，不是設定 modal）", async () => {
    vi.stubGlobal("fetch", mockFetchForRedirect());
    renderAt("/settings/users");

    await waitFor(() => expect(screen.getByTestId("redirect-location")).toHaveTextContent("/admin/users"));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "User management" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "Settings" })).not.toBeInTheDocument();
  });

  it("admin 深連結 /admin/users → 直達站台 modal；主樹不含 /admin/*（背景是 /* 的 HomePage：New note 在）", async () => {
    vi.stubGlobal("fetch", mockFetchForRedirect());
    renderAt("/admin/users");

    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "User management" })).toBeInTheDocument());
    expect(screen.getByTestId("redirect-location")).toHaveTextContent("/admin/users");
    expect(screen.getByRole("button", { name: "New note", hidden: true })).toBeInTheDocument();
  });
});

// issue #19 的回歸釘用：把 NotePage 模組換成「測試放行才 resolve 的 stub（不含 AppShell）」。
// vi.mock 是 hoisted 的、對整個檔案的 NotePage import 生效——但 factory 是惰性的：
// lazy 版的 App 只有在 /notes/:ref 真的 render 時才觸發 import()，那時閘門已由測試架好，
// factory 停在閘門上、fallback 一直掛著，斷言不必跟任何計時賽跑；若有人把 NotePage 改回
// 靜態 import（迴歸），factory 在檔頭 import ./App 時就被呼叫——閘門還沒架（null）、立刻
// resolve，stub 一開始就頂上、fallback 從未存在，下面對「New note」（AppShell 的招牌）的
// 斷言在 stub 的空殼上永遠找不到 → 紅。
// （先前是「2 秒後 resolve」＋waitFor 上限 1.5 秒；全套平行負載下 1.5 秒內等不到 AppShell
// 就會假紅，所以改成閘門。閘門只在測試內架起，所以靜態 import 的迴歸不會卡死在收集階段。）
// 上面的 redirect 測試不 render NotePage，factory 不會被觸發，不受影響。
const notePageGate = vi.hoisted(() => ({ pending: null as Promise<void> | null, release: () => {} }));
vi.mock("./pages/NotePage", async () => {
  if (notePageGate.pending) await notePageGate.pending;
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
 * 現行寫法兩種突變都會紅（已實測；改成閘門版後於 2026-10-30 重測：靜態 import、fallback 改裸 <p>
 * 兩者都在「New note」等待處紅）。
 */
describe("App route tree — NotePage lazy fallback 保留 AppShell（issue #19）", () => {
  afterEach(() => {
    // 測試中途紅掉也要放行，別讓 factory 永遠懸著（後面 describe 若 render /notes/… 會卡住）。
    notePageGate.release();
    vi.unstubAllGlobals();
  });

  it("chunk 載入中：fallback 有 AppShell（New note 按鈕在），不是空白頁", async () => {
    notePageGate.pending = new Promise<void>(resolve => {
      notePageGate.release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/groups") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
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

    // fallback 掛著（閘門未放行，stub 不可能 resolve）時，AppShell 的招牌元素必須在場——
    // 等待上限用全域 asyncUtilTimeout，多久都不會讓斷言跑出 fallback 期間。
    await waitFor(() => expect(screen.getByText("New note")).toBeInTheDocument());
    // 「Loading…」可能同時出現在 fallback 本體與 NoteList 的載入態——至少一份
    //（AppShell 在場 + 載入文案在場＝fallback 的完整形狀）。
    expect(screen.getAllByText("Loading…").length).toBeGreaterThanOrEqual(1);
    // 反向釘：此刻還在 fallback，stub 不得已經頂上（閘門沒放行就頂上＝NotePage 不是 lazy）。
    expect(screen.queryByText("notepage-stub-without-appshell")).not.toBeInTheDocument();

    // 放行後 stub 必須頂上：證明擋住 fallback 的正是這支 mock 的閘門（mock 沒生效、
    // 真 NotePage 被載入的話，這裡等不到 stub → 紅）。
    notePageGate.release();
    expect(await screen.findByText("notepage-stub-without-appshell")).toBeInTheDocument();
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
            fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true } }) }),
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
