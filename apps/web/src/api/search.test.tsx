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

function setup(initial: { query: string; debounced: string }, userId = "u1") {
  // 刻意不設 retry: false——H5 要殺「拿掉 hook 的 retry: false」。
  const client = new QueryClient();
  client.setQueryData<UserDto | null>(SESSION_QUERY_KEY, { id: userId } as UserDto);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  const hook = renderHook((p: { query: string; debounced: string }) => useBodySearch(p), { initialProps: initial, wrapper });
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

  it("H1 發一次、URL 形；特殊字元編碼；gate 不是 search → 不發、pending", async () => {
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

  it("H2 第一次載入中 pending；回來 ready、stale false、forQuery", async () => {
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

  it("H3 hook 不再 trim：debounced 照原樣送", async () => {
    setup({ query: " ab ", debounced: "ab" });
    await waitFor(() => expect(calls.length).toBe(1));
    expect(qOf(urls()[0]!)).toBe("ab");
  });

  it("H4 取消：debounced 改變、新請求發出後，第一發的 signal 已 aborted", async () => {
    const { rerender } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    rerender({ query: "abcde", debounced: "abcde" });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls[0]!.signal?.aborted).toBe(true);
  });

  it("H5 第一頁 429 → error rateLimited；500 → rateLimited false；都不 retry", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(429, { error: { code: "too_many_requests", message: "x" } })));
    await waitFor(() => expect(result.current.kind).toBe("error"));
    expect(result.current).toEqual({ kind: "error", rateLimited: true });

    stubFetch();
    const h = setup({ query: "wxyz", debounced: "wxyz" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(500, { error: { code: "internal", message: "x" } })));
    await waitFor(() => expect(h.result.current.kind).toBe("error"));
    expect(h.result.current).toEqual({ kind: "error", rateLimited: false });
    await new Promise((r) => setTimeout(r, 1200)); // 預設 retry 的第一次延遲是 1 s
    expect(calls.length).toBe(1);
  });

  it("H6 換人登入：session 快取的 user id 改了、rerender → 重新發請求", async () => {
    const { client, rerender } = setup({ query: "abcd", debounced: "abcd" }, "u1");
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1"]))));
    client.setQueryData<UserDto | null>(SESSION_QUERY_KEY, { id: "u2" } as UserDto);
    rerender({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(2));
  });

  it("H7 stale：防抖中與新請求在路上都回 ready stale（舊批、舊 forQuery、hasMore false），整段不出現 pending", async () => {
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

  it("H8 分頁：hasMore → loadMore 帶 cursor、兩頁串接 → 第二頁 null 後 hasMore false", async () => {
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

  it("H9 去重：第二頁含第一頁已有的 id → 只出現一次、位置在第一頁那裡", async () => {
    const { result } = setup({ query: "abcd", debounced: "abcd" });
    await waitFor(() => expect(calls.length).toBe(1));
    act(() => calls[0]!.resolve(json(200, page(["n1", "n2"], "c1"))));
    await waitFor(() => expect(result.current.kind).toBe("ready"));
    act(() => ready(result.current).loadMore());
    await waitFor(() => expect(calls.length).toBe(2));
    act(() => calls[1]!.resolve(json(200, page(["n3", "n1"], null))));
    await waitFor(() => expect(ready(result.current).hits.map((h) => h.note.id)).toEqual(["n1", "n2", "n3"]));
  });

  it("H10 第二頁 429 → ready、第一頁還在、moreError.rateLimited；再 loadMore 成功 → moreError null", async () => {
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

  it("H11 視窗重新聚焦（資料已過 30 s staleTime）→ 不發新請求", async () => {
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

  it("H12 網路恢復（資料已過 30 s staleTime）→ 不發新請求", async () => {
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
