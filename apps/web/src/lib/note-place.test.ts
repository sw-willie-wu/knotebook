import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { FolderDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { indexFolders } from "@/components/sidebar/folder-index";
import { folderDto } from "@/test/folder-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { placeNoteWithUndo } from "./note-place";

// ⋮ 同空間移動＋復原（資料夾 spec §6.11.2「選定後」）。真的 QueryClient、假 fetch 只收 PUT /api/notes/n1/folder。

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

type Reply = { status: number; body: unknown };
const fail = (status: number, code: string): Reply => ({ status, body: { error: { code, message: "x" } } });

const PUT_URL = "/api/notes/n1/folder";

/** 依序回 replies；記下每次的 body。 */
function stubPut(replies: Reply[]) {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PUT" && url === PUT_URL) {
        bodies.push(JSON.parse(String(init?.body)));
        const reply = replies.shift();
        if (reply === undefined) throw new Error("no more replies");
        return Promise.resolve(fakeResponse(reply.status, reply.body));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return bodies;
}

const A: FolderDto = folderDto({ id: "A", name: "A" });
const A1: FolderDto = folderDto({ id: "A1", name: "A1", parentId: "A" });
const B: FolderDto = folderDto({ id: "B", name: "B" });
const INDEX = indexFolders([A, A1, B]);

const PLACED_A1: NoteDto = personalNote({ id: "n1", title: "Note", folderId: "A1" });
const PLACED_ROOT: NoteDto = personalNote({ id: "n1", title: "Note", folderId: null });
const PLACED_B: NoteDto = personalNote({ id: "n1", title: "Note", folderId: "B" });

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["folders"], [A, A1, B]);
  render(createElement(Toaster));
  return { queryClient, t: i18n.t.bind(i18n) };
}

/** 目前畫面上的 toast（Radix Toast Root 是 `<li>`）。 */
function toastItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("ol li"));
}

function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

describe("placeNoteWithUndo", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("NP1 放進 A1：PUT {folderId:A1} → toast「Moved to “A1”」有 Undo；A、A1 展開；['note','n1'] 是回應 dto", async () => {
    const bodies = stubPut([{ status: 200, body: PLACED_A1 }]);
    const { queryClient, t } = setup();
    setCollapsed("folder:A", true);
    setCollapsed("folder:A1", true);

    await act(() => placeNoteWithUndo({ noteId: "n1", from: "B", to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    expect(bodies).toEqual([{ folderId: "A1" }]);
    expect(await screen.findByText("Moved to “A1”", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(isCollapsed("folder:A")).toBe(false);
    expect(isCollapsed("folder:A1")).toBe(false);
    expect(queryClient.getQueryData(["note", "n1"])).toEqual(PLACED_A1);
  });

  it("NP2 回根層：body {folderId:null}、toast「Moved to “Top level”」", async () => {
    const bodies = stubPut([{ status: 200, body: PLACED_ROOT }]);
    const { queryClient, t } = setup();

    await act(() =>
      placeNoteWithUndo({ noteId: "n1", from: "A1", to: { folderId: null, name: t("folders.dest.topLevel") }, index: INDEX, queryClient, t }),
    );

    expect(bodies).toEqual([{ folderId: null }]);
    expect(await screen.findByText("Moved to “Top level”", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("NP3 404 folder_not_found → destructive toast「Folder not found.」、沒有 Undo、['folders'] 被失效、只送一次", async () => {
    const bodies = stubPut([fail(404, "folder_not_found")]);
    const { queryClient, t } = setup();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(false);

    await act(() => placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Folder not found.")).toHaveClass("bg-destructive");
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    expect(bodies).toHaveLength(1);
  });

  it("NP4 按 Undo → PUT {folderId:<from>}；成功後原 toast 消失、沒有新 toast", async () => {
    const bodies = stubPut([
      { status: 200, body: PLACED_A1 },
      { status: 200, body: PLACED_B },
    ]);
    const { queryClient, t } = setup();
    await act(() => placeNoteWithUndo({ noteId: "n1", from: "B", to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));
    expect(toastItems()).toHaveLength(1);

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(bodies).toEqual([{ folderId: "A1" }, { folderId: "B" }]));
    await waitFor(() => expect(queryClient.getQueryData(["note", "n1"])).toEqual(PLACED_B));
    await act(async () => {});
    expect(screen.queryByText("Moved to “A1”", { exact: true })).toBeNull();
    expect(toastItems()).toHaveLength(0);
  });

  it("NP4 復原回 404 → destructive 錯誤 toast、復原只送一次", async () => {
    const bodies = stubPut([{ status: 200, body: PLACED_A1 }, fail(404, "folder_not_found")]);
    const { queryClient, t } = setup();
    await act(() => placeNoteWithUndo({ noteId: "n1", from: "B", to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Folder not found.")).toHaveClass("bg-destructive");
    await act(async () => {});
    expect(bodies).toEqual([{ folderId: "A1" }, { folderId: "B" }]);
  });

  it("NP7 zh：name＝資料夾短名「A」→ 畫面出現「已移到「A」」與「復原」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubPut([{ status: 200, body: { ...PLACED_A1, folderId: "A" } }]);
    const { queryClient, t } = setup();

    await act(() => placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A", name: "A" }, index: INDEX, queryClient, t }));

    expect(await screen.findByText("已移到「A」", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "復原" })).toBeInTheDocument();
  });

  it("NP6 409 folder_too_deep 的錯誤字帶入上限、不含 {{max}}", async () => {
    stubPut([fail(409, "folder_too_deep")]);
    const { queryClient, t } = setup();

    await act(() => placeNoteWithUndo({ noteId: "n1", from: null, to: { folderId: "A1", name: "A1" }, index: INDEX, queryClient, t }));

    const message = await screen.findByText(/^Folders can be at most .* levels deep\.$/);
    expect(message.textContent).not.toContain("{{max}}");
    expect(message.textContent).toMatch(/at most \d+ levels/);
  });
});
