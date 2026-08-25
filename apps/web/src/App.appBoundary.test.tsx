import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import App from "./App";

/**
 * Issue #66 接線案 12：釘預設匯出的 App() 最外層**真的**包了 AppErrorBoundary——
 * 其餘測試都只 render AppRoutes，app 級那層在那些路徑上根本不會被執行到。
 *
 * 獨立成第三個檔案（不與案 11/11a 同檔）：這裡的 vi.mock("./pages/HomePage") 是
 * 檔案級 hoisted，同檔的話任何走到 `/` 的案子都會莫名拿到 app 級 fallback。
 *
 * 前提：render 預設匯出 App＝內含 BrowserRouter，讀真實 window.location——
 * **不得 stub location**（router 會拿到假 Location 而炸）；vitest jsdom 環境預設
 * URL 是 http://localhost:3000/，pathname `/` 走 catch-all → HomePage（mock 丟
 * 非 chunk 錯誤）。QueryClientProvider 由測試自備（App 不含，提供者在 main.tsx）。
 */

vi.mock("./pages/HomePage", () => ({
  default: function HomePageMock(): never {
    throw new Error("render crash from homepage");
  },
}));

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

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage("en");
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App — app 級 ErrorBoundary 接線（issue #66 案 12）", () => {
  it("案 12：樹內 render 丟非 chunk 錯誤 → app 級 fallback 專屬文案（無白屏）", async () => {
    const queryClient = new QueryClient();
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );

    // timeout 放寬：最終狀態等待，守門力在斷言內容；預設 1s 冷啟下餘裕太薄
    await waitFor(() => expect(screen.getByText("Something went wrong")).toBeInTheDocument(), { timeout: 3_000 });
  });
});
