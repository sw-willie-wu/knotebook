import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { OWNER_PERMS } from "@/test/fixtures";
import { trashItem, trashList } from "@/test/trash-fixtures";
import { folderChain, folderDto } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { ApiFail } from "./client";
import { useFolders } from "./folders";
import {
  chunkIds,
  invalidateTrashRelated,
  purgeTrashIds,
  restoreTrashIds,
  TRASH_QUERY_KEY,
  TRASH_SETTINGS_QUERY_KEY,
  TrashBatchError,
  trashErrorCause,
  usePurgeTrash,
  useRestoreTrash,
  useTrash,
  useTrashSettings,
  useUpdateTrashSettings,
} from "./trash";

function note(id: string, title = `T-${id}`): NoteDto {
  return {
    id,
    title,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `s-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    group: null,
    groupId: null,
    permissions: OWNER_PERMS,
    folderId: null,
  };
}

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

/** 記下每次 `method url body`；同一個 `method url` 依序取回應（用完就重複最後一個）；未列的 throw。 */
function stubFetch(routes: Record<string, Array<() => Response>>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const used: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const key = `${method} ${url}`;
      const list = routes[key];
      if (!list) throw new Error(`unexpected fetch: ${key}`);
      const i = used[key] ?? 0;
      used[key] = i + 1;
      return Promise.resolve(list[Math.min(i, list.length - 1)]!());
    }),
  );
  return calls;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

const ids = (n: number, prefix = "id") => Array.from({ length: n }, (_, i) => `${prefix}-${i}`);
const BUSY = () => fakeResponse(409, { error: { code: "server_busy", message: "busy" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

describe("chunkIds", () => {
  it("AT1 空→[]；200→1 批；201→[200,1]；450→[200,200,50]，順序同輸入", () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(ids(200)).map((c) => c.length)).toEqual([200]);
    expect(chunkIds(ids(201)).map((c) => c.length)).toEqual([200, 1]);
    const input = ids(450);
    const chunks = chunkIds(input);
    expect(chunks.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(chunks.flat()).toEqual(input);
    expect(chunks[1]![0]).toBe("id-200");
  });

  it("AT1b size ≤ 0 → RangeError（不會無窮迴圈）", () => {
    expect(() => chunkIds(ids(3), 0)).toThrow(RangeError);
    expect(() => chunkIds(ids(3), -1)).toThrow(RangeError);
  });
});

describe("useTrash", () => {
  it("AT0 打 GET /api/trash，key 是 ['trash']", async () => {
    const list = trashList([trashItem({ id: "a", title: "A" })]);
    stubFetch({ "GET /api/trash": [() => fakeResponse(200, list)] });
    const qc = client();
    const { result } = renderHook(() => useTrash(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data).toEqual(list));
    expect(qc.getQueryData(TRASH_QUERY_KEY)).toEqual(list);
  });
});

describe("restoreTrashIds", () => {
  it("AT2 450 個 id → 依序 3 次 POST，restored／skipped 依批次串接", async () => {
    const input = ids(450);
    const batch = (n: number): TrashRestoreResultDto => ({ restored: [note(`r${n}`)], skipped: [{ id: `s${n}`, reason: "not_in_trash" }] });
    const calls = stubFetch({
      "POST /api/trash/restore": [() => fakeResponse(200, batch(1)), () => fakeResponse(200, batch(2)), () => fakeResponse(200, batch(3))],
    });
    const result = await restoreTrashIds(input);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(Array(3).fill("POST /api/trash/restore"));
    expect(calls.map((c) => (c.body as { ids: string[] }).ids)).toEqual([input.slice(0, 200), input.slice(200, 400), input.slice(400)]);
    expect(result.restored.map((n) => n.id)).toEqual(["r1", "r2", "r3"]);
    expect(result.skipped.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("AT3 第二批 409 server_busy → TrashBatchError（cause＝ApiFail、partial＝第一批），第三批沒送", async () => {
    const first: TrashRestoreResultDto = { restored: [note("r1"), note("r1b")], skipped: [] };
    const calls = stubFetch({ "POST /api/trash/restore": [() => fakeResponse(200, first), BUSY, () => fakeResponse(200, first)] });
    const err = await restoreTrashIds(ids(450)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrashBatchError);
    const batchErr = err as TrashBatchError<TrashRestoreResultDto>;
    expect(batchErr.cause).toBeInstanceOf(ApiFail);
    expect((batchErr.cause as ApiFail).code).toBe("server_busy");
    expect(batchErr.message).toBe("busy");
    expect(batchErr.partial.restored.map((n) => n.id)).toEqual(["r1", "r1b"]);
    expect(trashErrorCause(err)).toBe(batchErr.cause);
    expect(calls).toHaveLength(2);
  });

  it("AT3 第一批就失敗 → partial 為空結果", async () => {
    stubFetch({ "POST /api/trash/restore": [BUSY] });
    const err = (await restoreTrashIds(ids(3)).catch((e: unknown) => e)) as TrashBatchError<TrashRestoreResultDto>;
    expect(err).toBeInstanceOf(TrashBatchError);
    expect(err.partial).toEqual({ restored: [], skipped: [] });
  });
});

describe("purgeTrashIds", () => {
  it("AT4 分批 POST /api/trash/purge，purged／skipped 串接", async () => {
    const input = ids(201);
    const calls = stubFetch({
      "POST /api/trash/purge": [
        () => fakeResponse(200, { purged: ["p1", "p2"], skipped: [{ id: "s1", reason: "not_found" }] } satisfies TrashPurgeResultDto),
        () => fakeResponse(200, { purged: ["p3"], skipped: [{ id: "s2", reason: "not_in_trash" }] } satisfies TrashPurgeResultDto),
      ],
    });
    const result = await purgeTrashIds(input);
    expect(calls.map((c) => (c.body as { ids: string[] }).ids)).toEqual([input.slice(0, 200), input.slice(200)]);
    expect(calls.every((c) => c.method === "POST" && c.url === "/api/trash/purge")).toBe(true);
    expect(result).toEqual({ purged: ["p1", "p2", "p3"], skipped: [{ id: "s1", reason: "not_found" }, { id: "s2", reason: "not_in_trash" }] });
  });

  it("AT4 空陣列 → 0 次請求、回空結果", async () => {
    const calls = stubFetch({});
    await expect(purgeTrashIds([])).resolves.toEqual({ purged: [], skipped: [] });
    await expect(restoreTrashIds([])).resolves.toEqual({ restored: [], skipped: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("invalidateTrashRelated", () => {
  it("AT5 失效的 key 恰為 trash／notes／folders／backlinks／每篇 note／兩支解析層前綴", () => {
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateTrashRelated(qc, ["a", "b"]);
    const keys = spy.mock.calls.filter(([arg]) => arg?.queryKey !== undefined).map(([arg]) => JSON.stringify(arg?.queryKey));
    expect([...keys].sort()).toEqual(['["backlinks"]', '["folders"]', '["note","a"]', '["note","b"]', '["note-by-group-path"]', '["note-by-path"]', '["notes"]', '["trash"]']);
  });

  it("AT-F 失效 ['folders']（資料夾 spec §6.12：還原會照原路徑重建資料夾）", () => {
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateTrashRelated(qc, ["a"]);
    expect(spy).toHaveBeenCalledWith({ queryKey: ["folders"] });
  });

  it("AT5b 舊形 /notes/:ref 的解析層（['note', slug] 停在 404 in_trash、noteId 在這批）也被失效；別篇的不動", async () => {
    const qc = client();
    const failWith = (noteId: string) => () => {
      const fail = new ApiFail(404, "in_trash", "x");
      fail.noteId = noteId;
      return Promise.reject(fail);
    };
    await qc.fetchQuery({ queryKey: ["note", "my-slug"], queryFn: failWith("a"), retry: false }).catch(() => undefined);
    await qc.fetchQuery({ queryKey: ["note", "vanity-zzz"], queryFn: failWith("z"), retry: false }).catch(() => undefined);
    await qc.fetchQuery({ queryKey: ["note", "gone"], queryFn: () => Promise.reject(new ApiFail(404, "not_found", "x")), retry: false }).catch(() => undefined);
    // error 態本來就帶 isInvalidated=true，所以改看「被哪些 filter 選中」：把每次失效的 filter 套回快取
    const spy = vi.spyOn(qc, "invalidateQueries");
    invalidateTrashRelated(qc, ["a"]);
    const hit = new Set(spy.mock.calls.flatMap(([filters]) => qc.getQueryCache().findAll(filters).map((q) => JSON.stringify(q.queryKey))));
    expect(hit.has('["note","my-slug"]')).toBe(true);
    expect(hit.has('["note","vanity-zzz"]')).toBe(false);
    expect(hit.has('["note","gone"]')).toBe(false);
  });
});

describe("useRestoreTrash／usePurgeTrash", () => {
  const trashInvalidations = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter(([arg]) => JSON.stringify((arg as { queryKey?: unknown } | undefined)?.queryKey) === '["trash"]').length;

  it("AT6 useRestoreTrash 成功、失敗都失效 ['trash']", async () => {
    stubFetch({
      "POST /api/trash/restore": [
        () => fakeResponse(200, { restored: [], skipped: [] }),
        () => fakeResponse(500, { error: { code: "internal", message: "boom" } }),
      ],
    });
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useRestoreTrash(), { wrapper: wrapper(qc) });
    await result.current.mutateAsync(["a"]);
    expect(trashInvalidations(spy)).toBe(1);
    await expect(result.current.mutateAsync(["a"])).rejects.toBeInstanceOf(TrashBatchError);
    expect(trashInvalidations(spy)).toBe(2);
  });

  it("AT6 usePurgeTrash 成功、失敗都失效 ['trash']", async () => {
    stubFetch({
      "POST /api/trash/purge": [
        () => fakeResponse(200, { purged: ["a"], skipped: [] }),
        () => fakeResponse(500, { error: { code: "internal", message: "boom" } }),
      ],
    });
    const qc = client();
    const spy = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => usePurgeTrash(), { wrapper: wrapper(qc) });
    await result.current.mutateAsync(["a"]);
    expect(trashInvalidations(spy)).toBe(1);
    await expect(result.current.mutateAsync(["a"])).rejects.toBeInstanceOf(TrashBatchError);
    expect(trashInvalidations(spy)).toBe(2);
  });

  /** 讀碼發現 27：移入時常駐層重抓拿到 404 → status error、data 留著舊 DTO。 */
  async function residentInError(qc: QueryClient, id: string) {
    qc.setQueryData(["note", id], note(id, "old"));
    await qc
      .fetchQuery({ queryKey: ["note", id], queryFn: () => Promise.reject(new ApiFail(404, "in_trash", "x")), retry: false })
      .catch(() => undefined);
    expect(qc.getQueryState(["note", id])?.status).toBe("error");
  }

  it("AT10 還原成功 → 常駐層 ['note', id] 被蓋回 success、data 是回應那篇", async () => {
    const restored = note("n1", "restored");
    stubFetch({ "POST /api/trash/restore": [() => fakeResponse(200, { restored: [restored], skipped: [] })] });
    const qc = client();
    await residentInError(qc, "n1");
    const { result } = renderHook(() => useRestoreTrash(), { wrapper: wrapper(qc) });
    await result.current.mutateAsync(["n1"]);
    expect(qc.getQueryState(["note", "n1"])?.status).toBe("success");
    expect(qc.getQueryData(["note", "n1"])).toEqual(restored);
  });

  it("AT10 中途失敗：已成功那批的 partial.restored 也蓋回常駐層", async () => {
    const restored = note("n1", "restored");
    stubFetch({ "POST /api/trash/restore": [() => fakeResponse(200, { restored: [restored], skipped: [] }), BUSY] });
    const qc = client();
    await residentInError(qc, "n1");
    const { result } = renderHook(() => useRestoreTrash(), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync(["n1", ...ids(200)])).rejects.toBeInstanceOf(TrashBatchError);
    expect(qc.getQueryState(["note", "n1"])?.status).toBe("success");
    expect(qc.getQueryData(["note", "n1"])).toEqual(restored);
  });
});

// 資料夾 PR-3b-2 T7（spec §6.8 還原後展開；總管裁定 I4、I-A）：還原照原路徑重建的資料夾與祖先要展開。
describe("useRestoreTrash × 還原後展開", () => {
  const CHAIN = folderChain("R", 3); // R1 ⊃ R2 ⊃ R3
  const inFolder = (id: string, folderId: string): NoteDto => ({ ...note(id), folderId });
  const foldersReply = (folders: unknown[]) => () => fakeResponse(200, { folders });
  const folderGets = (calls: Array<{ method: string; url: string }>) => calls.filter((c) => c.method === "GET" && c.url === "/api/folders").length;
  const collapseAll = (ids: readonly string[]) => {
    for (const id of ids) setCollapsed(`folder:${id}`, true);
  };

  it("TR-F1 還原成功（['folders'] 沒有 observer）→ 先收合的 folder:A 被展開", async () => {
    stubFetch({
      "POST /api/trash/restore": [() => fakeResponse(200, { restored: [inFolder("n1", "A")], skipped: [] })],
      "GET /api/folders": [foldersReply([folderDto({ id: "A", name: "A" })])],
    });
    const qc = client();
    collapseAll(["A"]);
    const { result } = renderHook(() => useRestoreTrash(), { wrapper: wrapper(qc) });
    await result.current.mutateAsync(["n1"]);
    await waitFor(() => expect(isCollapsed("folder:A")).toBe(false));
  });

  it("FI-R2 掛著 useFolders observer（我的筆記 tab 的形）→ 還原成功後新資料夾與祖先展開、GET /api/folders 恰好 1 次、沒有 unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const calls = stubFetch({
        "POST /api/trash/restore": [() => fakeResponse(200, { restored: [inFolder("n1", "R3")], skipped: [] })],
        // 第一次是 observer 掛載時（舊的、還沒有重建的資料夾）；之後是還原後
        "GET /api/folders": [foldersReply([]), foldersReply(CHAIN)],
      });
      const qc = client();
      const { result } = renderHook(() => ({ folders: useFolders(), restore: useRestoreTrash() }), { wrapper: wrapper(qc) });
      await waitFor(() => expect(result.current.folders.isSuccess).toBe(true));
      const before = folderGets(calls);
      expect(before).toBe(1);
      collapseAll(["R1", "R2", "R3"]);

      await result.current.restore.mutateAsync(["n1"]);
      await waitFor(() => expect(isCollapsed("folder:R1")).toBe(false));
      expect(isCollapsed("folder:R2")).toBe(false);
      expect(isCollapsed("folder:R3")).toBe(false);
      await waitFor(() => expect(result.current.folders.data).toEqual(CHAIN));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(folderGets(calls) - before).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("TR-F2 分批中途失敗（TrashBatchError）→ 已還原那幾篇的資料夾展開", async () => {
    stubFetch({
      "POST /api/trash/restore": [() => fakeResponse(200, { restored: [inFolder("n1", "A")], skipped: [] }), BUSY],
      "GET /api/folders": [foldersReply([folderDto({ id: "A", name: "A" }), folderDto({ id: "B", name: "B" })])],
    });
    const qc = client();
    collapseAll(["A", "B"]);
    const { result } = renderHook(() => useRestoreTrash(), { wrapper: wrapper(qc) });
    await expect(result.current.mutateAsync(["n1", ...ids(200)])).rejects.toBeInstanceOf(TrashBatchError);
    await waitFor(() => expect(isCollapsed("folder:A")).toBe(false));
    expect(isCollapsed("folder:B")).toBe(true);
  });
});

describe("站台垃圾桶設定", () => {
  it("AT7 GET /api/admin/trash/settings；PATCH {retentionDays:null} 成功後 setQueryData 並失效 ['trash']", async () => {
    const calls = stubFetch({
      "GET /api/admin/trash/settings": [() => fakeResponse(200, { retentionDays: 7 })],
      "PATCH /api/admin/trash/settings": [() => fakeResponse(200, { retentionDays: null })],
    });
    const qc = client();
    const read = renderHook(() => useTrashSettings(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(read.result.current.data).toEqual({ retentionDays: 7 }));
    const spy = vi.spyOn(qc, "invalidateQueries");
    const write = renderHook(() => useUpdateTrashSettings(), { wrapper: wrapper(qc) });
    await write.result.current.mutateAsync({ retentionDays: null });
    expect(calls.at(-1)).toEqual({ method: "PATCH", url: "/api/admin/trash/settings", body: { retentionDays: null } });
    expect(qc.getQueryData(TRASH_SETTINGS_QUERY_KEY)).toEqual({ retentionDays: null });
    expect(spy).toHaveBeenCalledWith({ queryKey: ["trash"] });
  });
});
