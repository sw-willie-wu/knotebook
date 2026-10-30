import { afterEach, describe, expect, it, vi } from "vitest";
import { baseRef } from "@/test/version-fixtures";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { VersionListDto } from "@knotebook/shared";
import {
  VersionSnapshotMismatch,
  applyVersion,
  base64ToBytes,
  fetchCurrent,
  fetchVersionList,
  saveVersion,
  useRenameVersion,
  useVersionList,
  useVersionSnapshot,
  versionListKey,
  versionSnapshotKey,
  versionsKey,
} from "./versions";

const NOTE = "11111111-1111-1111-1111-111111111111";
const V1 = "aaaaaaaa-0000-0000-0000-000000000001";
const V1_OTHER = "aaaaaaaa-0000-0000-0000-0000000000ff";

function fakeResponse(status: number, json?: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => (json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(json)),
  } as unknown as Response;
}

function listBody(over: Partial<VersionListDto> = {}): VersionListDto {
  return {
    versions: [],
    current: { baseSeq: null, base: null, dirty: false, nextSeq: 1, autoEnabled: true },
    nextBefore: null,
    ...over,
  };
}

/** "AQID" ＝ bytes [1,2,3] */
const SNAP = (id: string) => ({ id, seq: 1, ydoc: "AQID" });

/** 預設 harness 關 retry；要守 hook 自己的 `retry: false` 的案傳 `new QueryClient()`（不關 retry）進來。 */
function setup(
  handler: (url: string, init?: RequestInit) => Response,
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      return Promise.resolve(handler(url, init));
    }),
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { calls, queryClient, wrapper };
}

describe("api/versions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("查詢鍵：清單在 ['notes'] 前綴下、快照在獨立前綴 ['note-versions', noteId, id]", () => {
    expect(versionsKey(NOTE)).toEqual(["notes", NOTE, "versions"]);
    // #258：清單鍵＝versionsKey 前綴＋"list"＋篩選，invalidate(versionsKey) 一次刷到兩種篩選。
    expect(versionListKey(NOTE, "all")).toEqual(["notes", NOTE, "versions", "list", "all"]);
    expect(versionListKey(NOTE, "manual")).toEqual(["notes", NOTE, "versions", "list", "manual"]);
    expect(versionSnapshotKey(NOTE, V1)).toEqual(["note-versions", NOTE, V1]);
  });

  it("invalidate ['notes'] 會重抓清單、不會重抓快照（spec §11.3）", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess && snap.result.current.isSuccess).toBe(true));
    const before = { list: calls.filter((c) => c.includes("?limit=50")).length, snap: calls.filter((c) => c.endsWith("/versions/1")).length };

    await queryClient.invalidateQueries({ queryKey: ["notes"] });

    await waitFor(() => expect(calls.filter((c) => c.includes("?limit=50")).length).toBe(before.list + 1));
    expect(calls.filter((c) => c.endsWith("/versions/1")).length).toBe(before.snap);
  });

  it("同 seq、不同 id → 不命中快取，各打一次（§9 會讓同一個 seq 指向不同內容）", async () => {
    let served = V1;
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(served));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const first = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    served = V1_OTHER;
    const second = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1_OTHER, name: null }), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(calls.filter((c) => c.endsWith("/versions/1"))).toHaveLength(2);
    expect(Array.from(second.result.current.data!)).toEqual([1, 2, 3]);
  });

  it("回應 id 與要的不符 → 丟棄（error＝VersionSnapshotMismatch、沒有 data）並 invalidate 清單", async () => {
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1_OTHER));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    await waitFor(() => expect(list.result.current.isSuccess).toBe(true));
    const listCalls = calls.filter((c) => c.includes("?limit=50")).length;

    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(snap.result.current.isError).toBe(true));
    expect(snap.result.current.error).toBeInstanceOf(VersionSnapshotMismatch);
    expect(snap.result.current.data).toBeUndefined();
    await waitFor(() => expect(calls.filter((c) => c.includes("?limit=50")).length).toBe(listCalls + 1));
  });

  it("快照失敗（404）→ error，不重試：快照端點恰打一次（QueryClient 不關 retry，守 hook 自己的 retry: false）", async () => {
    // 刻意用**不關 retry** 的 QueryClient：拿掉 hook 的 `retry: false` 的話 query-core 預設重試 3 次
    //（退避約 7 秒，塞得進全域等待上限），isError 出現時已打 4 次 → 計次紅。
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(404, { error: { code: "not_found", message: "x" } });
      throw new Error(`unexpected fetch: ${url}`);
    }, new QueryClient());
    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(snap.result.current.isError).toBe(true));
    expect(calls.filter((c) => c === `GET /api/notes/${NOTE}/versions/1`)).toHaveLength(1);
  });

  it("清單游標：before 與 limit 照實帶上；第二頁用上一頁的 nextBefore", async () => {
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody({ nextBefore: 51 }));
      if (url === `/api/notes/${NOTE}/versions?before=51&limit=50`) return fakeResponse(200, listBody());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    await waitFor(() => expect(list.result.current.hasNextPage).toBe(true));
    await list.result.current.fetchNextPage();
    await waitFor(() => expect(list.result.current.data?.pages).toHaveLength(2));
    expect(list.result.current.hasNextPage).toBe(false);
    expect(calls).toContain(`GET /api/notes/${NOTE}/versions?before=51&limit=50`);
    await expect(fetchVersionList(NOTE, { before: 7, limit: 1 })).rejects.toThrow("unexpected fetch");
  });

  it("enabled=false → 不打清單", async () => {
    const { calls, wrapper } = setup(() => {
      throw new Error("unexpected fetch");
    });
    renderHook(() => useVersionList(NOTE, false), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });

  it("fetchCurrent 一律重抓（staleTime 0）：連呼叫兩次打兩次 limit=1，回 current", async () => {
    let dirty = false;
    const { calls, queryClient } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=1`)
        return fakeResponse(200, listBody({ current: { baseSeq: 3, base: baseRef(3), dirty, nextSeq: 4, autoEnabled: true } }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    expect((await fetchCurrent(queryClient, NOTE)).dirty).toBe(false);
    dirty = true;
    expect((await fetchCurrent(queryClient, NOTE)).dirty).toBe(true);
    expect(calls.filter((c) => c.endsWith("?limit=1"))).toHaveLength(2);
  });

  it("saveVersion：名稱去頭尾空白；全空白或 null → body 不帶 name", async () => {
    const bodies: unknown[] = [];
    setup((url, init) => {
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") {
        bodies.push(JSON.parse(String(init.body)));
        return fakeResponse(201, { id: V1, seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, base: null, createdAt: "x", upgraded: false });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    await saveVersion(NOTE, "  里程碑 ");
    await saveVersion(NOTE, "   ");
    await saveVersion(NOTE, null);
    expect(bodies).toEqual([{ name: "里程碑" }, {}, {}]);
  });

  it("applyVersion：POST …/:seq/apply，body 恰為 { versionId, discardUnsaved }", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    setup((url, init) => {
      seen.push({ url, body: JSON.parse(String(init?.body)) });
      return fakeResponse(200, { current: { baseSeq: 2, base: baseRef(2), dirty: false, nextSeq: 5, autoEnabled: true } });
    });
    const out = await applyVersion(NOTE, 2, { versionId: V1, discardUnsaved: true });
    expect(seen).toEqual([{ url: `/api/notes/${NOTE}/versions/2/apply`, body: { versionId: V1, discardUnsaved: true } }]);
    expect(out.current.baseSeq).toBe(2);
  });

  it("base64ToBytes：二進位往返（含 0x00 與 0xff）", () => {
    expect(Array.from(base64ToBytes("AP8A"))).toEqual([0, 255, 0]);
  });

  it("快照 query 在 useQuery 層也是 Infinity staleTime：重新掛載不重抓", async () => {
    const { calls, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const a = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    a.unmount();
    const b = renderHook(() => useQuery({ queryKey: versionSnapshotKey(NOTE, V1), enabled: false }), { wrapper });
    expect(b.result.current.data).toBeDefined();
    renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1, name: null }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.endsWith("/versions/1"))).toHaveLength(1);
  });

  it("#258 清單篩選：kind=manual 照實帶上（與 before、limit 並用）；全部時不帶 kind；兩種篩選各一份快取", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions?kind=manual&limit=50`) return fakeResponse(200, listBody({ nextBefore: 9 }));
      if (url === `/api/notes/${NOTE}/versions?kind=manual&before=9&limit=50`) return fakeResponse(200, listBody());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const all = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const manual = renderHook(() => useVersionList(NOTE, true, "manual"), { wrapper });
    await waitFor(() => expect(all.result.current.isSuccess && manual.result.current.isSuccess).toBe(true));
    expect(manual.result.current.hasNextPage).toBe(true);
    expect(all.result.current.hasNextPage).toBe(false);
    await manual.result.current.fetchNextPage();
    await waitFor(() => expect(manual.result.current.data?.pages).toHaveLength(2));
    expect(calls).toEqual([
      `GET /api/notes/${NOTE}/versions?limit=50`,
      `GET /api/notes/${NOTE}/versions?kind=manual&limit=50`,
      `GET /api/notes/${NOTE}/versions?kind=manual&before=9&limit=50`,
    ]);
    expect(queryClient.getQueryData(versionListKey(NOTE, "all"))).toBeDefined();
    expect(queryClient.getQueryData(versionListKey(NOTE, "manual"))).toBeDefined();
    await expect(fetchVersionList(NOTE, { kind: "auto" })).rejects.toThrow("unexpected fetch");
    expect(calls.at(-1)).toBe(`GET /api/notes/${NOTE}/versions?kind=auto`);
  });

  it("#258 以 versionsKey 前綴 invalidate → 兩種篩選的清單都被標記並（有人訂閱時）重抓；current 單發重抓的鍵也在前綴下", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url.includes("?")) return fakeResponse(200, listBody());
      throw new Error(`unexpected fetch: ${url}`);
    });
    const all = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const manual = renderHook(() => useVersionList(NOTE, true, "manual"), { wrapper });
    await waitFor(() => expect(all.result.current.isSuccess && manual.result.current.isSuccess).toBe(true));
    await fetchCurrent(queryClient, NOTE);
    expect(queryClient.getQueryState(["notes", NOTE, "versions", "current"])).toBeDefined();
    const before = calls.length;
    await queryClient.invalidateQueries({ queryKey: versionsKey(NOTE) });
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(before + 2));
    expect(calls.slice(before).sort()).toEqual([
      `GET /api/notes/${NOTE}/versions?kind=manual&limit=50`,
      `GET /api/notes/${NOTE}/versions?limit=50`,
    ].sort());
  });

  it("#258 自動版本改名（PATCH）成功 → 帶 kind 的清單立刻重抓，轉成手動的那一版會出現在「僅手動」", async () => {
    let renamed = false;
    const row = (kind: "auto" | "manual") => ({ id: V1, seq: 1, kind, name: null, editors: [], baseSeq: null, base: null, createdAt: "x" });
    const { calls, wrapper } = setup((url, init) => {
      if (init?.method === "PATCH") {
        renamed = true;
        return fakeResponse(200, row("manual"));
      }
      if (url === `/api/notes/${NOTE}/versions?kind=manual&limit=50`) return fakeResponse(200, listBody({ versions: renamed ? [row("manual")] : [] }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const manual = renderHook(() => useVersionList(NOTE, true, "manual"), { wrapper });
    const rename = renderHook(() => useRenameVersion(NOTE), { wrapper });
    await waitFor(() => expect(manual.result.current.isSuccess).toBe(true));
    expect(manual.result.current.data?.pages[0]?.versions).toEqual([]);
    await rename.result.current.mutateAsync({ seq: 1, name: "命名" });
    await waitFor(() => expect(manual.result.current.data?.pages[0]?.versions.map((v) => v.seq)).toEqual([1]));
    expect(calls.filter((c) => c.includes("kind=manual"))).toHaveLength(2);
  });
});
