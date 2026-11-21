import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { focusManager, onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { NoteDto, NoteSearchHitDto, NoteSearchResultDto, UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { OWNER_PERMS } from "@/test/fixtures";
import { useBodySearch, type BodySearchState } from "./search";

function note(id: string): NoteDto {
  return {
    id, title: `t-${id}`, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `slug-${id}`, slugIsCustom: false, prevSlug: null, ownerHandle: "owner", lastEdited: null, group: null, groupId: null, folderId: null,
    permissions: OWNER_PERMS,
  };
}
const hit = (id: string): NoteSearchHitDto => ({ note: note(id), matchedOn: "body", matches: [{ sectionId: "s", heading: "", snippet: `x ${id}` }] });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const page = (ids: string[], nextCursor: string | null = null): NoteSearchResultDto => ({ hits: ids.map(hit), nextCursor });

type Pending = { url: string; signal: AbortSignal | undefined; resolve: (r: Response) => void };
let calls: Pending[] = [];
function stubFetch() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("/api/search?")) throw new Error(`unexpected fetch: ${url}`);
      return new Promise<Response>((resolve) => calls.push({ url, signal: init?.signal ?? undefined, resolve }));
    }),
  );
}
const urls = () => calls.map((c) => c.url);
const qOf = (url: string) => new URL(url, "http://x").searchParams.get("q");

function setup(initial: { query: string; debounced: string; tagIds?: string[] }, userId = "u1") {
  // Deliberately not setting retry: false, so removing the hook's own `retry: false` is caught (see the 429/500 case).
  const client = new QueryClient();
  client.setQueryData<UserDto | null>(SESSION_QUERY_KEY, { id: userId } as UserDto);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook((p: { query: string; debounced: string; tagIds?: string[] }) => useBodySearch(p), { initialProps: initial, wrapper });
  return { client, ...hook };
}
const ready = (s: BodySearchState) => {
  if (s.kind !== "ready") throw new Error(`not ready: ${s.kind}`);
  return s;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

describe("useBodySearch", () => {
  beforeEach(() => stubFetch());

  it("sends one request with the right URL shape; special characters encoded; gate not search -> no request, pending", async () => {
    const { result, rerender } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(urls()[0]).toBe("/api/search?q=abcd&limit=20&match=body");
    rerender({ query: "a&b#c%", debounced: "a&b#c%" });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(urls()[1]).toBe("/api/search?q=a%26b%23c%25&limit=20&match=body");
    expect(qOf(urls()[1]!)).toBe("a&b#c%");

    stubFetch();
    const h = setup({ query: "a", debounced: "a" });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(0);
    expect(h.result.current.kind).toBe("pending");
    void result;
  });

  it("adds tags=<ids> only when tag ids are given, and a different tag set is a different search", async () => {
    const { rerender } = setup({ query: "abcd", debounced: "abcd", tagIds: ["b-id", "a-id"] });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(urls()[0]).toBe("/api/search?q=abcd&limit=20&match=body&tags=b-id%2Ca-id");
    rerender({ query: "abcd", debounced: "abcd", tagIds: ["a-id"] });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(urls()[1]).toBe("/api/search?q=abcd&limit=20&match=body&tags=a-id");
    rerender({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(3));
    expect(urls()[2]).toBe("/api/search?q=abcd&limit=20&match=body");
  });

  it("the same tags in another order reuse the cached search", async () => {
    const { rerender } = setup({ query: "abcd", debounced: "abcd", tagIds: ["a-id", "b-id"] });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"]))));
    rerender({ query: "abcd", debounced: "abcd", tagIds: ["b-id", "a-id"] });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls.length).toBe(1);
  });

  it("a 400 invalid_tags answer is reported as invalidTags, by code, and is not retried", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd", tagIds: ["gone-id"] });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(400, { error: { code: "invalid_tags", message: "Any text at all." } })));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(result.current).toEqual({ kind: "error", rateLimited: false, invalidTags: true });
    await new Promise((r) => setTimeout(r, 1200));
    expect(calls.length).toBe(1);
  });

  it("pending while first loading; ready when it returns, stale false, forQuery", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(result.current.kind).toBe("pending");
    act(() => calls[0]!.resolve(json(200, page(["n1"]))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    const s = ready(result.current);
    expect(s.stale).toBe(false);
    expect(s.forQuery).toBe("abcd");
    expect(s.hits.map((h) => h.note.id)).toEqual(["n1"]);
  });

  it("hook no longer trims: debounced is sent as is", async () => {
    setup({ query: " ab ", debounced: "ab" });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(qOf(urls()[0]!)).toBe("ab");
  });

  it("cancel: after debounced changes and the new request is sent, the first request's signal is aborted", async () => {
    const { rerender } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    rerender({ query: "abcde", debounced: "abcde" });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("first page 429 -> error rateLimited; 500 -> rateLimited false; neither retries", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(429, { error: { code: "too_many_requests", message: "x" } })));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(result.current).toEqual({ kind: "error", rateLimited: true, invalidTags: false });

    stubFetch();
    const h = setup({ query: "wxyz", debounced: "wxyz" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(500, { error: { code: "internal", message: "x" } })));
    await waitFor(() => expect(h.result.current.kind).toBe("error"));
    expect(h.result.current).toEqual({ kind: "error", rateLimited: false, invalidTags: false });
    await new Promise((r) => setTimeout(r, 1200)); // The default retry's first delay is 1 s
    expect(calls.length).toBe(1);
  });

  it("switching user: the session cache's user id changes, rerender -> a new request is sent", async () => {
    const { client, rerender } = setup({ query: "abcd", debounced: "abcd" }, "u1");
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"]))));
    client.setQueryData<UserDto | null>(SESSION_QUERY_KEY, { id: "u2" } as UserDto);
    rerender({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(2));
  });

  it("stale: while debouncing and while a new request is in flight, returns ready stale (old batch, old forQuery, hasMore false), never pending", async () => {
    const kinds: string[] = [];
    const { result, rerender } = setup({ query: "abc", debounced: "abc" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"], "c1"))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    expect(ready(result.current).hasMore).toBe(true);

    rerender({ query: "abcd", debounced: "abc" });
    kinds.push(result.current.kind);
    let s = ready(result.current);
    expect(s.stale).toBe(true);
    expect(s.forQuery).toBe("abc");
    expect(s.hits.map((h) => h.note.id)).toEqual(["n1"]);
    expect(s.hasMore).toBe(false);

    rerender({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(2));
    kinds.push(result.current.kind);
    s = ready(result.current);
    expect(s.stale).toBe(true);
    expect(s.forQuery).toBe("abc");
    expect(s.hasMore).toBe(false);

    act(() => calls[1]!.resolve(json(200, page(["n2"]))));
    await waitFor(() => expect(ready(result.current).stale).toBe(false));
    kinds.push(result.current.kind);
    s = ready(result.current);
    expect(s.forQuery).toBe("abcd");
    expect(s.hits.map((h) => h.note.id)).toEqual(["n2"]);
    expect(kinds).not.toContain("pending");
  });

  it("pagination: hasMore -> loadMore sends the cursor, two pages concatenate -> hasMore false after a null second page", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1", "n2"], "c1"))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    expect(ready(result.current).hasMore).toBe(true);
    act(() => ready(result.current).loadMore());
    await waitFor(() => expect(calls.length).toBe(2));
    expect(new URL(urls()[1]!, "http://x").searchParams.get("cursor")).toBe("c1");
    await waitFor(() => expect(ready(result.current).loadingMore).toBe(true));
    act(() => calls[1]!.resolve(json(200, page(["n3"], null))));
    await waitFor(() => expect(ready(result.current).hits.map((h) => h.note.id)).toEqual(["n1", "n2", "n3"]));
    expect(ready(result.current).hasMore).toBe(false);
    expect(ready(result.current).loadingMore).toBe(false);
  });

  it("dedupe: a second page containing an id from the first page -> appears once, at its first-page position", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1", "n2"], "c1"))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    act(() => ready(result.current).loadMore());
    await waitFor(() => expect(calls.length).toBe(2));
    act(() => calls[1]!.resolve(json(200, page(["n3", "n1"], null))));
    await waitFor(() => expect(ready(result.current).hits.map((h) => h.note.id)).toEqual(["n1", "n2", "n3"]));
  });

  it("second page 429 -> ready, first page kept, moreError.rateLimited; a successful loadMore afterwards -> moreError null", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"], "c1"))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    act(() => ready(result.current).loadMore());
    await waitFor(() => expect(calls.length).toBe(2));
    act(() => calls[1]!.resolve(json(429, { error: { code: "too_many_requests", message: "x" } })));
    await waitFor(() => expect(ready(result.current).moreError).toEqual({ rateLimited: true }));
    expect(ready(result.current).hits.map((h) => h.note.id)).toEqual(["n1"]);
    act(() => ready(result.current).loadMore());
    await waitFor(() => expect(calls.length).toBe(3));
    act(() => calls[2]!.resolve(json(200, page(["n2"], null))));
    await waitFor(() => expect(ready(result.current).hits.map((h) => h.note.id)).toEqual(["n1", "n2"]));
    expect(ready(result.current).moreError).toBeNull();
  });

  it("window refocus (data older than the 30 s staleTime) -> no new request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"]))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    await act(async () => vi.advanceTimersByTime(31_000));
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await act(async () => vi.advanceTimersByTime(50));
    expect(calls.length).toBe(1);
  });

  it("network recovery (data older than the 30 s staleTime) -> no new request", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"]))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    await act(async () => vi.advanceTimersByTime(31_000));
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await act(async () => vi.advanceTimersByTime(50));
    expect(calls.length).toBe(1);
  });
});
