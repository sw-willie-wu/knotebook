import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { FavoriteDto } from "@knotebook/shared";
import { ApiFail } from "./client";
import { FAVORITES_QUERY_KEY, useAddFavorite, useFavorites, useFavoriteStatus, useRemoveFavorite } from "./favorites";

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

type Handler = () => Response | Promise<Response>;

/** 記下每次呼叫；同一個 `method url` 依序取回應（用完就重複最後一個）；未列的 throw。 */
function stubFetch(routes: Record<string, Handler[]>) {
  const calls: Array<{ method: string; url: string; init: RequestInit | undefined }> = [];
  const used: Record<string, number> = {};
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, init });
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

/** 由測試決定何時回應的 handler。 */
function deferred() {
  let resolve!: (r: Response) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { handler: (() => promise) as Handler, resolve, reject };
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const fav = (noteId: string, favoritedAt: string): FavoriteDto => ({ noteId, favoritedAt });
const NOT_FOUND = () => fakeResponse(404, { error: { code: "not_found", message: "No note with that id." } });
const NO_CONTENT = () => fakeResponse(204);
const getCount = (calls: Array<{ method: string; url: string }>) =>
  calls.filter((c) => c.method === "GET" && c.url === "/api/favorites").length;
const cached = (qc: QueryClient) => qc.getQueryData<FavoriteDto[]>(FAVORITES_QUERY_KEY);
/** 讓已排進佇列的 promise 回呼與 React Query 的通知跑完。 */
const flush = () => act(() => new Promise((r) => setTimeout(r, 20)));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useFavorites", () => {
  it("key 是 ['favorites']，GET /api/favorites 成功回陣列", async () => {
    const list = [fav("b", "2026-03-02T00:00:00.000Z"), fav("a", "2026-03-01T00:00:00.000Z")];
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, list)] });
    const qc = client();
    const { result } = renderHook(() => useFavorites(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data).toEqual(list));
    expect(cached(qc)).toEqual(list);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /api/favorites"]);
  });

  it("enabled: false 時不打 GET，改成 true 才打", async () => {
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [])] });
    const qc = client();
    const { result, rerender } = renderHook(({ enabled }) => useFavorites({ enabled }), {
      wrapper: wrapper(qc),
      initialProps: { enabled: false },
    });
    await flush();
    expect(calls).toHaveLength(0);
    expect(result.current.fetchStatus).toBe("idle");
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(getCount(calls)).toBe(1);
  });
});

describe("useAddFavorite", () => {
  it("PUT /api/favorites/:id 不帶 body、不補 Content-Type", async () => {
    const calls = stubFetch({ "PUT /api/favorites/n1": [() => fakeResponse(200, fav("n1", "2026-03-01T00:00:00.000Z"))] });
    const qc = client();
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    await act(() => result.current.mutateAsync({ noteId: "n1" }));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init?.body).toBeUndefined();
    expect(new Headers(calls[0]!.init?.headers).has("Content-Type")).toBe(false);
  });

  it("樂觀插入依加入時間新到舊；同一毫秒時 noteId 大的在前", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = "2026-03-05T10:00:00.000Z";
    vi.setSystemTime(new Date(now));
    const putZ = deferred();
    const putC = deferred();
    stubFetch({ "PUT /api/favorites/z": [putZ.handler], "PUT /api/favorites/c": [putC.handler] });
    const qc = client();
    qc.setQueryData(FAVORITES_QUERY_KEY, [fav("m", now), fav("x", "2026-03-04T00:00:00.000Z")]);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });

    act(() => result.current.mutate({ noteId: "z" }));
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["z", "m", "x"]));
    expect(cached(qc)?.[0]).toEqual(fav("z", now));

    act(() => result.current.mutate({ noteId: "c" }));
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["z", "m", "c", "x"]));
    putZ.resolve(fakeResponse(200, fav("z", now)));
    putC.resolve(fakeResponse(200, fav("c", now)));
  });

  it("加入失敗（404）→ 快取回到原值、mutateAsync reject 出 ApiFail", async () => {
    stubFetch({ "PUT /api/favorites/a": [NOT_FOUND] });
    const qc = client();
    const before = [fav("x", "2026-03-04T00:00:00.000Z")];
    qc.setQueryData(FAVORITES_QUERY_KEY, before);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    let err: unknown;
    await act(async () => {
      await result.current.mutateAsync({ noteId: "a" }).catch((e: unknown) => {
        err = e;
      });
    });
    expect(err).toBeInstanceOf(ApiFail);
    expect((err as ApiFail).code).toBe("not_found");
    expect(cached(qc)).toEqual(before);
  });

  it("加入一篇本來就在快取裡的，失敗時不把它撤掉", async () => {
    stubFetch({ "PUT /api/favorites/a": [NOT_FOUND] });
    const qc = client();
    const before = [fav("a", "2026-03-04T00:00:00.000Z")];
    qc.setQueryData(FAVORITES_QUERY_KEY, before);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    await act(async () => {
      await result.current.mutateAsync({ noteId: "a" }).catch(() => undefined);
    });
    expect(cached(qc)).toEqual(before);
  });

  it("A 加入送出中、B 移出先完成，之後 A 失敗 → 快取裡沒有 A 也沒有 B", async () => {
    const putA = deferred();
    stubFetch({ "PUT /api/favorites/a": [putA.handler], "DELETE /api/favorites/b": [NO_CONTENT] });
    const qc = client();
    qc.setQueryData(FAVORITES_QUERY_KEY, [fav("b", "2026-03-04T00:00:00.000Z")]);
    const { result } = renderHook(() => ({ add: useAddFavorite(), remove: useRemoveFavorite() }), { wrapper: wrapper(qc) });

    let addDone!: Promise<unknown>;
    act(() => {
      addDone = result.current.add.mutateAsync({ noteId: "a" }).catch(() => undefined);
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a", "b"]));
    await act(() => result.current.remove.mutateAsync({ noteId: "b" }));
    expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]);

    putA.resolve(NOT_FOUND());
    await act(() => addDone);
    expect(cached(qc)).toEqual([]);
  });

  it("成功後 favoritedAt 換成 server 回的值", async () => {
    const server = "2026-03-05T10:00:00.123Z";
    stubFetch({ "PUT /api/favorites/a": [() => fakeResponse(200, fav("a", server))] });
    const qc = client();
    qc.setQueryData(FAVORITES_QUERY_KEY, []);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });
    await act(() => result.current.mutateAsync({ noteId: "a" }));
    expect(cached(qc)).toEqual([fav("a", server)]);
  });

  it("送出中快取被重抓蓋掉（不含 A），之後 A 成功 → 快取補回 A、依順序排好", async () => {
    const putA = deferred();
    stubFetch({ "PUT /api/favorites/a": [putA.handler] });
    const qc = client();
    const x = fav("x", "2026-03-04T00:00:00.000Z");
    const y = fav("y", "2026-03-06T00:00:00.000Z");
    qc.setQueryData(FAVORITES_QUERY_KEY, [x]);
    const { result } = renderHook(() => useAddFavorite(), { wrapper: wrapper(qc) });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toContain("a"));
    act(() => {
      qc.setQueryData(FAVORITES_QUERY_KEY, [y, x]);
    });

    const server = fav("a", "2026-03-05T00:00:00.000Z");
    putA.resolve(fakeResponse(200, server));
    await act(() => done);
    expect(cached(qc)).toEqual([y, server, x]);
  });

  it("加入前已在路上的重抓被取消，回來的舊清單不會蓋掉樂觀列", async () => {
    const refetch = deferred();
    const putA = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, []), refetch.handler, () => fakeResponse(200, [rowA])],
      "PUT /api/favorites/a": [putA.handler],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([]));
    act(() => {
      void qc.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY });
    });
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.fetchStatus).toBe("fetching"));

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]));
    refetch.resolve(fakeResponse(200, []));
    await flush();
    expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => done);
    await waitFor(() => expect(result.current.list.data).toEqual([rowA]));
  });

  it("A、B 同時加入：B 先完成時不重抓，A 完成後重抓一次", async () => {
    const putA = deferred();
    const putB = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const rowB = fav("b", "2026-03-05T00:00:01.000Z");
    const calls = stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, []), () => fakeResponse(200, [rowB, rowA])],
      "PUT /api/favorites/a": [putA.handler],
      "PUT /api/favorites/b": [putB.handler],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([]));
    expect(getCount(calls)).toBe(1);

    let doneA!: Promise<unknown>;
    let doneB!: Promise<unknown>;
    act(() => {
      doneA = result.current.add.mutateAsync({ noteId: "a" });
    });
    act(() => {
      doneB = result.current.add.mutateAsync({ noteId: "b" });
    });
    await waitFor(() => expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2));

    putB.resolve(fakeResponse(200, rowB));
    await act(() => doneB);
    await flush();
    expect(getCount(calls)).toBe(1);
    expect(result.current.list.data?.map((f) => f.noteId).sort()).toEqual(["a", "b"]);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => doneA);
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
    expect(result.current.list.data).toEqual([rowB, rowA]);
  });

  it("A 加入送出中、B 移出先完成：B 完成時不重抓，A 完成後重抓一次", async () => {
    const putA = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const rowB = fav("b", "2026-03-04T00:00:00.000Z");
    const calls = stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowB]), () => fakeResponse(200, [rowA])],
      "PUT /api/favorites/a": [putA.handler],
      "DELETE /api/favorites/b": [NO_CONTENT],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite(), remove: useRemoveFavorite() }), {
      wrapper: wrapper(qc),
    });
    await waitFor(() => expect(result.current.list.data).toEqual([rowB]));
    expect(getCount(calls)).toBe(1);

    let doneA!: Promise<unknown>;
    act(() => {
      doneA = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a", "b"]));
    await act(() => result.current.remove.mutateAsync({ noteId: "b" }));
    await flush();
    expect(getCount(calls)).toBe(1);
    expect(cached(qc)?.map((f) => f.noteId)).toEqual(["a"]);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => doneA);
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
    expect(result.current.list.data).toEqual([rowA]);
  });

  it("加入失敗後也重抓一次（掛著清單時）", async () => {
    const rowX = fav("x", "2026-03-04T00:00:00.000Z");
    const calls = stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [rowX])], "PUT /api/favorites/a": [NOT_FOUND] });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), add: useAddFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([rowX]));
    expect(getCount(calls)).toBe(1);

    await act(async () => {
      await result.current.add.mutateAsync({ noteId: "a" }).catch(() => undefined);
    });
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
  });
});

describe("useRemoveFavorite", () => {
  it("單獨一次移出完成後重抓一次（掛著清單時）", async () => {
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const calls = stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(200, [])],
      "DELETE /api/favorites/a": [NO_CONTENT],
    });
    const qc = client();
    const { result } = renderHook(() => ({ list: useFavorites(), remove: useRemoveFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.list.data).toEqual([rowA]));
    expect(getCount(calls)).toBe(1);

    await act(() => result.current.remove.mutateAsync({ noteId: "a" }));
    await waitFor(() => expect(getCount(calls)).toBe(2));
    await flush();
    expect(getCount(calls)).toBe(2);
    expect(result.current.list.data).toEqual([]);
  });

  it("DELETE /api/favorites/:id；回應前快取不變，204 後濾掉那一篇", async () => {
    const del = deferred();
    const calls = stubFetch({ "DELETE /api/favorites/a": [del.handler] });
    const qc = client();
    const a = fav("a", "2026-03-05T00:00:00.000Z");
    const b = fav("b", "2026-03-04T00:00:00.000Z");
    qc.setQueryData(FAVORITES_QUERY_KEY, [a, b]);
    const { result } = renderHook(() => useRemoveFavorite(), { wrapper: wrapper(qc) });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    await flush();
    expect(cached(qc)).toEqual([a, b]);

    del.resolve(NO_CONTENT());
    await act(() => done);
    expect(cached(qc)).toEqual([b]);
  });

  it("移出失敗（網路錯誤）→ 快取不變、mutateAsync reject", async () => {
    const del = deferred();
    stubFetch({ "DELETE /api/favorites/a": [del.handler] });
    const qc = client();
    const before = [fav("a", "2026-03-05T00:00:00.000Z")];
    qc.setQueryData(FAVORITES_QUERY_KEY, before);
    const { result } = renderHook(() => useRemoveFavorite(), { wrapper: wrapper(qc) });
    let err: unknown;
    act(() => {
      void result.current.mutateAsync({ noteId: "a" }).catch((e: unknown) => {
        err = e;
      });
    });
    del.reject(new TypeError("Failed to fetch"));
    await waitFor(() => expect(err).toBeInstanceOf(TypeError));
    expect(cached(qc)).toEqual(before);
  });
});

describe("useFavoriteStatus", () => {
  it("查詢 pending 時 ready=false；這一篇送出中 pending=true，別篇不受影響；送完 pending=false", async () => {
    const get = deferred();
    const putA = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    const rowB = fav("b", "2026-03-04T00:00:00.000Z");
    // 第二次 GET 是加入完成後的重抓。
    stubFetch({ "GET /api/favorites": [get.handler, () => fakeResponse(200, [rowA, rowB])], "PUT /api/favorites/a": [putA.handler] });
    const qc = client();
    const { result } = renderHook(() => ({ a: useFavoriteStatus("a"), b: useFavoriteStatus("b"), add: useAddFavorite() }), {
      wrapper: wrapper(qc),
    });
    await flush();
    expect(result.current.a).toEqual({ ready: false, favorite: false, pending: false });

    get.resolve(fakeResponse(200, [rowB]));
    await waitFor(() => expect(result.current.a.ready).toBe(true));
    expect(result.current.a).toEqual({ ready: true, favorite: false, pending: false });
    expect(result.current.b).toEqual({ ready: true, favorite: true, pending: false });

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.add.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: true, pending: true }));
    expect(result.current.b.pending).toBe(false);

    putA.resolve(fakeResponse(200, rowA));
    await act(() => done);
    await waitFor(() => expect(result.current.a.pending).toBe(false));
    expect(result.current.a.favorite).toBe(true);
  });

  it("這一篇移出送出中 pending=true，204 後 pending=false", async () => {
    const del = deferred();
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    // 第二次 GET 是移出完成後的重抓。
    stubFetch({ "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(200, [])], "DELETE /api/favorites/a": [del.handler] });
    const qc = client();
    const { result } = renderHook(() => ({ a: useFavoriteStatus("a"), remove: useRemoveFavorite() }), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: true, pending: false }));

    let done!: Promise<unknown>;
    act(() => {
      done = result.current.remove.mutateAsync({ noteId: "a" });
    });
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: true, pending: true }));

    del.resolve(NO_CONTENT());
    await act(() => done);
    await waitFor(() => expect(result.current.a).toEqual({ ready: true, favorite: false, pending: false }));
  });

  it("掛著的時候背景重抓失敗 → ready=false、favorite=false（即使快取裡還有這一篇）", async () => {
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(500, { error: { code: "internal", message: "x" } })],
    });
    const qc = client();
    const { result } = renderHook(() => useFavoriteStatus("a"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current).toEqual({ ready: true, favorite: true, pending: false }));
    await act(() => qc.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY }));
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    await flush();
    expect(cached(qc)).toEqual([rowA]);
    expect(result.current).toEqual({ ready: false, favorite: false, pending: false });
  });

  it("查詢失敗 → ready=false", async () => {
    stubFetch({ "GET /api/favorites": [() => fakeResponse(500, { error: { code: "internal", message: "x" } })] });
    const qc = client();
    const { result } = renderHook(() => useFavoriteStatus("a"), { wrapper: wrapper(qc) });
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    expect(result.current).toEqual({ ready: false, favorite: false, pending: false });
  });

  it("重抓失敗後才掛上的（例如重開選單）→ ready=false，即使快取裡還有舊清單", async () => {
    const rowA = fav("a", "2026-03-05T00:00:00.000Z");
    stubFetch({
      "GET /api/favorites": [() => fakeResponse(200, [rowA]), () => fakeResponse(500, { error: { code: "internal", message: "x" } })],
    });
    const qc = client();
    const first = renderHook(() => useFavorites(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(first.result.current.data).toEqual([rowA]));
    await act(() => qc.invalidateQueries({ queryKey: FAVORITES_QUERY_KEY }));
    await waitFor(() => expect(qc.getQueryState(FAVORITES_QUERY_KEY)?.status).toBe("error"));
    first.unmount();

    const { result } = renderHook(() => useFavoriteStatus("a"), { wrapper: wrapper(qc) });
    await flush();
    expect(cached(qc)).toEqual([rowA]);
    expect(result.current).toEqual({ ready: false, favorite: false, pending: false });
  });
});
