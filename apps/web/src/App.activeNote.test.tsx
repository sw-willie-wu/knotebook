import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import App from "./App";

/**
 * #122 接線案：釘預設匯出的 App() **真的**把 ActiveNoteProvider 包在 AppRoutes 外
 * （App.tsx 的 provider 那三行）。其餘測試都自備 provider 再 render AppRoutes——
 * 正式樹的這層接線在那些路徑上根本不會被執行到；而 useActiveNote 是 fail-loud，
 * 漏了這層的代價是**所有已登入頁面**（側欄每一列都消費 context）被 app 級
 * ErrorBoundary 接成 fallback、整站白屏頁（突變審查：拿掉 provider 原本全套仍綠）。
 *
 * 前提同 App.appBoundary.test：render 預設匯出 App＝內含 BrowserRouter、讀真實
 * window.location（jsdom 預設 `/` → HomePage，側欄 NoteList 渲染 stub 回的筆記）。
 */

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Wired Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "wired-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
};

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

describe("App — ActiveNoteProvider 接線（#122）", () => {
  beforeEach(async () => {
    sessionStorage.clear();
    await i18n.changeLanguage("en");
    window.history.replaceState(null, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes") {
          // ⚠ 必須回**非空**清單：NoteRow 才會 render、useActiveNote 才會被呼叫——
          // 空清單下有沒有 provider 都綠，這支測試就空轉了。
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([NOTE]) }));
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("正式樹渲染側欄筆記列（消費 context）而不落 app 級 fallback——provider 漏接時這裡必紅", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Wired Note" }).length).toBeGreaterThan(0));
    // app 級 fallback 的實際文案是 app.crashTitle（比照 App.appBoundary.test 的
    // APP_CRASH_TITLE）——別寫成 errors.internal 那句，那是死守衛（突變審查抓到）。
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();
  });
});
