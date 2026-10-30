import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { FolderDto, GroupDto, NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider, type SidebarTab } from "@/lib/sidebar-tab";
import { SidebarTabList } from "@/components/sidebar/SidebarTabList";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { __resetDragSessionForTests, getDragSource, useDragView } from "@/components/sidebar/drag-session";
import { DRAG_HOVER_DELAY_MS, DRAG_NOTE_MIME } from "@/components/sidebar/drag-zone";
import { DROP_SCOPE_CLASS } from "@/components/sidebar/useSidebarDrag";
import { groupDto, memberRole } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { createFakeDataTransfer, mockFinePointer, type FakeDataTransfer } from "@/test/drag-fixtures";
import { NoteList } from "./NoteList";

/**
 * 側欄拖曳接線（資料夾 spec §6.13、§6.8；PR-3c T4）：接手判準、落點範圍提示、放進資料夾／回根目錄（樂觀）、彈簧資料夾。
 * fixture（同 T2 的子集）：個人 F ⊃ F1；根層 A、F 裡 N1、N2；群組 G 有 GF、根層 g1、GF 裡 g2、唯讀 gr；群組 H 有 HF、h1。
 * 計時照 plan H7：渲染與等樹用真計時，只在停留段切假的 setTimeout／clearTimeout。
 */

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
  __resetDragSessionForTests();
  vi.useRealTimers();
});

const G: GroupDto = groupDto({ id: "G", name: "G" }, memberRole());
const H: GroupDto = groupDto({ id: "H", name: "H" }, memberRole());

const FOLDERS: FolderDto[] = [
  folderDto({ id: "F", name: "F" }),
  folderDto({ id: "F1", name: "F1", parentId: "F" }),
  groupFolder({ id: "GF", name: "GF", groupId: "G" }),
  groupFolder({ id: "HF", name: "HF", groupId: "H" }),
];

const NOTES: NoteDto[] = [
  personalNote({ id: "A", title: "A" }),
  personalNote({ id: "N1", title: "N1", folderId: "F" }),
  personalNote({ id: "N2", title: "N2", folderId: "F" }),
  groupNote({ id: "g1", title: "g1", group: G }),
  groupNote({ id: "g2", title: "g2", group: G, folderId: "GF" }),
  groupNote({ id: "gr", title: "gr", group: G, edit: false }),
  groupNote({ id: "h1", title: "h1", group: H }),
];

const ME: UserDto = { id: "u1", email: "me@example.com", handle: "tester", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };

type Reply = { status: number; body: unknown };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/**
 * 假 server：GET 照常回；寫入（`PUT /api/notes/:id/folder`、`POST /api/folders`、`PATCH /api/folders/:id`）先掛著，`respond()` 依序才回
 * （預設成功＝更新 server 端的資料再回它，之後的重抓看得到新位置；POST 建出的資料夾 id 恆為 "NEW"）。
 * `extra` 給個別案例多加的筆記與資料夾。
 */
function stubServer(extra: { notes?: NoteDto[]; folders?: FolderDto[] } = {}) {
  const notes = [...NOTES, ...(extra.notes ?? [])].map((note) => ({ ...note }));
  const folders = [...FOLDERS, ...(extra.folders ?? [])].map((folder) => ({ ...folder }));
  const puts: { url: string; body: unknown }[] = [];
  /** 每一發寫入（method、url、body）。 */
  const writes: { method: string; url: string; body: unknown }[] = [];
  const pending: ((reply?: Reply) => void)[] = [];
  const hold = (succeed: () => Response) =>
    new Promise<Response>((resolve) => {
      pending.push((reply) => resolve(reply !== undefined ? json(reply.body, reply.status) : succeed()));
    });
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/folders" && method === "GET") return Promise.resolve(json({ folders }));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(json(notes));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G, H]));
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET") writes.push({ method, url, body });
    const match = /^\/api\/notes\/([^/]+)\/folder$/.exec(url);
    if (match !== null && method === "PUT") {
      const { folderId } = body as { folderId: string | null };
      puts.push({ url, body });
      return hold(() => {
        const index = notes.findIndex((note) => note.id === match[1]);
        notes[index] = { ...notes[index]!, folderId };
        return json(notes[index]);
      });
    }
    if (url === "/api/folders" && method === "POST") {
      const input = body as { name: string; parentId?: string; space?: FolderDto["space"] };
      return hold(() => {
        const parent = input.parentId === undefined ? undefined : folders.find((folder) => folder.id === input.parentId);
        const created = folderDto({ id: "NEW", name: input.name, parentId: input.parentId ?? null, space: parent?.space ?? input.space });
        folders.push(created);
        return json(created, 201);
      });
    }
    const folderMatch = /^\/api\/folders\/([^/]+)$/.exec(url);
    if (folderMatch !== null && method === "PATCH") {
      return hold(() => {
        const index = folders.findIndex((folder) => folder.id === folderMatch[1]);
        folders[index] = { ...folders[index]!, name: (body as { name: string }).name };
        return json(folders[index]);
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    puts,
    writes,
    /** server 端的筆記與資料夾（案例可直接改，下一次重抓就看得到）。 */
    notes,
    folders,
    /** 等到有掛著的寫入，再回最早的那一發。 */
    respond: async (reply?: Reply) => {
      await waitFor(() => expect(pending.length).toBeGreaterThan(0));
      const next = pending.shift()!;
      await act(async () => {
        next(reply);
      });
    },
  };
}

function DragProbe() {
  const { active } = useDragView();
  return <span data-testid="drag-active">{String(active)}</span>;
}

/** 渲染骨架＝`NoteList.test.tsx` 的 `renderNoteList`，再加 `<Toaster />` 與讀拖曳狀態的探針。 */
function renderNoteList(opts: { tab?: SidebarTab } = {}) {
  if (opts.tab) localStorage.setItem("sidebar.tab", opts.tab);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <SidebarTabList idBase="t" />
            <div role="tabpanel">
              <NoteList />
            </div>
            <DragProbe />
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient, unmount: view.unmount };
}

const panel = () => screen.getByRole("tabpanel");
const list = () => panel().querySelector("[data-sidebar-list]") as HTMLElement;
const nodeOf = (kind: "note" | "folder" | "group", id: string) =>
  panel().querySelector(`[data-node-kind="${kind}"][data-node-id="${id}"]`) as HTMLElement | null;
const noteLink = (id: string) => nodeOf("note", id)!.querySelector("a") as HTMLElement;
/** 資料夾／群組的列（`<li>` 的第一個子元素）。 */
const rowOf = (kind: "folder" | "group", id: string) => nodeOf(kind, id)!.firstElementChild as HTMLElement;
const childIds = (kind: "folder" | "group", id: string) =>
  Array.from(nodeOf(kind, id)?.querySelector(":scope > div > ul")?.children ?? []).map((li) => li.getAttribute("data-node-id"));
const topIds = () => Array.from(list().firstElementChild?.querySelector(":scope > ul")?.children ?? []).map((li) => li.getAttribute("data-node-id"));
const scoped = () => Array.from(panel().querySelectorAll("[data-drop-scope]"));
const dropScopeTokens = DROP_SCOPE_CLASS.split(" ");

async function waitForTree(id = "F") {
  await waitFor(() => expect(nodeOf(id === "G" ? "group" : "folder", id)).not.toBeNull());
}

/** 在筆記連結上 dragStart，回這一輪的假 DataTransfer。 */
function startDrag(id: string, el: HTMLElement = noteLink(id)): FakeDataTransfer {
  const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
  fireEvent.dragStart(el, { dataTransfer: dt });
  return dt;
}

describe("NoteList 拖曳", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    mockFinePointer(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("ND1 不是精細指標 → dragStart 不接手（不寫自訂型別）；之後對 F 的 dragOver 不處理", async () => {
    mockFinePointer(false);
    stubServer();
    renderNoteList();
    await waitForTree();

    const dt = startDrag("A");

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt })).toBe(true);
    expect(scoped()).toHaveLength(0);
  });

  it("ND2 接手：setData(DRAG_NOTE_MIME, 'A') 一次、不 clearData、effectAllowed 'all'", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();

    const dt = startDrag("A");

    expect(dt.setData).toHaveBeenCalledTimes(1);
    expect(dt.setData).toHaveBeenCalledWith(DRAG_NOTE_MIME, "A");
    expect(dt.clearData).not.toHaveBeenCalled();
    expect(dt.effectAllowed).toBe("all");
    expect(dt.types).toEqual(["text/uri-list", "text/plain", DRAG_NOTE_MIME]);
  });

  it("ND3 對 F 列 dragOver → 已處理、dropEffect move、F 的 <li> 標示；回到根層空白（原處）→ 不處理、全樹沒有標示", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");

    expect(fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt })).toBe(false);
    expect(dt.dropEffect).toBe("move");
    expect(scoped()).toEqual([nodeOf("folder", "F")]);
    expect(nodeOf("folder", "F")).toHaveClass(...dropScopeTokens);

    expect(fireEvent.dragOver(list(), { dataTransfer: dt })).toBe(true);
    expect(scoped()).toHaveLength(0);
  });

  it("ND4 drop 到 F：標示立刻消失；PUT {folderId:F}；回應前 A 已在 F 裡（樂觀）；回應後 toast「Moved to “F”」有 Undo", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });

    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: dt });

    expect(scoped()).toHaveLength(0);
    await waitFor(() => expect(server.puts).toEqual([{ url: "/api/notes/A/folder", body: { folderId: "F" } }]));
    await waitFor(() => expect(childIds("folder", "F")).toContain("A"));
    expect(topIds()).not.toContain("A");
    expect(screen.queryByText("Moved to “F”", { exact: true })).toBeNull();

    await server.respond();

    expect(await screen.findByText("Moved to “F”", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("ND5 drop 到 F、PUT 403 forbidden → A 回根層（回滾）、錯誤 toast 為 errors.forbidden", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });
    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: dt });
    await waitFor(() => expect(childIds("folder", "F")).toContain("A"));

    await server.respond({ status: 403, body: { error: { code: "forbidden", message: "x" } } });

    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(topIds()).toContain("A"));
    expect(childIds("folder", "F")).not.toContain("A");
  });

  it("ND6 N1（在 F）drop 到清單空白 → body {folderId:null}、toast「Moved to “Top level”」；Undo → 放回 F", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("N1");
    expect(fireEvent.dragOver(list(), { dataTransfer: dt })).toBe(false);
    expect(scoped()).toEqual([list().firstElementChild]);

    fireEvent.drop(list(), { dataTransfer: dt });
    await waitFor(() => expect(server.puts).toEqual([{ url: "/api/notes/N1/folder", body: { folderId: null } }]));
    await server.respond();

    expect(await screen.findByText("Moved to “Top level”", { exact: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(server.puts).toHaveLength(2));
    expect(server.puts[1]).toEqual({ url: "/api/notes/N1/folder", body: { folderId: "F" } });
    await server.respond();
  });

  it("ND7 在原處 drop（未曾 accept）→ drop 已 preventDefault、沒有任何請求", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(list(), { dataTransfer: dt });
    const calls = server.fetchMock.mock.calls.length;

    expect(fireEvent.drop(list(), { dataTransfer: dt })).toBe(false);
    await act(async () => {});

    expect(server.fetchMock.mock.calls.length).toBe(calls);
    expect(server.puts).toHaveLength(0);
  });

  it("ND8 dragOver F 後 dragEnd → 沒有標示；另一輪 drop 後不發 dragEnd → 沒有標示、拖曳狀態已結束", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const first = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: first });
    expect(scoped()).toHaveLength(1);
    fireEvent.dragEnd(noteLink("A"), { dataTransfer: first });
    expect(scoped()).toHaveLength(0);
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");

    const second = startDrag("A");
    expect(screen.getByTestId("drag-active")).toHaveTextContent("true");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: second });
    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: second });

    expect(scoped()).toHaveLength(0);
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
    await waitFor(() => expect(server.puts).toHaveLength(1));
    await server.respond();
  });

  it("ND9 彈簧：收合的 F 上停 0.5 秒 → 展開（F1 出現）；dragEnd 後仍展開、localStorage 沒有折疊鍵", async () => {
    setCollapsed("folder:F", true);
    stubServer();
    renderNoteList();
    await waitForTree();
    expect(nodeOf("folder", "F1")).toBeNull();
    const dt = startDrag("A");

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });
    act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS));
    expect(nodeOf("folder", "F1")).not.toBeNull();
    vi.useRealTimers();

    fireEvent.dragEnd(noteLink("A"), { dataTransfer: dt });
    expect(nodeOf("folder", "F1")).not.toBeNull();
    expect(localStorage.getItem("sidebar.collapsed.folder:F")).toBeNull();
  });

  it("ND10 選取模式中 → dragStart 不接手", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    await screen.findByRole("button", { name: "Done" });

    const dt = startDrag("A", nodeOf("note", "A")!);

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
  });

  it("ND10 最近 tab → dragStart 不接手", async () => {
    stubServer();
    renderNoteList({ tab: "recent" });
    await waitFor(() => expect(nodeOf("note", "A")).not.toBeNull());

    const dt = startDrag("A");

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
  });

  it("ND11 工作坊：g2 拖到 H 群組列 → 不處理、H 無標示；拖到清單最下方空白 → G 標示；drop → body {folderId:null}", async () => {
    const server = stubServer();
    renderNoteList({ tab: "workspace" });
    await waitForTree("G");
    const dt = startDrag("g2");

    expect(fireEvent.dragOver(rowOf("group", "H"), { dataTransfer: dt })).toBe(true);
    expect(scoped()).toHaveLength(0);

    expect(fireEvent.dragOver(list(), { dataTransfer: dt })).toBe(false);
    expect(scoped()).toEqual([nodeOf("group", "G")]);
    expect(nodeOf("group", "G")).toHaveClass(...dropScopeTokens);

    fireEvent.drop(list(), { dataTransfer: dt });
    await waitFor(() => expect(server.puts).toEqual([{ url: "/api/notes/g2/folder", body: { folderId: null } }]));
    await server.respond();
  });

  it("ND12 工作坊：唯讀的 gr → dragStart 不接手", async () => {
    stubServer();
    renderNoteList({ tab: "workspace" });
    await waitForTree("G");

    const dt = startDrag("gr");

    expect(dt.setData).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
    expect(screen.getByTestId("drag-active")).toHaveTextContent("false");
  });

  it("ND13 接手後指標移到容器外（document.body 的 dragover）→ 標示消失", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });
    expect(scoped()).toHaveLength(1);

    fireEvent.dragOver(document.body, { dataTransfer: dt });

    expect(scoped()).toHaveLength(0);
  });

  it("ND14 來源已存在時，另一個不含自訂型別的拖曳（Files）對 F dragOver → 不處理、F 無標示", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    startDrag("A");

    const files = createFakeDataTransfer(["Files"]);

    expect(fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: files })).toBe(true);
    expect(scoped()).toHaveLength(0);
  });

  it("ND15 F 收合、不停留直接 drop 到 F 列 → PUT 回應前 F 已展開、A 在 F 底下看得到", async () => {
    setCollapsed("folder:F", true);
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(rowOf("folder", "F"), { dataTransfer: dt });

    fireEvent.drop(rowOf("folder", "F"), { dataTransfer: dt });
    await waitFor(() => expect(server.puts).toHaveLength(1));

    await waitFor(() => expect(childIds("folder", "F")).toContain("A"));
    expect(nodeOf("note", "A")).not.toBeNull();
    await server.respond();
  });

  it("ND16 發起拖曳的 NoteList 在拖曳中卸載 → 拖曳狀態結束、document 的 dragover 監聽移除", async () => {
    stubServer();
    const { unmount } = renderNoteList();
    await waitForTree();
    startDrag("A");
    expect(getDragSource()).not.toBeNull();
    const removeSpy = vi.spyOn(document, "removeEventListener");

    unmount();

    expect(getDragSource()).toBeNull();
    expect(removeSpy).toHaveBeenCalledWith("dragover", expect.any(Function), true);
    removeSpy.mockRestore();
  });
});

const previewOf = (root: HTMLElement = panel()) => root.querySelector<HTMLElement>('[data-node-kind="preview"]');

/** 在 B 的連結上 dragOver 一發並停滿 0.5 秒（H7：只在這一段用假的 setTimeout／clearTimeout）。 */
function holdOver(el: HTMLElement, dt: FakeDataTransfer) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  fireEvent.dragOver(el, { dataTransfer: dt });
  act(() => vi.advanceTimersByTime(DRAG_HOVER_DELAY_MS));
  vi.useRealTimers();
}

/**
 * 兩份 NoteList 並排（靜態卡與抽屜，各包 `[data-sidebar-instance]`，同 AppShell），共用同一個 SidebarTabProvider；
 * `hideDrawer()` 只卸載第二份。
 */
function renderTwoInstances() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (drawer: boolean) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <ActiveNoteProvider>
          <SidebarTabProvider>
            <div data-sidebar-instance="" data-testid="static">
              <NoteList />
            </div>
            {drawer && (
              <div data-sidebar-instance="" data-testid="drawer">
                <NoteList />
              </div>
            )}
          </SidebarTabProvider>
        </ActiveNoteProvider>
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>
  );
  const view = render(ui(true));
  const inst = (name: "static" | "drawer") => screen.getByTestId(name);
  const node = (name: "static" | "drawer", kind: "note" | "folder", id: string) =>
    inst(name).querySelector<HTMLElement>(`[data-node-kind="${kind}"][data-node-id="${id}"]`);
  return { inst, node, hideDrawer: () => view.rerender(ui(false)) };
}

describe("NoteList 疊資料夾（PR-3c T5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    mockFinePointer(true);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("NS1 A 對 N2 列 dragOver 一發、停滿 0.5 秒 → N2 的列換成預覽（New folder、N2、A），帶 data-drop-scope、內層沒有 data-node-kind", async () => {
    stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");

    holdOver(noteLink("N2"), dt);

    const preview = previewOf();
    expect(preview).not.toBeNull();
    expect(nodeOf("note", "N2")).toBeNull();
    expect(childIds("folder", "F")).toContain(null);
    expect(preview).toHaveAttribute("data-drop-scope", "");
    expect(preview).toHaveClass(...dropScopeTokens);
    expect(preview).not.toHaveAttribute("aria-busy");
    expect(within(preview!).getByText("New folder", { exact: true })).toBeInTheDocument();
    expect(within(preview!).getByText("N2", { exact: true })).toBeInTheDocument();
    expect(within(preview!).getByText("A", { exact: true })).toBeInTheDocument();
    expect(preview!.querySelectorAll("[data-node-kind]")).toHaveLength(0);
  });

  it("NS2 預覽出現後對 R 列 dragOver 兩發 → 預覽消失、N2 列回來；整段沒有 POST /api/folders", async () => {
    const server = stubServer({ notes: [personalNote({ id: "R", title: "R" })] });
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    holdOver(noteLink("N2"), dt);
    expect(previewOf()).not.toBeNull();

    fireEvent.dragOver(noteLink("R"), { dataTransfer: dt });
    fireEvent.dragOver(noteLink("R"), { dataTransfer: dt });
    await act(async () => {});

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
    expect(server.writes).toEqual([]);
  });

  it("NS3 對 N2 dragOver 未停滿就 drop → 照區域放進 F（PUT A {folderId:F}）、沒有 POST /api/folders", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    fireEvent.dragOver(noteLink("N2"), { dataTransfer: dt });

    fireEvent.drop(noteLink("N2"), { dataTransfer: dt });

    await waitFor(() => expect(server.writes).toEqual([{ method: "PUT", url: "/api/notes/A/folder", body: { folderId: "F" } }]));
    expect(previewOf()).toBeNull();
    await server.respond();
  });

  it("NS4 預覽上 drop → 建立中（aria-busy）期間兩份實例都不接手 dragStart；三發完成 → 改名框（New folder 全選）、沒有成功 toast；Save → toast「Created “New folder” with 2 notes」、焦點回新資料夾列", async () => {
    const server = stubServer();
    const { inst, node } = renderTwoInstances();
    await waitFor(() => expect(node("static", "folder", "F")).not.toBeNull());
    const link = (name: "static" | "drawer", id: string) => node(name, "note", id)!.querySelector("a") as HTMLElement;
    const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(link("static", "A"), { dataTransfer: dt });
    holdOver(link("static", "N2"), dt);
    const preview = previewOf(inst("static"))!;
    expect(preview).not.toBeNull();

    fireEvent.dragOver(preview, { dataTransfer: dt });
    fireEvent.drop(preview, { dataTransfer: dt });

    expect(previewOf(inst("static"))).toHaveAttribute("aria-busy", "true");
    expect(previewOf(inst("static"))).not.toHaveAttribute("data-drop-scope");
    await waitFor(() => expect(server.writes).toEqual([{ method: "POST", url: "/api/folders", body: { name: "New folder", parentId: "F" } }]));
    for (const name of ["static", "drawer"] as const) {
      const other = createFakeDataTransfer(["text/uri-list", "text/plain"]);
      fireEvent.dragStart(link(name, "N1"), { dataTransfer: other });
      expect(other.setData, name).not.toHaveBeenCalledWith(DRAG_NOTE_MIME, expect.anything());
      expect(getDragSource(), name).toBeNull();
    }

    await server.respond();
    await server.respond();
    await server.respond();
    expect(server.writes.slice(1)).toEqual([
      { method: "PUT", url: "/api/notes/N2/folder", body: { folderId: "NEW" } },
      { method: "PUT", url: "/api/notes/A/folder", body: { folderId: "NEW" } },
    ]);

    const dialog = await screen.findByRole("dialog", { name: "Rename folder" });
    const field = within(dialog).getByRole("textbox", { name: "Folder name" }) as HTMLInputElement;
    expect(field).toHaveValue("New folder");
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, "New folder".length]);
    expect(previewOf(inst("static"))).toBeNull();
    expect(screen.queryByText(/Created/)).toBeNull();

    // 沿用預設名按 Save：不送 PATCH（總管裁定），關框後照樣出成功 toast。
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Created “New folder” with 2 notes", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.writes.map((write) => write.method)).toEqual(["POST", "PUT", "PUT"]);
    await waitFor(() => expect(node("static", "folder", "NEW")!.querySelector("button[aria-expanded]")).toHaveFocus());
  });

  it("NS4 抽屜那一份發起疊資料夾、POST 還沒回時抽屜被關（卸載）→ 三發完成後沒有改名框，直接出「Created “New folder” with 2 notes」＋Undo", async () => {
    const server = stubServer();
    const { inst, node, hideDrawer } = renderTwoInstances();
    await waitFor(() => expect(node("drawer", "folder", "F")).not.toBeNull());
    const link = (id: string) => node("drawer", "note", id)!.querySelector("a") as HTMLElement;
    const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(link("A"), { dataTransfer: dt });
    holdOver(link("N2"), dt);
    const preview = previewOf(inst("drawer"))!;
    fireEvent.dragOver(preview, { dataTransfer: dt });
    fireEvent.drop(preview, { dataTransfer: dt });
    await waitFor(() => expect(server.writes).toEqual([{ method: "POST", url: "/api/folders", body: { name: "New folder", parentId: "F" } }]));

    hideDrawer();
    await server.respond();
    await server.respond();
    await server.respond();

    expect(await screen.findByText("Created “New folder” with 2 notes", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(previewOf(inst("static"))).toBeNull();
  });

  it("NS4 兩份實例：靜態卡發起拖曳時卸載抽屜那一份 → 拖曳照常進行", async () => {
    stubServer();
    const { node, hideDrawer } = renderTwoInstances();
    await waitFor(() => expect(node("drawer", "folder", "F")).not.toBeNull());
    const dt = createFakeDataTransfer(["text/uri-list", "text/plain"]);
    fireEvent.dragStart(node("static", "note", "A")!.querySelector("a")!, { dataTransfer: dt });
    const source = getDragSource();
    expect(source).not.toBeNull();

    hideDrawer();

    expect(getDragSource()).toBe(source);
    expect(fireEvent.dragOver(node("static", "folder", "F")!.firstElementChild!, { dataTransfer: dt })).toBe(false);
  });

  /**
   * 停留計時已起算（假的 setTimeout）後重抓 `keys`，只推進到 0.5 秒之前、等 `landed()` 成立（react-query 的通知走被假造的 setTimeout），
   * 再推過 0.5 秒讓舊計時到點。呼叫前要已在 B 上 dragOver 一發。
   */
  async function refetchDuringHold(queryClient: QueryClient, keys: string[][], landed: () => boolean) {
    await act(async () => {
      for (const queryKey of keys) void queryClient.invalidateQueries({ queryKey });
    });
    for (let i = 0; i < 40 && !landed(); i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });
    }
    expect(landed()).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAG_HOVER_DELAY_MS);
    });
    vi.useRealTimers();
  }

  it("NS-C1 停留期間重抓、B 已不在原層（N2 被移到根層）→ 計時到點以當下的樹重判，不出預覽", async () => {
    const server = stubServer();
    const { queryClient } = renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(noteLink("N2"), { dataTransfer: dt });

    const index = server.notes.findIndex((note) => note.id === "N2");
    server.notes[index] = { ...server.notes[index]!, folderId: null };
    await refetchDuringHold(queryClient, [["notes"]], () => topIds().includes("N2"));

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
  });

  it("NS-C2 停留期間重抓、B 變成唯讀（工作坊 g2 失去編輯權）→ 不出預覽", async () => {
    const server = stubServer();
    const { queryClient } = renderNoteList({ tab: "workspace" });
    await waitForTree("G");
    const dt = startDrag("g1");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(noteLink("g2"), { dataTransfer: dt });

    const index = server.notes.findIndex((note) => note.id === "g2");
    server.notes[index] = groupNote({ id: "g2", title: "g2", group: G, folderId: "GF", edit: false });
    await refetchDuringHold(queryClient, [["notes"]], () =>
      queryClient.getQueryData<NoteDto[]>(["notes"])?.find((note) => note.id === "g2")?.permissions.edit === false,
    );

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "g2")).not.toBeNull();
  });

  it("NS-C3 停留期間重抓、B 所在的 F 被搬到第 4 層底下（F 成第 5 層）→ 不出預覽", async () => {
    const server = stubServer({ folders: folderChain("D", 4) });
    const { queryClient } = renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fireEvent.dragOver(noteLink("N2"), { dataTransfer: dt });

    const index = server.folders.findIndex((folder) => folder.id === "F");
    server.folders[index] = { ...server.folders[index]!, parentId: "D4" };
    await refetchDuringHold(queryClient, [["folders"]], () => nodeOf("folder", "D4")?.contains(nodeOf("folder", "F")) === true);

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
  });

  it("NS5 N2 在第 5 層資料夾 → 停滿後沒有預覽", async () => {
    const server = stubServer({ folders: folderChain("D", 5), notes: [personalNote({ id: "deep", title: "deep", folderId: "D5" })] });
    renderNoteList();
    await waitFor(() => expect(nodeOf("note", "deep")).not.toBeNull());
    const dt = startDrag("A");

    holdOver(noteLink("deep"), dt);

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "deep")).not.toBeNull();
    expect(server.writes).toEqual([]);
  });

  it("NS6 F 底下已有「New folder」→ 預覽顯示「New folder 2」", async () => {
    stubServer({ folders: [folderDto({ id: "FN", name: "New folder", parentId: "F" })] });
    renderNoteList();
    await waitFor(() => expect(nodeOf("folder", "FN")).not.toBeNull());
    const dt = startDrag("A");

    holdOver(noteLink("N2"), dt);

    expect(within(previewOf()!).getByText("New folder 2", { exact: true })).toBeInTheDocument();
  });

  it("NS7 B 不可放置 → 停滿後沒有預覽、放開照區域規則（原處，不送任何請求）：工作坊 g1 → 唯讀 gr", async () => {
    const server = stubServer();
    renderNoteList({ tab: "workspace" });
    await waitForTree("G");
    const dt = startDrag("g1");

    holdOver(noteLink("gr"), dt);
    expect(previewOf()).toBeNull();
    fireEvent.drop(noteLink("gr"), { dataTransfer: dt });
    await act(async () => {});

    expect(server.writes).toEqual([]);
  });

  it("NS7 B 不可放置：與我共享 tab s1 → 兜底群組筆記 sg（群組 K 不在我的群組）", async () => {
    const K = groupDto({ id: "K", name: "K" }, memberRole());
    const server = stubServer({ notes: [sharedNote({ id: "s1", title: "s1", role: "viewer" }), groupNote({ id: "sg", title: "sg", group: K })] });
    renderNoteList({ tab: "shared" });
    await waitFor(() => expect(nodeOf("note", "sg")).not.toBeNull());
    const dt = startDrag("s1");
    expect(dt.setData).toHaveBeenCalledWith(DRAG_NOTE_MIME, "s1");

    holdOver(noteLink("sg"), dt);
    expect(previewOf()).toBeNull();
    fireEvent.drop(noteLink("sg"), { dataTransfer: dt });
    await act(async () => {});

    expect(server.writes).toEqual([]);
  });

  it("NS9 預覽中 dragEnd → 預覽消失、N2 回來、沒有請求", async () => {
    const server = stubServer();
    renderNoteList();
    await waitForTree();
    const dt = startDrag("A");
    holdOver(noteLink("N2"), dt);
    expect(previewOf()).not.toBeNull();

    fireEvent.dragEnd(noteLink("A"), { dataTransfer: dt });
    await act(async () => {});

    expect(previewOf()).toBeNull();
    expect(nodeOf("note", "N2")).not.toBeNull();
    expect(server.writes).toEqual([]);
  });
});
