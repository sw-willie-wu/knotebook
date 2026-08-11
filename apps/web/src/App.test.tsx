import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

// 用真正的 production route 樹（`AppRoutes`，App.tsx 與這裡共用同一份匯出，
// 不各自重建等價樹——見 App.tsx 的說明）跑一次「setup 表單送出成功」的整合測試。
//
// 這是 Critical 1 的回歸測試：SetupPage 送出成功後只寫 `['me']` cache、沒種
// `SETUP_STATUS_QUERY_KEY`，會讓 `needed` 停留在 `true`——`SetupGate` 是
// layout route，`/setup → /` 的 navigate 不會讓它重新掛載，沒有東西觸發
// `['setup-status']` 的 refetch，使用者會被彈回一個空白的 setup 表單。
// 這裡驗證：送出後真的落在首頁佔位內容，而不是又停在 setup 表單。

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

const ADMIN_USER: UserDto = { id: "u1", email: "admin@example.com", displayName: "Admin", isAdmin: true, mustChangePassword: false };

/** `needed` 只有在 POST /api/setup 成功後才會變 false——刻意用一個 closure 旗標
 * 模擬 server 端狀態轉換，而不是一開始就 mock 死 `{needed:false}`（那樣測不出
 * SetupGate 有沒有正確依賴 cache 而非重新 fetch 才拿到新狀態）。 */
function mockFetch() {
  let setupDone = false;
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/setup/status") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ needed: !setupDone }) }),
      );
    }
    if (url === "/api/auth/me") {
      if (setupDone) {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
      }
      return Promise.resolve(
        fakeResponse({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: "unauthorized", message: "nope" } }),
        }),
      );
    }
    if (url === "/api/setup" && method === "POST") {
      setupDone = true;
      return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(ADMIN_USER) }));
    }
    // 送出成功後真的落在 HomePage（Task 12 起不再是佔位頁面），它會發起
    // `GET /api/notes`（AppShell 的 NoteList + HomePage 自己各查一次，同一個
    // query key 會被 react-query dedupe）——回空陣列即可，這裡驗證的是路由
    // 落點，不是筆記列表內容。
    if (url === "/api/notes" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

describe("App route tree — setup success (Critical 1 regression)", () => {
  beforeEach(async () => {
    // 表單文案是雙語的；固定成 en 讓 label 文字在測試裡是確定值，不受偵測到的
    // 瀏覽器語言影響（guards.test.tsx 的佔位文字不需要這個，這裡渲染真正頁面）。
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("submitting the setup form lands on the home placeholder, not back on /setup", async () => {
    vi.stubGlobal("fetch", mockFetch());
    const queryClient = new QueryClient();

    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/setup"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Setup token")).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText("Setup token"), { target: { value: "tok" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "admin@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correcthorsebatterystaple" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Admin" } });

    fireEvent.click(screen.getByRole("button", { name: "Create admin account" }));

    // HomePage（真正的首頁，非佔位）落地的證據：AppShell 的「New note」按鈕
    // 與尚無筆記時的引導文案都渲染出來——不是又停在 setup 表單。
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByLabelText("Setup token")).not.toBeInTheDocument();
  });
});

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
      if (url === "/api/setup/status") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ needed: false }) }));
      }
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

    await waitFor(() => expect(screen.getByRole("heading", { name: "Users" })).toBeInTheDocument());
    // Radix Dialog 開啟時背景兄弟節點會被標成 `aria-hidden`（focus trap），`getByRole`
    // 依可及性樹過濾會找不到——這裡改用不受影響的 `getByText`（見 SettingsModal.test.tsx
    // 同款斷言的說明），驗證主樹背景真的落在 HomePage。
    expect(screen.getByText("New note")).toBeInTheDocument();
  });
});
