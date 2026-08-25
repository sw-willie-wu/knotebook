import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

/**
 * Issue #66 接線案 11／11a：釘 App.tsx **真的**把 /notes/:ref 包進
 * NoteRouteErrorBoundary、且 ChunkLoadBeacon 真的在 Suspense 內——boundary 元件
 * 自身的行為在 ErrorBoundary.test.tsx，那裡手組的形狀對不代表 App.tsx 的對。
 * 案 12（app 級接線）在 App.appBoundary.test.tsx（它的 HomePage mock 是檔案級
 * hoisted，同檔會與本檔案互相耦合）。
 *
 * ⚠⚠ 案 11 必須宣告在 11a 之前，不得調換、也不得在案 11 前插入任何會成功
 * render /notes/:ref 的新案：App.tsx 的 NotePage lazy 是模組級單例，同一個測試檔
 * 只有第一個觸發它的案子會經過 suspend 期。「beacon 錯放到 Suspense 外 → 案 11 紅」
 * 這道守門（本設計最嚴重故障形＝無限重整迴圈）靠的正是案 11 那次 render 有
 * pending 期——錯放的 beacon 會在該期 commit、清掉種下的旗標，讓 componentDidCatch
 * 誤判「首次」而走 reload＋載入畫面，案 11 對 B 專屬文案的斷言因此變紅。11a 若
 * 先跑把 lazy resolve 掉，案 11 變純同步 throw、beacon 根本不 commit，這道守門
 * 就靜靜失效。
 */

// vi.mock 是 hoisted 的，factory 不得引用模組頂層 const（TDZ）——共享狀態一律走
// vi.hoisted。旗標必須在 mock 元件**函式本體內**讀：import 結果被 React.lazy 永久
// 快取、factory 只執行一次，在 factory 層決定匯出哪個元件的話第二案拿到的仍是
// 第一案的行為。
const mockNotePage = vi.hoisted(() => ({
  mode: "throw" as "throw" | "ok",
  chunkMessage: "Failed to fetch dynamically imported module: https://x/assets/NotePage-abc.js",
}));

vi.mock("./pages/NotePage", () => ({
  default: function NotePageMock() {
    if (mockNotePage.mode === "throw") throw new Error(mockNotePage.chunkMessage);
    return <p>notepage-mock-ok</p>;
  },
}));

const FLAG_KEY = "knotebook:chunk-reload:notepage";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";

const ADMIN_USER: UserDto = {
  id: "u1",
  email: "admin@example.com",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
};

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

function stubFetch() {
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
}

function renderNoteRoute() {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/notes/11111111-1111-1111-1111-111111111111"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  sessionStorage.clear();
  // 預設值：新增案子忘了設 mode 時沿用上一案的模式會很難查（且案 11 必須是第一
  // 個、順序不能動），這裡固定歸位
  mockNotePage.mode = "throw";
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree — /notes/:ref 的 ErrorBoundary 接線（issue #66 案 11／11a）", () => {
  // 案 11 在前（見檔頭警告）。先種旗標：讓 A 路徑短路進 B，期望結果才是可斷言的
  // 穩態；同時讓「beacon 錯放」有旗標可偷清。
  it("案 11：NotePage render 丟 chunk 錯誤（旗標已設）→ B 畫面而非白屏（斷言 B 專屬元素）", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    mockNotePage.mode = "throw";
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });

    renderNoteRoute();

    // B 專屬元素（chunk 分支文案＋重試鈕）。⚠ 不得改斷 AppShell 招牌（「New note」）
    // ——B 畫面與 Suspense fallback 都包 AppShell，那樣拿掉 boundary 也綠。
    // timeout 放寬：這是「最終到達某狀態」的等待，守門力在斷言內容不在等待長度；
    // 預設 1s 在冷啟高負載下（fetch→react-query→lazy→分類→setState 整條鏈）餘裕太薄
    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("案 11a：NotePage 正常 render（旗標已設）→ beacon 清旗標（clear-on-success 的接線）", async () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // 先種：起始為空的話刪掉 beacon 也綠——恆真
    mockNotePage.mode = "ok";

    renderNoteRoute();

    await waitFor(() => expect(screen.getByText("notepage-mock-ok")).toBeInTheDocument(), { timeout: 3_000 });
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
  });
});
