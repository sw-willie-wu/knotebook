import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type InfiniteData } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { CommentListDto, UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { COMMENT_NOTE, NEWEST_URL, cid, comment, json, page, stubCommentFetch } from "@/test/comment-fixtures";
import {
  applyCommentChange,
  commentListKey,
  commentUnreadKey,
  mergeComment,
  removeComment,
  useCommentList,
  useCommentUnreadCount,
  type CommentPages,
} from "./comments";

const user = (id: string) => ({ id }) as UserDto;
const UNREAD = `/api/notes/${COMMENT_NOTE}/comments/unread-count`;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(SESSION_QUERY_KEY, user("u-alice"));
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  return { queryClient, wrapper };
}

const ids = (data: InfiniteData<CommentListDto, unknown> | undefined) => data?.pages.flatMap((p) => p.comments.map((c) => c.id));

describe("comment cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a live created comment merged while the list refetches is still there once the refetch is done", async () => {
    const { queryClient, wrapper } = setup();
    let listCalls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    stubCommentFetch({
      [UNREAD]: json({ count: 0 }),
      [`/api/comments/${cid(2)}`]: json(comment(2)),
      [NEWEST_URL]: () => {
        listCalls += 1;
        return json(listCalls === 2 ? page([1]) : listCalls === 1 ? page([1]) : page([1, 2]));
      },
    });
    // The second list response is the stale one and arrives late.
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (String(input) === NEWEST_URL && listCalls === 2) await held;
      return res;
    });
    const { result } = renderHook(() => useCommentList(COMMENT_NOTE, null, true), { wrapper });
    await waitFor(() => expect(ids(result.current.data)).toEqual([cid(1)]));
    void queryClient.invalidateQueries({ queryKey: commentListKey(COMMENT_NOTE, "u-alice", null) });
    await waitFor(() => expect(queryClient.isFetching()).toBe(1));
    await applyCommentChange(queryClient, COMMENT_NOTE, "created", cid(2));
    release();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(ids(queryClient.getQueryData<CommentPages>(commentListKey(COMMENT_NOTE, "u-alice", null)))).toEqual([cid(1), cid(2)]);
  });

  it("a live deleted comment removed while the list refetches does not come back", async () => {
    const { queryClient, wrapper } = setup();
    let listCalls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    stubCommentFetch({
      [UNREAD]: json({ count: 0 }),
      [NEWEST_URL]: () => {
        listCalls += 1;
        return json(listCalls >= 3 ? page([1]) : page([1, 2]));
      },
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (String(input) === NEWEST_URL && listCalls === 2) await held;
      return res;
    });
    const { result } = renderHook(() => useCommentList(COMMENT_NOTE, null, true), { wrapper });
    await waitFor(() => expect(ids(result.current.data)).toEqual([cid(1), cid(2)]));
    void queryClient.invalidateQueries({ queryKey: commentListKey(COMMENT_NOTE, "u-alice", null) });
    await waitFor(() => expect(queryClient.isFetching()).toBe(1));
    await applyCommentChange(queryClient, COMMENT_NOTE, "deleted", cid(2));
    release();
    await waitFor(() => expect(queryClient.isFetching()).toBe(0));
    expect(ids(queryClient.getQueryData<CommentPages>(commentListKey(COMMENT_NOTE, "u-alice", null)))).toEqual([cid(1)]);
  });

  it("live changes that arrive during the first load of a thread are in the list once it is loaded", async () => {
    const { queryClient, wrapper } = setup();
    let listCalls = 0;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    stubCommentFetch({
      [UNREAD]: json({ count: 0 }),
      [`/api/comments/${cid(2)}`]: json(comment(2)),
      [`/api/comments/${cid(3)}`]: () => json({ error: { code: "not_found", message: "gone" } }, 404),
      // The first response predates both changes and arrives late.
      [NEWEST_URL]: () => {
        listCalls += 1;
        return json(listCalls === 1 ? page([1, 3]) : page([1, 2]));
      },
    });
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await realFetch(input, init);
      if (String(input) === NEWEST_URL && listCalls === 1) await held;
      return res;
    });
    const { result } = renderHook(() => useCommentList(COMMENT_NOTE, null, true), { wrapper });
    await waitFor(() => expect(queryClient.isFetching()).toBe(1));
    await applyCommentChange(queryClient, COMMENT_NOTE, "created", cid(2));
    await applyCommentChange(queryClient, COMMENT_NOTE, "deleted", cid(3));
    release();
    await waitFor(() => expect(ids(result.current.data)).toEqual([cid(1), cid(2)]));
  });

  it("an older copy of a comment doesn't replace a newer one; a comment deleted live isn't merged back", () => {
    const { queryClient } = setup();
    const key = commentListKey(COMMENT_NOTE, "u-alice", null);
    const newer = comment(1, { body: "v2", editedAt: "2026-01-02T00:00:00.000Z" });
    queryClient.setQueryData<CommentPages>(key, { pages: [{ comments: [newer, comment(2)], olderCursor: null, newerCursor: null }], pageParams: [{ kind: "newest" }] });
    mergeComment(queryClient, comment(1, { body: "v1" }), { append: false });
    mergeComment(queryClient, comment(1, { body: "v1.5", editedAt: "2026-01-01T12:00:00.000Z" }), { append: false });
    expect(queryClient.getQueryData<CommentPages>(key)!.pages[0]!.comments[0]!.body).toBe("v2");
    mergeComment(queryClient, comment(1, { body: "v3", editedAt: "2026-01-03T00:00:00.000Z" }), { append: false });
    expect(queryClient.getQueryData<CommentPages>(key)!.pages[0]!.comments[0]!.body).toBe("v3");

    removeComment(queryClient, COMMENT_NOTE, cid(2));
    mergeComment(queryClient, comment(2), { append: true });
    expect(ids(queryClient.getQueryData<CommentPages>(key))).toEqual([cid(1)]);
  });

  it("another user in the same tab doesn't see the previous user's list or unread count", async () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(commentUnreadKey(COMMENT_NOTE, "u-alice"), { count: 7 });
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, "u-alice", null), {
      pages: [{ comments: [comment(1, { canDelete: true })], olderCursor: null, newerCursor: null }],
      pageParams: [{ kind: "newest" }],
    });
    queryClient.setQueryData(SESSION_QUERY_KEY, user("u-carol"));
    stubCommentFetch({ [UNREAD]: json({ count: 0 }), [NEWEST_URL]: json(page([])) });
    const unread = renderHook(() => useCommentUnreadCount(COMMENT_NOTE, true), { wrapper });
    const list = renderHook(() => useCommentList(COMMENT_NOTE, null, true), { wrapper });
    expect(unread.result.current.data).toBeUndefined();
    expect(list.result.current.data).toBeUndefined();
    await waitFor(() => expect(unread.result.current.data).toEqual({ count: 0 }));
    await waitFor(() => expect(ids(list.result.current.data)).toEqual([]));
  });
});
