import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { FolderDto, GroupDto, NoteDto, ShareDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { groupDto, memberRole, OWNER_PERMS, EDITOR_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { NoteMenu } from "@/components/NoteMenu";
import type { DestSpace } from "@/components/sidebar/destination-level";
import { indexFolders } from "@/components/sidebar/folder-index";
import {
  GroupTransferDialog,
  INLINE_GROUP_LIST_QUERY,
  isSameSpaceMove,
  type DestinationPick,
  type GroupTransferPick,
  type TransferTarget,
} from "./GroupTransfer";

// #216：⋮ 選單的「移動到群組」「複製到群組」（原 MoveToGroupSection 的測試搬來）。
// 寬螢幕＝右側 flyout（Radix Sub）；窄／觸控（matchMedia 命中 INLINE_GROUP_LIST_QUERY）＝就地向下展開。
// PR-3b-2 T4 起子選單是逐層清單（destination-level）：這組案的群組都沒有資料夾、筆記在根層、`GET /api/folders` 回空，
// 第一層與 #216 的平清單同項同序（上下半部之間的分隔線不是 menuitem），斷言照舊不放寬。資料夾層的案在檔尾「逐層子選單」。

function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}
const okJson = (body: unknown, status = 200) => fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });
const failJson = (status: number, code: string) =>
  fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  groupId: null,
  group: null,
  folderId: null,
  permissions: { ...OWNER_PERMS },
};

const GA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GC = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const GROUP_A = groupDto({ id: GA, name: "Workshop A" }, memberRole());
const GROUP_C = groupDto({ id: GC, name: "Workshop C" }, memberRole());
/** 成員但角色沒有新建旗標——不得出現在候選裡。 */
const GROUP_B = groupDto(
  { id: GB, name: "Readers" },
  memberRole({ permissions: { ...memberRole().permissions, create: false, edit: false } }),
);

const BOB: ShareDto = { userId: "22222222-2222-2222-2222-222222222222", email: "bob@example.com", displayName: "Bob", role: "viewer" };
const CAROL: ShareDto = { userId: "33333333-3333-3333-3333-333333333333", email: "carol@example.com", displayName: "Carol", role: "editor" };
const TOKEN = "T".repeat(43);

const BASE = `/api/notes/${NOTE.id}`;
const URLS = {
  groups: "/api/groups",
  folders: "/api/folders",
  shares: `${BASE}/shares`,
  link: `${BASE}/public-link`,
  note: BASE,
  move: `${BASE}/move`,
  copy: `${BASE}/copy`,
  place: `${BASE}/folder`,
};

const MOVED: NoteDto = {
  ...NOTE,
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GA,
  group: { id: GA, name: "Workshop A" },
  permissions: { ...EDITOR_PERMS },
};
const COPY: NoteDto = { ...MOVED, id: "44444444-4444-4444-4444-444444444444", slug: "my-note-2" };
const GROUP_NOTE: NoteDto = { ...MOVED, id: NOTE.id };

interface Server {
  groups: GroupDto[];
  /** `GET /api/folders`（PR-3b-2 T4：⋮ 子選單掛著時會讀；預設空）。 */
  folders: FolderDto[];
  shares: ShareDto[];
  token: string | null;
  latest: NoteDto;
  move?: () => Response | Promise<Response>;
  copy?: () => Response | Promise<Response>;
  /** 這些 URL 的 GET 懸置，直到 `release(url, response)`。 */
  hold?: Set<string>;
}

function stub(init: Partial<Server> = {}) {
  const server: Server = { groups: [GROUP_A, GROUP_C], folders: [], shares: [], token: null, latest: NOTE, ...init };
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const waiting = new Map<string, (r: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
      const url = String(input);
      const method = (reqInit?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: reqInit?.body === undefined ? undefined : JSON.parse(String(reqInit.body)) });
      if (method === "GET" && server.hold?.has(url)) {
        return new Promise<Response>((resolve) => waiting.set(url, resolve));
      }
      if (method === "GET" && url === URLS.groups) return Promise.resolve(okJson(server.groups));
      if (method === "GET" && url === URLS.folders) return Promise.resolve(okJson({ folders: server.folders }));
      if (method === "PUT" && url === URLS.place) {
        const body = JSON.parse(String(reqInit?.body)) as { folderId: string | null };
        return Promise.resolve(okJson({ ...server.latest, folderId: body.folderId }));
      }
      if (method === "GET" && url === URLS.shares) return Promise.resolve(okJson([...server.shares]));
      if (method === "GET" && url === URLS.link) return Promise.resolve(okJson({ token: server.token, slug: null, width: "full" }));
      if (method === "GET" && url === URLS.note) return Promise.resolve(okJson(server.latest));
      if (method === "POST" && url === URLS.move) return Promise.resolve(server.move ? server.move() : okJson(MOVED));
      if (method === "POST" && url === URLS.copy) return Promise.resolve(server.copy ? server.copy() : okJson(COPY, 201));
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
  return {
    server,
    calls,
    release(url: string, response: Response) {
      server.hold?.delete(url);
      waiting.get(url)?.(response);
    },
  };
}

/** 讓 matchMedia 對 INLINE_GROUP_LIST_QUERY 回報命中（窄／觸控）。 */
function stubInlineMode(on: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query === INLINE_GROUP_LIST_QUERY,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
}

function renderMenu(note: NoteDto = NOTE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${note.id}`]}>
        <Routes>
          <Route
            path="/notes/:id"
            element={
              <NoteMenu
                note={note}
                state={{ phase: "connected", role: "owner" }}
                leavingRef={{ current: false }}
                onOpenEdits={() => {}}
              />
            }
          />
          <Route path="/g/:groupId/:slug" element={<p>copy page</p>} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
}

/** 開 ⋮ 並等群組清單載入（觸發項出現）。 */
async function openMenuReady(testId: "note-menu-move-to" | "note-menu-copy-to" = "note-menu-copy-to") {
  openMenu();
  return screen.findByTestId(testId);
}

/** flyout 形：鍵盤 → 展開第二層（Radix SubTrigger）。 */
async function openFlyout(trigger: HTMLElement): Promise<HTMLElement> {
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowRight" });
  return screen.findByRole("menu", { name: trigger.textContent ?? "" });
}

async function pickFlyout(testId: "note-menu-move-to" | "note-menu-copy-to", name: string) {
  const trigger = await openMenuReady(testId);
  const sub = await openFlyout(trigger);
  fireEvent.click(within(sub).getByRole("menuitem", { name }));
}

describe("⋮ 選單：移動／複製到群組（#216）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubInlineMode(false);
  });
  afterEach(() => {
    cleanup();
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("沒有可選群組（沒有任何角色同時有新建與編輯）→ 移動不出現；複製只剩「建立副本」", async () => {
    const CREATE_ONLY = groupDto(
      { id: GB, name: "Create only" },
      memberRole({ permissions: { ...memberRole().permissions, create: true, edit: false } }),
    );
    stub({ groups: [GROUP_B, CREATE_ONLY] });
    renderMenu();
    const copy = await openMenuReady();
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    const sub = await openFlyout(copy);
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Make a copy"]);
  });

  it("flyout 形：移動／複製觸發項前各有自己的圖示（與其他選單項同款 mr-2 h-4 w-4），右側箭頭仍在", async () => {
    stub();
    renderMenu();
    const move = await openMenuReady("note-menu-move-to");
    const moveIcon = move.querySelector('svg[data-icon="folder-input"]');
    expect(moveIcon).not.toBeNull();
    expect(moveIcon).toHaveClass("mr-2", "h-4", "w-4");
    expect(move.querySelector('svg[data-icon="chevron-right"]')).not.toBeNull();
    const copy = screen.getByTestId("note-menu-copy-to");
    const copyIcon = copy.querySelector('svg[data-icon="copy"]');
    expect(copyIcon).not.toBeNull();
    expect(copyIcon).toHaveClass("mr-2", "h-4", "w-4");
    expect(copy.querySelector('svg[data-icon="chevron-right"]')).not.toBeNull();
  });

  // 選項矩陣（Willie 2026-10-08）。
  it("矩陣：自己的個人筆記 -> 移動＝候選群組；複製＝建立副本＋候選群組（create＋edit）", async () => {
    stub({ groups: [GROUP_A, GROUP_B, GROUP_C] });
    renderMenu();
    expect(await openMenuReady("note-menu-move-to")).toHaveTextContent("Move to…");
    expect(screen.getByTestId("note-menu-copy-to")).toHaveTextContent("Copy to…");
    const move = await openFlyout(screen.getByTestId("note-menu-move-to"));
    expect(within(move).getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Workshop A", "Workshop C"]);
    fireEvent.keyDown(move, { key: "Escape" });
    const copy = await openFlyout(screen.getByTestId("note-menu-copy-to"));
    expect(within(copy).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Make a copy",
      "Workshop A",
      "Workshop C",
    ]);
  });

  it("矩陣：群組筆記 -> 沒有移動；複製＝建立副本（原群組）、我的筆記、其餘群組（不含原群組）", async () => {
    stub({ groups: [GROUP_A, GROUP_C] });
    renderMenu(GROUP_NOTE);
    await openMenuReady();
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    const sub = await openFlyout(screen.getByTestId("note-menu-copy-to"));
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Make a copy",
      "My notes",
      "Workshop C",
    ]);
  });

  it("TC4 zh-TW：群組筆記的複製第二層有「我的筆記」、沒有「個人空間」（與側欄 tab 同名）", async () => {
    await i18n.changeLanguage("zh-TW");
    stub({ groups: [GROUP_A, GROUP_C] });
    renderMenu(GROUP_NOTE);
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }), { button: 0 });
    const sub = await openFlyout(await screen.findByTestId("note-menu-copy-to"));
    const labels = within(sub).getAllByRole("menuitem").map((e) => e.textContent);
    expect(labels).toContain("我的筆記");
    expect(labels).not.toContain("個人空間");
  });

  it("矩陣：群組筆記、我在該群組只能讀（無 create／edit）-> 沒有建立副本、仍有我的筆記（與其餘可用群組）", async () => {
    const READER_A = groupDto(
      { id: GA, name: "Workshop A" },
      memberRole({ permissions: { ...memberRole().permissions, create: false, edit: false } }),
    );
    stub({ groups: [READER_A, GROUP_C] });
    renderMenu(GROUP_NOTE);
    const sub = await openFlyout(await openMenuReady());
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["My notes", "Workshop C"]);
  });

  it.each([
    ["viewer", VIEWER_PERMS],
    ["editor", { ...EDITOR_PERMS, moveToGroup: false }],
  ] as const)("矩陣：別人分享給我的個人筆記（%s）-> 沒有移動；複製＝我的筆記＋我 create＋edit 的群組", async (role, permissions) => {
    stub({ groups: [GROUP_A, GROUP_B, GROUP_C] });
    renderMenu({ ...NOTE, role, ownerId: "someone", ownerHandle: "someone", permissions: { ...permissions } });
    const sub = await openFlyout(await openMenuReady());
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "My notes",
      "Workshop A",
      "Workshop C",
    ]);
  });

  it("自己的個人筆記「建立副本」：確認框標題與按鈕同為 Make a copy（POST body {}）", async () => {
    const s = stub();
    renderMenu();
    await pickFlyout("note-menu-copy-to", "Make a copy");
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Make a copy" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(s.calls.find((c) => c.url === URLS.copy)?.body).toEqual({}));
  });

  it("flyout：候選只列 create＋edit 為真的群組", async () => {
    stub({ groups: [GROUP_A, GROUP_B, GROUP_C] });
    renderMenu();
    const sub = await openFlyout(await openMenuReady("note-menu-move-to"));
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Workshop A", "Workshop C"]);
  });

  it("我的筆記／建立副本：複製確認文案與 POST body（個人 {}、原群組 {groupId}）", async () => {
    const s = stub();
    renderMenu(GROUP_NOTE);
    await pickFlyout("note-menu-copy-to", "My notes");
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This creates a copy in your own notes; the original stays as it is.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy to my notes" }));
    expect(await screen.findByText("Copied to your notes")).toBeInTheDocument();
    expect(s.calls.find((c) => c.url === URLS.copy)?.body).toEqual({});
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    cleanup();

    const s2 = stub();
    renderMenu(GROUP_NOTE);
    await pickFlyout("note-menu-copy-to", "Make a copy");
    dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('next to the original in "Workshop A"');
    fireEvent.click(within(dialog).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(s2.calls.find((c) => c.url === URLS.copy)?.body).toEqual({ groupId: GA }));
  });

  it("移動確認：列出被移除的人名、公開連結關閉、網址與擁有權；提交鈕 destructive；等 shares／public-link 都到才可按", async () => {
    stub({ shares: [BOB, CAROL], token: TOKEN });
    renderMenu();
    await pickFlyout("note-menu-move-to", "Workshop A");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Move this note into "Workshop A"?');
    await waitFor(() =>
      expect(dialog).toHaveTextContent("Per-person sharing with 2 people is removed: Bob and Carol. Anyone not in the group loses access."),
    );
    expect(dialog).toHaveTextContent("Its public link will be turned off.");
    expect(dialog).toHaveTextContent("Its address changes to /g/…");
    expect(dialog).toHaveTextContent("You will no longer own it");
    const submit = within(dialog).getByRole("button", { name: "Move into group" });
    expect(submit).toHaveClass("bg-destructive");
    // 選單已關
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("移動確認：沒有逐人分享、沒有 token → 不提被移除的人與公開連結；取消 → 框關閉、不發 /move", async () => {
    const s = stub();
    renderMenu();
    await pickFlyout("note-menu-move-to", "Workshop A");
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Move into group" })).not.toBeDisabled());
    expect(dialog).not.toHaveTextContent("Per-person sharing");
    expect(dialog).not.toHaveTextContent("public link");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(s.calls.filter((c) => c.url === URLS.move)).toEqual([]);
  });

  it("移動成功 → 先重讀筆記、再 POST /move 帶 { groupId }；快取收斂成群組形（寫入先後由 api/note-move.test 守）", async () => {
    const s = stub({ shares: [BOB], token: TOKEN });
    const qc = renderMenu();
    await pickFlyout("note-menu-move-to", "Workshop C");
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Move into group" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);

    await waitFor(() => expect(s.calls.some((c) => c.url === URLS.move)).toBe(true));
    const noteRead = s.calls.findIndex((c) => c.method === "GET" && c.url === URLS.note);
    const moveCall = s.calls.findIndex((c) => c.method === "POST" && c.url === URLS.move);
    expect(noteRead).toBeGreaterThanOrEqual(0);
    expect(moveCall).toBeGreaterThan(noteRead);
    expect(s.calls[moveCall].body).toEqual({ groupId: GC });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText('Moved into "Workshop C"')).toBeInTheDocument();
    expect(qc.getQueryData(["shares", NOTE.id])).toEqual([]);
    expect(qc.getQueryData(["public-link", NOTE.id])).toEqual({ token: null, slug: null, width: "full" });
    expect(qc.getQueryData(["note", NOTE.id])).toEqual(MOVED);
  });

  it("I2：shares 或 public-link 尚未成功之前，移動的提交鈕停用；到齊才可按", async () => {
    for (const url of [URLS.shares, URLS.link]) {
      const s = stub({ hold: new Set([url]) });
      renderMenu();
      await pickFlyout("note-menu-move-to", "Workshop A");
      const submit = within(await screen.findByRole("dialog")).getByRole("button", { name: "Move into group" });
      await waitFor(() => expect(s.calls.some((c) => c.url === url)).toBe(true));
      await act(async () => {});
      expect(submit).toBeDisabled();
      s.release(url, url === URLS.shares ? okJson([]) : okJson({ token: null, slug: null }));
      await waitFor(() => expect(submit).not.toBeDisabled());
      cleanup();
      vi.unstubAllGlobals();
      stubInlineMode(false);
    }
  });

  it("I3：移動送出前檢查還在飛時再按提交鈕 -> 鈕停用、不重送（筆記只重讀 1 次）", async () => {
    const s = stub();
    renderMenu();
    await pickFlyout("note-menu-move-to", "Workshop A");
    const submit = within(await screen.findByRole("dialog")).getByRole("button", { name: "Move into group" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    s.server.hold = new Set([URLS.note]);
    fireEvent.click(submit);
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await act(async () => {});
    expect(s.calls.filter((c) => c.method === "GET" && c.url === URLS.note)).toHaveLength(1);
    expect(s.calls.filter((c) => c.url === URLS.move)).toEqual([]);
  });

  it("I4：複製不發 /shares、/public-link 請求", async () => {
    const s = stub();
    renderMenu(GROUP_NOTE);
    await pickFlyout("note-menu-copy-to", "Workshop C");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy into group" }));
    await waitFor(() => expect(s.calls.some((c) => c.url === URLS.copy)).toBe(true));
    expect(s.calls.filter((c) => c.url === URLS.shares || c.url === URLS.link)).toEqual([]);
  });

  it("I1：flyout 內按 Esc 只關第二層（選單仍開、焦點回子選單觸發項）；再按 Esc 才關選單", async () => {
    stub();
    renderMenu();
    const trigger = await openMenuReady("note-menu-move-to");
    const sub = await openFlyout(trigger);
    const item = within(sub).getByRole("menuitem", { name: "Workshop A" });
    item.focus();
    fireEvent.keyDown(item, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Workshop A" })).toBeNull());
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("確認框關閉（取消）後焦點回 ⋮ 觸發鈕", async () => {
    stub();
    renderMenu();
    await pickFlyout("note-menu-copy-to", "Workshop A");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "More" })).toHaveFocus());
  });

  it("送出前檢查不過（重讀到已是群組筆記）→ 不發 /move、changedElsewhere toast、框關閉", async () => {
    const s = stub();
    renderMenu();
    await pickFlyout("note-menu-move-to", "Workshop A");
    s.server.latest = MOVED;
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Move into group" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(await screen.findByText("This note was changed elsewhere, so nothing was moved.")).toBeInTheDocument();
    expect(s.calls.filter((c) => c.url === URLS.move)).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("移動失敗 409 → destructive toast（errors.conflict）、框關閉", async () => {
    stub({ move: () => failJson(409, "conflict") });
    renderMenu();
    await pickFlyout("note-menu-move-to", "Workshop A");
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Move into group" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    expect(await screen.findByText("Something changed while you were doing that. Reload and try again.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("複製確認是 outline 提交鈕；成功 → toast「Copied into …」附「Open copy」（altText），點了導到副本的 /g/ 網址；不重讀筆記、不發 /move", async () => {
    const s = stub();
    renderMenu();
    await pickFlyout("note-menu-copy-to", "Workshop A");

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('This creates a copy in "Workshop A"; the original stays as it is.');
    const submit = within(dialog).getByRole("button", { name: "Copy into group" });
    expect(submit).not.toHaveClass("bg-destructive");
    expect(submit).toHaveClass("border-input", "bg-transparent");
    fireEvent.click(submit);

    expect(await screen.findByText('Copied into "Workshop A"')).toBeInTheDocument();
    expect(s.calls.find((c) => c.url === URLS.copy)?.body).toEqual({ groupId: GA });
    expect(
      document.querySelector('[data-radix-toast-announce-alt="You can also open the copy from the sidebar."]'),
    ).not.toBeNull();
    expect(s.calls.filter((c) => c.url === URLS.move || (c.method === "GET" && c.url === URLS.note))).toEqual([]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Open copy" }));
    expect(await screen.findByText("copy page")).toBeInTheDocument();
  });

  it("群組筆記也能複製到其他群組 → POST /copy 帶 { groupId }", async () => {
    const s = stub();
    renderMenu(GROUP_NOTE);
    await pickFlyout("note-menu-copy-to", "Workshop C");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy into group" }));
    await waitFor(() => expect(s.calls.find((c) => c.url === URLS.copy)?.body).toEqual({ groupId: GC }));
  });

  it("複製送出掛著時再按 → 鈕停用、POST /copy 仍只 1 次", async () => {
    const s = stub({ copy: () => new Promise<Response>(() => {}) });
    renderMenu();
    await pickFlyout("note-menu-copy-to", "Workshop A");
    const submit = within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy into group" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(s.calls.filter((c) => c.url === URLS.copy)).toHaveLength(1));
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await act(async () => {});
    expect(s.calls.filter((c) => c.url === URLS.copy)).toHaveLength(1);
  });

  it("複製失敗 → destructive toast（errors.group_not_found）、框關閉", async () => {
    stub({ copy: () => failJson(404, "group_not_found") });
    renderMenu();
    await pickFlyout("note-menu-copy-to", "Workshop A");
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy into group" }));
    expect(await screen.findByText("We couldn't find that group.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  describe("就地展開形（窄視窗／觸控）", () => {
    beforeEach(() => stubInlineMode(true));

    it("就地展開形：移動／複製觸發項前各有自己的圖示，右側箭頭（向下）仍在", async () => {
      stub();
      renderMenu();
      const move = await openMenuReady("note-menu-move-to");
      const moveIcon = move.querySelector('svg[data-icon="folder-input"]');
      expect(moveIcon).not.toBeNull();
      expect(moveIcon).toHaveClass("mr-2", "h-4", "w-4");
      expect(move.querySelector('svg[data-icon="chevron-down"]')).not.toBeNull();
      const copy = screen.getByTestId("note-menu-copy-to");
      const copyIcon = copy.querySelector('svg[data-icon="copy"]');
      expect(copyIcon).not.toBeNull();
      expect(copyIcon).toHaveClass("mr-2", "h-4", "w-4");
      expect(copy.querySelector('svg[data-icon="chevron-down"]')).not.toBeNull();
    });

    it("沒有 flyout：點觸發項 → 同一個選單內向下展開（縮排的群組項），aria-expanded 同步；再點收合", async () => {
      stub();
      renderMenu();
      const trigger = await openMenuReady("note-menu-move-to");
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("menuitem", { name: "Workshop A" })).toBeNull();

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const items = screen.getAllByRole("menuitem", { name: /Workshop/ });
      expect(items.map((e) => e.textContent)).toEqual(["Workshop A", "Workshop C"]);
      // 同一個 menu 內（沒有第二個 menu）、縮排
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      expect(screen.getByRole("menu")).toContainElement(items[0]);
      expect(items[0]).toHaveClass("pl-6");

      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("menuitem", { name: "Workshop A" })).toBeNull();
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("同時只展開一組；鍵盤：→ 展開、← 收合並留在選單；Esc 先收合（選單仍開）、再 Esc 才關選單", async () => {
      stub();
      renderMenu();
      const move = await openMenuReady("note-menu-move-to");
      const copy = screen.getByTestId("note-menu-copy-to");

      move.focus();
      fireEvent.keyDown(move, { key: "ArrowRight" });
      expect(move).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(copy);
      expect(move).toHaveAttribute("aria-expanded", "false");
      expect(copy).toHaveAttribute("aria-expanded", "true");

      fireEvent.keyDown(copy, { key: "ArrowLeft" });
      expect(copy).toHaveAttribute("aria-expanded", "false");

      fireEvent.keyDown(copy, { key: "ArrowRight" });
      expect(copy).toHaveAttribute("aria-expanded", "true");
      const first = screen.getByRole("menuitem", { name: "Workshop A" });
      first.focus();
      fireEvent.keyDown(first, { key: "Escape" });
      await waitFor(() => expect(copy).toHaveAttribute("aria-expanded", "false"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      await waitFor(() => expect(copy).toHaveFocus());

      fireEvent.keyDown(copy, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    });

    it("挑群組 → 選單關閉、開同一份確認框；移動確認內容與 flyout 形相同，確認後 POST /move", async () => {
      const s = stub({ shares: [BOB], token: TOKEN });
      renderMenu();
      fireEvent.click(await openMenuReady("note-menu-move-to"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Workshop A" }));

      const dialog = await screen.findByRole("dialog");
      expect(screen.queryByRole("menu")).toBeNull();
      expect(dialog).toHaveTextContent('Move this note into "Workshop A"?');
      await waitFor(() => expect(dialog).toHaveTextContent("Per-person sharing with Bob is removed"));
      const submit = within(dialog).getByRole("button", { name: "Move into group" });
      expect(submit).toHaveClass("bg-destructive");
      await waitFor(() => expect(submit).not.toBeDisabled());
      fireEvent.click(submit);
      await waitFor(() => expect(s.calls.find((c) => c.url === URLS.move)?.body).toEqual({ groupId: GA }));
    });

    it("複製：挑群組 → 確認 → POST /copy、toast 附 Open copy", async () => {
      const s = stub();
      renderMenu();
      fireEvent.click(await openMenuReady("note-menu-copy-to"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Workshop C" }));
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy into group" }));
      expect(await screen.findByText('Copied into "Workshop C"')).toBeInTheDocument();
      expect(s.calls.find((c) => c.url === URLS.copy)?.body).toEqual({ groupId: GC });
      expect(screen.getByRole("button", { name: "Open copy" })).toBeInTheDocument();
    });

    it("關選單再開 → 回到收合態", async () => {
      stub();
      renderMenu();
      const trigger = await openMenuReady();
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      fireEvent.keyDown(trigger, { key: "Escape" }); // 展開中第一次 Esc 只收合
      fireEvent.keyDown(trigger, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      openMenu();
      expect(await screen.findByTestId("note-menu-copy-to")).toHaveAttribute("aria-expanded", "false");
    });
  });
});

// PR-3b-2 T3：確認框帶資料夾、「建立副本」落點與 n6 退回（資料夾 spec §6.11.2、§6.11.3、§5.7.6）。直接渲染 GroupTransferDialog。
describe("GroupTransferDialog：資料夾目的地（PR-3b-2 T3）", () => {
  const GG = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const GROUP_G = groupDto({ id: GG, name: "G" }, memberRole());
  const IN_A: NoteDto = { ...NOTE, folderId: "A" };
  const GROUP_NOTE_IN_GF: NoteDto = { ...MOVED, id: NOTE.id, groupId: GG, group: { id: GG, name: "G" }, folderId: "GF" };
  /** 別人分享給我、我自己把它放在共享私人資料夾 S1（放置 id 不得跟著複製）。 */
  const SHARED_IN_S1: NoteDto = {
    ...NOTE,
    role: "editor",
    ownerId: "someone",
    ownerHandle: "someone",
    permissions: { ...EDITOR_PERMS, moveToGroup: false },
    folderId: "S1",
  };

  /** 照 NoteMenu 的掛法：onClose 卸載確認框（不卸載的話 modal 會把 toast 藏在 aria-hidden 後面）。 */
  function DialogHost({ note, pick }: { note: NoteDto; pick: GroupTransferPick }) {
    const [open, setOpen] = useState(true);
    return open ? <GroupTransferDialog note={note} pick={pick} onClose={() => setOpen(false)} /> : null;
  }

  function renderDialog(note: NoteDto, pick: GroupTransferPick) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["folders"], []);
    queryClient.setQueryData(["notes"], []);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/here"]}>
          <Routes>
            <Route path="/here" element={<DialogHost note={note} pick={pick} />} />
          </Routes>
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    return { queryClient };
  }

  const copyBodies = (s: ReturnType<typeof stub>) => s.calls.filter((c) => c.url === URLS.copy).map((c) => c.body);
  const moveBodies = (s: ReturnType<typeof stub>) => s.calls.filter((c) => c.url === URLS.move).map((c) => c.body);

  /** 依序回 replies 的 /copy。 */
  function copySequence(...replies: Array<() => Response>) {
    return () => {
      const next = replies.shift();
      if (next === undefined) throw new Error("no more /copy replies");
      return next();
    };
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubInlineMode(false);
  });
  afterEach(() => {
    cleanup();
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("GT-F1 duplicate：筆記在 A → POST /copy {folderId:A}；筆記在根 → {}", async () => {
    let s = stub();
    renderDialog(IN_A, { kind: "copy", target: { type: "duplicate" } });
    let dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Make a copy" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("This creates a copy in your own notes; the original stays as it is.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(copyBodies(s)).toEqual([{ folderId: "A" }]));
    cleanup();
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());

    s = stub();
    renderDialog(NOTE, { kind: "copy", target: { type: "duplicate" } });
    dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(copyBodies(s)).toEqual([{}]));
    expect(await screen.findByText("Copied to your notes")).toBeInTheDocument();
  });

  it("GT-F2 inPlace：群組筆記在 GF → POST /copy {groupId:G, folderId:GF}", async () => {
    const s = stub();
    renderDialog(GROUP_NOTE_IN_GF, { kind: "copy", target: { type: "inPlace", group: GROUP_G } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('next to the original in "G"');
    fireEvent.click(within(dialog).getByRole("button", { name: "Make a copy" }));
    await waitFor(() => expect(copyBodies(s)).toEqual([{ groupId: GG, folderId: "GF" }]));
  });

  it('GT-F3 personal 帶 folder（共享筆記）→ {folderId:A}、說明含 "My notes › A"、鈕 Copy to my notes；不帶 → {}、說明照現行', async () => {
    let s = stub();
    renderDialog(SHARED_IN_S1, { kind: "copy", target: { type: "personal", folder: { id: "A", path: "My notes › A" } } });
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('This creates a copy in "My notes › A"; the original stays as it is.');
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy to my notes" }));
    await waitFor(() => expect(copyBodies(s)).toEqual([{ folderId: "A" }]));
    expect(await screen.findByText("Copied to your notes")).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());

    s = stub();
    renderDialog(SHARED_IN_S1, { kind: "copy", target: { type: "personal" } });
    dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("This creates a copy in your own notes; the original stays as it is.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy to my notes" }));
    await waitFor(() => expect(copyBodies(s)).toEqual([{}]));
  });

  it('GT-F4 group 帶 folder → {groupId:G, folderId:GF}、說明含 "G › GF"；成功 toast 照現行（群組名）', async () => {
    const s = stub();
    renderDialog(NOTE, { kind: "copy", target: { type: "group", group: GROUP_G, folder: { id: "GF", path: "G › GF" } } });
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('This creates a copy in "G › GF"; the original stays as it is.');
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy into group" }));
    await waitFor(() => expect(copyBodies(s)).toEqual([{ groupId: GG, folderId: "GF" }]));
    expect(await screen.findByText('Copied into "G"')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open copy" })).toBeInTheDocument();
  });

  it('GT-F5 MoveDialog 帶 folder → 說明 Move this note into "G › GF"?、body {groupId, folderId}、toast Moved into "G › GF"；不帶 → body 鍵恰 [groupId]', async () => {
    let s = stub();
    renderDialog(NOTE, { kind: "move", target: { type: "group", group: GROUP_G, folder: { id: "GF", path: "G › GF" } } });
    let dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Move this note into "G › GF"?');
    let submit = within(dialog).getByRole("button", { name: "Move into group" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(moveBodies(s)).toEqual([{ groupId: GG, folderId: "GF" }]));
    expect(await screen.findByText('Moved into "G › GF"')).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());

    s = stub();
    renderDialog(NOTE, { kind: "move", target: { type: "group", group: GROUP_G } });
    dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Move this note into "G"?');
    submit = within(dialog).getByRole("button", { name: "Move into group" });
    await waitFor(() => expect(submit).not.toBeDisabled());
    fireEvent.click(submit);
    await waitFor(() => expect(moveBodies(s)).toHaveLength(1));
    expect(Object.keys(moveBodies(s)[0] as object)).toEqual(["groupId"]);
    expect(await screen.findByText('Moved into "G"')).toBeInTheDocument();
  });

  it.each([
    ["duplicate", IN_A, { type: "duplicate" } as TransferTarget, { folderId: "A" }, {}],
    ["inPlace", GROUP_NOTE_IN_GF, { type: "inPlace", group: GROUP_G } as TransferTarget, { groupId: GG, folderId: "GF" }, { groupId: GG }],
  ])(
    "GT-F6 建立副本（%s）第一次 404 folder_not_found → 不帶 folderId 重送一次、toast 退回根層且有 Open copy、['folders'] 被失效",
    async (_name, note, target, first, second) => {
      const s = stub({ copy: copySequence(() => failJson(404, "folder_not_found"), () => okJson(COPY, 201)) });
      const { queryClient } = renderDialog(note, { kind: "copy", target });
      fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Make a copy" }));
      expect(await screen.findByText("Copy created at the top level (the original folder is gone)")).toBeInTheDocument();
      expect(copyBodies(s)).toEqual([first, second]);
      expect(screen.getByRole("button", { name: "Open copy" })).toBeInTheDocument();
      expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    },
  );

  it("GT-F6 退回重送也失敗 → 照現行錯誤 toast、共送兩次", async () => {
    const s = stub({ copy: copySequence(() => failJson(404, "folder_not_found"), () => failJson(404, "group_not_found")) });
    renderDialog(IN_A, { kind: "copy", target: { type: "duplicate" } });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Make a copy" }));
    expect(await screen.findByText("We couldn't find that group.")).toBeInTheDocument();
    expect(copyBodies(s)).toEqual([{ folderId: "A" }, {}]);
  });

  it.each([
    ["personal", SHARED_IN_S1, { type: "personal", folder: { id: "A", path: "My notes › A" } } as TransferTarget, "Copy to my notes"],
    ["group", NOTE, { type: "group", group: GROUP_G, folder: { id: "GF", path: "G › GF" } } as TransferTarget, "Copy into group"],
  ])("GT-F7 明選資料夾（%s）404 folder_not_found → 不重試、toast Folder not found.、['folders']／['notes'] 被失效", async (_name, note, target, button) => {
    const s = stub({ copy: copySequence(() => failJson(404, "folder_not_found"), () => okJson(COPY, 201)) });
    const { queryClient } = renderDialog(note, { kind: "copy", target });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: button }));
    expect(await screen.findByText("Folder not found.")).toBeInTheDocument();
    await act(async () => {});
    expect(copyBodies(s)).toHaveLength(1);
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    // ['folders'] 失敗時 useCopyNote 的 onSettled 也會失效；['notes'] 失敗時只有 invalidateFolderRelated 會失效。
    expect(queryClient.getQueryState(["notes"])?.isInvalidated).toBe(true);
  });

  it("GT-F8 zh：已建立副本（原資料夾已不在，放在最上層）；已移到「我的筆記 › A」", async () => {
    await i18n.changeLanguage("zh-TW");
    stub({ copy: copySequence(() => failJson(404, "folder_not_found"), () => okJson(COPY, 201)) });
    renderDialog(IN_A, { kind: "copy", target: { type: "duplicate" } });
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "建立副本" }));
    expect(await screen.findByText("已建立副本（原資料夾已不在，放在最上層）")).toBeInTheDocument();
    expect(i18n.t("folders.movedTo", { name: "我的筆記 › A" })).toBe("已移到「我的筆記 › A」");
    await i18n.changeLanguage("en");
    expect(i18n.t("folders.movedTo", { name: "A" })).toBe("Moved to “A”");
  });
});

// PR-3b-2 T4：⋮ 的逐層子選單（資料夾 spec §6.11.1、§6.11.4、§6.14）。寬＝flyout（jsdom 預設）；窄／觸控＝就地展開。
// 焦點與子選單換層在 jsdom 只守「程式有搬焦點／狀態有變」，真瀏覽器由 e2e 41 驗。
describe("⋮ 逐層子選單（PR-3b-2 T4）", () => {
  const GG = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const GH = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
  const G = groupDto({ id: GG, name: "G" }, memberRole());
  const H = groupDto({ id: GH, name: "H" }, memberRole());
  const A = folderDto({ id: "A", name: "A" });
  const A1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
  const A2 = folderDto({ id: "A2", name: "A2", parentId: "A1" });
  const B = folderDto({ id: "B", name: "B" });
  const GF = groupFolder({ id: "GF", name: "GF", groupId: GG });
  const HF = groupFolder({ id: "HF", name: "HF", groupId: GH });
  const SF = sharedFolder({ id: "SF", name: "SF" });
  /** 個人 A ⊃ A1、B；群組 G、H 沒有資料夾（NM-D1 的形）。 */
  const BASE_SERVER = { groups: [G, H], folders: [A, A1, B] };

  /** 可及名稱：aria-label 優先，否則去掉 aria-hidden 的字（「‹ 」）。 */
  function accessibleName(el: Element): string {
    const label = el.getAttribute("aria-label");
    if (label !== null) return label;
    const clone = el.cloneNode(true) as Element;
    clone.querySelectorAll('[aria-hidden="true"]').forEach((hidden) => hidden.remove());
    return (clone.textContent ?? "").trim();
  }
  const names = (container: HTMLElement) => within(container).queryAllByRole("menuitem").map(accessibleName);
  /** 項目與分隔線依 DOM 序（分隔線記成 "—"）。 */
  const entries = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
      el.getAttribute("role") === "separator" ? "—" : accessibleName(el),
    );
  const placeBodies = (s: ReturnType<typeof stub>) => s.calls.filter((c) => c.method === "PUT" && c.url === URLS.place).map((c) => c.body);
  const subMenu = (name = "Move to…") => screen.queryByRole("menu", { name });

  /** 開 ⋮ → 鍵盤開 Move to… 的 flyout，等第一層有 expected 這些項。 */
  async function openMoveSub(expected: string[]): Promise<HTMLElement> {
    const sub = await openFlyout(await openMenuReady("note-menu-move-to"));
    await waitFor(() => expect(names(sub)).toEqual(expected));
    return sub;
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    stubInlineMode(false);
  });
  afterEach(() => {
    cleanup();
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("NM-D1 個人筆記在根、A ⊃ A1：Move to… 第一層＝[A, open, B, G, H]，分隔線在 B 與 G 之間、A 尾端有 aria-hidden 的 >", async () => {
    stub(BASE_SERVER);
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    expect(entries(sub)).toEqual(["A, open", "B", "—", "G", "H"]);
    const a = within(sub).getByRole("menuitem", { name: "A, open" });
    const chevron = a.querySelector('svg[data-icon="chevron-right"]');
    expect(chevron).not.toBeNull();
    expect(chevron).toHaveAttribute("aria-hidden", "true");
    expect(within(sub).getByRole("menuitem", { name: "B" }).querySelector("svg")).toBeNull();
  });

  it("NM-D2 點「A, open」→ 選單與子選單仍開、換成 [Back, Move here, A1]、焦點在 Back（「‹ 」aria-hidden）、子選單捲回頂端", async () => {
    stub(BASE_SERVER);
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    // jsdom 沒有版面：用可寫的 scrollTop 記下程式有沒有把子選單捲回頂端。
    let scrollTop = 40;
    Object.defineProperty(sub, "scrollTop", { configurable: true, get: () => scrollTop, set: (value: number) => (scrollTop = value) });
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    await waitFor(() => expect(scrollTop).toBe(0));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A1"]));
    expect(subMenu()).toBe(sub);
    expect(screen.getByTestId("note-menu-move-to")).toBeInTheDocument();
    const back = within(sub).getByRole("menuitem", { name: "Back" });
    expect(document.activeElement).toBe(back);
    expect(back).toHaveTextContent("‹ Back");
    expect(back.querySelector('[aria-hidden="true"]')).toHaveTextContent("‹");
  });

  it("NM-D3 第二層 ArrowLeft → 回第一層、子選單仍開；第一層 ArrowLeft → 子選單關（交 Radix）", async () => {
    stub(BASE_SERVER);
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A1"]));
    fireEvent.keyDown(within(sub).getByRole("menuitem", { name: "A1" }), { key: "ArrowLeft" });
    await waitFor(() => expect(names(sub)).toEqual(["A, open", "B", "G", "H"]));
    expect(subMenu()).toBe(sub);
    const first = within(sub).getByRole("menuitem", { name: "A, open" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    await waitFor(() => expect(subMenu()).toBeNull());
    expect(screen.getByTestId("note-menu-move-to")).toBeInTheDocument();
  });

  it("NM-D4 在 A1（有子資料夾）上 ArrowRight → 進下一層 [Back, Move here, A2]、焦點在 Back", async () => {
    stub({ ...BASE_SERVER, folders: [A, A1, A2, B] });
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    const a1 = await within(sub).findByRole("menuitem", { name: "A1, open" });
    a1.focus();
    fireEvent.keyDown(a1, { key: "ArrowRight" });
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A2"]));
    expect(document.activeElement).toBe(within(sub).getByRole("menuitem", { name: "Back" }));
    expect(subMenu()).toBe(sub);
  });

  it("NM-D5 第二層按 Esc → 只關子選單、主選單仍開、焦點回 Move to…；再開子選單 → 第一層", async () => {
    stub(BASE_SERVER);
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    const back = await within(sub).findByRole("menuitem", { name: "Back" });
    fireEvent.keyDown(back, { key: "Escape" });
    await waitFor(() => expect(subMenu()).toBeNull());
    const trigger = screen.getByTestId("note-menu-move-to");
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    const again = await openFlyout(trigger);
    expect(names(again)).toEqual(["A, open", "B", "G", "H"]);
  });

  it("NM-D6 第二層時關掉整個選單（點選單外）再開 → 子選單回第一層", async () => {
    stub(BASE_SERVER);
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A1"]));
    fireEvent.pointerDown(document.body);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    const again = await openFlyout(await openMenuReady("note-menu-move-to"));
    expect(names(again)).toEqual(["A, open", "B", "G", "H"]);
  });

  it("NM-D7 GET /api/folders 還沒回 → 子選單只有群組項、沒有「, open」；回了才補上 A、B", async () => {
    const s = stub({ ...BASE_SERVER, hold: new Set([URLS.folders]) });
    renderMenu();
    const sub = await openFlyout(await openMenuReady("note-menu-move-to"));
    await waitFor(() => expect(names(sub)).toEqual(["G", "H"]));
    expect(names(sub).some((name) => name.endsWith(", open"))).toBe(false);
    await act(async () => s.release(URLS.folders, okJson({ folders: [A, A1, B] })));
    await waitFor(() => expect(names(sub)).toEqual(["A, open", "B", "G", "H"]));
  });

  it("NM-D8 點「B」（沒有子資料夾）→ 選單關、不開確認框、PUT {folderId:B}、toast「Moved to “B”」", async () => {
    const s = stub(BASE_SERVER);
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "B" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(await screen.findByText("Moved to “B”")).toBeInTheDocument();
    expect(placeBodies(s)).toEqual([{ folderId: "B" }]);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("NM-D9 點「G, open」→ [Back, Top level, GF]；選 GF → 選單關、移入確認框說明含 G › GF、不送 PUT", async () => {
    const s = stub({ ...BASE_SERVER, folders: [A, A1, B, GF] });
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G, open", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "G, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Top level", "GF"]));
    fireEvent.click(within(sub).getByRole("menuitem", { name: "GF" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent('Move this note into "G › GF"?');
    expect(screen.queryByRole("menu")).toBeNull();
    expect(placeBodies(s)).toEqual([]);
  });

  it("NM-D10 Copy to… 第一層選「Make a copy」→ CopyDialog 標題 Make a copy", async () => {
    stub(BASE_SERVER);
    renderMenu();
    const sub = await openFlyout(await openMenuReady("note-menu-copy-to"));
    await waitFor(() => expect(names(sub)).toEqual(["Make a copy", "A, open", "B", "G", "H"]));
    fireEvent.click(within(sub).getByRole("menuitem", { name: "Make a copy" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Make a copy" })).toBeInTheDocument();
  });

  it("NM-D11 筆記在 B（沒有子資料夾）→ 第一層有 Top level、B 那一項 aria-disabled", async () => {
    stub(BASE_SERVER);
    renderMenu({ ...NOTE, folderId: "B" });
    const sub = await openMoveSub(["Top level", "A, open", "B", "G", "H"]);
    expect(within(sub).getByRole("menuitem", { name: "B" })).toHaveAttribute("aria-disabled", "true");
    expect(within(sub).getByRole("menuitem", { name: "Top level" })).not.toHaveAttribute("aria-disabled");
  });

  it("NM-D12 群組筆記（edit）→ Move to… 只列本群組資料夾；只讀 → 沒有 Move to…；共享筆記 → 只列共享資料夾", async () => {
    const IN_G: NoteDto = { ...MOVED, groupId: GG, group: { id: GG, name: "G" } };
    stub({ groups: [G, H], folders: [A, GF, HF, SF] });
    renderMenu(IN_G);
    await openMoveSub(["GF"]);
    cleanup();
    vi.unstubAllGlobals();
    stubInlineMode(false);

    stub({ groups: [G, H], folders: [A, GF, HF, SF] });
    renderMenu({ ...IN_G, role: "viewer", permissions: { ...EDITOR_PERMS, edit: false } });
    await openMenuReady("note-menu-copy-to");
    await act(async () => {});
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    cleanup();
    vi.unstubAllGlobals();
    stubInlineMode(false);

    stub({ groups: [G, H], folders: [A, GF, HF, SF] });
    renderMenu({ ...NOTE, role: "editor", ownerId: "someone", ownerHandle: "someone", permissions: { ...EDITOR_PERMS, moveToGroup: false } });
    await openMoveSub(["SF"]);
  });

  it("NM-D13 zh：「A，開啟下一層」→「返回」「移動到這裡」", async () => {
    await i18n.changeLanguage("zh-TW");
    stub(BASE_SERVER);
    renderMenu();
    fireEvent.pointerDown(screen.getByRole("button", { name: "更多" }), { button: 0 });
    const sub = await openFlyout(await screen.findByTestId("note-menu-move-to"));
    await waitFor(() => expect(names(sub)).toEqual(["A，開啟下一層", "B", "G", "H"]));
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A，開啟下一層" }));
    await waitFor(() => expect(names(sub)).toEqual(["返回", "移動到這裡", "A1"]));
  });

  // 以下 NM-D14–D18、NM-I4 是 implementer 自補（brief 沒列）：所在層失效（T2 交接：不看 path.length）、選定後與收合時回第一層、復原送回原處。
  it("NM-D14 在 A › A1 時 A1 被刪（folders 重抓）→ 顯示 A 那層；按「返回」恰退一層到第一層", async () => {
    const s = stub({ ...BASE_SERVER, folders: [A, A1, A2, B] });
    const qc = renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    fireEvent.click(await within(sub).findByRole("menuitem", { name: "A1, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A2"]));
    s.server.folders = [A, B];
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["folders"] });
    });
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here"]));
    fireEvent.click(within(sub).getByRole("menuitem", { name: "Back" }));
    await waitFor(() => expect(names(sub)).toEqual(["A", "B", "G", "H"]));
  });

  it("NM-D15 在 A 那層時 A 被刪 → 顯示第一層；第一層 ArrowLeft 照 Radix 關子選單（不是回「上一層」）", async () => {
    const s = stub(BASE_SERVER);
    const qc = renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A1"]));
    s.server.folders = [B];
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["folders"] });
    });
    await waitFor(() => expect(names(sub)).toEqual(["B", "G", "H"]));
    fireEvent.keyDown(within(sub).getByRole("menuitem", { name: "B" }), { key: "ArrowLeft" });
    await waitFor(() => expect(subMenu()).toBeNull());
  });

  it("NM-D16 在 A 那層時 A 被刪 → 第一層點「B, open」→ 進 B 那層（不接在失效的 A 後面）", async () => {
    const B1 = folderDto({ id: "B1", name: "B1", parentId: "B" });
    const s = stub({ ...BASE_SERVER, folders: [A, A1, B, B1] });
    const qc = renderMenu();
    const sub = await openMoveSub(["A, open", "B, open", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "A, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "A1"]));
    s.server.folders = [B, B1];
    await act(async () => {
      await qc.invalidateQueries({ queryKey: ["folders"] });
    });
    await waitFor(() => expect(names(sub)).toEqual(["B, open", "G", "H"]));
    fireEvent.click(within(sub).getByRole("menuitem", { name: "B, open" }));
    await waitFor(() => expect(names(sub)).toEqual(["Back", "Move here", "B1"]));
  });

  it("NM-D17 在第二層選定（開確認框、選單由程式關閉）→ 取消後再開 ⋮ → 子選單回第一層", async () => {
    stub({ ...BASE_SERVER, folders: [A, A1, B, GF] });
    renderMenu();
    const sub = await openMoveSub(["A, open", "B", "G, open", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "G, open" }));
    fireEvent.click(await within(sub).findByRole("menuitem", { name: "GF" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const again = await openFlyout(await openMenuReady("note-menu-move-to"));
    expect(names(again)).toEqual(["A, open", "B", "G, open", "H"]);
  });

  it("NM-D18 筆記在 A1：移到 B → toast 用短名「B」；按 Undo → PUT 回 {folderId:A1}", async () => {
    const s = stub(BASE_SERVER);
    renderMenu({ ...NOTE, folderId: "A1" });
    const sub = await openMoveSub(["Top level", "A, open", "B", "G", "H"]);
    fireEvent.click(within(sub).getByRole("menuitem", { name: "B" }));
    expect(await screen.findByText("Moved to “B”")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(placeBodies(s)).toEqual([{ folderId: "B" }, { folderId: "A1" }]));
  });

  describe("就地展開形（窄視窗／觸控）", () => {
    beforeEach(() => {
      stubInlineMode(true);
    });

    /** 開 ⋮、展開 Move to…，等縮排區有 expected 這些項。 */
    async function expandMove(expected: string[]): Promise<{ trigger: HTMLElement; group: HTMLElement }> {
      const trigger = await openMenuReady("note-menu-move-to");
      fireEvent.click(trigger);
      const group = screen.getByRole("group", { name: "Move to…" });
      await waitFor(() => expect(names(group)).toEqual(expected));
      return { trigger, group };
    }

    it("NM-I1 展開 → 縮排的 A（帶 >）…；點 A → 縮排區換成 [Back, Move here, A1]、觸發項仍在、焦點在 Back", async () => {
      stub(BASE_SERVER);
      renderMenu();
      const { trigger, group } = await expandMove(["A, open", "B", "G", "H"]);
      const a = within(group).getByRole("menuitem", { name: "A, open" });
      expect(a).toHaveClass("pl-6");
      expect(a.querySelector('svg[data-icon="chevron-right"]')).toHaveAttribute("aria-hidden", "true");
      fireEvent.click(a);
      await waitFor(() => expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["Back", "Move here", "A1"]));
      expect(trigger).toBeInTheDocument();
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const back = screen.getByRole("menuitem", { name: "Back" });
      expect(back).toHaveClass("pl-6");
      expect(document.activeElement).toBe(back);
      expect(screen.getAllByRole("menu")).toHaveLength(1);
    });

    it("NM-I2 第二層 ArrowLeft → 回第一層（仍展開）；第一層 ArrowLeft → 收合", async () => {
      stub(BASE_SERVER);
      renderMenu();
      const { trigger, group } = await expandMove(["A, open", "B", "G", "H"]);
      fireEvent.click(within(group).getByRole("menuitem", { name: "A, open" }));
      const back = await screen.findByRole("menuitem", { name: "Back" });
      fireEvent.keyDown(back, { key: "ArrowLeft" });
      await waitFor(() => expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["A, open", "B", "G", "H"]));
      expect(trigger).toHaveAttribute("aria-expanded", "true");
      const first = screen.getByRole("menuitem", { name: "A, open" });
      expect(document.activeElement).toBe(first);
      fireEvent.keyDown(first, { key: "ArrowLeft" });
      await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("NM-I3 第二層按 Esc → 收合、選單仍開；再展開 → 第一層", async () => {
      stub(BASE_SERVER);
      renderMenu();
      const { trigger, group } = await expandMove(["A, open", "B", "G", "H"]);
      fireEvent.click(within(group).getByRole("menuitem", { name: "A, open" }));
      const back = await screen.findByRole("menuitem", { name: "Back" });
      fireEvent.keyDown(back, { key: "Escape" });
      await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
      expect(screen.getByRole("menu")).toBeInTheDocument();
      fireEvent.click(trigger);
      expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["A, open", "B", "G", "H"]);
    });

    it("NM-I4（自補）第二層時再點觸發項收合 → 再展開回第一層；第二層時改展開 Copy to… → 回頭展開 Move to… 也是第一層", async () => {
      stub(BASE_SERVER);
      renderMenu();
      const { trigger, group } = await expandMove(["A, open", "B", "G", "H"]);
      fireEvent.click(within(group).getByRole("menuitem", { name: "A, open" }));
      await screen.findByRole("menuitem", { name: "Back" });
      fireEvent.click(trigger);
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["A, open", "B", "G", "H"]);

      fireEvent.click(screen.getByRole("menuitem", { name: "A, open" }));
      await screen.findByRole("menuitem", { name: "Back" });
      fireEvent.click(screen.getByTestId("note-menu-copy-to"));
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["A, open", "B", "G", "H"]);
    });

    // flyout 形的 NM-D6／NM-D17 另有 Radix `MenuSub` 自己的保險（父選單關閉或卸載時呼叫 onOpenChange(false) → 子選單關閉重設 path），
    // 主選單關閉與選定後的重設只有在就地展開形才是唯一一道：這兩案守它（自補）。
    it("NM-I5（自補，NM-D6 的就地展開版）第二層時點選單外關掉整個選單 → 再開、展開 → 第一層", async () => {
      stub(BASE_SERVER);
      renderMenu();
      const { group } = await expandMove(["A, open", "B", "G", "H"]);
      fireEvent.click(within(group).getByRole("menuitem", { name: "A, open" }));
      await screen.findByRole("menuitem", { name: "Back" });
      fireEvent.pointerDown(document.body);
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      fireEvent.click(await openMenuReady("note-menu-move-to"));
      expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["A, open", "B", "G", "H"]);
    });

    it("NM-I6（自補，NM-D17 的就地展開版）第二層選定（確認框）→ 取消後再開、展開 → 第一層", async () => {
      stub({ ...BASE_SERVER, folders: [A, A1, B, GF] });
      renderMenu();
      const { group } = await expandMove(["A, open", "B", "G, open", "H"]);
      fireEvent.click(within(group).getByRole("menuitem", { name: "G, open" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "GF" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.click(await openMenuReady("note-menu-move-to"));
      expect(names(screen.getByRole("group", { name: "Move to…" }))).toEqual(["A, open", "B", "G, open", "H"]);
    });
  });
});

describe("isSameSpaceMove（PR-3b-2 T4 fix）", () => {
  const place = (space: DestSpace): DestinationPick["target"] => ({ kind: "place", space, folder: null });
  const pick = (kind: "move" | "copy", target: DestinationPick["target"]): DestinationPick => ({ kind, target, groups: [], index: indexFolders([]) });
  const groupNote: NoteDto = { ...NOTE, groupId: GA };
  /** 別人分享給我的筆記：移動來源的上半部是「與我共享」（`noteDestSource`）。 */
  const sharedWithMe: NoteDto = { ...NOTE, ownerId: "u2", role: "editor", permissions: { ...EDITOR_PERMS } };

  it("個人筆記移到我的筆記、共享筆記移到共享 → true", () => {
    expect(isSameSpaceMove(NOTE, pick("move", place({ kind: "personal" })))).toBe(true);
    expect(isSameSpaceMove(sharedWithMe, pick("move", place({ kind: "shared" })))).toBe(true);
  });
  it("群組筆記移到自己的群組 → true", () => {
    expect(isSameSpaceMove(groupNote, pick("move", place({ kind: "group", groupId: GA, name: "A" })))).toBe(true);
  });
  it("個人筆記移到群組、群組筆記移到別的群組 → false", () => {
    expect(isSameSpaceMove(NOTE, pick("move", place({ kind: "group", groupId: GA, name: "A" })))).toBe(false);
    expect(isSameSpaceMove(groupNote, pick("move", place({ kind: "group", groupId: GC, name: "C" })))).toBe(false);
  });
  it("複製、建立副本 → false", () => {
    expect(isSameSpaceMove(NOTE, pick("copy", place({ kind: "personal" })))).toBe(false);
    expect(isSameSpaceMove(NOTE, pick("copy", { kind: "makeCopy" }))).toBe(false);
    expect(isSameSpaceMove(NOTE, pick("move", { kind: "makeCopy" }))).toBe(false);
  });
});
