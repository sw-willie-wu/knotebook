import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
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
 * 假 server：GET 照常回；`PUT /api/notes/:id/folder` 先掛著，`respond()` 才回（預設 200＝更新 server 端的筆記再回它，之後的重抓看得到新位置）。
 */
function stubServer() {
  const notes = NOTES.map((note) => ({ ...note }));
  const puts: { url: string; body: unknown }[] = [];
  const pending: ((reply?: Reply) => void)[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/folders" && method === "GET") return Promise.resolve(json({ folders: FOLDERS }));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(json(notes));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(json([G, H]));
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(json(ME));
    const match = /^\/api\/notes\/([^/]+)\/folder$/.exec(url);
    if (match !== null && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { folderId: string | null };
      puts.push({ url, body });
      return new Promise<Response>((resolve) => {
        pending.push((reply) => {
          if (reply !== undefined) {
            resolve(json(reply.body, reply.status));
            return;
          }
          const index = notes.findIndex((note) => note.id === match[1]);
          notes[index] = { ...notes[index]!, folderId: body.folderId };
          resolve(json(notes[index]));
        });
      });
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    puts,
    respond: async (reply?: Reply) => {
      const next = pending.shift();
      if (next === undefined) throw new Error("no pending PUT");
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
