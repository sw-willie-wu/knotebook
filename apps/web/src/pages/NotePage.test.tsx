import { useEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, canonicalNotePath, type BacklinkDto, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider, useActiveNote } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import type { CollabState } from "@/collab/connection";

// BlockNote 需要一整套 jsdom 沒有的 DOM/Range API，掛進單元測試只會測到環境；
// 這裡只驗證「頁面有沒有把正確的 props 交給編輯器」，編輯器本身留給手動驗證。
//
// PR2（BLK-1）：NoteEditor slot 化——舊版 mock 只吃 `editable`，slot 化後會把整個
// 頁頭（TitleInput/ConnectionBadge/分享鈕/⋮）與 backlinks chips 一起吞掉。改為原樣
// 渲染 `headerSlot`/`footerSlot`，讓下面依賴 `getByLabelText("Note title")` 等查詢的
// 既有測試在新結構下繼續照過。`SettingsModal.test.tsx` 有第二處綁定同一份 mock 形狀
// （該檔檔頭自述沿用這裡的最小替身慣例），兩處要同步改。
vi.mock("@/components/NoteEditor", () => ({
  NoteEditor: ({
    editable,
    headerSlot,
    footerSlot,
  }: {
    editable: boolean;
    headerSlot?: ReactNode;
    footerSlot?: ReactNode;
  }) => (
    <div data-testid="note-editor" data-editable={String(editable)}>
      {headerSlot}
      {footerSlot}
    </div>
  ),
}));

/** `provider.on("synced", …)`／`.off(…)`／`.synced` 的最小替身（Task 7）。多數既有測試
 * 不主動 emit、`synced` 也維持預設 `false`——那些測試裡 link-sync 狀態機不會送出任何
 * `POST .../links`（`onSynced()` 是它唯一的提交觸發點，見 `link-sync.ts`）。但「Task 7
 * 接線」那組測試會主動呼叫 `.emit("synced", …)` 或把 `.synced` 直接設 `true`——這支替身
 * 兩種用法都要撐得住，`mockFetch` 的 `POST .../links` → 204 分支正是那些測試依賴的
 * 成功回應（不是單純防禦性備而不用）。 */
function createStubProvider() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    synced: false,
    on(event: string, fn: (...args: unknown[]) => void) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    /** 直接呼叫所有透過 `.on(event, …)` 註冊過的 handler——**不是**先設
     * `synced = true` 再讓 `NotePage` 掛載 effect 裡的
     * `if (provider.synced) handleSynced()` 補呼叫那條路徑。用 `emit` 才是真的在戳
     * `provider.on("synced", handleSynced)` 這行**訂閱本身**有沒有接上：若那行被拿掉，
     * `listeners` 裡就不會有任何 handler，`emit` 什麼都不會發生。 */
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
  };
}

// useCollab 的真實行為（HocuspocusProvider + WebSocket）不進 jsdom；狀態機本身
// 有 connection.test.ts 全覆蓋。這裡把它換成一個可由測試直接擺弄的假回傳值，
// 驗證 NotePage 對每個 phase 的反應。
//
// `doc`/`provider` 換成 Task 7 之前的 `{fake:"doc"}`/`{fake:"provider"}` 會讓
// `NotePage` 的 link-sync 掛載 effect（`doc.on("update",…)`／`provider.on("synced",…)`）
// 直接 TypeError（那兩個替身沒有 `.on`）：`doc` 換一個**真的** `Y.Doc`、`provider` 換
// 上面的最小 `on`/`off`/`synced` 替身。兩者都放進這個 `vi.hoisted` 模組級物件、由
// `beforeEach` 逐測試重建（見下）——**不能**改成 mock 工廠裡每次呼叫 `useCollab()`
// 都新建一份：link-sync 的掛載 effect deps 是 `[noteId, doc, provider]`，逐 render
// 給新物件會讓它每個 render 都 teardown 再重訂閱，在真實情境下會讓 provider 的
// `synced`（只在 false→true 邊緣 emit 一次）被錯過訂閱窗口。
/** m14 專用的 navigate 攔截縫：預設 `undefined`＝走真的 useNavigate；單一測試把
 * `navSpy.current` 設成 vi.fn() 可**壓住導頁**，觀察「解析 404 的那幾個 render」
 * 畫面停在哪一格（否則 navigate 太快、中間態無法斷言）。afterEach 歸零。 */
const navSpy = vi.hoisted(() => ({ current: undefined as ((to: unknown, opts?: unknown) => void) | undefined }));
vi.mock("react-router", async (importOriginal) => {
  const mod = await importOriginal<typeof import("react-router")>();
  return {
    ...mod,
    useNavigate: () => {
      const real = mod.useNavigate();
      return navSpy.current ?? real;
    },
  };
});

const collab = vi.hoisted(() => ({
  state: { phase: "connecting" } as CollabState,
  onUnauthorized: undefined as (() => void) | undefined,
  doc: undefined as unknown as Y.Doc,
  provider: undefined as unknown as ReturnType<typeof createStubProvider>,
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ onUnauthorized }: { onUnauthorized: () => void }) => {
    collab.onUnauthorized = onUnauthorized;
    // issue #48：NotePage 用 `synced` 閘住 editable。真實 useCollab 的 `synced` 是 sticky
    // 追蹤 `provider.synced`，測試裡直接反映 stub 的 `provider.synced`——設一處就同時餵
    // editable 與 link-sync 掛載 effect。
    return { state: collab.state, doc: collab.doc, provider: collab.provider, synced: collab.provider.synced };
  },
}));

const { default: NotePage, scheduleTerminalReconcile } = await import("./NotePage");

/** 與 NotePage 內同名常數對齊；輪詢輪數的斷言用得到。 */
const RECONCILE_INTERVAL_MS = 750;
const RECONCILE_TIMEOUT_MS = 6_000;

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

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
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
};

/** `/api/auth/me`、`/api/notes`（清單）、`/api/notes/:ref`（單篇）三支的假 server。
 * `backlinks` 參數預設空陣列（既有測試全部維持「0 篇→整塊隱藏」不干擾），佈局回饋
 * 那組新測試會傳非空陣列逼 `BacklinksSection` 真的渲染出 `<details>`。 */
function mockFetch(
  note: NoteDto | { status: number; code: string } = NOTE,
  backlinks: BacklinkDto[] = [],
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth/me") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
    }
    if (url === "/api/notes" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    // Task 6b：backlinks 折疊區塊的 fetch（`useBacklinks`）。必須放在下面的
    // `GET /api/notes/` catch-all 之前——`/api/notes/:id/backlinks` 也會匹配那個
    // `startsWith` 判斷，若順序反了，backlinks 請求會被誤餵成 NoteDto（catch-all
    // 分支回的是 `note` 而不是 `{backlinks:[]}`），這支測試檔案裡的 NotePage 測試
    // 多數不驗證 backlinks 內容，固定回空陣列即可（0 篇時 `BacklinksSection` 整塊
    // 隱藏，不干擾既有斷言）；佈局回饋那組測試會傳非空陣列。
    if (url.endsWith("/backlinks") && method === "GET") {
      return Promise.resolve(
        fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks }) }),
      );
    }
    if (url.startsWith("/api/notes/") && method === "GET") {
      if ("status" in note) {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: note.status,
            json: () => Promise.resolve({ error: { code: note.code, message: "x" } }),
          }),
        );
      }
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(note) }));
    }
    // Task 7：link-sync 的提交端點。「Task 7 接線」那組測試會主動 emit `"synced"`
    // 事件（或直接把 `collab.provider.synced` 設 `true`）觸發真的提交，這支就是那些
    // 測試依賴的成功回應（204）——不是備而不用的防禦性分支。
    if (url.endsWith("/links") && method === "POST") {
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

/** #122：ActiveNoteContext 的觀測探針——NotePage 的 set/清除行為靠它斷言。 */
function ActiveProbe() {
  const { activeNoteId } = useActiveNote();
  return <div data-testid="active-probe">{activeNoteId ?? "none"}</div>;
}

/** 模擬 NoteList 的樂觀 set：掛載時把 `id` 種進 context（A6 案的殘留來源）。
 * `id` 選填且元件**恆掛載**——provider 的 children 形狀必須在 render 與 rerender 之間
 * 穩定（child 位移會讓 React 把 NotePage 整棵 remount，previousRoleRef 之類的頁內
 * state 全部歸零，N4 那組 rerender 案就假紅了）。 */
function SeedActive({ id }: { id?: string }) {
  const { setActiveNoteId } = useActiveNote();
  useEffect(() => {
    if (id !== undefined) setActiveNoteId(id);
  }, [id, setActiveNoteId]);
  return null;
}

/** renderNotePage 與各 rerender 案共用的 provider 內部樹——單一定義保證形狀一致。 */
function NotePageTree({ seedActiveId }: { seedActiveId?: string }) {
  return (
    <ActiveNoteProvider>
      <SeedActive id={seedActiveId} />
      <ActiveProbe />
      <Routes>
        <Route path="/notes/:ref" element={<NotePage />} />
        <Route path="/" element={<div>home landing</div>} />
      </Routes>
    </ActiveNoteProvider>
  );
}

function renderNotePage(ref: string, options: { seedActiveId?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/notes/${ref}`]}>
          <NotePageTree seedActiveId={options.seedActiveId} />
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("NotePage", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    collab.state = { phase: "connecting" };
    collab.doc = new Y.Doc();
    collab.provider = createStubProvider();
    window.history.replaceState(null, "", "/");
    // toast store 是模組層級的，不歸零的話上一個測試的 toast 會留在畫面上。
    dismissAllToasts();
  });

  afterEach(() => {
    collab.doc.destroy();
    vi.unstubAllGlobals();
    navSpy.current = undefined;
  });

  it("以 slug 開頁：解析出筆記、把網址 replaceState 成 canonical、掛上編輯器", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true; // 正常開頁路徑：同步過才有可編輯的標題 input（issue #48）
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);

    renderNotePage(NOTE.id);

    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(screen.getByLabelText("Note title")).toHaveValue("My Note");
    // 有自訂 slug → canonical 是 `/notes/<slug>`，不是開頁時用的 uuid。
    expect(window.location.pathname).toBe(canonicalNotePath(NOTE));
  });

  it("issue #48：從未同步過的連線（開頁就連不上）→ 即使 REST 角色是 owner 也唯讀", async () => {
    // 第一次 sync 之前，本機 Y.Doc 是空的——「可編輯」等於在一篇空白但看似正常的筆記上
    // 打字，重整就沒了。此時必須唯讀，不管 REST 給的角色多高。
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = false;

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
    // ⚠ 但標題**仍可編輯**（issue #48 審查）：標題走 REST 的 last-write-wins、不走 Yjs，
    // 連不上共編但 REST 正常時改標題完全安全。跟著 synced 一起鎖死是功能倒退。
    expect(screen.getByLabelText("Note title")).toBeInTheDocument();
  });

  it("issue #48：同步過一次之後就可編輯（owner）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));
  });

  it("Task 7 接線：owner 掛載後 provider 觸發 synced 事件 → 真的打 POST /api/notes/:id/links（驗證 provider.on(\"synced\",…) 掛載接線本身，不是只測 link-sync 內部狀態機）", async () => {
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);

    renderNotePage("my-note");
    // 不看 editable（那要 synced，而這條專門測「emit synced 事件路徑」，不能先設
    // provider.synced=true，否則走的是護欄③的 getter 補呼叫、不是事件本身）。
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());

    // 用 `emit` 直接呼叫透過 `.on("synced", …)` 註冊的 handler——這條路徑非過
    // `provider.synced` 這個 getter 補呼叫（見 `createStubProvider` 註解），專門戳
    // NotePage 掛載 effect 裡 `provider.on("synced", handleSynced)` 這行訂閱本身。
    collab.provider.emit("synced", { state: true });

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/notes/${NOTE.id}/links`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("護欄③：effect 掛載前 provider 已 synced ⇒ 不靠事件也補提交一次", async () => {
    // 掛載 effect 訂閱 `provider.on("synced", …)` 之後，緊接著檢查一次
    // `if (provider.synced) handleSynced()`——這條補呼叫是專門對付「effect 是在
    // provider 早已同步完成之後才掛上去」的邊緣情形（StrictMode 重掛、或本來就慢了
    // 一步），false→true 那個邊緣事件已經 emit 過、不會再等到。這裡刻意**不** emit
    // 任何事件，只把 `synced` 這個狀態設成 `true`，逼 NotePage 只能靠這條補呼叫線路
    // 才會提交——若那行被拿掉，這裡永遠等不到 POST。
    const fetchSpy = mockFetch();
    vi.stubGlobal("fetch", fetchSpy);
    collab.provider.synced = true;

    renderNotePage("my-note");

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(
        `/api/notes/${NOTE.id}/links`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("Task 7 啟動條件：viewer fixture（canEdit 為假）⇒ 不 start() ⇒ 即使 synced 事件觸發也不提交", async () => {
    const fetchSpy = mockFetch({ ...NOTE, role: "viewer" });
    vi.stubGlobal("fetch", fetchSpy);

    renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));

    collab.provider.emit("synced", { state: true });
    // link-sync 的 `onSynced()` 在 `!started` 時完全同步 no-op（見 link-sync.ts），
    // 這裡多等一輪 microtask/宏任務只是保守起見，避免漏抓任何非同步分支。
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchSpy).not.toHaveBeenCalledWith(`/api/notes/${NOTE.id}/links`, expect.anything());
  });

  it("connected 且角色是 viewer → 編輯器唯讀、標題變純文字", async () => {
    vi.stubGlobal("fetch", mockFetch({ ...NOTE, role: "viewer" }));
    collab.state = { phase: "connected", role: "viewer" };

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    // PR2（BLK-1）：`container.querySelector("header")` 範圍化——單純的
    // `queryByLabelText(...).not.toBeInTheDocument()` 在新 mock 下即使 headerSlot
    // 整個沒渲染也會通過（vacuous pass）；範圍化到 header 內同時斷言「heading 在」
    // 與「textbox 不在」，才把鑑別力綁回同一個容器上。
    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(within(header!).getByRole("heading", { name: "My Note" })).toBeInTheDocument();
    expect(within(header!).queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  // #115：頁首回滿卡寬（置左置右）——單層 header 自己就是內容列，標題貼左、
  // 控制項貼右，`px-5`（20px）與 `<md` 內文左緣共線。#88 的「內容列套文章欄」
  // 是被本改版刻意拆掉的行為（守衛端的反向掃描見 article-column.guard.test.ts
  // (d)：NotePage 不得再 import 文章欄常數）。
  it("#115：頁首單層滿卡寬（px-5，不再套文章欄）", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");
    await screen.findByTestId("note-editor");

    const header = document.querySelector("header");
    expect(header).not.toBeNull();
    expect(header).toHaveClass("flex", "items-center", "gap-3", "border-b", "border-border", "px-5", "py-3");
    expect(header).toContainElement(screen.getByLabelText("Note title"));
    // #115：頁首最前面是 `md:hidden` 的漢堡鈕（窄視窗開抽屜的入口——筆記頁沒有
    // NarrowTopBar，這顆就是唯一入口）。
    expect(header).toContainElement(screen.getByRole("button", { name: "Open navigation" }));
  });

  it("N4 降級：connected(owner) → connected(viewer) 時 toast 並切成唯讀", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };
    collab.provider.synced = true;

    const { rerender, queryClient } = renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));

    collab.state = { phase: "connected", role: "viewer" };
    rerender(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}><NotePageTree /></MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    await waitFor(() =>
      expect(screen.getByText("Your access changed to viewer. This note is now read-only.")).toBeInTheDocument(),
    );
  });

  it("角色變 'none'（撤權流程的前半段）不報「已改為檢視者」——那會跟隨後的撤權提示矛盾", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "editor" };
    collab.provider.synced = true;

    const { rerender, queryClient } = renderNotePage("my-note");
    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));

    collab.state = { phase: "connected", role: "none" };
    rerender(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}><NotePageTree /></MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    expect(screen.queryByText("Your access changed to viewer. This note is now read-only.")).not.toBeInTheDocument();
  });

  it("kicked 終態 → toast「已失去存取權」並導回 /", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "kicked" };

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("You no longer have access to this note.")).toBeInTheDocument();
    // 撤權的 close reason 常數本身由 shared 提供，client 只認 reason 字串（code 硬寫 1000）。
    expect(COLLAB_CLOSE_REVOKED).toBe("knotebook:revoked");
  });

  it("deleted 終態 → toast 並導回 /", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "deleted" };

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This note has been deleted.")).toBeInTheDocument();
  });

  it("首次解析 404 → **linkInvalid** 文案（A10：不得沿用「筆記已刪」）並導回 /", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    renderNotePage("gone");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
  });

  // ── #122：ActiveNoteContext 接線（set-after-load／404 清殘留／卸載條件清除） ──

  it("解析成功後 set active（最終校正點——直接進網址/書籤也會亮，樂觀誤 set 由此校正）", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;

    // seed 一個錯的 id（模擬樂觀誤 set）——解析成功後必須被校正成真的
    renderNotePage(NOTE.id, { seedActiveId: "99999999-9999-4999-8999-999999999999" });

    // 先確認誤 set 真的在場（不是一路都對的空轉），再斷校正
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent("99999999"));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id));
  });

  it("真接線的卸載清除：關頁滅（current===自己→清）；他頁搶先 set→**不誤清**（條件清除）", async () => {
    // active-note.test 的競態案守的是復刻 Page——這裡把同兩條語意釘在**真的 NotePage**
    // 上（突變審查：把 NotePage 的 cleanup 改成無條件清 null，原本全套仍綠）。
    vi.stubGlobal("fetch", mockFetch());
    collab.provider.synced = true;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const OTHER_ID = "22222222-2222-4222-8222-222222222222";
    // withPage=false 時同一個 child 槽位換成 <div/>——NotePage 卸載、provider/probe 留著
    const tree = (withPage: boolean, seedActiveId?: string) => (
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/notes/${NOTE.id}`]}>
            <ActiveNoteProvider>
              <SeedActive id={seedActiveId} />
              <ActiveProbe />
              {withPage ? (
                <Routes>
                  <Route path="/notes/:ref" element={<NotePage />} />
                  <Route path="/" element={<div>home landing</div>} />
                </Routes>
              ) : (
                <div />
              )}
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>
    );

    const view = render(tree(true));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id));

    // 關頁滅：卸載 NotePage → cleanup（current===自己）→ 清空
    view.rerender(tree(false));
    expect(screen.getByTestId("active-probe")).toHaveTextContent("none");

    // 競態不誤清：重開頁亮起後，他頁（模擬 NoteList 樂觀 set）搶先 set 另一 id，
    // 再卸載本頁——cleanup 帶舊 id、current 已是別人，不得把剛亮起來的高亮滅掉
    view.rerender(tree(true));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id));
    view.rerender(tree(true, OTHER_ID));
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent(OTHER_ID));
    view.rerender(tree(false, OTHER_ID));
    expect(screen.getByTestId("active-probe")).toHaveTextContent(OTHER_ID);
  });

  it("解析 404 導走前清掉樂觀殘留（A6）：NoteList 點擊 set 的 id 不會卡在側欄", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    // SeedActive＝模擬 NoteList 的樂觀 set：點了一篇隨後解析失敗的筆記。NotePage 對
    // 這個 id 從未 set 成功，卸載的條件清除按 id 對不上——殘留只有 404 出口的
    // setActiveNoteId(null) 清得掉（拿掉那行本案必紅）。
    renderNotePage("gone", { seedActiveId: "99999999-9999-4999-8999-999999999999" });
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent("99999999"));

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("active-probe")).toHaveTextContent("none"));
  });

  // ── #122 5a：解析層→id 常駐層（spec §3d ①③＋A1＋收斂閘門） ──

  const NOTE_B: NoteDto = {
    ...NOTE,
    id: "33333333-3333-4333-8333-333333333333",
    title: "Note B",
    slug: "note-b",
  };

  /** 兩篇筆記、以 ref（slug 或 uuid）查找的假 server；`bPending` 讓 B 的解析掛住
   * （A1／閘門案要的「解析回應前」窗口），`killRef(ref)` 讓某個 ref 之後 404
   * （①案的「舊 slug 鍵已死」與真刪除案），`failRef(ref)` 讓它之後 500（常駐層
   * 錯誤卡案）。另帶 shares/public-link/PATCH 最小 handler——「改自訂 slug → 網址
   * 收斂」案要開真的 ShareDialog 走 persist 全鏈。 */
  function stubTwoNotes(options: { bPending?: boolean } = {}) {
    let releaseB!: () => void;
    const bGate = new Promise<void>((resolve) => (releaseB = resolve));
    const byRef = new Map<string, NoteDto>([
      [NOTE.id, NOTE],
      ["my-note", NOTE],
      [NOTE_B.id, NOTE_B],
      ["note-b", NOTE_B],
    ]);
    const failRefs = new Set<string>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) });
      }
      if (url === "/api/notes" && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      if (url.endsWith("/backlinks") && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ backlinks: [] }) });
      }
      if (url.endsWith("/shares") && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
      }
      if (url.endsWith("/public-link") && method === "GET") {
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ token: null }) });
      }
      if (url.startsWith("/api/notes/") && method === "PATCH") {
        const id = decodeURIComponent(url.slice("/api/notes/".length));
        const base = id === NOTE_B.id ? NOTE_B : NOTE;
        const body = JSON.parse(String(init?.body)) as { title?: string; slug?: string | null };
        const updated: NoteDto = {
          ...base,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.slug !== undefined
            ? body.slug === null
              ? { slug: "auto-recomputed", slugIsCustom: false }
              : { slug: body.slug, slugIsCustom: true }
            : {}),
        };
        // 寫回 stub 狀態（讀碼審 m13）：useUpdateNote.onSuccess 會 invalidate id 鍵、
        // 觸發常駐層重抓——stub 不同步的話重抓會拿回舊 DTO，M2 案綠不綠就押在
        // setQueryData 與 refetch 的 microtask 落點先後（脆弱且與真 server 語意不符）。
        byRef.set(updated.id, updated);
        byRef.set(updated.slug, updated);
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) });
      }
      if (url.startsWith("/api/notes/") && method === "GET") {
        const ref = decodeURIComponent(url.slice("/api/notes/".length));
        if (failRefs.has(ref)) {
          return fakeResponse({
            ok: false,
            status: 500,
            json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
          });
        }
        const hit = byRef.get(ref);
        if (hit?.id === NOTE_B.id && options.bPending) await bGate;
        if (!hit) {
          return fakeResponse({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: { code: "not_found", message: "x" } }),
          });
        }
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(hit) });
      }
      if (url.endsWith("/links") && method === "POST") {
        return fakeResponse({ ok: true, status: 204 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      releaseB: () => releaseB(),
      killRef: (ref: string) => byRef.delete(ref),
      failRef: (ref: string) => failRefs.add(ref),
    };
  }

  function NavToB() {
    const nav = useNavigate();
    return (
      <button type="button" onClick={() => void nav("/notes/note-b")}>
        go-b
      </button>
    );
  }

  function renderTwoNoteTree(initialEntry = "/notes/my-note") {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[initialEntry]}>
            <ActiveNoteProvider>
              <SeedActive id={undefined} />
              <ActiveProbe />
              <NavToB />
              <Routes>
                <Route path="/notes/:ref" element={<NotePage />} />
                <Route path="/" element={<div>home landing</div>} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return queryClient;
  }

  it("①改標題後 invalidate 全清 → 頁面存活、不觸發 deleted 出口（id 鍵永不過時）", async () => {
    const { fetchMock, killRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    // 模擬改標題後舊 slug 鍵已死（server 端 auto slug 已重算）：舊架構下 focus/invalidate
    // 重抓 ['note', 'my-note'] 會 404 → 被當「筆記已刪」踢回首頁——這正是 id 錨定要殺的病。
    killRef("my-note");
    await act(async () => {
      await queryClient.invalidateQueries();
    });

    // 存活：編輯器還在、沒有任何 404 出口的 toast、active 不掉
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE.id);
    // 機制直釘（讀碼審 m9）：invalidate 之後**沒有**再對舊 slug 鍵發 GET——解析 query
    // 已停用、常駐層走 id 鍵；順帶釘 A11（從未打過空 ref 的 `/api/notes/`）。
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls.filter((u) => u === "/api/notes/my-note")).toHaveLength(1);
    expect(urls).not.toContain("/api/notes/");
  });

  it("③同 pattern 真導航（點側欄另一篇）→ **內容**切到新筆記、URL 收斂到新 canonical", async () => {
    stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    fireEvent.click(screen.getByRole("button", { name: "go-b" }));

    // C6-1(d)：斷**內容**（標題 input 的值），不是高亮——同 pattern 下 params 變更只
    // re-render 不 remount，解析機制必須對 params 變更反應，否則內容卡在舊筆記。
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    await waitFor(() => expect(window.location.pathname).toBe("/notes/note-b"));
    expect(screen.getByTestId("active-probe")).toHaveTextContent(NOTE_B.id);
  });

  it("A1：導航到 B 後、解析回應前——畫面無 A 的標題與可編輯編輯器（loading 佔位）；收斂閘門：舊 note 的快取更新不寫網址", async () => {
    const { releaseB } = stubTwoNotes({ bPending: true });
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(window.location.pathname).toBe("/notes/my-note"));

    fireEvent.click(screen.getByRole("button", { name: "go-b" }));

    // A1：轉場中不得渲染舊筆記的 NoteEditor/TitleInput（loading 佔位卡）
    await waitFor(() => expect(screen.queryByTestId("note-editor")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument();

    // 收斂閘門（C6-1(c)）：在途重解析時，舊筆記（A）的常駐層更新（例如它的 refetch
    // 帶回新 slug）**不得**把網址改走——needsResolve 閘要擋住它。
    // ⚠ 必須 flush 一個 **macrotask**：react-query 的通知走 macrotask 排程，同步 act
    // 斷言會落在 re-render 之前、變成零鑑別力的假綠（突變審查實證：拿掉閘門、網址
    // 真的被改走，同步版斷言照樣綠）。
    await act(async () => {
      queryClient.setQueryData(["note", NOTE.id], { ...NOTE, slug: "moved-away" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(window.location.pathname).not.toBe("/notes/moved-away");
    expect(window.location.pathname).toBe("/notes/my-note"); // 轉場中網址原地不動

    // 放行 B：內容與網址一起收斂
    releaseB();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Note B"));
    await waitFor(() => expect(window.location.pathname).toBe("/notes/note-b"));
  });

  it("常駐層 404＝**真刪除** → note.deleted 文案導回 /（不得誤入 linkInvalid——needsResolve 前置的牙）", async () => {
    // 以 uuid 開頁：解析層與常駐層共用同一個 cache entry（["note", <id>]）——真刪除的
    // 404 會同時讓 resolveQuery.isError 成立，linkInvalid 少了 needsResolve 前置就會
    // 噴錯文案（A10 違反）。這一案同時守 noteGone 出口存在性與該前置。
    const { killRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree(`/notes/${NOTE.id}`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    killRef(NOTE.id);
    killRef("my-note");
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This note has been deleted.")).toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
    expect(screen.getByTestId("active-probe")).toHaveTextContent("none");
  });

  it("改自訂 slug（經 ShareDialog 全鏈）→ 快取回寫 → 收斂 effect 更新網址（A3 移轉的正向面）", async () => {
    // 這一案守兩件事：①收斂 effect 是**資料變動驅動**（deps 少了 note 這裡必紅）；
    // ②NotePage 傳給 ShareDialog 的 cacheRef 必須是常駐層 id 鍵（改回 ref 的話
    // persist 寫進 slug 鍵、常駐層看不到、網址不動——突變審查的存活刀）。
    stubTwoNotes();
    collab.provider.synced = true;

    renderTwoNoteTree();
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));
    await waitFor(() => expect(window.location.pathname).toBe("/notes/my-note"));

    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    const slugInput = await screen.findByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(window.location.pathname).toBe("/notes/renamed"));
  });

  it("常駐層非 404 錯誤（500）→ 錯誤卡留在頁上，不導走、不噴 404 文案", async () => {
    const { failRef } = stubTwoNotes();
    collab.provider.synced = true;

    const queryClient = renderTwoNoteTree(`/notes/${NOTE.id}`);
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("My Note"));

    failRef(NOTE.id);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["note", NOTE.id] });
    });

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    expect(screen.queryByText("This note has been deleted.")).not.toBeInTheDocument();
    expect(screen.queryByText("This link is invalid or the note doesn't exist.")).not.toBeInTheDocument();
  });

  it("m14：解析 404 的 render 落在 **loading 佔位格**（非錯誤卡），出口只靠 navigate", async () => {
    // 壓住 navigate 讓中間態可觀察（否則導頁太快、這一格斷言不到）。
    const nav = vi.fn();
    navSpy.current = nav;
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    renderNotePage("gone");

    await waitFor(() => expect(nav).toHaveBeenCalledWith("/", { replace: true }));
    // 導頁被壓住 → 頁面停在解析 404 的那一格：loading 佔位、**沒有** role=alert 錯誤卡
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("This link is invalid or the note doesn't exist.")).toBeInTheDocument();
  });

  it("非 404 的載入錯誤留在頁面上顯示訊息，不導走", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 500, code: "internal" }));

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    // PR2（A/G 節）：error 態渲染的是佔位內文卡，不是裸 <p>。
    const card = screen.getByRole("alert").parentElement;
    expect(card).toHaveClass("min-w-0", "flex-1", "overflow-y-auto", "rounded-xl", "border", "border-border", "bg-card");
    // #115：佔位卡也要有窄視窗抽屜入口——isError 是會**停住**的狀態（筆記被刪、
    // 沒權限），沒有這顆，`<md` 的使用者在錯誤畫面上零導覽出口（審查 F1）。
    expect(screen.getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  });

  // PR2（A 節）：note 本身載入成功，但 `doc|provider|user` 還沒全部備妥（這裡卡住
  // `user`——`useSession()` 的 `/api/auth/me` 故意延遲 resolve）時，渲染的是不含
  // header/footer slot 的佔位卡，不是 `NoteEditor`。
  it("PR2：doc/provider/user 尚未備妥時渲染不含 header 的佔位卡，不是 NoteEditor", async () => {
    let resolveMe!: () => void;
    const meGate = new Promise<void>((resolve) => {
      resolveMe = resolve;
    });
    const base = mockFetch();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/auth/me") {
          return meGate.then(() => base(input, init));
        }
        return base(input, init);
      }),
    );

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
    expect(screen.queryByTestId("note-editor")).not.toBeInTheDocument();
    expect(document.querySelector("header")).toBeNull();
    const card = screen.getByText("Loading…").parentElement;
    expect(card).toHaveClass("min-w-0", "flex-1", "overflow-y-auto", "rounded-xl", "border", "border-border", "bg-card");

    resolveMe();
    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(document.querySelector("header")).not.toBeNull();
  });

  it("token 401 的登出回呼會清掉 ['me'] 並導去 /login", async () => {
    vi.stubGlobal("fetch", mockFetch());

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/notes/:ref" element={<NotePage />} />
                <Route path="/login" element={<div>login page</div>} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(collab.onUnauthorized).toBeTypeOf("function"));
    collab.onUnauthorized!();

    // 只斷言導頁：`['me']` 被 setQueryData(null) 之後緊接著 invalidate，假 server
    // 仍回得出使用者，所以快取會立刻被重新填回來——那正是正常行為，不該拿來斷言。
    await waitFor(() => expect(screen.getByText("login page")).toBeInTheDocument());
  });

  // PR2（BLK-1 版面斷言重寫）：NoteEditor 現在是「slot 化」呼叫——NotePage body 直接
  // 渲染 `<div className="flex min-h-0 flex-1"><NoteEditor .../></div>`，`NoteEditor`
  // （mock）容器的直接父層就是這個 body row，不再是 Task 6 時代「自己捲動」的
  // `overflow-y-auto` 容器（捲動責任完全交給 `NoteEditor` 內部／各卡片自己的
  // `overflow-y-auto`，見 `NoteEditor.tsx`／`AppShell.tsx` 的說明）。
  it("PR2：NoteEditor 容器存在，外層是 slot 化的 body row（flex min-h-0 flex-1），不是舊版自捲容器", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");

    const editor = await screen.findByTestId("note-editor");
    const bodyRow = editor.parentElement;
    expect(bodyRow).not.toBeNull();
    expect(bodyRow).toHaveClass("flex", "min-h-0", "flex-1");
    expect(bodyRow).not.toHaveClass("overflow-y-auto");
  });

  // PR2（F 節）：backlinks 從可折疊的 `<details>` 改成常駐 chips，且不再由 NotePage
  // 額外包一層容器——`footerSlot` 就是 `<BacklinksSection>` 本身，幾何（shrink-0／
  // border-t／捲動上限）完全收在該元件內部（見 BacklinksSection.test.tsx 的專屬
  // 覆蓋）。這裡只驗證 slot 接線本身：footerSlot 的內容（chip 連結）確實出現在
  // mock 渲染出的 note-editor 容器內，不是漏接。
  it("PR2：footerSlot（backlinks chips）確實接進 NoteEditor，不是漏接的 slot", async () => {
    const backlink: BacklinkDto = { id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other", ownerHandle: "tester" };
    vi.stubGlobal("fetch", mockFetch(NOTE, [backlink]));

    renderNotePage("my-note");

    const editor = await screen.findByTestId("note-editor");
    await waitFor(() => expect(within(editor).getByRole("link", { name: "Other" })).toBeInTheDocument());
    expect(within(editor).getByText("Mentioned in 1 note")).toBeInTheDocument();
    // 已不再有折疊語意（<details>/<summary>）——F 節改成常駐 chips。
    expect(editor.querySelector("details")).toBeNull();
  });
});

/**
 * 終態後的清單對帳。這條路徑是在跟 **server 的既知行為** 賽跑：
 * `DELETE /api/notes/:id` 會先 `await beforeNoteDeleted(id)`（unload 輪詢上限
 * 20 × 250ms = 5s）**才**跑刪除交易，所以 client 收到 NOTE_DELETED 之後，那一列最久
 * 還會在 DB 裡待 5 秒。單發重抓一定不夠，必須輪詢——這組測試就是在鎖這件事。
 */
describe("scheduleTerminalReconcile", () => {
  const OTHER_NOTE: NoteDto = { ...NOTE, id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other" };

  let queryClient: QueryClient;

  beforeEach(async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** 先用真的 fetchQuery 建出 `['notes']`（帶 queryFn，之後 invalidate 才抓得動）。 */
  async function seedNotesQuery(queryFn: () => Promise<NoteDto[]>) {
    await queryClient.fetchQuery({ queryKey: ["notes"], queryFn });
  }

  it("server 還沒 commit 刪除時會持續重抓，直到那一筆真的消失", async () => {
    let snapshot: NoteDto[] = [NOTE, OTHER_NOTE];
    const queryFn = vi.fn(() => Promise.resolve(snapshot));
    await seedNotesQuery(queryFn);
    expect(queryClient.getQueryData<NoteDto[]>(["notes"])).toHaveLength(2);

    scheduleTerminalReconcile(queryClient, NOTE.id);

    // 前幾輪 server 仍回舊清單（刪除交易還沒 commit）——幽靈列還在，輪詢不能停。
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2);
    expect(queryClient.getQueryData<NoteDto[]>(["notes"])).toHaveLength(2);
    const callsWhileGhostPresent = queryFn.mock.calls.length;
    expect(callsWhileGhostPresent).toBeGreaterThan(1);

    // 交易 commit 之後，下一輪就會抓到正確的清單並停止。
    snapshot = [OTHER_NOTE];
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS * 2);
    expect(queryClient.getQueryData<NoteDto[]>(["notes"])).toEqual([OTHER_NOTE]);

    const callsAfterConverged = queryFn.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS);
    expect(queryFn.mock.calls.length).toBe(callsAfterConverged);
  });

  it("那一筆一開始就不在了 → 抓一次就收工", async () => {
    const queryFn = vi.fn(() => Promise.resolve([OTHER_NOTE]));
    await seedNotesQuery(queryFn);
    const before = queryFn.mock.calls.length;

    scheduleTerminalReconcile(queryClient, NOTE.id);
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS * 2);

    expect(queryFn.mock.calls.length).toBe(before + 1);
  });

  it("server 一直回傳該筆 → 到上限就停，不會無限輪詢", async () => {
    const queryFn = vi.fn(() => Promise.resolve([NOTE, OTHER_NOTE]));
    await seedNotesQuery(queryFn);
    const before = queryFn.mock.calls.length;

    scheduleTerminalReconcile(queryClient, NOTE.id);
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS + RECONCILE_INTERVAL_MS * 2);
    const afterDeadline = queryFn.mock.calls.length;

    // 輪詢次數受時限約束（+2 是首發那次與邊界誤差的餘裕）。
    expect(afterDeadline - before).toBeLessThanOrEqual(Math.ceil(RECONCILE_TIMEOUT_MS / RECONCILE_INTERVAL_MS) + 2);

    // 而且是真的停了，不是慢下來。
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS * 2);
    expect(queryFn.mock.calls.length).toBe(afterDeadline);
  });

  it("時限涵蓋 server 的最壞情況（unload 輪詢 20 × 250ms = 5s）", () => {
    expect(RECONCILE_TIMEOUT_MS).toBeGreaterThan(20 * 250);
  });

  it("noteId 未知（筆記從未載入成功）→ 只抓一次，不進輪詢", async () => {
    const queryFn = vi.fn(() => Promise.resolve([NOTE, OTHER_NOTE]));
    await seedNotesQuery(queryFn);
    const before = queryFn.mock.calls.length;

    scheduleTerminalReconcile(queryClient, undefined);
    await vi.advanceTimersByTimeAsync(RECONCILE_TIMEOUT_MS * 2);

    expect(queryFn.mock.calls.length).toBe(before + 1);
  });
});
