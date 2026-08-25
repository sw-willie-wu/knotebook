import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { CollabState } from "@/collab/connection";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteMenu } from "./NoteMenu";

// ⋮ 選單（spec D.4）：複製連結（任何角色）＋刪除筆記（owner-only，含 M11 的
// leavingRef 時序：刪除失敗且已進終態時，`NoteMenu` 必須自己補一套「同文案同
// 終點」的終態出口——`NotePage` 的終態 effect 被這支 handler 自己設的
// `leavingRef.current=true` 閘住，永遠不會再觸發，見 `NoteMenu.tsx` 檔頭）。
// DropdownMenuTrigger 只掛 onPointerDown（Radix），純 `fireEvent.click` 開不了
// ——比照 SettingsModal.test.tsx 開 UserMenu 的既有寫法。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const OWNER_NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
};

const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
}

function renderMenu(note: NoteDto, state: CollabState, leavingRef: { current: boolean }, fetchImpl?: typeof fetch) {
  vi.stubGlobal("fetch", fetchImpl ?? vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/notes/my-note"]}>
        <Routes>
          <Route path="/notes/:ref" element={<NoteMenu note={note} state={state} leavingRef={leavingRef} />} />
          <Route path="/" element={<div>home landing</div>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("NoteMenu（⋮ 選單，spec D.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("owner：選單含複製連結與刪除筆記兩項", () => {
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Delete note/ })).toBeInTheDocument();
  });

  it("非 owner（editor）：只有複製連結，沒有刪除項", () => {
    renderMenu({ ...OWNER_NOTE, role: "editor" }, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Delete note/ })).not.toBeInTheDocument();
  });

  it("複製連結成功 → toast「已複製」，選單隨後關閉", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/notes/my-note`));
    await waitFor(() => expect(screen.getByText("Link copied to clipboard.")).toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
  });

  it("複製連結兩條路都失敗 → 開手動複製 Dialog（標題沿用 share.copyLink）", async () => {
    vi.stubGlobal("navigator", {}); // 明文 http：整支 clipboard API 不存在
    Object.defineProperty(document, "execCommand", { value: vi.fn(() => false), configurable: true, writable: true });

    renderMenu(OWNER_NOTE, CONNECTED, { current: false });
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Copy link" })).toBeInTheDocument());
    const manual = screen.getByLabelText("Couldn't copy automatically — select the link below and copy it yourself.");
    expect(manual).toHaveValue(`${window.location.origin}/notes/my-note`);
    expect(manual).toHaveAttribute("readonly");

    Reflect.deleteProperty(document, "execCommand");
  });

  it("owner 刪除：確認 → DELETE → 導回 /（leavingRef 在送出請求當下已是 true）", async () => {
    const leavingRef = { current: false };
    // M1（複審修正）：`waitFor` 內綁兩個各自單調的條件（fetchSpy 被呼叫過＋
    // leavingRef 現在是 true）是恆真式——不管 `leavingRef.current = true` 擺在
    // 送出請求「之前」還是「之後」，兩個條件最終都會同時成立，測不出時序。
    // 真正有牙齒的做法：在 fetch spy 的 DELETE 分支**內側**（也就是請求真的被
    // 送出的那一瞬間）side-record 當下的 `leavingRef.current`——若實作把設定
    // 搬到 `await deleteNote.mutateAsync(...)` 之後才做，這裡側錄到的值必然是
    // false，測試會紅。
    let leavingAtFetch: boolean | undefined;
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") {
        leavingAtFetch = leavingRef.current;
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      if (String(input) === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });

    renderMenu(OWNER_NOTE, CONNECTED, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete note/ }));

    const dialog = await screen.findByRole("dialog");
    expect(leavingRef.current).toBe(false); // 只是打開確認框，還沒真的送出
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${OWNER_NOTE.id}`, expect.objectContaining({ method: "DELETE" })),
    );
    expect(leavingAtFetch).toBe(true);

    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(leavingRef.current).toBe(true);
    // 成功時不另發成功 toast（跟改版前側欄刪除一致，導頁即回饋）。
    expect(screen.queryByText("Delete note?")).not.toBeInTheDocument();
  });

  it("刪除失敗且非終態 → leavingRef 撥回 false，顯示錯誤 toast，不導頁", async () => {
    const leavingRef = { current: false };
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") {
        return Promise.resolve(
          fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });

    renderMenu(OWNER_NOTE, CONNECTED, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete note/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(leavingRef.current).toBe(false);
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
  });

  // review B1 修正：刪除失敗但已進終態時，`NotePage` 的終態 effect 被這支
  // handler 自己設的 `leavingRef.current=true` 閘住，永遠不會再觸發——`NoteMenu`
  // 必須自己就地補上同一套出口（同文案同終點），這裡真的分辨出「有 toast＋有
  // 導頁」，不是舊版誤判的「不重複 toast、讓終態流程接手」（那條路根本不會走到）。
  it("刪除失敗但已進終態（deleted）→ 就地 toast「已刪除」＋導回 /（NotePage 終態 effect 不會再觸發）", async () => {
    const leavingRef = { current: false };
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
      ),
    );

    renderMenu(OWNER_NOTE, { phase: "deleted" }, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete note/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("This note has been deleted.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    // leavingRef 維持 true——這個分支本來就該離開，不是「留在頁面上」的錯誤分支。
    expect(leavingRef.current).toBe(true);
    // 不是非終態那條「Something went wrong」的錯誤映射——文案要對得上終態出口。
    expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
  });

  it("刪除失敗但已進終態（kicked）→ 就地 toast「已失去存取權」＋導回 /", async () => {
    const leavingRef = { current: false };
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        fakeResponse({ ok: false, status: 500, json: () => Promise.resolve({ error: { code: "internal", message: "x" } }) }),
      ),
    );

    renderMenu(OWNER_NOTE, { phase: "kicked" }, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete note/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("You no longer have access to this note.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(leavingRef.current).toBe(true);
  });

  // 複審 B1-a：覆蓋真實競態，回歸釘死「必須讀 stateRef.current，不能讀 closure
  // 裡的 state」這件事本身。時間軸：按下確認鈕那一刻 `state` prop 還是
  // connected（`handleConfirmDelete` closure 捕捉到的也是它）→ DELETE 請求送出
  // 但**故意掛住不 settle**→ 共編這時收到 close(NOTE_DELETED)，父層把 `state`
  // prop rerender 成 deleted → 這時候 DELETE 才失敗。若 catch 分支讀的是 closure
  // 裡的 `state`（呼叫當下的 connected），會誤判成「非終態」走錯分支
  // （leavingRef 撥回 false＋「Something went wrong」），跟正確的終態出口
  // （toast「已刪除」＋導頁）文案/行為都不同，兩者不會混淆——這案能真的分辨。
  it("stateRef 零守衛回歸案：確認當下 state=connected，DELETE 掛起期間收到終態 → 失敗時仍走終態出口", async () => {
    const leavingRef = { current: false };
    let rejectDelete!: (err: unknown) => void;
    const deletePromise = new Promise<Response>((_resolve, reject) => {
      rejectDelete = reject;
    });
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") {
        return deletePromise; // 刻意掛住，直到測試手動 reject
      }
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    function tree(state: CollabState) {
      return (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={["/notes/my-note"]}>
            <Routes>
              <Route path="/notes/:ref" element={<NoteMenu note={OWNER_NOTE} state={state} leavingRef={leavingRef} />} />
              <Route path="/" element={<div>home landing</div>} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(tree(CONNECTED));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete note/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    // DELETE 仍在飛行中（deferred，尚未 settle）——這時共編收到
    // close(NOTE_DELETED)，state prop 變成 deleted。
    rerender(tree({ phase: "deleted" }));

    rejectDelete(new Error("boom"));

    // 走終態出口：destructive toast「已刪除」＋導頁。若 `stateRef.current` 被改回
    // `state`（closure 讀到建立當下的 connected），會走錯到非終態分支——本案必紅。
    await waitFor(() => expect(screen.getByText("This note has been deleted.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(leavingRef.current).toBe(true);
    expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
  });
});
