import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";

// 把 PublicNotePage 換成「等測試放行才 resolve 的 stub」，讓 Suspense fallback 有
// 可斷言的窗口；同時 stub 本身零 fetch——於是「整條 /p/ 路由（含 fallback 期）完全
// 不打任何 API」就能用『fetch 從未被呼叫』一刀斷言。
// 不用 App.test.tsx 的固定延遲手法（審查 Minor：把正確性綁在 wall-clock 上，CI 慢機
// 有 flake 窗口）——手控 gate 是確定性的：第一案全程不放行（fallback 期恆成立）、
// 第二案自己放行。⚠ 兩案共用同一個 module-level gate 與 React.lazy 的 import 快取，
// 「不放行的案子在前」是順序承重，別重排。
const chunkGate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});
vi.mock("./pages/PublicNotePage", async () => {
  await chunkGate.promise;
  return { default: () => <p>public-note-page-stub</p> };
});

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

function renderApp() {
  // 任何 fetch 都是違規：/p/:token 在 RequireAuth 外，匿名訪客不該打到 /api/auth/me
  // （包 RequireAuth 的迴歸會在這裡現形——session query 一跑 fetchSpy 就有呼叫紀錄）。
  const fetchSpy = vi.fn(() => Promise.reject(new Error("public route must not fetch")));
  vi.stubGlobal("fetch", fetchSpy);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/p/${TOKEN}`]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return fetchSpy;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree — /p/:token 在 RequireAuth 外（#72 Task 3）", () => {
  it("chunk 載入中：公開頁專屬 fallback（極簡 loading，無 AppShell 側欄）；全程零 fetch", async () => {
    const fetchSpy = renderApp();

    // gate 未放行、chunk 永遠 pending——fallback 期恆成立：loading 在場、AppShell 招牌
    // （New note）不得在場——重用 NotePageFallback 會把側欄（連同 session/notes query）
    // 露給匿名者。
    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
    expect(screen.queryByText("New note")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("chunk 落地：頁面渲染、未被導去 /login、全程零 fetch（未登入不重導）", async () => {
    const fetchSpy = renderApp();

    chunkGate.release();
    await waitFor(() => expect(screen.getByText("public-note-page-stub")).toBeInTheDocument());
    // 沒被 RequireAuth 踢去登入頁
    expect(screen.queryByLabelText("Email")).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
