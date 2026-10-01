import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import { useCopyNote, useConfirmNoteStillPersonal, useMoveNoteToGroup } from "./note-move";
import { usePublicLink } from "./public-link";
import { useShares } from "./shares";

/**
 * #175 PR2 Task 8：移動／複製／送出前檢查三支 hook 的快取契約。renderHook 本體掛 `useShares`＋`usePublicLink`
 * 兩個 observer——沒有 active observer 時 `invalidateQueries` 只標 stale、不重抓、promise 立即 resolve，
 * 「先 await 重抓」與「重抓掛起」都造不出來。
 */

const ID = "11111111-1111-1111-1111-111111111111";
const GID = "33333333-3333-3333-3333-333333333333";
const SHARES_URL = `/api/notes/${ID}/shares`;
const PUBLIC_URL = `/api/notes/${ID}/public-link`;
const NOTE_URL = `/api/notes/${ID}`;

const SHARE: ShareDto = { userId: "u2", email: "bob@example.com", displayName: "Bob", role: "viewer" };

function noteDto(over: Partial<NoteDto>): NoteDto {
  return {
    id: ID,
    title: "N",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "n",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "tester",
    lastEdited: null,
    groupId: null,
    group: null,
    permissions: { moveToGroup: true },
    ...over,
  } as unknown as NoteDto;
}

function fakeResponse(status: number, json?: unknown): Response {
  return {
    ok: status < 400,
    status,
    json: () => (json === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(json)),
  } as unknown as Response;
}

type GateName = "shares" | "public";

/** armed 之後的 shares／public-link GET 各有自己的閘門，由測試分別手動放行（才分得出「少等哪一支」）。 */
function setupFetch(handlers: Record<string, () => Response>) {
  let armed = false;
  const releases = {} as Record<GateName, () => void>;
  const gates: Record<GateName, Promise<void>> = {
    shares: new Promise<void>(r => (releases.shares = r)),
    public: new Promise<void>(r => (releases.public = r)),
  };
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: init?.body as string | undefined });
    if (armed && method === "GET" && url === SHARES_URL) await gates.shares;
    if (armed && method === "GET" && url === PUBLIC_URL) await gates.public;
    const h = handlers[`${method} ${url}`];
    if (!h) throw new Error(`unexpected fetch ${method} ${url}`);
    return h();
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    calls,
    arm: () => {
      armed = true;
    },
    release: (name: GateName) => releases[name](),
  };
}

const KEY_OF: Record<GateName, unknown[]> = { shares: ["shares", ID], public: ["public-link", ID] };

/** 放行 name 那一支並等它重抓完成（fetchStatus idle）、再讓出一個 macrotask。抓得到「只等一支就寫」的錯誤實作，主要靠 waitFor 約 50ms 的輪詢給了它提早寫入的時間（讓出 macrotask 只是多一層）；延遲 ≥ 50ms 才寫的錯誤形從外部分辨不出，r3 審查實測過、接受。 */
async function releaseAndSettle(client: QueryClient, f: { release: (n: GateName) => void }, name: GateName) {
  f.release(name);
  await waitFor(() => expect(client.getQueryState(KEY_OF[name])?.fetchStatus).toBe("idle"));
  await new Promise(r => setTimeout(r, 0));
}

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const baseHandlers = {
  [`GET ${SHARES_URL}`]: () => fakeResponse(200, [SHARE]),
  [`GET ${PUBLIC_URL}`]: () => fakeResponse(200, { token: "T", slug: null }),
};

async function waitObserversReady(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(["shares", ID])?.status).toBe("success");
    expect(client.getQueryState(["public-link", ID])?.status).toBe("success");
  });
}

function keysOf(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map(c => {
    const arg = c[0];
    return typeof arg === "object" && arg !== null && "queryKey" in arg ? (arg as { queryKey: unknown }).queryKey : arg;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useMoveNoteToGroup", () => {
  it("移動成功：快取寫入序＝shares→public-link→note（三次同步、之間無 await；不變量①⑥）", async () => {
    // 搬完以回應為準、不假設 editor（Willie 裁決：create-only 搬完可能是 viewer）
    const moved = noteDto({ groupId: GID, ownerId: "u9", role: "viewer", permissions: { moveToGroup: false, edit: false } as never });
    const f = setupFetch({ ...baseHandlers, [`POST ${NOTE_URL}/move`]: () => fakeResponse(200, moved) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useMoveNoteToGroup(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");

    await result.current.mutateAsync(GID);

    const post = f.calls.find(c => c.method === "POST");
    expect(post).toMatchObject({ url: `${NOTE_URL}/move` });
    expect(JSON.parse(post!.body!)).toEqual({ groupId: GID });

    const sets = setSpy.mock.calls.slice(0, 3);
    expect(sets.map(c => c[0])).toEqual([["shares", ID], ["public-link", ID], ["note", ID]]);
    expect(sets[0]![1]).toEqual([]);
    expect(sets[1]![1]).toEqual({ token: null, slug: null });
    expect(sets[2]![1]).toEqual(moved);
    const inv = keysOf(invSpy as never);
    for (const k of ["notes", "note-by-path", "note-by-group-path", "backlinks"]) {
      expect(inv).toContainEqual([k]);
    }
  });

  it.each<[GateName, GateName]>([
    ["shares", "public"],
    ["public", "shares"],
  ])("移動失敗：先放行 %s、後放行 %s——兩支重抓都完成後才失效 note 與 groups；mutateAsync 在重抓結束前就 reject（不從 onError 回傳 promise——不變量②）", async (first, second) => {
    const f = setupFetch({
      ...baseHandlers,
      [`POST ${NOTE_URL}/move`]: () => fakeResponse(403, { error: { code: "forbidden", message: "no" } }),
    });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useMoveNoteToGroup(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const invSpy = vi.spyOn(client, "invalidateQueries");
    f.arm();

    let rejected = false;
    const p = result.current.mutateAsync(GID).catch(() => {
      rejected = true;
    });
    // 重抓真的被掛起（兩支都已發出第二次 GET、尚未放行）
    await waitFor(() => {
      expect(f.calls.filter(c => c.method === "GET" && c.url === SHARES_URL)).toHaveLength(2);
      expect(f.calls.filter(c => c.method === "GET" && c.url === PUBLIC_URL)).toHaveLength(2);
    });
    // mutateAsync 在重抓結束前就已 reject
    await waitFor(() => expect(rejected).toBe(true));
    // 重抓掛著：note 與 groups 都還沒被失效
    const mid = keysOf(invSpy as never);
    expect(mid).toContainEqual(["shares", ID]);
    expect(mid).toContainEqual(["public-link", ID]);
    expect(mid).not.toContainEqual(["note", ID]);
    expect(mid).not.toContainEqual(["groups"]);

    // 只放行一支並等它完成：另一支仍掛著，note 與 groups 仍不得被失效（少等任一支都會在此紅）
    await releaseAndSettle(client, f, first);
    const half = keysOf(invSpy as never);
    expect(half).not.toContainEqual(["note", ID]);
    expect(half).not.toContainEqual(["groups"]);

    await releaseAndSettle(client, f, second);
    await p;
    await waitFor(() => {
      const after = keysOf(invSpy as never);
      expect(after).toContainEqual(["note", ID]);
      expect(after).toContainEqual(["groups"]);
    });
  });
});

describe("useCopyNote", () => {
  it("複製到個人：body 是 {}；成功寫 ['note', copy.id]、失效 ['notes']，不動來源的 ['note', id]", async () => {
    const copy = noteDto({ id: "44444444-4444-4444-4444-444444444444", slug: "n-copy" });
    const f = setupFetch({ [`POST ${NOTE_URL}/copy`]: () => fakeResponse(201, copy) });
    const client = makeClient();
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useCopyNote(ID), { wrapper: wrapperFor(client) });

    const got = await result.current.mutateAsync(undefined);

    expect(got).toEqual(copy);
    expect(f.calls[0]).toMatchObject({ method: "POST", url: `${NOTE_URL}/copy` });
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({});
    expect(setSpy.mock.calls.map(c => c[0])).toEqual([["note", copy.id]]);
    expect(keysOf(invSpy as never)).toContainEqual(["notes"]);
    expect(client.getQueryData(["note", ID])).toBeUndefined();
  });

  it("複製到群組：body 是 { groupId }", async () => {
    const copy = noteDto({ id: "44444444-4444-4444-4444-444444444444", groupId: GID });
    const f = setupFetch({ [`POST ${NOTE_URL}/copy`]: () => fakeResponse(201, copy) });
    const client = makeClient();
    const { result } = renderHook(() => useCopyNote(ID), { wrapper: wrapperFor(client) });
    await result.current.mutateAsync(GID);
    expect(JSON.parse(f.calls[0]!.body!)).toEqual({ groupId: GID });
  });
});

describe("useConfirmNoteStillPersonal", () => {
  it("送出前檢查：仍是我的個人筆記 → true、不寫快取", async () => {
    setupFetch({ ...baseHandlers, [`GET ${NOTE_URL}`]: () => fakeResponse(200, noteDto({})) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useConfirmNoteStillPersonal(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const setSpy = vi.spyOn(client, "setQueryData");

    await expect(result.current()).resolves.toBe(true);
    expect(setSpy).not.toHaveBeenCalled();
    expect(client.getQueryData(["note", ID])).toBeUndefined();
  });

  it("送出前檢查：仍是個人筆記但 permissions.moveToGroup=false（不是我能移動的）→ false、寫入最新 note", async () => {
    const latest = noteDto({ groupId: null, role: "viewer", permissions: { moveToGroup: false } as never });
    setupFetch({ ...baseHandlers, [`GET ${NOTE_URL}`]: () => fakeResponse(200, latest) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useConfirmNoteStillPersonal(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);

    await expect(result.current()).resolves.toBe(false);
    expect(client.getQueryData(["note", ID])).toEqual(latest);
  });

  it.each<[GateName, GateName]>([
    ["shares", "public"],
    ["public", "shares"],
  ])("送出前檢查：已變群組筆記 → 先放行 %s、後放行 %s，兩支重抓都完成後才寫 ['note', id]、回 false（刻意不用 fetchQuery）", async (first, second) => {
    const latest = noteDto({ groupId: GID, role: "viewer", permissions: { moveToGroup: false } as never });
    const f = setupFetch({ ...baseHandlers, [`GET ${NOTE_URL}`]: () => fakeResponse(200, latest) });
    const client = makeClient();
    const { result } = renderHook(
      () => {
        useShares(ID);
        usePublicLink(ID);
        return useConfirmNoteStillPersonal(ID);
      },
      { wrapper: wrapperFor(client) },
    );
    await waitObserversReady(client);
    const setSpy = vi.spyOn(client, "setQueryData");
    const invSpy = vi.spyOn(client, "invalidateQueries");
    f.arm();

    let settled: boolean | undefined;
    const p = result.current().then(v => {
      settled = v;
    });
    await waitFor(() => {
      expect(f.calls.filter(c => c.method === "GET" && c.url === SHARES_URL)).toHaveLength(2);
      expect(f.calls.filter(c => c.method === "GET" && c.url === PUBLIC_URL)).toHaveLength(2);
    });
    // 重抓掛著：note 尚未被寫、promise 尚未 resolve
    expect(client.getQueryData(["note", ID])).toBeUndefined();
    expect(settled).toBeUndefined();

    // 只放行一支並等它完成：另一支仍掛著，note 仍不得被寫、promise 仍未 resolve
    // （少等任一支＝PR1 交接不變量⑥「閃一下公開」，會在此紅）
    await releaseAndSettle(client, f, first);
    expect(client.getQueryData(["note", ID])).toBeUndefined();
    expect(setSpy).not.toHaveBeenCalled();
    expect(settled).toBeUndefined();

    await releaseAndSettle(client, f, second);
    await p;
    expect(settled).toBe(false);
    expect(client.getQueryData(["note", ID])).toEqual(latest);
    expect(setSpy.mock.calls[0]![0]).toEqual(["note", ID]);
    const keys = keysOf(invSpy as never);
    for (const k of [["shares", ID], ["public-link", ID]]) {
      expect(keys).toContainEqual(k);
    }
    // false 路徑也要失效列表／解析層／群組（M-1）
    for (const k of ["notes", "note-by-path", "note-by-group-path", "groups"]) {
      expect(keys).toContainEqual([k]);
    }
  });
});
