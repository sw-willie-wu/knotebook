import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { NoteDto, SpaceTagDto } from "@knotebook/shared";
import {
  patchNoteTagsInList,
  spaceTagsKey,
  tagSpaceOfNote,
  useAddNoteTag,
  useDeleteTag,
  useMergeTag,
  useNoteTags,
  useRemoveNoteTag,
  useSpaceTags,
  useUpdateTag,
} from "./tags";

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

type Handler = () => Response | Promise<Response>;

function stubFetch(routes: Record<string, Handler>) {
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

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const aws = { id: "t1", name: "AWS", color: "blue" as const };
const note = (id: string, tags?: NoteDto["tags"]): NoteDto => ({ id, groupId: null, ...(tags ? { tags } : {}) }) as unknown as NoteDto;
const personal = { kind: "personal" } as const;
const group = { kind: "group", groupId: "g1" } as const;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("space keys and paths", () => {
  it("spaceTagsKey and the GET path: personal → ['tags','personal'] /api/tags; group → ['tags','group',id] /api/groups/:id/tags", async () => {
    expect(spaceTagsKey(personal)).toEqual(["tags", "personal"]);
    expect(spaceTagsKey(group)).toEqual(["tags", "group", "g1"]);
    expect(tagSpaceOfNote({ groupId: null })).toEqual(personal);
    expect(tagSpaceOfNote({ groupId: "g1" })).toEqual(group);

    const list: SpaceTagDto[] = [{ ...aws, noteCount: 2 }];
    const calls = stubFetch({
      "GET /api/tags": () => fakeResponse(200, list),
      "GET /api/groups/g1/tags": () => fakeResponse(200, list),
    });
    const qc = client();
    const a = renderHook(() => useSpaceTags(personal), { wrapper: wrapper(qc) });
    const b = renderHook(() => useSpaceTags(group), { wrapper: wrapper(qc) });
    await waitFor(() => expect(a.result.current.data).toEqual(list));
    await waitFor(() => expect(b.result.current.data).toEqual(list));
    expect(calls.map((c) => c.url).sort()).toEqual(["/api/groups/g1/tags", "/api/tags"]);
  });

  it("does not fetch when disabled", async () => {
    const calls = stubFetch({});
    renderHook(() => useSpaceTags(personal, { enabled: false }), { wrapper: wrapper(client()) });
    await act(() => new Promise((r) => setTimeout(r, 20)));
    expect(calls).toEqual([]);
  });
});

describe("useNoteTags", () => {
  it("returns undefined until ['notes'] has loaded and [] for a row without tags", async () => {
    stubFetch({ "GET /api/notes": () => fakeResponse(200, [note("n1"), note("n2", [aws])]) });
    const qc = client();
    const first = renderHook(() => useNoteTags("n1"), { wrapper: wrapper(qc) });
    const second = renderHook(() => useNoteTags("n2"), { wrapper: wrapper(qc) });
    const missing = renderHook(() => useNoteTags("nope"), { wrapper: wrapper(qc) });
    expect(first.result.current).toBeUndefined();
    await waitFor(() => expect(first.result.current).toEqual([]));
    expect(second.result.current).toEqual([aws]);
    expect(missing.result.current).toBeUndefined();
  });
});

describe("note tag mutations", () => {
  it("useAddNoteTag posts {name}, cancels an in-flight ['notes'] fetch, puts the returned tags on that row of ['notes'], then invalidates the space's tag list", async () => {
    const calls = stubFetch({ "POST /api/notes/n1/tags": () => fakeResponse(200, { tags: [aws] }) });
    const qc = client();
    qc.setQueryData(["notes"], [note("n1", []), note("n2", [])]);
    const cancel = vi.spyOn(qc, "cancelQueries");
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useAddNoteTag(), { wrapper: wrapper(qc) });
    await act(() => result.current.mutateAsync({ noteId: "n1", name: "AWS", space: personal }));
    expect(calls[0]).toMatchObject({ method: "POST", url: "/api/notes/n1/tags", body: { name: "AWS" } });
    expect(cancel).toHaveBeenCalledWith({ queryKey: ["notes"], exact: true });
    const cached = qc.getQueryData<NoteDto[]>(["notes"])!;
    expect(cached.find((n) => n.id === "n1")!.tags).toEqual([aws]);
    expect(cached.find((n) => n.id === "n2")!.tags).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tags", "personal"] });
  });

  it("patchNoteTagsInList cancels before writing so an earlier request cannot overwrite the row", async () => {
    const qc = client();
    qc.setQueryData(["notes"], [note("n1", [])]);
    const order: string[] = [];
    vi.spyOn(qc, "cancelQueries").mockImplementation(async () => {
      order.push("cancel");
    });
    const set = qc.setQueryData.bind(qc);
    vi.spyOn(qc, "setQueryData").mockImplementation(((...args: Parameters<typeof set>) => {
      order.push("set");
      return set(...args);
    }) as typeof qc.setQueryData);
    const invalidate = vi.spyOn(qc, "invalidateQueries").mockImplementation(async () => {
      order.push("invalidate");
    });
    await patchNoteTagsInList(qc, "n1", [aws]);
    expect(order).toEqual(["cancel", "set", "invalidate"]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes"], exact: true });
  });

  it("useRemoveNoteTag deletes /api/notes/:id/tags/:tagId and patches the row", async () => {
    const calls = stubFetch({ "DELETE /api/notes/n1/tags/t1": () => fakeResponse(200, { tags: [] }) });
    const qc = client();
    qc.setQueryData(["notes"], [note("n1", [aws])]);
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const { result } = renderHook(() => useRemoveNoteTag(), { wrapper: wrapper(qc) });
    await act(() => result.current.mutateAsync({ noteId: "n1", tagId: "t1", space: group }));
    expect(calls[0]).toMatchObject({ method: "DELETE", url: "/api/notes/n1/tags/t1" });
    expect(qc.getQueryData<NoteDto[]>(["notes"])![0]!.tags).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["tags", "group", "g1"] });
  });
});

describe("list management mutations", () => {
  it("useUpdateTag, useMergeTag and useDeleteTag invalidate ['notes'] and the space key", async () => {
    const calls = stubFetch({
      "PATCH /api/tags/t1": () => fakeResponse(200, { ...aws, name: "Cloud", noteCount: 1 }),
      "POST /api/tags/t1/merge": () => fakeResponse(200, { ...aws, noteCount: 3 }),
      "DELETE /api/tags/t1": () => fakeResponse(204),
    });
    const qc = client();
    const invalidate = vi.spyOn(qc, "invalidateQueries");
    const update = renderHook(() => useUpdateTag(group), { wrapper: wrapper(qc) });
    await act(() => update.result.current.mutateAsync({ tagId: "t1", name: "Cloud" }));
    const merge = renderHook(() => useMergeTag(group), { wrapper: wrapper(qc) });
    await act(() => merge.result.current.mutateAsync({ tagId: "t1", into: "t2" }));
    const del = renderHook(() => useDeleteTag(group), { wrapper: wrapper(qc) });
    await act(() => del.result.current.mutateAsync({ tagId: "t1" }));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["PATCH /api/tags/t1", "POST /api/tags/t1/merge", "DELETE /api/tags/t1"]);
    expect(calls[0]!.body).toEqual({ name: "Cloud" });
    expect(calls[1]!.body).toEqual({ into: "t2" });
    const keys = invalidate.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    expect(keys.filter((k) => k === JSON.stringify(["notes"]))).toHaveLength(3);
    expect(keys.filter((k) => k === JSON.stringify(["tags", "group", "g1"]))).toHaveLength(3);
  });
});
