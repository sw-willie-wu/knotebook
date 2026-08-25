import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import * as Y from "yjs";
import { COLLAB_CLOSE_REVOKED, canonicalNotePath, type BacklinkDto, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
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

function renderNotePage(ref: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/notes/${ref}`]}>
          <Routes>
            <Route path="/notes/:ref" element={<NotePage />} />
            <Route path="/" element={<div>home landing</div>} />
          </Routes>
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
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <Routes>
              <Route path="/notes/:ref" element={<NotePage />} />
              <Route path="/" element={<div>home landing</div>} />
            </Routes>
          </MemoryRouter>
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
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <Routes>
              <Route path="/notes/:ref" element={<NotePage />} />
              <Route path="/" element={<div>home landing</div>} />
            </Routes>
          </MemoryRouter>
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

  it("GET /api/notes/:ref 回 404 → toast 並導回 /", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 404, code: "not_found" }));

    renderNotePage("gone");

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(screen.getByText("This note has been deleted.")).toBeInTheDocument();
  });

  it("非 404 的載入錯誤留在頁面上顯示訊息，不導走", async () => {
    vi.stubGlobal("fetch", mockFetch({ status: 500, code: "internal" }));

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong. Please try again."));
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    // PR2（A/G 節）：error 態渲染的是佔位內文卡，不是裸 <p>。
    const card = screen.getByRole("alert").parentElement;
    expect(card).toHaveClass("min-w-0", "flex-1", "overflow-y-auto", "rounded-xl", "border", "border-border", "bg-card");
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
            <Routes>
              <Route path="/notes/:ref" element={<NotePage />} />
              <Route path="/login" element={<div>login page</div>} />
            </Routes>
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
    const backlink: BacklinkDto = { id: "22222222-2222-2222-2222-222222222222", title: "Other", slug: "other" };
    vi.stubGlobal("fetch", mockFetch(NOTE, [backlink]));

    renderNotePage("my-note");

    const editor = await screen.findByTestId("note-editor");
    await waitFor(() => expect(within(editor).getByRole("link", { name: "Other" })).toBeInTheDocument());
    expect(within(editor).getByText("1 note mentions this page")).toBeInTheDocument();
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
