import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { Toaster } from "@/components/ui/toast";
import { AppRoutes } from "./App";

/**
 * Issue #68：NoteRouteErrorBoundary 的 resetKey 選型（`useParams().ref` 而非
 * `location.key`）的整合守門——**在 /notes/:ref 的錯誤畫面上開、關設定 modal，
 * 不得觸發 reload**。
 *
 * 機制（審查探針三步實測數據，改壞會直接對不上）：
 * - 初始 /notes/my-note：location.key=`default`、params.ref=`my-note`
 * - 開設定 modal：主樹 `<Routes location={backgroundLocation}>` 覆寫 context，
 *   NoteRoute 讀到的是被保存的背景 location——key **仍 `default`**、ref 不變，
 *   boundary 實例不重掛、error 態保留
 * - 關閉 modal：SettingsModal 走 `navigate(backgroundLocation)`，react-router 8
 *   對 Location 物件導航會產生**新的 key**（實測 `so4qa1lk` 之類）——ref 仍
 *   `my-note`。**若 resetKey 是 location.key，componentDidUpdate 就在這一步
 *   reload**（突變驗證：把 App.tsx 的 resetKey 改成 useLocation().key → 本檔
 *   主案紅 reload=1、control 案仍綠；兩案一起紅＝harness 壞了不是突變被抓到）。
 *
 * 獨立成檔：SettingsModal.test.tsx 的多案斷言依賴真 NotePage 替身（note-editor
 * testid），檔案級 mock 掉 NotePage 會廢掉它們；App.errorBoundary.test.tsx 則是
 * 最小接線判準的定位，本檔需要 Toaster＋設定樹＋UserMenu 整套 harness。
 */

// vi.mock 是 hoisted 的，factory 不得引用檔頭 const（TDZ）——message 內聯。
// 一律 throw：主案/control 案的路徑分歧由旗標（種/不種）決定，與 mock 無關，
// 因此本檔**沒有**案子順序相依（不像 App.errorBoundary.test.tsx 的案 11）。
vi.mock("./pages/NotePage", () => ({
  default: function NotePageMock(): never {
    throw new Error("Failed to fetch dynamically imported module: https://x/assets/NotePage-abc.js");
  },
}));

const FLAG_KEY = "knotebook:chunk-reload:notepage";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";
const CRASH_TEXT = "Something went wrong on this page.";
const LOADING_TEXT = "Loading…";

const PLAIN_USER: UserDto = {
  id: "u-plain",
  email: "plain@example.com",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u-plain",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
};

const OTHER_NOTE: NoteDto = {
  id: "22222222-2222-2222-2222-222222222222",
  title: "Other Note",
  ownerId: "u-plain",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "other-note",
};

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PLAIN_USER) }));
      }
      if (url === "/api/notes" && method === "GET") {
        // 第三案要從側欄點另一篇：清單給兩篇
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([NOTE, OTHER_NOTE]) }));
      }
      if (url.endsWith("/backlinks") && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) }));
      }
      if (url.startsWith("/api/notes/") && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(NOTE) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** App.tsx 接線不傳 reload prop、boundary 走預設 `location.reload()`——只能從
 * global 攔（App.errorBoundary.test.tsx 案 11 同法；MemoryRouter 不讀 global
 * location，兩把 stubGlobal 互不干擾）。 */
function stubLocationReload() {
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  return reload;
}

function renderNoteRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** DropdownMenuTrigger（UserMenu）只掛 onPointerDown，純 fireEvent.click 開不了
 * （SettingsModal.test.tsx 既有註解）。錯誤畫面（B）包完整 AppShell，UserMenu
 * 可正常互動——審查探針已實測。 */
function openUserMenu(userDisplayName: string): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: userDisplayName }), { button: 0 });
}

beforeEach(async () => {
  sessionStorage.clear(); // 旗標各案自設：主案種（進 B 穩態）、control 案不種
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resetKey 選型守門——錯誤畫面上開/關設定 modal 不觸發 reload（issue #68）", () => {
  it("主案：B 畫面上開設定 → 關閉（navigate(backgroundLocation) 產新 location key）→ reload 零次、錯誤畫面仍在", async () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // 短路自動 reload，進 B 穩態
    const reload = stubLocationReload();

    renderNoteRoute();

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });
    expect(reload).not.toHaveBeenCalled();

    openUserMenu("Plain");
    fireEvent.click(screen.getByText("Settings"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    // 開 modal 期間：背景 location（含其 key）被保存原封不動，ref 不變 → 不 reload；
    // 背景錯誤畫面仍在 DOM（Radix aria-hidden 不影響 getByText）
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 3_000 });
    // 關鍵斷言：關閉走 navigate(backgroundLocation) → location key 換新、ref 沒變
    // → resetKey（=ref）不動 → 不 reload。resetKey 若改回 location.key，這裡紅。
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  // Positive control：證明主案攔的那條 spy 路徑是活的——旗標不種 → componentDidCatch
  // 走首次路徑 → 經真實 App.tsx 接線的**預設** seam（location.reload()）自動 reload
  // 恰一次＋停在載入畫面。seam 或 stubGlobal 行為若哪天斷了，此案先紅，主案的
  // 「spy=0」才不會淪為守著空氣的負向斷言。
  // 前提：jsdom 預設 navigator.onLine === true（審查實測）——主案突變能紅、本案能
  // reload 都依賴它；若 jsdom 改預設，離線分支會讓兩案假綠/假紅，先查這條。
  it("positive control：旗標不種 → 真實接線的預設 seam 自動 reload 恰一次＋載入畫面", async () => {
    const reload = stubLocationReload();

    renderNoteRoute();

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    // 載入畫面（reloading 態）而非錯誤畫面——鑑別式斷言（兩畫面都含 AppShell）
    expect(screen.getAllByText(LOADING_TEXT).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
    // 「恰一次」在 waitFor 外再釘一遍——waitFor 內那句只保證「曾達到 1」
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // 第二個 control（#69 審查補）：上面那案證明 componentDidCatch → 預設 seam 活著，
  // 主案守的卻是 componentDidUpdate → 預設 seam ——單元層案 8a 走的是注入 prop。
  // 若有人把 componentDidUpdate 改成直接呼叫 window.location.reload()（繞過
  // doReload），主案會靜靜退化成恆真而上面的 control 照樣綠。這一案封住交集：
  // 錯誤畫面上點側欄**另一篇**筆記（ref 真的變）→ componentDidUpdate 經預設
  // seam reload 恰一次。
  it("control 2：錯誤畫面上導航到另一篇筆記 → componentDidUpdate 經預設 seam reload 恰一次", async () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // 進 B 穩態
    const reload = stubLocationReload();

    renderNoteRoute();

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument(), { timeout: 3_000 });
    expect(reload).not.toHaveBeenCalled();

    // 側欄清單載入後點另一篇（react-router Link，MemoryRouter 內正常導航）
    await waitFor(() => expect(screen.getByRole("link", { name: /Other Note/ })).toBeInTheDocument(), {
      timeout: 3_000,
    });
    fireEvent.click(screen.getByRole("link", { name: /Other Note/ }));

    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    expect(reload).toHaveBeenCalledTimes(1);
    // 旗標不被清（導航觸發的 reload 不清旗標——spec §resetKey；落地若又失敗直接進 B）
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
  });
});
