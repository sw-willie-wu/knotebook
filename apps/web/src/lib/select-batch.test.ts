import { afterEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import type { PublicLinkDto } from "@/api/public-link";
import { folderDto } from "@/test/folder-fixtures";
import { groupNote, personalNote } from "@/test/select-fixtures";
import { groupDto, memberRole } from "@/test/fixtures";
import type { DestTarget } from "@/components/sidebar/destination-level";
import type { SelectionTarget } from "@/components/sidebar/select-model";
import {
  classifyBatchError,
  copyNotesInOrder,
  deleteTargetsInOrder,
  moveNotesInOrder,
  placeTargetsInOrder,
  runSequential,
  trashNotesInOrder,
  undoPlacements,
  type PlacedItem,
} from "./select-batch";

type Reply = Response | Promise<Response>;
interface Call {
  method: string;
  url: string;
  body: unknown;
}

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

const ok = (body?: unknown): Response => fakeResponse(body === undefined ? 204 : 200, body);
const fail = (status: number, code: string): Response => fakeResponse(status, { error: { code, message: "x" } });

/** 記下每次 `method url body`；回應依 `method url` 查表，未列的 throw（讓測試紅在這裡）。 */
function stubFetch(routes: Record<string, () => Reply>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const route = routes[`${method} ${url}`];
      if (!route) throw new Error(`unexpected fetch ${method} ${url}`);
      return Promise.resolve(route());
    }),
  );
  return calls;
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** invalidateQueries 的呼叫序（照常執行，只記 queryKey）。 */
function spyInvalidations(qc: QueryClient): string[] {
  const keys: string[] = [];
  const original = qc.invalidateQueries.bind(qc);
  vi.spyOn(qc, "invalidateQueries").mockImplementation(((filters?: { queryKey?: readonly unknown[] }) => {
    keys.push(JSON.stringify(filters?.queryKey ?? null));
    return original(filters);
  }) as QueryClient["invalidateQueries"]);
  return keys;
}

const k = (...key: unknown[]): string => JSON.stringify(key);
const sorted = (keys: readonly string[]): string[] => [...new Set(keys)].sort();
const notes = (...ids: string[]): NoteDto[] => ids.map((id) => personalNote({ id, title: `T-${id}` }));
const del = (id: string): string => `DELETE /api/notes/${id}`;
const move = (id: string): string => `POST /api/notes/${id}/move`;
const copy = (id: string): string => `POST /api/notes/${id}/copy`;
const PERSONAL_ROOT: DestTarget = { kind: "place", space: { kind: "personal" }, folder: null };
const RND_ROOT: DestTarget = { kind: "place", space: { kind: "group", groupId: "g1", name: "R&D" }, folder: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("runSequential（spec §6.11 執行、D-M4）", () => {
  it("SB1 依序：前一篇回來之前不送下一篇；全部成功 → done 三篇、沒有略過與停下", async () => {
    let release!: (r: Response) => void;
    const calls = stubFetch({
      [del("a")]: () => new Promise<Response>((resolve) => { release = resolve; }),
      [del("b")]: () => ok(),
      [del("c")]: () => ok(),
    });
    const [a, b, c] = notes("a", "b", "c");
    const pending = trashNotesInOrder([a, b, c], { queryClient: newClient() });
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(1);
    release(ok());
    const out = await pending;
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([del("a"), del("b"), del("c")]);
    expect(out).toEqual({ done: [a, b, c], skipped: 0, skippedDetail: [], stopped: null });
  });

  it("SB2 classifyBatchError：403、404 not_found 略過；其餘一律停下", () => {
    expect(classifyBatchError(new ApiFail(403, "forbidden", "x"))).toBe("skip");
    expect(classifyBatchError(new ApiFail(404, "not_found", "x"))).toBe("skip");
    expect(classifyBatchError(new ApiFail(404, "role_not_found", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(404, "group_not_found", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(409, "storage_quota_exceeded", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(409, "server_busy", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(429, "too_many_requests", "x"))).toBe("stop");
    expect(classifyBatchError(new ApiFail(500, "internal", "x"))).toBe("stop");
    expect(classifyBatchError(new TypeError("Failed to fetch"))).toBe("stop");
  });

  it("SB3 略過繼續：403 與 404 not_found 計入 skipped，其餘照送", async () => {
    const calls = stubFetch({
      [del("a")]: () => ok(),
      [del("b")]: () => fail(403, "forbidden"),
      [del("c")]: () => fail(404, "not_found"),
      [del("d")]: () => ok(),
    });
    const [a, b, c, d] = notes("a", "b", "c", "d");
    const out = await trashNotesInOrder([a, b, c, d], { queryClient: newClient() });
    expect(calls).toHaveLength(4);
    expect(out.done).toEqual([a, d]);
    expect(out.skipped).toBe(2);
    expect(out.stopped).toBeNull();
  });

  it("SB4 停下：429 之後不再送；remaining 是停下那篇（含）之後的選取鍵形", async () => {
    const calls = stubFetch({
      [del("a")]: () => ok(),
      [del("b")]: () => fail(429, "too_many_requests"),
      [del("c")]: () => ok(),
      [del("d")]: () => ok(),
    });
    const [a, b, c, d] = notes("a", "b", "c", "d");
    const out = await trashNotesInOrder([a, b, c, d], { queryClient: newClient() });
    expect(calls.map((x) => x.url)).toEqual(["/api/notes/a", "/api/notes/b"]);
    expect(out.done).toEqual([a]);
    expect(out.skipped).toBe(0);
    expect(out.stopped?.remaining).toEqual([
      { kind: "note", id: "b" },
      { kind: "note", id: "c" },
      { kind: "note", id: "d" },
    ]);
    expect(out.stopped?.cause).toBeInstanceOf(ApiFail);
    expect((out.stopped?.cause as ApiFail).status).toBe(429);
  });

  it("SB5 hook 時機：beforeEach 在送出前；afterFailure 收到分類", async () => {
    const calls = stubFetch({
      [del("a")]: () => ok(),
      [del("b")]: () => fail(403, "forbidden"),
      [del("c")]: () => fail(429, "too_many_requests"),
    });
    const sentBefore: Array<[string, number]> = [];
    const failures: Array<[string, number, string]> = [];
    await trashNotesInOrder(notes("a", "b", "c"), {
      queryClient: newClient(),
      beforeEach: (n) => sentBefore.push([n.id, calls.length]),
      afterFailure: (n, err, kind) => failures.push([n.id, (err as ApiFail).status, kind]),
    });
    expect(sentBefore).toEqual([["a", 0], ["b", 1], ["c", 2]]);
    expect(failures).toEqual([["b", 403, "skip"], ["c", 429, "stop"]]);
  });

  it("SB9 空陣列：三種動作都不送請求", async () => {
    const calls = stubFetch({});
    const qc = newClient();
    const empty = { done: [], skipped: 0, skippedDetail: [], stopped: null };
    expect(await trashNotesInOrder([], { queryClient: qc })).toEqual(empty);
    expect(await moveNotesInOrder([], { groupId: "g1" }, { queryClient: qc })).toEqual(empty);
    expect(await copyNotesInOrder([], PERSONAL_ROOT, { queryClient: qc })).toEqual(empty);
    expect(await runSequential([], () => ({ kind: "note", id: "x" }), () => Promise.resolve(1))).toEqual(empty);
    expect(calls).toHaveLength(0);
  });

  it("SB10 進度：每篇成功或略過後回報；停下那篇不回報", async () => {
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => fail(403, "forbidden"), [del("c")]: () => ok() });
    const progress: Array<[number, number]> = [];
    await trashNotesInOrder(notes("a", "b", "c"), { queryClient: newClient(), onProgress: (p, t) => progress.push([p, t]) });
    expect(progress).toEqual([[1, 3], [2, 3], [3, 3]]);

    vi.unstubAllGlobals();
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => fail(429, "too_many_requests"), [del("c")]: () => ok() });
    const stopped: Array<[number, number]> = [];
    await trashNotesInOrder(notes("a", "b", "c"), { queryClient: newClient(), onProgress: (p, t) => stopped.push([p, t]) });
    expect(stopped).toEqual([[1, 3]]);
  });
});

describe("trashNotesInOrder 快取", () => {
  it("SB6 整批後恰失效 notes／backlinks／trash 與每篇成功的 note；停下時也失效", async () => {
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => ok() });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    await trashNotesInOrder(notes("a", "b"), { queryClient: qc });
    expect(sorted(keys)).toEqual(sorted([k("notes"), k("backlinks"), k("trash"), k("note", "a"), k("note", "b")]));

    vi.unstubAllGlobals();
    stubFetch({ [del("a")]: () => ok(), [del("b")]: () => fail(429, "too_many_requests") });
    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    const out = await trashNotesInOrder(notes("a", "b"), { queryClient: qc2 });
    expect(out.stopped).not.toBeNull();
    expect(sorted(keys2)).toEqual(sorted([k("notes"), k("backlinks"), k("trash"), k("note", "a")]));
  });
});

describe("moveNotesInOrder", () => {
  it("SB7 body、成功的快取寫入、失敗的對帳序；停下時 groups 仍失效", async () => {
    const [a, b, c] = notes("a", "b", "c");
    const movedA = { ...a, groupId: "g1", group: { id: "g1", name: "R&D" } };
    const movedB = { ...b, groupId: "g1", group: { id: "g1", name: "R&D" } };
    const calls = stubFetch({
      [move("a")]: () => ok(movedA),
      [move("b")]: () => ok(movedB),
      [move("c")]: () => fail(403, "forbidden"),
    });
    const qc = newClient();
    qc.setQueryData<PublicLinkDto>(["public-link", "a"], { token: "tok", slug: "pub", width: "standard" } as PublicLinkDto);
    const keys = spyInvalidations(qc);
    const out = await moveNotesInOrder([a, b, c], { groupId: "g1" }, { queryClient: qc });
    expect(calls.map((x) => x.body)).toEqual([{ groupId: "g1" }, { groupId: "g1" }, { groupId: "g1" }]);
    expect(out.done).toEqual([movedA, movedB]);
    expect(out.skipped).toBe(1);
    expect(qc.getQueryData(["shares", "a"])).toEqual([]);
    expect(qc.getQueryData<PublicLinkDto>(["public-link", "a"])).toMatchObject({ token: null, slug: null });
    expect(qc.getQueryData(["note", "a"])).toEqual(movedA);
    expect(qc.getQueryData(["note", "b"])).toEqual(movedB);
    await waitFor(() => expect(keys).toContain(k("note", "c")));
    const noteC = keys.indexOf(k("note", "c"));
    expect(keys.indexOf(k("shares", "c"))).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(k("public-link", "c"))).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf(k("shares", "c"))).toBeLessThan(noteC);
    expect(keys.indexOf(k("public-link", "c"))).toBeLessThan(noteC);

    // 停下案：第一篇 429。finally 的 groups 一次＋對帳序裡的一次。
    vi.unstubAllGlobals();
    stubFetch({ [move("a")]: () => fail(429, "too_many_requests") });
    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    const out2 = await moveNotesInOrder([a, b], { groupId: "g1" }, { queryClient: qc2 });
    expect(out2.stopped?.remaining).toEqual([{ kind: "note", id: "a" }, { kind: "note", id: "b" }]);
    expect(keys2).toContain(k("groups"));
    await waitFor(() => expect(keys2).toContain(k("note", "a")));
    expect(keys2.filter((x) => x === k("groups"))).toHaveLength(2);
  });
});

describe("copyNotesInOrder", () => {
  it("SB8 body 依目的地、副本寫入快取、整批後失效 notes；停下時也失效", async () => {
    const [a, b] = notes("a", "b");
    const copyA = personalNote({ id: "ca", title: "T-a" });
    const copyB = personalNote({ id: "cb", title: "T-b", groupId: "g1", group: { id: "g1", name: "R&D" } });
    const calls = stubFetch({ [copy("a")]: () => ok(copyA), [copy("b")]: () => ok(copyB) });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    const out = await copyNotesInOrder([a], PERSONAL_ROOT, { queryClient: qc });
    expect(calls[0].body).toEqual({});
    expect(out.done).toEqual([copyA]);
    expect(qc.getQueryData(["note", "ca"])).toEqual(copyA);
    expect(keys).toContain(k("notes"));

    const out2 = await copyNotesInOrder([b], RND_ROOT, { queryClient: qc });
    expect(calls[1].body).toEqual({ groupId: "g1" });
    expect(out2.done).toEqual([copyB]);
    expect(qc.getQueryData(["note", "cb"])).toEqual(copyB);

    vi.unstubAllGlobals();
    stubFetch({ [copy("a")]: () => ok(copyA), [copy("b")]: () => fail(429, "too_many_requests") });
    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    const out3 = await copyNotesInOrder([a, b], PERSONAL_ROOT, { queryClient: qc2 });
    expect(out3.stopped).not.toBeNull();
    expect(keys2).toContain(k("notes"));
  });
});

describe("hook 丟例外（finally 的意義）", () => {
  it("SB11 onProgress 丟例外 → 整批 reject，三種動作的整批失效仍做", async () => {
    const boom = (): never => {
      throw new Error("boom");
    };
    const [a] = notes("a");
    stubFetch({
      [del("a")]: () => ok(),
      [move("a")]: () => ok({ ...a, groupId: "g1" }),
      [copy("a")]: () => ok(personalNote({ id: "ca", title: "T-a" })),
    });

    const qc1 = newClient();
    const keys1 = spyInvalidations(qc1);
    await expect(trashNotesInOrder([a], { queryClient: qc1, onProgress: boom })).rejects.toThrow("boom");
    expect(sorted(keys1)).toEqual(sorted([k("notes"), k("backlinks"), k("trash"), k("note", "a")]));

    const qc2 = newClient();
    const keys2 = spyInvalidations(qc2);
    await expect(moveNotesInOrder([a], { groupId: "g1" }, { queryClient: qc2, onProgress: boom })).rejects.toThrow("boom");
    expect(keys2).toContain(k("groups"));

    const qc3 = newClient();
    const keys3 = spyInvalidations(qc3);
    await expect(copyNotesInOrder([a], PERSONAL_ROOT, { queryClient: qc3, onProgress: boom })).rejects.toThrow("boom");
    expect(keys3).toContain(k("notes"));
  });
});

// ── PR-3b-2 T5：資料夾與筆記的批次（資料夾 spec §6.10） ──

const noteT = (note: NoteDto): SelectionTarget => ({ kind: "note", note });
const folderT = (id: string, parentId: string | null = null): SelectionTarget => ({ kind: "folder", folder: folderDto({ id, name: id, parentId }) });
const patchFolder = (id: string): string => `PATCH /api/folders/${id}`;
const putFolder = (id: string): string => `PUT /api/notes/${id}/folder`;
const delFolder = (id: string): string => `DELETE /api/folders/${id}`;
const lines = (calls: readonly Call[]): string[] => calls.map((x) => `${x.method} ${x.url} ${JSON.stringify(x.body ?? null)}`);

describe("SBf1 classifyBatchError（資料夾錯誤碼）", () => {
  it("folder_not_found 預設 stop、{ folderGone: skip } 時 skip；folder_delete_blocked（403）skip；folder_name_taken（409）stop", () => {
    const gone = new ApiFail(404, "folder_not_found", "x");
    expect(classifyBatchError(gone)).toBe("stop");
    expect(classifyBatchError(gone, { folderGone: "stop" })).toBe("stop");
    expect(classifyBatchError(gone, { folderGone: "skip" })).toBe("skip");
    expect(classifyBatchError(new ApiFail(403, "folder_delete_blocked", "x"))).toBe("skip");
    expect(classifyBatchError(new ApiFail(409, "folder_name_taken", "x"))).toBe("stop");
    // 選項只影響 folder_not_found：其餘照 PR-2c。
    expect(classifyBatchError(new ApiFail(404, "not_found", "x"), { folderGone: "skip" })).toBe("skip");
    expect(classifyBatchError(new ApiFail(429, "too_many_requests", "x"), { folderGone: "skip" })).toBe("stop");
  });
});

describe("placeTargetsInOrder（同空間）", () => {
  const p1 = personalNote({ id: "p1", title: "P1", folderId: "B" });

  it("SBf2 依序 PATCH 資料夾、PUT 筆記；done 帶原處；根層送 null；成功筆記寫進快取", async () => {
    const placedP1 = { ...p1, folderId: "C" };
    const calls = stubFetch({
      [patchFolder("A")]: () => ok(folderDto({ id: "A", name: "A", parentId: "C" })),
      [putFolder("p1")]: () => ok(placedP1),
    });
    const qc = newClient();
    const out = await placeTargetsInOrder([folderT("A"), noteT(p1)], "C", { queryClient: qc });
    expect(lines(calls)).toEqual(['PATCH /api/folders/A {"parentId":"C"}', 'PUT /api/notes/p1/folder {"folderId":"C"}']);
    expect(out).toEqual({
      done: [
        { kind: "folder", id: "A", from: null },
        { kind: "note", id: "p1", from: "B" },
      ],
      skipped: 0,
      skippedDetail: [],
      stopped: null,
    });
    expect(qc.getQueryData(["note", "p1"])).toEqual(placedP1);

    vi.unstubAllGlobals();
    const rootCalls = stubFetch({
      [patchFolder("A")]: () => ok(folderDto({ id: "A", name: "A" })),
      [putFolder("p1")]: () => ok({ ...p1, folderId: null }),
    });
    await placeTargetsInOrder([folderT("A", "X"), noteT(p1)], null, { queryClient: newClient() });
    expect(lines(rootCalls)).toEqual(['PATCH /api/folders/A {"parentId":null}', 'PUT /api/notes/p1/folder {"folderId":null}']);
  });

  it("SBf3 第二項 404 folder_not_found → 停下（不是略過）；remaining 只剩它；finally 失效 folders、notes、trash", async () => {
    const calls = stubFetch({
      [patchFolder("A")]: () => ok(folderDto({ id: "A", name: "A", parentId: "C" })),
      [putFolder("p1")]: () => fail(404, "folder_not_found"),
    });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    const out = await placeTargetsInOrder([folderT("A"), noteT(p1)], "C", { queryClient: qc });
    expect(calls).toHaveLength(2);
    expect(out.done).toEqual([{ kind: "folder", id: "A", from: null }]);
    expect(out.skipped).toBe(0);
    expect(out.stopped?.remaining).toEqual([{ kind: "note", id: "p1" }]);
    expect((out.stopped?.cause as ApiFail).code).toBe("folder_not_found");
    expect(keys).toEqual(expect.arrayContaining([k("folders"), k("notes"), k("trash")]));
  });

  it("SBf4 429 → 停下、之後不送", async () => {
    const calls = stubFetch({
      [putFolder("p1")]: () => fail(429, "too_many_requests"),
      [patchFolder("A")]: () => ok(folderDto({ id: "A", name: "A" })),
    });
    const out = await placeTargetsInOrder([noteT(p1), folderT("A")], "C", { queryClient: newClient() });
    expect(calls).toHaveLength(1);
    expect(out.done).toEqual([]);
    expect(out.stopped?.remaining).toEqual([
      { kind: "note", id: "p1" },
      { kind: "folder", id: "A" },
    ]);
  });
});

describe("undoPlacements（D18 ③）", () => {
  const placed: PlacedItem[] = [
    { kind: "folder", id: "A", from: null },
    { kind: "note", id: "p1", from: "B" },
    { kind: "note", id: "p2", from: null },
  ];

  it("SBf5 依序送回各自的 from；done＝送回成功的項目", async () => {
    const calls = stubFetch({
      [patchFolder("A")]: () => ok(folderDto({ id: "A", name: "A" })),
      [putFolder("p1")]: () => ok(personalNote({ id: "p1", title: "P1", folderId: "B" })),
      [putFolder("p2")]: () => ok(personalNote({ id: "p2", title: "P2" })),
    });
    const out = await undoPlacements(placed, { queryClient: newClient() });
    expect(lines(calls)).toEqual([
      'PATCH /api/folders/A {"parentId":null}',
      'PUT /api/notes/p1/folder {"folderId":"B"}',
      'PUT /api/notes/p2/folder {"folderId":null}',
    ]);
    expect(out).toEqual({ done: placed, skipped: 0, skippedDetail: [], stopped: null });
  });

  it("SBf6 第 2 項 429 → 停下、done 長度 1、第 3 項不送", async () => {
    const calls = stubFetch({
      [patchFolder("A")]: () => ok(folderDto({ id: "A", name: "A" })),
      [putFolder("p1")]: () => fail(429, "too_many_requests"),
      [putFolder("p2")]: () => ok(personalNote({ id: "p2", title: "P2" })),
    });
    const out = await undoPlacements(placed, { queryClient: newClient() });
    expect(calls).toHaveLength(2);
    expect(out.done).toHaveLength(1);
    expect(out.stopped?.remaining).toEqual([
      { kind: "note", id: "p1" },
      { kind: "note", id: "p2" },
    ]);
  });
});

describe("deleteTargetsInOrder", () => {
  it("SBf7 資料夾先、筆記後；資料夾 403 folder_delete_blocked 與 404 folder_not_found 都略過；收 trashedNoteIds", async () => {
    const [n1, n2] = notes("n1", "n2");
    const calls = stubFetch({
      [delFolder("F1")]: () => ok({ trashedNoteIds: ["x1", "x2"], deletedFolderIds: ["F1"] }),
      [delFolder("F2")]: () => fail(403, "folder_delete_blocked"),
      [delFolder("F3")]: () => fail(404, "folder_not_found"),
      [del("n1")]: () => ok(),
      [del("n2")]: () => ok(),
    });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    const f1 = folderT("F1");
    const out = await deleteTargetsInOrder([noteT(n1), f1, folderT("F2"), folderT("F3"), noteT(n2)], { queryClient: qc });
    expect(calls.map((x) => `${x.method} ${x.url}`)).toEqual([delFolder("F1"), delFolder("F2"), delFolder("F3"), del("n1"), del("n2")]);
    expect(out.done).toEqual([
      { target: f1, trashedNoteIds: ["x1", "x2"] },
      { target: noteT(n1), trashedNoteIds: ["n1"] },
      { target: noteT(n2), trashedNoteIds: ["n2"] },
    ]);
    expect(out.stopped).toBeNull();
    expect(out.skipped).toBe(2);
    expect(out.skippedDetail.map((s) => [s.node, (s.err as ApiFail).status, (s.err as ApiFail).code])).toEqual([
      [{ kind: "folder", id: "F2" }, 403, "folder_delete_blocked"],
      [{ kind: "folder", id: "F3" }, 404, "folder_not_found"],
    ]);
    expect(keys).toEqual(
      expect.arrayContaining([k("folders"), k("notes"), k("trash"), k("backlinks"), k("note", "x1"), k("note", "x2"), k("note", "n1"), k("note", "n2")]),
    );
  });

  it("SBf7b 筆記的 404 folder_not_found 不套資料夾的略過（停下）；hook 收 SelectionTarget", async () => {
    const [n1] = notes("n1");
    stubFetch({ [del("n1")]: () => fail(404, "folder_not_found") });
    const seen: Array<[string, string]> = [];
    const out = await deleteTargetsInOrder([noteT(n1)], {
      queryClient: newClient(),
      beforeEach: (target) => seen.push(["before", target.kind]),
      afterFailure: (target, _err, kind) => seen.push([target.kind, kind]),
    });
    expect(out.stopped?.remaining).toEqual([{ kind: "note", id: "n1" }]);
    expect(seen).toEqual([
      ["before", "note"],
      ["note", "stop"],
    ]);
  });
});

describe("moveNotesInOrder（PR-3b 簽名）", () => {
  it("SBf8 body：帶資料夾 {groupId, folderId}、根層只有 {groupId}；finally 另失效 folders", async () => {
    const [a] = notes("a");
    const calls = stubFetch({ [move("a")]: () => ok({ ...a, groupId: "G" }) });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    await moveNotesInOrder([a], { groupId: "G", folderId: "GF" }, { queryClient: qc });
    await moveNotesInOrder([a], { groupId: "G" }, { queryClient: qc });
    expect(calls.map((x) => JSON.stringify(x.body))).toEqual(['{"groupId":"G","folderId":"GF"}', '{"groupId":"G"}']);
    expect(keys).toContain(k("folders"));
  });
});

describe("copyNotesInOrder（PR-3b 目的地）", () => {
  const G = groupDto({ id: "G", name: "G" }, memberRole());

  it("SBf9 建立副本：每篇落回自己的群組與資料夾；原資料夾 404 → 該篇不帶 folderId 重送一次、算完成", async () => {
    const p1 = personalNote({ id: "p1", title: "P1", folderId: "A" });
    const g1 = groupNote({ id: "g1", title: "G1", group: G, folderId: "GF" });
    const root = personalNote({ id: "r", title: "R" });
    let p1Tries = 0;
    const calls = stubFetch({
      [copy("p1")]: () => {
        p1Tries += 1;
        return p1Tries === 1 ? fail(404, "folder_not_found") : ok(personalNote({ id: "c-p1", title: "P1" }));
      },
      [copy("g1")]: () => ok(personalNote({ id: "c-g1", title: "G1" })),
      [copy("r")]: () => ok(personalNote({ id: "c-r", title: "R" })),
    });
    const qc = newClient();
    const keys = spyInvalidations(qc);
    const out = await copyNotesInOrder([p1, g1, root], { kind: "makeCopy" }, { queryClient: qc });
    expect(lines(calls)).toEqual([
      'POST /api/notes/p1/copy {"folderId":"A"}',
      "POST /api/notes/p1/copy {}",
      'POST /api/notes/g1/copy {"groupId":"G","folderId":"GF"}',
      "POST /api/notes/r/copy {}",
    ]);
    expect(out.done.map((n) => n.id)).toEqual(["c-p1", "c-g1", "c-r"]);
    expect(out.skipped).toBe(0);
    expect(out.stopped).toBeNull();
    expect(qc.getQueryData(["note", "c-p1"])).toMatchObject({ id: "c-p1" });
    expect(keys).toEqual(expect.arrayContaining([k("notes"), k("folders")]));
  });

  it("SBf9 群組筆記的原資料夾 404 → 重送時保留 groupId", async () => {
    const g1 = groupNote({ id: "g1", title: "G1", group: G, folderId: "GF" });
    let tries = 0;
    const calls = stubFetch({
      [copy("g1")]: () => {
        tries += 1;
        return tries === 1 ? fail(404, "folder_not_found") : ok(personalNote({ id: "c-g1", title: "G1" }));
      },
    });
    const out = await copyNotesInOrder([g1], { kind: "makeCopy" }, { queryClient: newClient() });
    expect(lines(calls)).toEqual(['POST /api/notes/g1/copy {"groupId":"G","folderId":"GF"}', 'POST /api/notes/g1/copy {"groupId":"G"}']);
    expect(out.done).toHaveLength(1);
  });

  it("SBf9 明選的資料夾 404 → 停下、不重送", async () => {
    const [a, b] = notes("a", "b");
    const calls = stubFetch({ [copy("a")]: () => fail(404, "folder_not_found"), [copy("b")]: () => ok(personalNote({ id: "cb", title: "B" })) });
    const target: DestTarget = {
      kind: "place",
      space: { kind: "group", groupId: "G", name: "G" },
      folder: folderDto({ id: "GF", name: "GF", space: { kind: "group", groupId: "G" } }),
    };
    const out = await copyNotesInOrder([a, b], target, { queryClient: newClient() });
    expect(lines(calls)).toEqual(['POST /api/notes/a/copy {"groupId":"G","folderId":"GF"}']);
    expect(out.done).toEqual([]);
    expect(out.stopped?.remaining).toEqual([
      { kind: "note", id: "a" },
      { kind: "note", id: "b" },
    ]);
  });

  it("SBf9 個人資料夾目的地 → {folderId}（沒有 groupId）", async () => {
    const [a] = notes("a");
    const calls = stubFetch({ [copy("a")]: () => ok(personalNote({ id: "ca", title: "A" })) });
    await copyNotesInOrder([a], { kind: "place", space: { kind: "personal" }, folder: folderDto({ id: "PF", name: "PF" }) }, { queryClient: newClient() });
    expect(lines(calls)).toEqual(['POST /api/notes/a/copy {"folderId":"PF"}']);
  });
});
