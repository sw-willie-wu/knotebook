import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { NoteDto } from "@knotebook/shared";
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
});
