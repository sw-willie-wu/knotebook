import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { folderDto } from "@/test/folder-fixtures";
import { personalNote } from "@/test/select-fixtures";
import { runStackFolder, showStackCreatedToast, STACK_CREATE_ATTEMPTS, undoStackFolder, type StackNote } from "./stack-folder";

/**
 * 疊資料夾的三發、補償與復原（資料夾 spec §6.13 疊資料夾第 5–8 步；總管裁定 2026-10-30 Q2）。
 * 假 fetch：依序記下 [method, url, body 原字串]；非 GET 依序取 replies（用完就 throw，之後不該再有請求）；GET 一律回空清單。
 */

type Reply = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Reply => ({ status, body });
const fail = (status: number, code: string): Reply => ({ status, body: { error: { code, message: "x" } } });

type Call = [method: string, url: string, body: string | undefined];

function stubSequence(replies: Reply[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") return Promise.resolve(new Response(JSON.stringify(url === "/api/folders" ? { folders: [] } : []), { status: 200 }));
      calls.push([method, url, typeof init?.body === "string" ? init.body : undefined]);
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`no more replies: ${method} ${url}`);
      return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "Content-Type": "application/json" } }));
    }),
  );
  return calls;
}

const NEW: FolderDto = folderDto({ id: "NEW", name: "New folder" });
const created = (name = "New folder"): Reply => ok({ ...NEW, name }, 201);
const placed = (id: string, folderId: string | null): Reply => ok(personalNote({ id, title: id, folderId }));
const body = (value: unknown) => JSON.stringify(value);
const POST = (payload: unknown): Call => ["POST", "/api/folders", body(payload)];
const PUT = (id: string, folderId: string | null): Call => ["PUT", `/api/notes/${id}/folder`, body({ folderId })];
const DELETE_ONLY_IF_EMPTY: Call = ["DELETE", "/api/folders/NEW", '{"onlyIfEmpty":true}'];
const PERSONAL: { space: FolderSpaceDto } = { space: { kind: "personal" } };

const A: StackNote = { noteId: "A", from: null };
const B: StackNote = { noteId: "B", from: "F" };

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["folders"], [folderDto({ id: "F", name: "F" })]);
  queryClient.setQueryData(["notes"], [] as NoteDto[]);
  render(createElement(Toaster));
  return { queryClient, t: i18n.t.bind(i18n) };
}

function toastItems(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("ol li"));
}

function run(queryClient: QueryClient, t: typeof i18n.t, over: Partial<Parameters<typeof runStackFolder>[0]> = {}) {
  return runStackFolder({ a: A, b: B, parent: { folderId: "F" }, firstName: "New folder", takenNames: [], queryClient, t, ...over });
}

/** 讓尚未結束的 promise 鏈跑完（假 fetch 都是立即 resolve）。 */
async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
  });
}

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

describe("runStackFolder", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("ST1 根層個人：POST {name, space personal} → PUT B → PUT A；['folders']、['notes'] 的失效（重抓）完成後才回 folder", async () => {
    const calls = stubSequence([created(), placed("B", "NEW"), placed("A", "NEW")]);
    const { queryClient, t } = setup();
    const releases: (() => void)[] = [];
    const invalidated: string[] = [];
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation((filters) => {
      invalidated.push(JSON.stringify((filters as { queryKey?: unknown } | undefined)?.queryKey));
      return new Promise<void>((resolve) => releases.push(resolve));
    });
    let settled = false;
    const promise = run(queryClient, t, { parent: PERSONAL }).then((folder) => {
      settled = true;
      return folder;
    });

    await waitFor(() => expect(calls).toHaveLength(3));
    await waitFor(() => expect(invalidated).toEqual(expect.arrayContaining(['["folders"]', '["notes"]'])));
    await settle();
    expect(settled).toBe(false);

    for (const release of releases) release();
    await expect(promise).resolves.toMatchObject({ id: "NEW", name: "New folder" });
    expect(calls).toEqual([POST({ name: "New folder", space: { kind: "personal" } }), PUT("B", "NEW"), PUT("A", "NEW")]);
    expect(toastItems()).toHaveLength(0);
  });

  it("ST2 parent 資料夾 → {name, parentId}；共享 → space shared；群組 → space {group, G}", async () => {
    const calls = stubSequence([
      created(), placed("B", "NEW"), placed("A", "NEW"),
      created(), placed("B", "NEW"), placed("A", "NEW"),
      created(), placed("B", "NEW"), placed("A", "NEW"),
    ]);
    const { queryClient, t } = setup();

    await act(() => run(queryClient, t, { parent: { folderId: "F" } }));
    await act(() => run(queryClient, t, { parent: { space: { kind: "shared" } } }));
    await act(() => run(queryClient, t, { parent: { space: { kind: "group", groupId: "G" } } }));

    expect(calls.filter(([method]) => method === "POST")).toEqual([
      POST({ name: "New folder", parentId: "F" }),
      POST({ name: "New folder", space: { kind: "shared" } }),
      POST({ name: "New folder", space: { kind: "group", groupId: "G" } }),
    ]);
  });

  it("ST3 撞名：前兩發 409 → 名稱依序 New folder／New folder 2／New folder 3；五發全 409 → 恰 5 發、沒有 PUT、一則 toast、回 null", async () => {
    const taken = fail(409, "folder_name_taken");
    const calls = stubSequence([taken, taken, created("New folder 3"), placed("B", "NEW"), placed("A", "NEW")]);
    const { queryClient, t } = setup();

    expect(await act(() => run(queryClient, t))).toMatchObject({ id: "NEW" });
    expect(calls.slice(0, 3)).toEqual([
      POST({ name: "New folder", parentId: "F" }),
      POST({ name: "New folder 2", parentId: "F" }),
      POST({ name: "New folder 3", parentId: "F" }),
    ]);

    vi.unstubAllGlobals();
    const failing = stubSequence(Array.from({ length: 6 }, () => taken));
    expect(STACK_CREATE_ATTEMPTS).toBe(5);

    expect(await act(() => run(queryClient, t))).toBeNull();
    expect(failing.map(([method]) => method)).toEqual(["POST", "POST", "POST", "POST", "POST"]);
    expect(await screen.findByText("There's already a folder with this name here.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST4 ① 409 folder_limit → 恰 1 發 POST、沒有 PUT 與 DELETE、一則錯誤 toast、回 null、['folders'] 被失效（重抓）", async () => {
    const calls = stubSequence([fail(409, "folder_limit")]);
    const { queryClient, t } = setup();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(false);

    expect(await act(() => run(queryClient, t))).toBeNull();

    expect(calls).toEqual([POST({ name: "New folder", parentId: "F" })]);
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    expect(await screen.findByText("You've reached the maximum number of folders.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST5 ② 403 → DELETE 新資料夾 {onlyIfEmpty:true}、沒有 ③、一則 toast（errors.forbidden）", async () => {
    const calls = stubSequence([created(), fail(403, "forbidden"), ok({ trashedNoteIds: [], deletedFolderIds: ["NEW"] })]);
    const { queryClient, t } = setup();

    expect(await act(() => run(queryClient, t))).toBeNull();

    expect(calls).toEqual([POST({ name: "New folder", parentId: "F" }), PUT("B", "NEW"), DELETE_ONLY_IF_EMPTY]);
    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST6 ③ 404 folder_not_found → PUT B 回 b.from → DELETE {onlyIfEmpty:true}、一則 toast「Folder not found.」", async () => {
    const calls = stubSequence([
      created(),
      placed("B", "NEW"),
      fail(404, "folder_not_found"),
      placed("B", "F"),
      ok({ trashedNoteIds: [], deletedFolderIds: ["NEW"] }),
    ]);
    const { queryClient, t } = setup();

    expect(await act(() => run(queryClient, t))).toBeNull();

    expect(calls).toEqual([POST({ name: "New folder", parentId: "F" }), PUT("B", "NEW"), PUT("A", "NEW"), PUT("B", "F"), DELETE_ONLY_IF_EMPTY]);
    expect(await screen.findByText("Folder not found.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST7 補償的 DELETE 回 409 folder_not_empty → 之後沒有請求、['folders'] 仍被失效（保留的新資料夾要進側欄）、仍只有一則 toast", async () => {
    const calls = stubSequence([created(), placed("B", "NEW"), fail(403, "forbidden"), placed("B", "F"), fail(409, "folder_not_empty")]);
    const { queryClient, t } = setup();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(false);

    expect(await act(() => run(queryClient, t))).toBeNull();
    await settle();

    expect(calls).toEqual([POST({ name: "New folder", parentId: "F" }), PUT("B", "NEW"), PUT("A", "NEW"), PUT("B", "F"), DELETE_ONLY_IF_EMPTY]);
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST8 ③ 失敗後補償的 PUT B 也失敗 → 不送 DELETE、['folders'] 被失效、只有一則 toast", async () => {
    const calls = stubSequence([created(), placed("B", "NEW"), fail(403, "forbidden"), fail(500, "internal")]);
    const { queryClient, t } = setup();
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(false);

    expect(await act(() => run(queryClient, t))).toBeNull();
    await settle();

    expect(calls).toEqual([POST({ name: "New folder", parentId: "F" }), PUT("B", "NEW"), PUT("A", "NEW"), PUT("B", "F")]);
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });
});

describe("undoStackFolder／showStackCreatedToast", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
    await i18n.changeLanguage("en");
  });

  const UNDO_SEQUENCE: Call[] = [PUT("A", null), PUT("B", "F"), DELETE_ONLY_IF_EMPTY];
  const undo = (queryClient: QueryClient, t: typeof i18n.t) => undoStackFolder({ folderId: "NEW", a: A, b: B, queryClient, t });

  it("ST9 PUT A {from:null} → PUT B {from} → DELETE {onlyIfEmpty}；200 → 沒有 toast、['folders'] 被失效", async () => {
    const calls = stubSequence([placed("A", null), placed("B", "F"), ok({ trashedNoteIds: [], deletedFolderIds: ["NEW"] })]);
    const { queryClient, t } = setup();

    await act(() => undo(queryClient, t));
    await settle();

    expect(calls).toEqual(UNDO_SEQUENCE);
    expect(calls[0]![2]).toBe('{"folderId":null}');
    expect(queryClient.getQueryState(["folders"])?.isInvalidated).toBe(true);
    expect(toastItems()).toHaveLength(0);
  });

  it("ST9 DELETE 409 folder_not_empty → toast「The folder has other items now, so it was kept」", async () => {
    const calls = stubSequence([placed("A", null), placed("B", "F"), fail(409, "folder_not_empty")]);
    const { queryClient, t } = setup();

    await act(() => undo(queryClient, t));

    expect(calls).toEqual(UNDO_SEQUENCE);
    expect(await screen.findByText("The folder has other items now, so it was kept", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST9 DELETE 404 folder_not_found → 視為完成、沒有 toast", async () => {
    const calls = stubSequence([placed("A", null), placed("B", "F"), fail(404, "folder_not_found")]);
    const { queryClient, t } = setup();

    await act(() => undo(queryClient, t));
    await settle();

    expect(calls).toEqual(UNDO_SEQUENCE);
    expect(toastItems()).toHaveLength(0);
  });

  it("ST9 PUT A 失敗 → 錯誤 toast、沒有 PUT B 與 DELETE", async () => {
    const calls = stubSequence([fail(403, "forbidden")]);
    const { queryClient, t } = setup();

    await act(() => undo(queryClient, t));
    await settle();

    expect(calls).toEqual([PUT("A", null)]);
    expect(await screen.findByText("You don't have permission to do that.", { exact: true })).toBeInTheDocument();
    expect(toastItems()).toHaveLength(1);
  });

  it("ST10 showStackCreatedToast：en「Created “Q3 notes” with 2 notes」有 Undo；按 Undo → 走 ST9 的序列；zh「已建立「Q3 notes」並放入 2 篇筆記」", async () => {
    const calls = stubSequence([placed("A", null), placed("B", "F"), ok({ trashedNoteIds: [], deletedFolderIds: ["NEW"] })]);
    const { queryClient, t } = setup();

    act(() => showStackCreatedToast({ folderId: "NEW", name: "Q3 notes", a: A, b: B, queryClient, t }));
    expect(await screen.findByText("Created “Q3 notes” with 2 notes", { exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(calls).toEqual(UNDO_SEQUENCE));

    act(() => dismissAllToasts());
    await i18n.changeLanguage("zh-TW");
    act(() => showStackCreatedToast({ folderId: "NEW", name: "Q3 notes", a: A, b: B, queryClient, t }));
    expect(await screen.findByText("已建立「Q3 notes」並放入 2 篇筆記", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "復原" })).toBeInTheDocument();
  });
});
