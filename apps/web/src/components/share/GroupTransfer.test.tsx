import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { GroupDto, NoteDto, ShareDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { groupDto, memberRole, OWNER_PERMS, EDITOR_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { NoteMenu } from "@/components/NoteMenu";
import { INLINE_GROUP_LIST_QUERY } from "./GroupTransfer";

// #216：⋮ 選單的「移動到群組」「複製到群組」（原 MoveToGroupSection 的測試搬來）。
// 寬螢幕＝右側 flyout（Radix Sub）；窄／觸控（matchMedia 命中 INLINE_GROUP_LIST_QUERY）＝就地向下展開。

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
const URLS = { groups: "/api/groups", shares: `${BASE}/shares`, link: `${BASE}/public-link`, note: BASE, move: `${BASE}/move`, copy: `${BASE}/copy` };

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
  shares: ShareDto[];
  token: string | null;
  latest: NoteDto;
  move?: () => Response | Promise<Response>;
  copy?: () => Response | Promise<Response>;
  /** 這些 URL 的 GET 懸置，直到 `release(url, response)`。 */
  hold?: Set<string>;
}

function stub(init: Partial<Server> = {}) {
  const server: Server = { groups: [GROUP_A, GROUP_C], shares: [], token: null, latest: NOTE, ...init };
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
      if (method === "GET" && url === URLS.shares) return Promise.resolve(okJson([...server.shares]));
      if (method === "GET" && url === URLS.link) return Promise.resolve(okJson({ token: server.token, slug: null }));
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

  it("矩陣：群組筆記 -> 沒有移動；複製＝建立副本（原群組）、個人空間、其餘群組（不含原群組）", async () => {
    stub({ groups: [GROUP_A, GROUP_C] });
    renderMenu(GROUP_NOTE);
    await openMenuReady();
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    const sub = await openFlyout(screen.getByTestId("note-menu-copy-to"));
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Make a copy",
      "Personal space",
      "Workshop C",
    ]);
  });

  it("矩陣：群組筆記、我在該群組只能讀（無 create／edit）-> 沒有建立副本、仍有個人空間（與其餘可用群組）", async () => {
    const READER_A = groupDto(
      { id: GA, name: "Workshop A" },
      memberRole({ permissions: { ...memberRole().permissions, create: false, edit: false } }),
    );
    stub({ groups: [READER_A, GROUP_C] });
    renderMenu(GROUP_NOTE);
    const sub = await openFlyout(await openMenuReady());
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual(["Personal space", "Workshop C"]);
  });

  it.each([
    ["viewer", VIEWER_PERMS],
    ["editor", { ...EDITOR_PERMS, moveToGroup: false }],
  ] as const)("矩陣：別人分享給我的個人筆記（%s）-> 沒有移動；複製＝個人空間＋我 create＋edit 的群組", async (role, permissions) => {
    stub({ groups: [GROUP_A, GROUP_B, GROUP_C] });
    renderMenu({ ...NOTE, role, ownerId: "someone", ownerHandle: "someone", permissions: { ...permissions } });
    const sub = await openFlyout(await openMenuReady());
    expect(screen.queryByTestId("note-menu-move-to")).toBeNull();
    expect(within(sub).getAllByRole("menuitem").map((e) => e.textContent)).toEqual([
      "Personal space",
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

  it("個人空間／建立副本：複製確認文案與 POST body（個人 {}、原群組 {groupId}）", async () => {
    const s = stub();
    renderMenu(GROUP_NOTE);
    await pickFlyout("note-menu-copy-to", "Personal space");
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
    expect(qc.getQueryData(["public-link", NOTE.id])).toEqual({ token: null, slug: null });
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
