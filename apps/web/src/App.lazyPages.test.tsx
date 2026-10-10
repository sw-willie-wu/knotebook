import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useNavigate } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

/**
 * #201 接線案：釘 App.tsx 的 `LazyPageRoute` **真的**把整頁 lazy route 包進
 * `LazyRouteErrorBoundary`、`ChunkLoadBeacon` 真的在 Suspense 內、且 boundary 依 `chunk`
 * 分實例。boundary 自身的行為在 ErrorBoundary.test.tsx（案 A–D），那裡手組的形狀對
 * 不代表 App.tsx 的對——比照 App.errorBoundary.test.tsx 案 11／11a。
 *
 * ⚠⚠ 每個頁面的「throw」案必須是本檔第一個觸發該頁 lazy 的案子（AdminPage、RegisterPage
 * 各自的 lazy 是模組級單例，只有第一次觸發會經過 suspend 期）。「beacon 錯放到 Suspense
 * 外」的守門靠那次 pending 期：錯放的 beacon 會在 pending 期 commit、清掉種下的旗標，
 * 讓 componentDidCatch 誤判「首次」而走 reload＋載入畫面——錯誤文案斷言與「reload 沒被
 * 呼叫」斷言一起變紅。
 *
 * 前置斷言：各 throw 案開頭斷言 `mockPages.<page>Loaded === false`——mock factory 只在該頁
 * lazy 第一次動態 import 時執行並把它設成 true，所以這條把「本案是第一個觸發者」的順序
 * 假設變成會紅的斷言。⚠ 不能改用「render 後此刻不是錯誤畫面」當前置斷言：/admin 在
 * RequireAuth 底下、要等非同步的 /api/auth/me，render 當下**必然**不是錯誤畫面，不論 lazy
 * 是否已載入過（審查實測：admin 的 ok 案移到 throw 案前＋beacon 錯放，admin 案照綠）。
 */

// vi.mock 是 hoisted 的——共享狀態走 vi.hoisted；模式要在 mock 元件函式本體內讀
// （import 結果被 React.lazy 永久快取，factory 只執行一次）。`*Loaded` 由 factory 設：
// factory 執行＝該頁 lazy 的第一次動態 import。
const mockPages = vi.hoisted(() => ({
  admin: "throw" as "throw" | "ok",
  register: "throw" as "throw" | "ok",
  adminLoaded: false,
  registerLoaded: false,
}));

vi.mock("./pages/AdminPage", () => {
  mockPages.adminLoaded = true;
  return {
    default: function AdminPageMock() {
      if (mockPages.admin === "throw") {
        throw new Error("Failed to fetch dynamically imported module: https://x/assets/AdminPage-abc.js");
      }
      return <p>adminpage-mock-ok</p>;
    },
  };
});

vi.mock("./pages/RegisterPage", () => {
  mockPages.registerLoaded = true;
  return {
    default: function RegisterPageMock() {
      if (mockPages.register === "throw") {
        throw new Error("Failed to fetch dynamically imported module: https://x/assets/RegisterPage-abc.js");
      }
      return <p>registerpage-mock-ok</p>;
    },
  };
});

vi.mock("./pages/LinkAccountPage", () => ({
  default: function LinkAccountPageMock() {
    return <p>linkaccountpage-mock-ok</p>;
  },
}));

const ADMIN_FLAG = "knotebook:chunk-reload:admin";
const REGISTER_FLAG = "knotebook:chunk-reload:register";
const LINK_ACCOUNT_FLAG = "knotebook:chunk-reload:link-account";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";

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

function fakeResponse(ok: boolean, status: number, body?: unknown): Response {
  return {
    ok,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(true, 200, ADMIN_USER));
      if (url === "/api/groups" || url === "/api/notes") return Promise.resolve(fakeResponse(true, 200, []));
      return Promise.resolve(fakeResponse(false, 404));
    }),
  );
}

let navigateFn: ((to: string) => void) | null = null;
function NavigateHandle() {
  const navigate = useNavigate();
  navigateFn = navigate;
  return null;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
          <NavigateHandle />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

let reload: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  sessionStorage.clear();
  mockPages.admin = "throw";
  mockPages.register = "throw";
  navigateFn = null;
  await i18n.changeLanguage("en");
  stubFetch();
  reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree — 整頁 lazy route 的 ErrorBoundary 接線（#201）", () => {
  it("/admin/users（frame=app）：AdminPage chunk 失敗（旗標已設）→ 錯誤畫面＋重試、不 reload、旗標仍在", async () => {
    // 前置斷言（見檔頭）：AdminPage 的 lazy 還沒被任何先前的案子觸發過
    expect(mockPages.adminLoaded).toBe(false);
    sessionStorage.setItem(ADMIN_FLAG, "1");
    renderAt("/admin/users");

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(ADMIN_FLAG)).toBe("1");
  });

  it("/admin/users：AdminPage 正常 render（旗標已設）→ beacon 清掉 admin 旗標", async () => {
    sessionStorage.setItem(ADMIN_FLAG, "1"); // 先種：起始為空的話刪掉 beacon 也綠
    mockPages.admin = "ok";
    renderAt("/admin/users");

    await waitFor(() => expect(screen.getByText("adminpage-mock-ok")).toBeInTheDocument(), { timeout: 3_000 });
    expect(sessionStorage.getItem(ADMIN_FLAG)).toBeNull();
  });

  it("/register（frame=page）：RegisterPage chunk 失敗（旗標已設）→ 錯誤畫面＋重試、不 reload、旗標仍在", async () => {
    // 前置斷言（見檔頭）：RegisterPage 的 lazy 還沒被任何先前的案子觸發過
    expect(mockPages.registerLoaded).toBe(false);
    sessionStorage.setItem(REGISTER_FLAG, "1");
    renderAt("/register");

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(REGISTER_FLAG)).toBe("1");
  });

  it("/register：RegisterPage 正常 render（旗標已設）→ beacon 清掉 register 旗標", async () => {
    sessionStorage.setItem(REGISTER_FLAG, "1");
    mockPages.register = "ok";
    renderAt("/register");

    await waitFor(() => expect(screen.getByText("registerpage-mock-ok")).toBeInTheDocument(), { timeout: 3_000 });
    expect(sessionStorage.getItem(REGISTER_FLAG)).toBeNull();
  });

  it("boundary 依 chunk 分實例：/register 錯誤畫面上 SPA 導到 /link-account → 換成 link-account 頁、不帶著 register 的錯誤", async () => {
    sessionStorage.setItem(REGISTER_FLAG, "1");
    sessionStorage.setItem(LINK_ACCOUNT_FLAG, "1");
    renderAt("/register");
    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });

    act(() => navigateFn?.("/link-account"));

    // 同一個 boundary 實例被兩條 route 共用的話，error 態會留著（resetKey 不變→不動作），
    // link-account 頁永遠出不來。
    await waitFor(() => expect(screen.getByText("linkaccountpage-mock-ok")).toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    // link-account 成功掛載只清自己的額度，不碰 register 的
    expect(sessionStorage.getItem(LINK_ACCOUNT_FLAG)).toBeNull();
    expect(sessionStorage.getItem(REGISTER_FLAG)).toBe("1");
  });
});
