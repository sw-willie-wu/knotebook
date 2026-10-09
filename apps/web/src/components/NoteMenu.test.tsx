import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { CollabState } from "@/collab/connection";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { NoteMenu, SidebarNoteMenu } from "./NoteMenu";
import { EDITOR_PERMS, OWNER_PERMS } from "@/test/fixtures";
import { useVersionsController, VersionsProvider } from "@/lib/versions-context";

// ⋮ 選單（spec D.4）：複製連結（任何角色）＋刪除筆記（#175 起看 `permissions.delete`，含 M11 的
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
    expect(screen.queryByRole("menuitem", { name: /Delete note/ })).not.toBeInTheDocument();
  });

  // #175 §8.3：刪除項看 `note.permissions.delete`，不再由 `role === "owner"` 推——群組筆記的 role
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

    expect(screen.getByRole("menuitem", { name: /Delete note/ })).toBeInTheDocument();
  });

  it("#175：個人筆記 role owner 但 permissions.delete false（刻意造的不一致 fixture）→ 沒有刪除項——看的是 permissions", () => {
    renderMenu({ ...OWNER_NOTE, permissions: { ...OWNER_PERMS, delete: false } }, CONNECTED, { current: false });
    openMenu();

    expect(screen.getByRole("menuitem", { name: /Copy link/ })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Delete note/ })).not.toBeInTheDocument();
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

// ── #175 PR2 ⋮「複製到我的筆記」（Task 10），#216 起併入「複製到… → 個人空間」──
// 兩個外殼（頁首 NoteMenu、側欄 SidebarNoteMenu）共用 NoteMenuCore，各一案守「可見性」。

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GROUP_NOTE: NoteDto = {
  ...OWNER_NOTE,
  ownerId: null,
  ownerHandle: null,
  role: "viewer",
  groupId: GROUP_ID,
  group: { id: GROUP_ID, name: "Workshop A" },
  // 只讀角色：不能編輯也不能刪除，仍可複製到個人空間（看得到即可讀）。
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

describe("NoteMenu：複製到我的筆記已併入「複製到… → 個人空間」（#216）", () => {
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

  it("群組筆記（有刪除權限）：Delete note 照舊在選單裡", async () => {
    renderCopyMenu("header", { ...GROUP_NOTE, role: "editor", permissions: { ...EDITOR_PERMS, edit: true, delete: true } });
    openAnyMenu("header");
    expect(await screen.findByRole("menuitem", { name: /Delete note/ })).toBeInTheDocument();
  });
});

describe("NoteMenu × 版本歷史（spec §8.5）", () => {
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

  it("canEdit（provider enabled）→ 「Version history」「Save current version」在「AI edit history」上方", async () => {
    renderVersionsMenu("enabled");
    const menu = await openVersionsMenu();
    const names = within(menu).getAllByRole("menuitem").map((el) => el.textContent?.trim());
    const iv = names.indexOf("Version history");
    expect(iv).toBeGreaterThanOrEqual(0);
    expect(names[iv + 1]).toBe("Save current version");
    expect(names.indexOf("AI edit history")).toBe(iv + 2);
  });

  it("點「Version history」→ open()；點「Save current version」→ 開儲存對話框", async () => {
    renderVersionsMenu("enabled");
    fireEvent.click(within(await openVersionsMenu()).getByRole("menuitem", { name: "Version history" }));
    expect(JSON.parse(screen.getByTestId("v-state").textContent!).mode).not.toBeNull();
    fireEvent.click(within(await openVersionsMenu()).getByRole("menuitem", { name: "Save current version" }));
    expect(JSON.parse(screen.getByTestId("v-state").textContent!).dialog).toBe("save");
  });

  it.each([["disabled（viewer）"], ["none（側欄每列 ⋮，provider 之外）"]] as const)("%s → 兩項都不渲染", async (label) => {
    renderVersionsMenu(label.startsWith("disabled") ? "disabled" : "none");
    const menu = await openVersionsMenu();
    expect(within(menu).getByRole("menuitem", { name: "AI edit history" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Version history" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Save current version" })).not.toBeInTheDocument();
  });
});
