import { afterEach, describe, expect, it, vi } from "vitest";
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
  useVersionList,
  useVersionSnapshot,
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
    current: { baseSeq: null, dirty: false, nextSeq: 1, autoEnabled: true },
    nextBefore: null,
    ...over,
  };
}

/** "AQID" ＝ bytes [1,2,3] */
const SNAP = (id: string) => ({ id, seq: 1, ydoc: "AQID" });

function setup(handler: (url: string, init?: RequestInit) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(`${(init?.method ?? "GET").toUpperCase()} ${url}`);
      return Promise.resolve(handler(url, init));
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { calls, queryClient, wrapper };
}

describe("api/versions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("查詢鍵：清單在 ['notes'] 前綴下、快照在獨立前綴 ['note-versions', noteId, id]", () => {
    expect(versionsKey(NOTE)).toEqual(["notes", NOTE, "versions"]);
    expect(versionSnapshotKey(NOTE, V1)).toEqual(["note-versions", NOTE, V1]);
  });

  it("invalidate ['notes'] 會重抓清單、不會重抓快照（spec §11.3）", async () => {
    const { calls, queryClient, wrapper } = setup((url) => {
      if (url === `/api/notes/${NOTE}/versions?limit=50`) return fakeResponse(200, listBody());
      if (url === `/api/notes/${NOTE}/versions/1`) return fakeResponse(200, SNAP(V1));
      throw new Error(`unexpected fetch: ${url}`);
    });
    const list = renderHook(() => useVersionList(NOTE, true), { wrapper });
    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1 }), { wrapper });
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
    const first = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1 }), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    served = V1_OTHER;
    const second = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1_OTHER }), { wrapper });
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

    const snap = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1 }), { wrapper });
    await waitFor(() => expect(snap.result.current.isError).toBe(true));
    expect(snap.result.current.error).toBeInstanceOf(VersionSnapshotMismatch);
    expect(snap.result.current.data).toBeUndefined();
    await waitFor(() => expect(calls.filter((c) => c.includes("?limit=50")).length).toBe(listCalls + 1));
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
        return fakeResponse(200, listBody({ current: { baseSeq: 3, dirty, nextSeq: 4, autoEnabled: true } }));
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
        return fakeResponse(201, { id: V1, seq: 1, kind: "manual", name: null, editors: [], baseSeq: null, createdAt: "x", upgraded: false });
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
      return fakeResponse(200, { current: { baseSeq: 2, dirty: false, nextSeq: 5, autoEnabled: true } });
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
    const a = renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1 }), { wrapper });
    await waitFor(() => expect(a.result.current.isSuccess).toBe(true));
    a.unmount();
    const b = renderHook(() => useQuery({ queryKey: versionSnapshotKey(NOTE, V1), enabled: false }), { wrapper });
    expect(b.result.current.data).toBeDefined();
    renderHook(() => useVersionSnapshot(NOTE, { seq: 1, id: V1 }), { wrapper });
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.endsWith("/versions/1"))).toHaveLength(1);
  });
});
