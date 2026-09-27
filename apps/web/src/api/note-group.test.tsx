import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { NoteDto } from "@knotebook/shared";
import { api } from "./client";
import { useConfirmNoteGroupUnchanged, useMoveNoteToGroup, useRemoveNoteGroup, useSetNoteGroupRole } from "./note-group";

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const BASE: NoteDto = {
  id: NOTE_ID,
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
};
const IN_GROUP: NoteDto = { ...BASE, group: { id: GROUP_ID, name: "Workshop A", role: "editor" } };
const GROUP_URL = `/api/notes/${NOTE_ID}/group`;

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const handler = routes[`${method} ${url}`];
      if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve(handler());
    }),
  );
  return calls;
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(["shares", NOTE_ID], [{ userId: "u9", email: "carol@example.com", displayName: "Carol", role: "viewer" }]);
  queryClient.setQueryData(["public-link", NOTE_ID], { token: "tok-1", slug: "alias" });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, wrapper };
}

/** setQueryData 呼叫的 key 序列（`a:b` 形，方便比對）。 */
function writtenKeys(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map(([key]) => (key as unknown[]).join(":"));
}

describe("api/note-group", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("useMoveNoteToGroup：PUT {groupId, role}；成功後依序寫 shares=[]、public-link=null、note（順序是 spec §8.3 契約）", async () => {
    const calls = stubFetch({ [`PUT ${GROUP_URL}`]: () => fakeResponse(200, IN_GROUP) });
    const { queryClient, wrapper } = setup();
    const setData = vi.spyOn(queryClient, "setQueryData");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useMoveNoteToGroup(NOTE_ID), { wrapper });

    await result.current.mutateAsync({ groupId: GROUP_ID, role: "editor" });

    expect(calls).toEqual([{ method: "PUT", url: GROUP_URL, body: { groupId: GROUP_ID, role: "editor" } }]);
    expect(writtenKeys(setData)).toEqual([`shares:${NOTE_ID}`, `public-link:${NOTE_ID}`, `note:${NOTE_ID}`]);
    expect(queryClient.getQueryData(["shares", NOTE_ID])).toEqual([]);
    expect(queryClient.getQueryData(["public-link", NOTE_ID])).toEqual({ token: null, slug: null });
    expect(queryClient.getQueryData(["note", NOTE_ID])).toEqual(IN_GROUP);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["note-by-path"] });
  });

  it("useSetNoteGroupRole：同一支 PUT，但**不碰** shares／public-link 快取（server 同群組只改 role、不清連結）", async () => {
    const calls = stubFetch({ [`PUT ${GROUP_URL}`]: () => fakeResponse(200, { ...IN_GROUP, group: { ...IN_GROUP.group!, role: "viewer" } }) });
    const { queryClient, wrapper } = setup();
    const setData = vi.spyOn(queryClient, "setQueryData");
    const { result } = renderHook(() => useSetNoteGroupRole(NOTE_ID), { wrapper });

    await result.current.mutateAsync({ groupId: GROUP_ID, role: "viewer" });

    expect(calls).toEqual([{ method: "PUT", url: GROUP_URL, body: { groupId: GROUP_ID, role: "viewer" } }]);
    expect(writtenKeys(setData)).toEqual([`note:${NOTE_ID}`]);
    expect(queryClient.getQueryData(["public-link", NOTE_ID])).toEqual({ token: "tok-1", slug: "alias" });
    expect(queryClient.getQueryData<NoteDto>(["note", NOTE_ID])?.group?.role).toBe("viewer");
  });

  it("useRemoveNoteGroup：DELETE 無 body；只寫 note，公開連結快取不動（A10）", async () => {
    const calls = stubFetch({ [`DELETE ${GROUP_URL}`]: () => fakeResponse(200, BASE) });
    const { queryClient, wrapper } = setup();
    const setData = vi.spyOn(queryClient, "setQueryData");
    const { result } = renderHook(() => useRemoveNoteGroup(NOTE_ID), { wrapper });

    await result.current.mutateAsync();

    expect(calls).toEqual([{ method: "DELETE", url: GROUP_URL, body: undefined }]);
    expect(writtenKeys(setData)).toEqual([`note:${NOTE_ID}`]);
    expect(queryClient.getQueryData(["public-link", NOTE_ID])).toEqual({ token: "tok-1", slug: "alias" });
    expect(queryClient.getQueryData(["note", NOTE_ID])).toEqual(BASE);
  });

  it("失敗（409 conflict）→ 不寫任何快取；先失效 shares／public-link，再失效 ['note', id] 與 ['groups']；錯誤往上拋給呼叫端", async () => {
    stubFetch({ [`DELETE ${GROUP_URL}`]: () => fakeResponse(409, { error: { code: "conflict", message: "x" } }) });
    const { queryClient, wrapper } = setup();
    const setData = vi.spyOn(queryClient, "setQueryData");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRemoveNoteGroup(NOTE_ID), { wrapper });

    await expect(result.current.mutateAsync()).rejects.toMatchObject({ code: "conflict" });

    expect(setData).not.toHaveBeenCalled();
    // 順序（gate r1 M1）：shares／public-link 先，note 後——見 `refetchAfterFailure` 的 JSDoc。
    expect(invalidate.mock.calls.map(([arg]) => (arg as { queryKey: unknown[] }).queryKey.join(":"))).toEqual([
      `shares:${NOTE_ID}`,
      `public-link:${NOTE_ID}`,
      `note:${NOTE_ID}`,
      "groups",
    ]);
  });

  it("useConfirmNoteGroupUnchanged：server 的群組與預期相同 → true，不寫也不失效任何快取", async () => {
    const calls = stubFetch({ [`GET /api/notes/${NOTE_ID}`]: () => fakeResponse(200, IN_GROUP) });
    const { queryClient, wrapper } = setup();
    const setData = vi.spyOn(queryClient, "setQueryData");
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useConfirmNoteGroupUnchanged(NOTE_ID), { wrapper });

    await expect(result.current(GROUP_ID)).resolves.toBe(true);

    expect(calls).toEqual([{ method: "GET", url: `/api/notes/${NOTE_ID}`, body: undefined }]);
    expect(setData).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("useConfirmNoteGroupUnchanged：不同 → false；先失效 shares／public-link，之後才寫 note（與 refetchAfterFailure 同一條順序規則）", async () => {
    stubFetch({ [`GET /api/notes/${NOTE_ID}`]: () => fakeResponse(200, BASE) });
    const { queryClient, wrapper } = setup();
    const log: string[] = [];
    const realSet = queryClient.setQueryData.bind(queryClient);
    vi.spyOn(queryClient, "setQueryData").mockImplementation(((key: readonly unknown[], value: unknown) => {
      log.push(`set ${key.join(":")}`);
      return realSet(key, value);
    }) as typeof queryClient.setQueryData);
    const realInvalidate = queryClient.invalidateQueries.bind(queryClient);
    vi.spyOn(queryClient, "invalidateQueries").mockImplementation(((filters: { queryKey: readonly unknown[] }) => {
      log.push(`invalidate ${filters.queryKey.join(":")}`);
      return realInvalidate(filters);
    }) as typeof queryClient.invalidateQueries);
    const { result } = renderHook(() => useConfirmNoteGroupUnchanged(NOTE_ID), { wrapper });

    await expect(result.current(GROUP_ID)).resolves.toBe(false);

    expect(log).toEqual([
      `invalidate shares:${NOTE_ID}`,
      `invalidate public-link:${NOTE_ID}`,
      `set note:${NOTE_ID}`,
      "invalidate notes",
      "invalidate note-by-path",
      "invalidate groups",
    ]);
    expect(queryClient.getQueryData(["note", NOTE_ID])).toEqual(BASE);
  });

  /**
   * fix round 1（review Minor 2）：`void refetchAfterFailure(...)` 的 fire-and-forget 承諾——
   * 之前只有 `useMoveNoteToGroup` 那支測試碰巧因為斷言順序而間接被護到；`useSetNoteGroupRole`／
   * `useRemoveNoteGroup` 完全沒被護到（把 `void` 換成 `return`、或整個拿掉 `onError`，六發只有一發
   * 讓既有測試變紅）。這裡補一支 `describe.each`，三支 hook 各跑一次同一套斷言：
   * 掛一個真的 `useQuery` 觀察者在 `['shares', id]` 上（讓 `invalidateQueries` 的預設
   * `refetchType:'active'` 真的會觸發重抓），把它的 GET 故意拖到 500ms 後才 resolve，
   * 斷言 `mutateAsync` 的 reject 落地時那支重抓**還沒**完成、但**已經**被觸發（`sharesFetchCount`
   * 從 1 變 2）——這是 onError 必須是 fire-and-forget 的直接證據；最後再等那支重抓真的完成，
   * 確認「shares 之後仍會失效並重抓」這件事本身沒有被犧牲掉。
   */
  type GroupHookCase = {
    name: string;
    method: "PUT" | "DELETE";
    useCase: (noteId: string) => { mutateAsync: () => Promise<NoteDto> };
  };

  const GROUP_HOOK_CASES: GroupHookCase[] = [
    {
      name: "useMoveNoteToGroup",
      method: "PUT",
      useCase: (noteId) => {
        const mutation = useMoveNoteToGroup(noteId);
        return { mutateAsync: () => mutation.mutateAsync({ groupId: GROUP_ID, role: "editor" }) };
      },
    },
    {
      name: "useSetNoteGroupRole",
      method: "PUT",
      useCase: (noteId) => {
        const mutation = useSetNoteGroupRole(noteId);
        return { mutateAsync: () => mutation.mutateAsync({ groupId: GROUP_ID, role: "editor" }) };
      },
    },
    {
      name: "useRemoveNoteGroup",
      method: "DELETE",
      useCase: (noteId) => {
        const mutation = useRemoveNoteGroup(noteId);
        return { mutateAsync: () => mutation.mutateAsync() };
      },
    },
  ];

  describe.each(GROUP_HOOK_CASES)(
    "$name：onError 對 shares 重抓是 fire-and-forget（review Minor 2）",
    ({ method, useCase }) => {
      it("mutateAsync 的 reject 早於 shares 重抓完成落地，但重抓確實已被觸發且最終完成", async () => {
        const SHARES_URL = `/api/notes/${NOTE_ID}/shares`;
        let sharesFetchCount = 0;
        let sharesRefetchSettled = false;

        vi.stubGlobal(
          "fetch",
          vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            const m = (init?.method ?? "GET").toUpperCase();
            if (`${m} ${url}` === `${method} ${GROUP_URL}`) {
              return Promise.resolve(fakeResponse(500, { error: { code: "internal", message: "boom" } }));
            }
            if (`${m} ${url}` === `GET ${SHARES_URL}`) {
              sharesFetchCount += 1;
              if (sharesFetchCount === 1) return Promise.resolve(fakeResponse(200, []));
              return new Promise<Response>((resolve) => {
                setTimeout(() => {
                  sharesRefetchSettled = true;
                  resolve(fakeResponse(200, []));
                }, 500);
              });
            }
            if (`${m} ${url}` === `GET /api/notes/${NOTE_ID}/public-link`) {
              return Promise.resolve(fakeResponse(200, { token: null, slug: null }));
            }
            throw new Error(`unexpected fetch: ${m} ${url}`);
          }),
        );

        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        const wrapper = ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        );

        const { result } = renderHook(
          () => ({
            mutation: useCase(NOTE_ID),
            shares: useQuery({ queryKey: ["shares", NOTE_ID], queryFn: () => api<unknown>(SHARES_URL) }),
          }),
          { wrapper },
        );

        await waitFor(() => expect(result.current.shares.isSuccess).toBe(true));
        expect(sharesFetchCount).toBe(1);

        const rejectPromise = result.current.mutation.mutateAsync();
        await expect(rejectPromise).rejects.toMatchObject({ code: "internal" });

        // reject 落地的當下：重抓已觸發（fire-and-forget 真的把 fetch 打出去了）、但還沒完成落地。
        expect(sharesFetchCount).toBe(2);
        expect(sharesRefetchSettled).toBe(false);

        // 「shares 之後仍會失效並重抓」這件事本身沒有被犧牲——等那支被觸發的重抓真的完成。
        await waitFor(() => expect(sharesRefetchSettled).toBe(true), { timeout: 2000 });
      });
    },
  );
});
