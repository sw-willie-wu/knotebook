import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { COLLAB_CLOSE_REVOKED, canonicalNotePath, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import type { CollabState } from "@/collab/connection";

// BlockNote 需要一整套 jsdom 沒有的 DOM/Range API，掛進單元測試只會測到環境；
// 這裡只驗證「頁面有沒有把正確的 props 交給編輯器」，編輯器本身留給手動驗證。
vi.mock("@/components/NoteEditor", () => ({
  NoteEditor: ({ editable }: { editable: boolean }) => (
    <div data-testid="note-editor" data-editable={String(editable)} />
  ),
}));

// useCollab 的真實行為（HocuspocusProvider + WebSocket）不進 jsdom；狀態機本身
// 有 connection.test.ts 全覆蓋。這裡把它換成一個可由測試直接擺弄的假回傳值，
// 驗證 NotePage 對每個 phase 的反應。
const collab = vi.hoisted(() => ({
  state: { phase: "connecting" } as CollabState,
  onUnauthorized: undefined as (() => void) | undefined,
}));
vi.mock("@/collab/useCollab", () => ({
  useCollab: ({ onUnauthorized }: { onUnauthorized: () => void }) => {
    collab.onUnauthorized = onUnauthorized;
    return { state: collab.state, doc: { fake: "doc" }, provider: { fake: "provider" } };
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

const USER: UserDto = { id: "u1", email: "a@example.com", displayName: "Ann", isAdmin: false, mustChangePassword: false };

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
};

/** `/api/auth/me`、`/api/notes`（清單）、`/api/notes/:ref`（單篇）三支的假 server。 */
function mockFetch(note: NoteDto | { status: number; code: string } = NOTE) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth/me") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
    }
    if (url === "/api/notes" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
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
    window.history.replaceState(null, "", "/");
    // toast store 是模組層級的，不歸零的話上一個測試的 toast 會留在畫面上。
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("以 slug 開頁：解析出筆記、把網址 replaceState 成 canonical、掛上編輯器", async () => {
    vi.stubGlobal("fetch", mockFetch());
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);

    renderNotePage(NOTE.id);

    await waitFor(() => expect(screen.getByTestId("note-editor")).toBeInTheDocument());
    expect(screen.getByLabelText("Note title")).toHaveValue("My Note");
    // 有自訂 slug → canonical 是 `/notes/<slug>`，不是開頁時用的 uuid。
    expect(window.location.pathname).toBe(canonicalNotePath(NOTE));
  });

  it("owner 連線中（尚未 connected）就以 REST 角色決定可編輯", async () => {
    vi.stubGlobal("fetch", mockFetch());

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "true"));
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
  });

  it("connected 且角色是 viewer → 編輯器唯讀、標題變純文字", async () => {
    vi.stubGlobal("fetch", mockFetch({ ...NOTE, role: "viewer" }));
    collab.state = { phase: "connected", role: "viewer" };

    renderNotePage("my-note");

    await waitFor(() => expect(screen.getByTestId("note-editor")).toHaveAttribute("data-editable", "false"));
    expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My Note" })).toBeInTheDocument();
    expect(screen.getByText("Read-only")).toBeInTheDocument();
  });

  it("N4 降級：connected(owner) → connected(viewer) 時 toast 並切成唯讀", async () => {
    vi.stubGlobal("fetch", mockFetch());
    collab.state = { phase: "connected", role: "owner" };

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
