import { createRef, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { CollabState } from "@/collab/connection";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteMenu, SidebarNoteMenu } from "./NoteMenu";
import { EDITOR_PERMS, OWNER_PERMS } from "@/test/fixtures";
import { NARROW_QUERY, useVersionsController, VersionsProvider } from "@/lib/versions-context";
import { FOLDER_LIST_EMPTY, folderDto } from "@/test/folder-fixtures";
import { mockWidePointer } from "@/test/wide-pointer";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { personalNote } from "@/test/select-fixtures";
import { NoteList } from "./NoteList";

// ⋮ 選單：複製連結（任何角色）＋移到垃圾桶（#181：不確認、成功 toast＋復原；#175 起看 `permissions.delete`，含
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
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const CONNECTED: CollabState = { phase: "connected", role: "owner" };

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
}

// `onOpenEdits`（#138）在 `NoteMenuProps` 上是必填——這裡給一個 no-op 預設值，只有
// 真的要觀測它的那一案才傳。
function renderMenu(
  note: NoteDto,
  state: CollabState,
  leavingRef: { current: boolean },
  fetchImpl?: typeof fetch,
  onOpenEdits: () => void = () => {},
) {
  vi.stubGlobal("fetch", fetchImpl ?? vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/notes/my-note"]}>
        <Routes>
          <Route
            path="/notes/:ref"
            element={<NoteMenu note={note} state={state} leavingRef={leavingRef} onOpenEdits={onOpenEdits} />}
          />
          <Route path="/" element={<div>home landing</div>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

/** 移到垃圾桶＋復原的假 server：DELETE 204、restore 回 `{ restored: [note] }`；`GET /api/notes`、`/api/groups` 回空。每筆記進 `calls`。 */
function trashFetch(note: NoteDto, opts: { onDelete?: () => void } = {}) {
  const calls: string[] = [];
  const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url}`);
    if (url === `/api/notes/${note.id}` && method === "DELETE") {
      opts.onDelete?.();
      return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
    }
    if (url === "/api/trash/restore" && method === "POST") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored: [note], skipped: [] }) }));
    }
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if ((url === "/api/notes" || url === "/api/groups") && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  return { fetchSpy, calls };
}

/** `NoteMenu` 只在筆記路由下渲染，`/` 是不含它的頁——導回首頁＝選單卸載（Toaster 在 router 之外，同 App.tsx）。 */
function renderRoutedMenu(
  note: NoteDto,
  leavingRef: { current: boolean },
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  vi.stubGlobal("fetch", fetchImpl);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const menu = <NoteMenu note={note} state={CONNECTED} leavingRef={leavingRef} onOpenEdits={() => {}} />;
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[canonicalNotePath(note)]}>
        <LocationProbe />
        <Routes>
          <Route path="/n/:handle/:slug" element={menu} />
          <Route path="/g/:groupId/:slug" element={menu} />
          <Route path="/" element={<div>home landing</div>} />
        </Routes>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

function groupMenuNote(perms: { edit: boolean; delete: boolean }): NoteDto {
  const groupId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  return {
    ...OWNER_NOTE,
    ownerId: null,
    ownerHandle: null,
    role: perms.edit ? "editor" : "viewer",
    groupId,
    group: { id: groupId, name: "Workshop A" },
    permissions: { ...EDITOR_PERMS, ...perms },
  };
}

describe("NoteMenu（⋮ 選單）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("owner：選單含複製連結與「刪除」兩項（移到垃圾桶）（垃圾桶圖示；沒有舊字「Delete note」）", () => {
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    const trashItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(trashItem.querySelector("svg")).toHaveAttribute("data-icon", "trash");
    expect(screen.queryByText(/Delete note/)).toBeNull();
  });

  it("#297：⋮ 選單沒有寬度（寬度只在頁首 icon）", () => {
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryAllByRole("menuitemradio")).toHaveLength(0);
    expect(screen.queryByRole("menuitem", { name: /Width/ })).toBeNull();
  });

  // #138：AI 修改紀錄項。狀態住在 `NotePage`（兩個觸發點共用），選單只負責關自己再
  // 通知父層——`onSelect` 的三步形與刪除項逐字同形，見 `NoteMenu.tsx` 檔頭的 focus trap 說明。
  // ⚠ 開選單一律用 `openMenu()`（pointerDown）：Radix 的 trigger 只掛 onPointerDown，
  // 純 `fireEvent.click` 開不了（本檔檔頭已記載）。
  it("⋮ → AI 修改紀錄：關閉選單並呼叫 onOpenEdits", async () => {
    const onOpenEdits = vi.fn();
    renderMenu(OWNER_NOTE, CONNECTED, { current: false }, undefined, onOpenEdits);
    openMenu();

    fireEvent.click(await screen.findByRole("menuitem", { name: i18n.t("note.menu.aiEdits") }));
    expect(onOpenEdits).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
  });

  it("非 owner（逐人分享 editor，permissions.delete false）：只有複製連結，沒有刪除項", () => {
    renderMenu({ ...OWNER_NOTE, role: "editor", permissions: EDITOR_PERMS }, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });

  // #175：刪除項看 `note.permissions.delete`，不再由 `role === "owner"` 推——群組筆記的 role
  // 從不是 owner，但角色有 `can_delete` 的成員要能刪。
  it("#175：群組筆記（role editor、permissions.delete true）→ 有刪除項", () => {
    const groupNote: NoteDto = {
      ...OWNER_NOTE,
      ownerId: null,
      ownerHandle: null,
      role: "editor",
      groupId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      group: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" },
      permissions: { ...EDITOR_PERMS, delete: true },
    };
    renderMenu(groupNote, { phase: "connected", role: "editor" }, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });

  it("#175：個人筆記 role owner 但 permissions.delete false（刻意造的不一致 fixture）→ 沒有刪除項——看的是 permissions", () => {
    renderMenu({ ...OWNER_NOTE, permissions: { ...OWNER_PERMS, delete: false } }, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
  });

  it("#175：群組筆記的複製連結是 /g/<groupId>/<slug>", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const groupNote: NoteDto = {
      ...OWNER_NOTE,
      ownerId: null,
      ownerHandle: null,
      role: "viewer",
      groupId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      group: { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" },
      permissions: { ...EDITOR_PERMS, edit: false },
    };
    renderMenu(groupNote, { phase: "connected", role: "viewer" }, { current: false });

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/g/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/my-note`),
    );
  });

  it("複製連結成功 → toast「已複製」，選單隨後關閉", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    renderMenu(OWNER_NOTE, CONNECTED, { current: false });

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy link/ }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/n/tester/my-note`));
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
    expect(manual).toHaveValue(`${window.location.origin}/n/tester/my-note`);
    expect(manual).toHaveAttribute("readonly");

    Reflect.deleteProperty(document, "execCommand");
  });

  it("NM-T2 owner 移到垃圾桶：不確認、點下即送（leavingRef 同步已是 true）→ 導回 / → toast 有 Undo", async () => {
    const leavingRef = { current: false };
    // `waitFor` 內綁兩個各自單調的條件（fetchSpy 被呼叫過＋
    // leavingRef 現在是 true）是恆真式——不管 `leavingRef.current = true` 擺在
    // 送出請求「之前」還是「之後」，兩個條件最終都會同時成立，測不出時序。
    // 真正有牙齒的做法：點下選單項之後**同步**斷言，並在 fetch spy 的 DELETE 分支**內側**
    // （也就是請求真的被送出的那一瞬間）side-record 當下的 `leavingRef.current`——若實作把設定
    // 搬到 `await deleteNote.mutateAsync(...)` 之後才做，這兩處讀到的值必然是 false，測試會紅。
    let leavingAtFetch: boolean | undefined;
    const { fetchSpy } = trashFetch(OWNER_NOTE, {
      onDelete: () => {
        leavingAtFetch = leavingRef.current;
      },
    });

    renderRoutedMenu(OWNER_NOTE, leavingRef, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    // 不確認——沒有對話框，點下就送出。
    expect(leavingRef.current).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${OWNER_NOTE.id}`, expect.objectContaining({ method: "DELETE" })),
    );
    expect(leavingAtFetch).toBe(true);

    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/"));
    expect(leavingRef.current).toBe(true);
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("NM-T3 選單已卸載（導回 / 之後）才按 Undo：照樣還原並導回該篇", async () => {
    const { fetchSpy, calls } = trashFetch(OWNER_NOTE);
    renderRoutedMenu(OWNER_NOTE, { current: false }, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe("/"));
    // `/` 不渲染 NoteMenu——toast 的「復原」只能靠建立 toast 時捕捉的 queryClient／navigate。
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(OWNER_NOTE)));
    expect(calls).toContain("POST /api/trash/restore");
  });

  it("NM-T4 群組筆記只有刪除權（edit 假）：成功 toast 沒有 Undo、有說明誰能還原", async () => {
    const note = groupMenuNote({ edit: false, delete: true });
    const { fetchSpy } = trashFetch(note);
    renderRoutedMenu(note, { current: false }, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Members of the group whose role can both edit and delete notes can restore it.", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("NM-T5 群組筆記有編輯＋刪除權：成功 toast 有 Undo", async () => {
    const note = groupMenuNote({ edit: true, delete: true });
    const { fetchSpy } = trashFetch(note);
    renderRoutedMenu(note, { current: false }, fetchSpy);
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("NM-T6 DELETE 掛起中：連點、再開選單點「Delete」都不重送（項目 disabled，DELETE 恰一次）", async () => {
    const pending = new Promise<Response>(() => {});
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === `/api/notes/${OWNER_NOTE.id}` && method === "DELETE") return pending;
      throw new Error(`unexpected fetch: ${method} ${String(input)}`);
    });
    const deleteCount = () =>
      fetchSpy.mock.calls.filter(
        ([input, init]) => String(input) === `/api/notes/${OWNER_NOTE.id}` && (init?.method ?? "GET").toUpperCase() === "DELETE",
      ).length;
    renderMenu(OWNER_NOTE, CONNECTED, { current: false }, fetchSpy as unknown as typeof fetch);
    openMenu();
    const first = screen.getByRole("menuitem", { name: "Delete" });
    fireEvent.click(first);
    fireEvent.click(first);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(deleteCount()).toBe(1));

    openMenu();
    const again = await screen.findByRole("menuitem", { name: "Delete" });
    expect(again).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(again);
    fireEvent.keyDown(again, { key: "Enter" });
    // 重送的話 mutateAsync → fetch 只隔幾個微任務；等一個 macrotask 讓它有機會落地再數。
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(deleteCount()).toBe(1);
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(leavingRef.current).toBe(false);
    expect(screen.queryByText("home landing")).not.toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });

  // 刪除失敗但已進終態時，`NotePage` 的終態 effect 被這支
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("This note has been deleted.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    // leavingRef 維持 true——這個分支本來就該離開，不是「留在頁面上」的錯誤分支。
    expect(leavingRef.current).toBe(true);
    // 不是非終態那條「Something went wrong」的錯誤映射——文案要對得上終態出口。
    expect(screen.queryByText("Something went wrong. Please try again.")).not.toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
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
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("You no longer have access to this note.")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("home landing")).toBeInTheDocument());
    expect(leavingRef.current).toBe(true);
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });

  // 覆蓋真實競態，回歸釘死「必須讀 stateRef.current，不能讀 closure
  // 裡的 state」這件事本身。時間軸：按下確認鈕那一刻 `state` prop 還是
  // connected（`handleConfirmDelete` closure 捕捉到的也是它）→ DELETE 請求送出
  // 但**故意掛住不 settle**→ 共編這時收到 close(NOTE_DELETED)，父層把 `state`
  // prop rerender 成 deleted → 這時候 DELETE 才失敗。若 catch 分支讀的是 closure
  // 裡的 `state`（呼叫當下的 connected），會誤判成「非終態」走錯分支
  // （leavingRef 撥回 false＋「Something went wrong」），跟正確的終態出口
  // （toast「已刪除」＋導頁）文案/行為都不同，兩者不會混淆——這案能真的分辨。
  it("stateRef 零守衛回歸案：點下當下 state=connected，DELETE 掛起期間收到終態 → 失敗時仍走終態出口", async () => {
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
              <Route
                path="/notes/:ref"
                element={
                  <NoteMenu note={OWNER_NOTE} state={state} leavingRef={leavingRef} onOpenEdits={() => {}} />
                }
              />
              <Route path="/" element={<div>home landing</div>} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </QueryClientProvider>
      );
    }

    const { rerender } = render(tree(CONNECTED));
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    await waitFor(() =>
      expect(fetchSpy).toHaveBeenCalledWith(`/api/notes/${OWNER_NOTE.id}`, expect.objectContaining({ method: "DELETE" })),
    );

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
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
  });
});

// ── #175 ⋮「複製到我的筆記」，#216 起併入「複製到… → 我的筆記」──
// 兩個外殼（頁首 NoteMenu、側欄 SidebarNoteMenu）共用 NoteMenuCore，各一案守「可見性」。

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_NOTE: NoteDto = {
  ...OWNER_NOTE,
  ownerId: null,
  ownerHandle: null,
  role: "viewer",
  groupId: GROUP_ID,
  group: { id: GROUP_ID, name: "Workshop A" },
  // 只讀角色：不能編輯也不能刪除，仍可複製到我的筆記（看得到即可讀）。
  permissions: { ...EDITOR_PERMS, edit: false, delete: false },
};

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname}</div>;
}

function renderCopyMenu(
  shell: "header" | "sidebar",
  note: NoteDto,
  fetchImpl: typeof fetch = vi.fn(() => Promise.reject(new Error("unexpected fetch"))) as unknown as typeof fetch,
) {
  // #216：⋮ 選單掛載後會讀 `GET /api/groups`（決定要不要顯示「移動／複製到群組」）——這裡回空清單（兩項都不出現），
  // 讓下面對 `fetchImpl` 呼叫次數／第一次呼叫的斷言只看複製本身。群組項的測試在 share/GroupTransfer.test.tsx。
  const spy = fetchImpl;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "/api/groups" ? Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })) : spy(input, init),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/start"]}>
        <LocationProbe />
        {shell === "header" ? (
          <NoteMenu note={note} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
        ) : (
          <SidebarNoteMenu note={note} />
        )}
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
}

function openAnyMenu(shell: "header" | "sidebar"): void {
  const name = shell === "header" ? "More" : `Note actions for ${OWNER_NOTE.title}`;
  fireEvent.pointerDown(screen.getByRole("button", { name }), { button: 0 });
}

describe("NoteMenu：複製到我的筆記已併入「複製到… → 我的筆記」（#216）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["header", "sidebar"] as const)("群組筆記／個人筆記的選單都沒有獨立的「Copy to my notes」項，改有「Copy to…」（%s）", async (shell) => {
    renderCopyMenu(shell, GROUP_NOTE);
    openAnyMenu(shell);
    expect(await screen.findByTestId("note-menu-copy-to")).toHaveTextContent("Copy to…");
    expect(screen.queryByRole("menuitem", { name: "Copy to my notes" })).not.toBeInTheDocument();
    cleanup();

    renderCopyMenu(shell, OWNER_NOTE);
    openAnyMenu(shell);
    expect(await screen.findByTestId("note-menu-copy-to")).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Copy to my notes" })).not.toBeInTheDocument();
  });

  it("群組筆記（有刪除權限）：Delete 照舊在選單裡", async () => {
    renderCopyMenu("header", { ...GROUP_NOTE, role: "editor", permissions: { ...EDITOR_PERMS, edit: true, delete: true } });
    openAnyMenu("header");
    expect(await screen.findByRole("menuitem", { name: "Delete" })).toBeInTheDocument();
  });
});

describe("NoteMenu × 版本歷史", () => {
  function VersionsHost({ enabled, children }: { enabled: boolean; children: ReactNode }) {
    const value = useVersionsController({ noteId: OWNER_NOTE.id, enabled });
    return (
      <VersionsProvider value={value}>
        <span data-testid="v-state">{JSON.stringify({ mode: value.mode, dialog: value.dialog?.kind ?? null })}</span>
        {children}
      </VersionsProvider>
    );
  }

  /** provider: "enabled" | "disabled" | "none"（none＝側欄每列 ⋮ 的處境：沒有 VersionsProvider）。 */
  function renderVersionsMenu(provider: "enabled" | "disabled" | "none") {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const menu = <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />;
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          {provider === "none" ? menu : <VersionsHost enabled={provider === "enabled"}>{menu}</VersionsHost>}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  async function openVersionsMenu(): Promise<HTMLElement> {
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
    return screen.findByRole("menu");
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  /** 可控 matchMedia：只有 `NARROW_QUERY` 回 `narrow`；回傳「跨斷點」的把手（會通知已註冊的 change 監聽）。 */
  let liveListeners = (): number => 0;
  function installMatchMedia(narrow: boolean): (next: boolean) => void {
    let current = narrow;
    const listeners = new Set<() => void>();
    liveListeners = () => listeners.size;
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        get matches() {
          return query === NARROW_QUERY ? current : false;
        },
        media: query,
        addEventListener: (_: string, fn: () => void) => listeners.add(fn),
        removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
      })),
    );
    return (next) => {
      current = next;
      act(() => listeners.forEach((fn) => fn()));
    };
  }

  it("窄（沒有歷史泡泡）：canEdit → 「Version history」在「AI edit history」上方；沒有「Save current version」", async () => {
    installMatchMedia(true);
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    const names = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    const iv = names.indexOf("Version history");
    expect(iv).toBeGreaterThanOrEqual(0);
    expect(names.indexOf("AI edit history")).toBe(iv + 1);
    expect(names).not.toContain("Save current version");
  });

  it("寬（有歷史泡泡）：沒有「Version history」也沒有「Save current version」", async () => {
    installMatchMedia(false);
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Save current version" })).not.toBeInTheDocument();
  });

  // 替身只翻 `NARROW_QUERY`（`WIDE_POINTER_QUERY` 恆不成立）：描述的是觸控裝置（寬判準不翻）跨寬度的路徑，選單保持開著、項目就地增減。
  // 有滑鼠的裝置跨寬度時寬判準也會翻，整個選單會先關（由 GroupTransfer.test 與本檔守）。
  it("視窗跨斷點：選單開著時窄→寬項目消失、寬→窄項目出現", async () => {
    const setNarrow = installMatchMedia(true);
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "Version history" })).toBeInTheDocument();
    setNarrow(false);
    expect(within(menu).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    setNarrow(true);
    expect(within(menu).getByRole("menuitem", { name: "Version history" })).toBeInTheDocument();
  });

  it("卸載後 change 監聽被移除（不留訂閱）", async () => {
    installMatchMedia(true);
    const { unmount } = renderVersionsMenu("enabled");
    await openVersionsMenu();
    expect(liveListeners()).toBeGreaterThan(0);
    unmount();
    expect(liveListeners()).toBe(0);
  });

  it("窄：點「Version history」→ open()", async () => {
    installMatchMedia(true);
    renderVersionsMenu("enabled");
    fireEvent.click(within(await openVersionsMenu()).getByRole("menuitem", { name: "Version history" }));
    expect(JSON.parse(screen.getByTestId("v-state").textContent!).mode).not.toBeNull();
  });

  it("triggerRef（NotePage 交給版本歷史整頁當焦點退路）指到頁首 ⋮ 觸發鈕本身", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const triggerRef = createRef<HTMLButtonElement>();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/notes/my-note"]}>
          <NoteMenu note={OWNER_NOTE} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} triggerRef={triggerRef} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(triggerRef.current).not.toBeNull();
    expect(triggerRef.current).toBe(screen.getByRole("button", { name: "More" }));
  });

  it.each([["disabled（viewer）"], ["none（側欄每列 ⋮，provider 之外）"]] as const)("%s → 窄視窗也不渲染", async (label) => {
    installMatchMedia(true);
    renderVersionsMenu(label.startsWith("disabled") ? "disabled" : "none");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Save current version" })).not.toBeInTheDocument();
  });
});

// 頁首與側欄 ⋮ 共用 NoteMenuCore 的逐層子選單；同空間移動開著的那篇不離場。
describe("NoteMenu × 逐層子選單", () => {
  const A = folderDto({ id: "A", name: "A" });
  const A1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
  const B = folderDto({ id: "B", name: "B" });

  /** 群組空清單、資料夾 A ⊃ A1、B；`PUT /api/notes/:id/folder` 回放好的筆記。每筆記進 `calls`。 */
  function folderFetch(note: NoteDto) {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    const fetchSpy = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body === undefined ? undefined : (JSON.parse(String(init.body)) as { folderId: string | null });
      calls.push({ method, url, body });
      const json = (value: unknown) => Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(value) }));
      if (method === "GET" && url === "/api/groups") return json([]);
      if (method === "GET" && url === "/api/folders") return json({ folders: [A, A1, B] });
      if (method === "PUT" && url === `/api/notes/${note.id}/folder`) return json({ ...note, folderId: body?.folderId ?? null });
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    return { fetchSpy, calls };
  }

  /** 寬形（層疊）：鍵盤開 Move to… 的子選單（第一層），等「A」（SubTrigger，不帶「, open」）出現。 */
  async function openMoveCascade(): Promise<HTMLElement> {
    const trigger = await screen.findByTestId("note-menu-move-to");
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const sub = await screen.findByRole("menu", { name: "Move to…" });
    await within(sub).findByRole("menuitem", { name: "A" });
    return sub;
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    cleanup();
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  // 寬形＝往旁層疊（Radix 巢狀子選單），窄形（jsdom 預設）＝就地展開逐層；頁首與側欄 ⋮ 同一套。
  it.each([
    ["header", "wide"],
    ["sidebar", "wide"],
    ["header", "narrow"],
    ["sidebar", "narrow"],
  ] as const)("NM-H1 %s ⋮（%s）：寬形是層疊（開 A → Move here、A1，沒有 Back）；窄形是就地展開逐層（點「A, open」→ Back、Move here）", async (shell, form) => {
    mockWidePointer(form === "wide");
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu(shell, OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu(shell);
    if (form === "wide") {
      const sub = await openMoveCascade();
      const a = within(sub).getByRole("menuitem", { name: "A" });
      expect(a).toHaveAttribute("aria-haspopup", "menu");
      a.focus();
      fireEvent.keyDown(a, { key: "ArrowRight" });
      const level = await screen.findByRole("menu", { name: "A" });
      await waitFor(() => expect(within(level).getAllByRole("menuitem").map((el) => el.textContent)).toEqual(["Move here", "A1"]));
      expect(screen.queryByRole("menuitem", { name: "Back" })).toBeNull();
    } else {
      const trigger = await screen.findByTestId("note-menu-move-to");
      expect(trigger).not.toHaveAttribute("aria-haspopup");
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("menuitem", { name: "A, open" }));
      expect(await screen.findByRole("menuitem", { name: "Back" })).toBeInTheDocument();
      expect(screen.getByRole("menuitem", { name: "Move here" })).toBeInTheDocument();
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    }
  });

  it("NM-W1 就地展開到第二層時跨判準（窄→寬）→ 選單關；回到窄再開 ⋮ → Move to… 是收合態、展開是第一層（groupExpanded／paths 已重設）", async () => {
    const mq = mockWidePointer(false);
    const { fetchSpy } = folderFetch(OWNER_NOTE);
    renderCopyMenu("header", OWNER_NOTE, fetchSpy as unknown as typeof fetch);
    openAnyMenu("header");
    fireEvent.click(await screen.findByTestId("note-menu-move-to"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "A, open" }));
    await screen.findByRole("menuitem", { name: "Back" });
    act(() => mq.setWide(true));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    act(() => mq.setWide(false));
    openAnyMenu("header");
    const trigger = await screen.findByTestId("note-menu-move-to");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Move to…" })).toBeNull();
    fireEvent.click(trigger);
    const group = screen.getByRole("group", { name: "Move to…" });
    expect(within(group).getAllByRole("menuitem").map((el) => el.getAttribute("aria-label") ?? el.textContent)).toEqual(["A, open", "B"]);
  });

  it("NM-H2 同空間移動開著的那篇 → PUT 一次、toast，不設 leavingRef、不導頁", async () => {
    mockWidePointer(true);
    const leavingRef = { current: false };
    const { fetchSpy, calls } = folderFetch(OWNER_NOTE);
    renderRoutedMenu(OWNER_NOTE, leavingRef, fetchSpy);
    openMenu();
    const sub = await openMoveCascade();
    fireEvent.click(within(sub).getByRole("menuitem", { name: "B" }));
    expect(await screen.findByText("Moved to “B”")).toBeInTheDocument();
    expect(calls.filter((c) => c.method === "PUT")).toEqual([
      { method: "PUT", url: `/api/notes/${OWNER_NOTE.id}/folder`, body: { folderId: "B" } },
    ]);
    expect(leavingRef.current).toBe(false);
    expect(screen.getByTestId("loc").textContent).toBe(canonicalNotePath(OWNER_NOTE));
    expect(screen.queryByText("home landing")).toBeNull();
  });
});

// ── 最愛：⋮ 的「加入最愛／移出最愛」與移出確認框 ──

describe("NoteMenu × 最愛", () => {
  const FAV_NOTE = OWNER_NOTE;
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const hang = () => new Promise<Response>(() => {});

  interface FavServer {
    /** 此刻在最愛裡的 noteId，新到舊。 */
    favorites: string[];
    /** 回應方式；"pending"＝掛住不回。 */
    get: "ok" | "pending";
    put: "ok" | "pending" | 404;
    del: "ok" | "pending" | 429;
    calls: string[];
  }

  function stubFavServer(init: Partial<Omit<FavServer, "calls">> = {}): FavServer {
    const server: FavServer = { favorites: [], get: "ok", put: "ok", del: "ok", calls: [], ...init };
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
        const url = String(input);
        const method = (request?.method ?? "GET").toUpperCase();
        server.calls.push(`${method} ${url}`);
        if (url === "/api/favorites" && method === "GET") {
          if (server.get === "pending") return hang();
          return Promise.resolve(jsonResponse(server.favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
        }
        const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
        if (target !== undefined && method === "PUT") {
          if (server.put === "pending") return hang();
          if (server.put === 404) return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404));
          server.favorites = [target, ...server.favorites];
          return Promise.resolve(jsonResponse({ noteId: target, favoritedAt: "2026-03-02T00:00:00.000Z" }));
        }
        if (target !== undefined && method === "DELETE") {
          if (server.del === "pending") return hang();
          if (server.del === 429) return Promise.resolve(jsonResponse({ error: { code: "too_many_requests", message: "slow" } }, 429));
          server.favorites = server.favorites.filter((id) => id !== target);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === "/api/groups" || url === "/api/notes") return Promise.resolve(jsonResponse([]));
        if (url === "/api/folders") return Promise.resolve(jsonResponse({ folders: [] }));
        return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404));
      }),
    );
    return server;
  }

  const count = (server: FavServer, call: string) => server.calls.filter((c) => c === call).length;

  function renderShell(shell: "header" | "sidebar", note: NoteDto = FAV_NOTE) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/start"]}>
          {shell === "header" ? (
            <NoteMenu note={note} state={CONNECTED} leavingRef={{ current: false }} onOpenEdits={() => {}} />
          ) : (
            <SidebarNoteMenu note={note} />
          )}
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );
    return { queryClient };
  }

  const triggerName = (shell: "header" | "sidebar") => (shell === "header" ? "More" : `Note actions for ${FAV_NOTE.title}`);
  const openShellMenu = (shell: "header" | "sidebar") => fireEvent.pointerDown(screen.getByRole("button", { name: triggerName(shell) }), { button: 0 });
  const favItem = (name: "Add to favorites" | "Remove from favorites") => screen.findByRole("menuitem", { name });
  /** 清單到了（項目不再 disabled）。 */
  const ready = (item: HTMLElement) => waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["header", "sidebar"] as const)("%s 殼：最愛項是第一項、複製連結是第二項", async (shell) => {
    stubFavServer();
    renderShell(shell);
    openShellMenu(shell);
    await favItem("Add to favorites");
    expect(screen.getAllByRole("menuitem")[0]).toHaveTextContent("Add to favorites");
    expect(screen.getAllByRole("menuitem")[1]).toHaveTextContent("Copy link");
  });

  it("不在最愛：空心星＋「Add to favorites」", async () => {
    stubFavServer({ favorites: [] });
    renderShell("header");
    openShellMenu("header");
    const add = await favItem("Add to favorites");
    await ready(add);
    expect(add.querySelector("svg")).toHaveAttribute("data-icon", "star");
    expect(add.querySelector("svg")).toHaveAttribute("fill", "none");
  });

  it("在最愛：實心星＋「Remove from favorites」", async () => {
    stubFavServer({ favorites: [FAV_NOTE.id] });
    renderShell("header");
    openShellMenu("header");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    expect(remove.querySelector("svg")).toHaveAttribute("data-icon", "star");
    expect(remove.querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("清單還沒到 → disabled、顯示「Add to favorites」", async () => {
    stubFavServer({ get: "pending" });
    renderShell("header");
    openShellMenu("header");
    expect(await favItem("Add to favorites")).toHaveAttribute("aria-disabled", "true");
  });

  it("按「Add」→ PUT /api/favorites/<id>、出「Added to favorites」", async () => {
    const server = stubFavServer();
    renderShell("sidebar");
    openShellMenu("sidebar");
    const add = await favItem("Add to favorites");
    await ready(add);
    fireEvent.click(add);
    expect(await screen.findByText("Added to favorites")).toBeInTheDocument();
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1);
  });

  it("加入失敗 → 出錯誤 toast、不出成功 toast", async () => {
    stubFavServer({ put: 404 });
    renderShell("header");
    openShellMenu("header");
    const add = await favItem("Add to favorites");
    await ready(add);
    fireEvent.click(add);
    expect(await screen.findByText(i18n.t("errors.not_found"))).toBeInTheDocument();
    expect(screen.queryByText("Added to favorites")).toBeNull();
  });

  it("按「Remove」→ 出確認框、還沒送 DELETE；Cancel → 沒送、焦點回 ⋮；再開、框內 Remove → 送 DELETE、框關、toast 沒有 Undo", async () => {
    const server = stubFavServer({ favorites: [FAV_NOTE.id] });
    renderShell("header");
    openShellMenu("header");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(0);
    expect(dialog).toHaveTextContent(`"${FAV_NOTE.title}" will be removed`);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus());
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(0);

    openShellMenu("header");
    fireEvent.click(await favItem("Remove from favorites"));
    const again = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(again).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed from favorites")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(1);
    expect(screen.queryByRole("button", { name: /undo/i })).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus());
  });

  it("DELETE 回 429 → 框關、錯誤 toast、快取不變、焦點回 ⋮", async () => {
    stubFavServer({ favorites: [FAV_NOTE.id], del: 429 });
    const { queryClient } = renderShell("sidebar");
    openShellMenu("sidebar");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Removed from favorites")).toBeNull();
    expect(queryClient.getQueryData(["favorites"])).toEqual([{ noteId: FAV_NOTE.id, favoritedAt: "2026-03-01T00:00:00.000Z" }]);
    await waitFor(() => expect(screen.getByRole("button", { name: triggerName("sidebar") })).toHaveFocus());
  });

  it("移出請求還沒回來：確認框不關、兩顆鈕 disabled、Esc 無效、DELETE 只送一次", async () => {
    const server = stubFavServer({ favorites: [FAV_NOTE.id], del: "pending" });
    renderShell("sidebar");
    openShellMenu("sidebar");
    const remove = await favItem("Remove from favorites");
    await ready(remove);
    fireEvent.click(remove);
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(1));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeDisabled());
    expect(within(dialog).getByRole("button", { name: "Remove" })).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Remove from favorites?" })).toBeInTheDocument();
    expect(count(server, `DELETE /api/favorites/${FAV_NOTE.id}`)).toBe(1);
  });

  it("送出中重開選單：PUT 掛住 → 該項 disabled；按它不送第二個請求", async () => {
    const server = stubFavServer({ put: "pending" });
    renderShell("header");
    openShellMenu("header");
    const add = await favItem("Add to favorites");
    await ready(add);
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1);

    openShellMenu("header");
    const during = await favItem("Remove from favorites");
    expect(during).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(during);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(count(server, `PUT /api/favorites/${FAV_NOTE.id}`)).toBe(1);
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("選單沒開時不打 GET /api/favorites（十個側欄 ⋮）；打開一個才打一次", async () => {
    const server = stubFavServer();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const notes = Array.from({ length: 10 }, (_, i) => ({ ...FAV_NOTE, id: `${FAV_NOTE.id.slice(0, -2)}${String(i).padStart(2, "0")}`, title: `Note ${i}` }));
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          {notes.map((n) => (
            <SidebarNoteMenu key={n.id} note={n} />
          ))}
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(count(server, "GET /api/favorites")).toBe(0);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Note actions for Note 3" }), { button: 0 });
    await favItem("Add to favorites");
    await waitFor(() => expect(count(server, "GET /api/favorites")).toBe(1));
  });
});

// 最愛 tab 裡用列自己的 ⋮ 移出：那一列在 204 之後卸載，焦點要落到下一列／上一列／tabpanel，toast 不能隨列消失。
describe("NoteMenu × 最愛 tab 的焦點", () => {
  const A = personalNote({ id: "fa", title: "Alpha" });
  const B = personalNote({ id: "fb", title: "Bravo" });
  const C = personalNote({ id: "fc", title: "Charlie" });
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    localStorage.setItem("sidebar.tab", "favorites");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("從 B、C、A 依序移出：焦點依序落在 C 的連結、A 的連結、tabpanel；三次都出現移出 toast", async () => {
    let favorites = [A.id, B.id, C.id];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/favorites" && method === "GET") {
          return Promise.resolve(json(favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
        }
        const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
        if (target !== undefined && method === "DELETE") {
          favorites = favorites.filter((id) => id !== target);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === "/api/notes") return Promise.resolve(json([A, B, C]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        return Promise.resolve(json({ error: { code: "not_found", message: "unexpected" } }, 404));
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="">
                <div role="tabpanel" tabIndex={0}>
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );

    const rowLink = (id: string) => screen.getByRole("tabpanel").querySelector(`[data-node-id="${id}"] a`) as HTMLElement;
    await waitFor(() => expect(rowLink(C.id)).not.toBeNull());

    async function removeFrom(note: NoteDto) {
      const menuButton = screen.getByRole("button", { name: `Note actions for ${note.title}` });
      menuButton.focus();
      fireEvent.pointerDown(menuButton, { button: 0 });
      const item = await screen.findByRole("menuitem", { name: "Remove from favorites" });
      await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
      fireEvent.click(item);
      const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
      expect(await screen.findByText("Removed from favorites")).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      await waitFor(() => expect(screen.getByRole("tabpanel").querySelector(`[data-node-id="${note.id}"]`)).toBeNull());
      dismissAllToasts();
    }

    await removeFrom(B);
    await waitFor(() => expect(rowLink(C.id)).toHaveFocus());
    await removeFrom(C);
    await waitFor(() => expect(rowLink(A.id)).toHaveFocus());
    await removeFrom(A);
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
  });

  it("畫面上有兩份側欄實例（抽屜＋隱藏的靜態卡）：焦點退路只在開框的那份裡找", async () => {
    let favorites = [A.id, B.id, C.id];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/favorites" && method === "GET") {
          return Promise.resolve(json(favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
        }
        const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
        if (target !== undefined && method === "DELETE") {
          favorites = favorites.filter((id) => id !== target);
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        if (url === "/api/notes") return Promise.resolve(json([A, B, C]));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json({ folders: [] }));
        return Promise.resolve(json({ error: { code: "not_found", message: "unexpected" } }, 404));
      }),
    );
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-testid="static" data-sidebar-instance="">
                <div role="tabpanel" tabIndex={0}>
                  <NoteList />
                </div>
              </div>
              <div data-testid="drawer" data-sidebar-instance="">
                <div role="tabpanel" tabIndex={0}>
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </QueryClientProvider>,
    );

    const drawer = screen.getByTestId("drawer");
    const staticCard = screen.getByTestId("static");
    const linkIn = (root: HTMLElement, id: string) => root.querySelector(`[data-node-id="${id}"] a`) as HTMLElement;
    await waitFor(() => expect(linkIn(drawer, C.id)).not.toBeNull());

    const menuButton = within(drawer).getByRole("button", { name: `Note actions for ${B.title}` });
    menuButton.focus();
    fireEvent.pointerDown(menuButton, { button: 0 });
    const item = await screen.findByRole("menuitem", { name: "Remove from favorites" });
    await waitFor(() => expect(item).not.toHaveAttribute("aria-disabled", "true"));
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Removed from favorites")).toBeInTheDocument();
    await waitFor(() => expect(drawer.querySelector(`[data-node-id="${B.id}"]`)).toBeNull());
    await waitFor(() => expect(linkIn(drawer, C.id)).toHaveFocus());
    expect(linkIn(staticCard, C.id)).not.toHaveFocus();
  });
});
