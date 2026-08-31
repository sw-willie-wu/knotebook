import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppErrorBoundary, ChunkLoadBeacon, NoteRouteErrorBoundary } from "./ErrorBoundary";
import { NotePageFallback } from "./NotePageFallback";

/**
 * Issue #66：NoteRouteErrorBoundary／AppErrorBoundary／ChunkLoadBeacon 的行為判準
 * （spec 案 1–10）。接線案（App.tsx 真的有包）在 App.errorBoundary.test.tsx／
 * App.appBoundary.test.tsx——這裡手組的形狀對，不代表 App.tsx 的對，兩邊都要有。
 *
 * 鑑別力紀律（本 repo 慣性缺陷形）：
 * - B 畫面與 NotePageFallback 都包 AppShell——只斷言 AppShell 招牌元素不鑑別；
 *   斷言載入畫面＝載入文案在場「且」兩支錯誤文案皆不在場，斷言 B＝分支文案/重試鈕。
 * - 凡斷言旗標狀態的案子，起始值顯式設成與期望終態相反（beforeEach 清空後直接
 *   斷言「被清」是恆真式）。
 * - 自建 lazy 的 payload 是該 lazy 物件的永久快取——每案 case 內新建，不得共用。
 */

const FLAG_KEY = "knotebook:chunk-reload:notepage";
const CHUNK_MSG = "Failed to fetch dynamically imported module: https://x/assets/NotePage-abc.js";

const LOADING_TEXT = "Loading…";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";
const CRASH_TEXT = "Something went wrong on this page.";
const RETRY_TEXT = "Try again";
const APP_CRASH_TITLE = "Something went wrong";
const RELOAD_TEXT = "Reload";
const OFFLINE_HINT = "You appear to be offline — this button will re-enable when the connection returns.";

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

// AppShell（B 畫面與 NotePageFallback 都包）需要 Router + QueryClientProvider +
// useSession 的 fetch——boundary 不接自己 fallback 丟的錯，缺任一項會以難解方式炸。
function Providers({ children }: { children: ReactNode }) {
  // useState 惰性初始化：案 8a–8d 走 rerender，直接 new 會每次重建 client
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/notes/n1"]}>{children}</MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
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

function ChunkBomb(): ReactNode {
  throw new Error(CHUNK_MSG);
}

function PlainBomb(): ReactNode {
  throw new Error("boom");
}

function setOffline() {
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
}

function restoreOnline() {
  // defineProperty 蓋的是 instance own property，刪掉即回落到 prototype getter
  delete (window.navigator as unknown as Record<string, unknown>).onLine;
}

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreOnline();
  vi.restoreAllMocks();
});

function expectLoadingScreen() {
  expect(screen.getAllByText(LOADING_TEXT).length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
  expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
}

describe("NoteRouteErrorBoundary（spec 案 1–8）", () => {
  it("案 1：chunk 錯誤（首次、online、旗標未設）→ reload 恰一次＋旗標被設；期間畫面是載入樣式非錯誤畫面", async () => {
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
    // 鑑別式斷言：載入文案在場、兩支錯誤文案皆不在場（B 也含 AppShell，只斷言
    // AppShell 招牌不鑑別）；AppShell 在場另外釘（不得是唯一斷言）。
    expectLoadingScreen();
    await waitFor(() => expect(screen.getByText("New note")).toBeInTheDocument(), { timeout: 3_000 });
  });

  it("案 2：chunk 錯誤（旗標已設）→ 不 reload，B 畫面 chunk 分支文案＋重試按鈕", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeInTheDocument();
    // #115：B 畫面包 AppShell → 窄視窗要有開抽屜的入口（NarrowTopBar 消費端
    // 明確清單之一，見 NarrowTopBar.test.tsx 檔頭）。
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  it("案 3：chunk 錯誤（offline）→ 不 reload、直接 B，且旗標未被設（離線不燒額度）", () => {
    setOffline();
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    // 離線短路必須在設旗標之前——兩步對調此斷言要紅
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
    // 離線時重試鈕 disabled：離線 reload＝把 SPA 換成瀏覽器網路錯誤頁，
    // 文案又正在叫人 check your connection，不能給一顆會炸掉 app 的鈕；
    // disabled 元素不可聚焦，要有文字說明為何灰掉
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeDisabled();
    expect(screen.getByText(OFFLINE_HINT)).toBeInTheDocument();
  });

  it("案 3b：離線進 B 後恢復連線（online 事件）→ 重試鈕重新啟用", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    setOffline();
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeDisabled();

    act(() => {
      restoreOnline();
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeEnabled();
  });

  it("案 4：按重試 → 旗標被清＋reload", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    screen.getByRole("button", { name: RETRY_TEXT }).click();
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // 案 5b/5c（PR #67 獨立審查抓到的 blocking 後補的回歸釘）：真實 bundle 的失敗
  // 訊息不是裸 import() 那三條——NotePage chunk 帶 CSS dep，走 Vite __vitePreload，
  // 離線/CSS hash 輪替時 reject 的是 Vite 自己的 CSS 訊息；反代 try_files 部署則是
  // MIME 型訊息。兩者都必須判為 chunk（旗標已設 → B 的 chunk 分支文案；若被誤判
  // 成非 chunk 會顯示 CRASH_TEXT，此案即紅）。
  it("案 5b：Vite CSS preload 失敗訊息 → 判為 chunk 類", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    function ViteCssBomb(): ReactNode {
      throw new Error("Unable to preload CSS for /assets/NotePage-CbKxQqM5.css");
    }
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ViteCssBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
  });

  it("案 5c：MIME 型訊息（try_files 反代把 404 JS 回成 text/html）→ 判為 chunk 類", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    function MimeBomb(): ReactNode {
      throw new Error(
        'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
      );
    }
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <MimeBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
  });

  it("案 5：非 chunk 錯誤 → 不 reload，B 畫面非 chunk 分支文案", () => {
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <PlainBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CRASH_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
  });

  // 案 6 用 Storage.prototype spy（實例層 spy 在 jsdom 30 靜默無效——配上先種旗標
  // 會綠得毫無意義；prototype spy 連 localStorage 一起丟錯——ThemeProvider 的
  // readStoredTheme 也走它，實測會在 boundary 外先炸——所以只對旗標 key 丟錯，
  // 其餘 key 照常回 null；逐案裝、案末還原）。
  // 不種旗標：spy 若無效會走「首次」路徑（reload＋載入畫面），下面斷言必紅。
  it("案 6a：sessionStorage 讀丟錯 → 不 reload、不炸，B 畫面", () => {
    const reload = vi.fn();
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
      if (key === FLAG_KEY) throw new Error("denied");
      return null;
    });
    try {
      render(
        <Providers>
          <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
            <ChunkBomb />
          </NoteRouteErrorBoundary>
        </Providers>,
      );
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("案 6b：sessionStorage 寫丟錯 → 不 reload、不炸，B 畫面", () => {
    const reload = vi.fn();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
      if (key === FLAG_KEY) throw new Error("denied");
    });
    try {
      render(
        <Providers>
          <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
            <ChunkBomb />
          </NoteRouteErrorBoundary>
        </Providers>,
      );
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("案 7：reload 丟錯 → 進 B（不停在 reloading），且剛設的旗標被清回", () => {
    const reload = vi.fn(() => {
      throw new Error("reload blocked");
    });
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    // 實際沒 reload 成，旗標留著會偷走下次真失敗的救援額度
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
  });

  it("案 8a：error 態下 resetKey 變化（online）→ reload 且旗標不被清", () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // 先種：進 B＋「不被清」才不是恆真式
    const reload = vi.fn();
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
  });

  it("案 8b：error 態下 resetKey 變化（offline）→ 不 reload、維持 B", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    setOffline();
    const reload = vi.fn();
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
  });

  it("案 8c：導航 reload 丟錯 → 維持 B、不冒泡（componentDidUpdate 的 try/catch）", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn(() => {
      throw new Error("reload blocked");
    });
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
  });

  it("案 8d：reloading 態下 resetKey 變化 → 不再 reload", () => {
    const reload = vi.fn();
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    // 首次：進 reloading，reload 一次
    expect(reload).toHaveBeenCalledTimes(1);
    expectLoadingScreen();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expectLoadingScreen();
  });
});

describe("ChunkLoadBeacon（spec 案 9／9a，真實 suspend→reject 時間軸）", () => {
  it("案 9：成功 commit → 旗標被清（先種；起始為空的話刪掉 beacon 也綠——恆真）", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    const Lazy = lazy(() => Promise.resolve({ default: () => <p>lazy-ok</p> }));
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <Suspense fallback={<NotePageFallback />}>
            <Lazy />
            <ChunkLoadBeacon />
          </Suspense>
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    await waitFor(() => expect(screen.getByText("lazy-ok")).toBeInTheDocument(), { timeout: 3_000 });
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("案 9a：lazy reject → beacon 不執行、旗標仍在 → 判「已 reload 過」→ 不 reload、進 B（beacon 擺放不變量）", async () => {
    // 先種旗標。起始為空的版本兩種擺放終態相同（都是設旗標＋reload），抓不到錯放；
    // 先種之後：正確擺放＝beacon 不跑→旗標在→不 reload＋B；錯放到 Suspense 外＝
    // beacon 在 pending 期清旗標→判首次→reload＋載入畫面——三個觀測量同時分岔。
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    const Lazy = lazy(() => Promise.reject(new Error(CHUNK_MSG)));
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <Suspense fallback={<NotePageFallback />}>
            <Lazy />
            <ChunkLoadBeacon />
          </Suspense>
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });
    // 守門的是上下兩條（錯放＝reload 1 次＋載入畫面，兩者同時紅）；「旗標仍在」在
    // 錯放下也成立（beacon 清掉後 componentDidCatch 又設回去）——它是輔助斷言，
    // 精簡時不得只留它。
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
  });
});

describe("AppErrorBoundary（spec 案 10）", () => {
  it("案 10：子元件 render 丟錯 → app 級 fallback（無白屏），按鈕觸發 reload", () => {
    const reload = vi.fn();
    render(
      <AppErrorBoundary reload={reload}>
        <PlainBomb />
      </AppErrorBoundary>,
    );

    expect(screen.getByText(APP_CRASH_TITLE)).toBeInTheDocument();
    // #115 反向斷言：app 級兜底**刻意不掛** NarrowTopBar/SidebarDrawerButton——
    // 它的不變量是零 context 相依（不用 AppShell；錯誤可能正來自 auth/query），
    // 掛上去要嘛在兜底畫面裡再拋 context 錯誤、要嘛是死鈕。日後「順手補一致性」
    // 把它加上來，這條就紅。
    expect(screen.queryByRole("button", { name: "Open navigation" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: RELOAD_TEXT }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("案 10b：離線時重整鈕 disabled（離線 reload＝瀏覽器網路錯誤頁）", () => {
    setOffline();
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <PlainBomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: RELOAD_TEXT })).toBeDisabled();
    expect(screen.getByText(OFFLINE_HINT)).toBeInTheDocument();
  });
});
