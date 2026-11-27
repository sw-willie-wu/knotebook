import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { commentListKey, commentUnreadKey, type CommentPages } from "@/api/comments";
import { stubLayoutTier } from "@/test/layout-tier";
import { COMMENT_NOTE, cid, comment, createLiveSource, json, page, stubCommentFetch } from "@/test/comment-fixtures";
import { NOOP_COMMENTS, parseCommentMessage, useComments, useCommentsController } from "./comments-context";

function setup(opts: { enabled?: boolean; onOpen?: () => void } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const live = createLiveSource();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(
    (props: { noteId: string | null; enabled: boolean }) => useCommentsController({ ...props, provider: live, onOpen: opts.onOpen }),
    { wrapper, initialProps: { noteId: COMMENT_NOTE as string | null, enabled: opts.enabled ?? true } },
  );
  return { ...hook, queryClient, live };
}

const READ = `POST /api/notes/${COMMENT_NOTE}/comments/read`;
const ids = (data: CommentPages | undefined) => data?.pages.flatMap((p) => p.comments.map((c) => c.id));

describe("comments context", () => {
  let tier: ReturnType<typeof stubLayoutTier>;
  beforeEach(() => {
    tier = stubLayoutTier("docked");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("without a provider: the no-op default, nothing throws", () => {
    const { result } = renderHook(() => useComments());
    expect(result.current).toBe(NOOP_COMMENTS);
    expect(() => result.current.open({ commentId: cid(1) })).not.toThrow();
  });

  it("open(): a panel from 640 up, a full-page sheet below; onOpen runs first (the version history closes there); disabled does nothing", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const onOpen = vi.fn();
    const { result, rerender } = setup({ onOpen });
    act(() => result.current.open());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(result.current.mode).toBe("panel");
    expect(result.current.panelOpen).toBe(true);
    act(() => result.current.close());
    act(() => tier.setLayoutTier("phone"));
    act(() => result.current.open());
    expect(result.current.mode).toBe("sheet");
    expect(result.current.panelOpen).toBe(false);
    act(() => result.current.close());
    rerender({ noteId: COMMENT_NOTE, enabled: false });
    act(() => result.current.open());
    expect(result.current.mode).toBeNull();
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("open({commentId, draftAnchor}) sets the target (lowercased) and the passage; clearDraftAnchor() drops the passage, close() the target; a new open of the same comment bumps targetSeq", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const { result } = setup();
    act(() => result.current.open({ commentId: cid(7).toUpperCase(), draftAnchor: { blockId: "b1", quote: "hello" } }));
    expect(result.current.target).toBe(cid(7));
    expect(result.current.draftAnchor).toEqual({ blockId: "b1", quote: "hello" });
    const seq = result.current.targetSeq;
    act(() => result.current.open({ commentId: cid(7) }));
    expect(result.current.targetSeq).toBe(seq + 1);
    act(() => result.current.clearDraftAnchor());
    expect(result.current.draftAnchor).toBeNull();
    act(() => result.current.close());
    expect(result.current.target).toBeNull();
    expect(result.current.mode).toBeNull();
  });

  it("opening marks the note read and sets the unread count to 0", async () => {
    const calls = stubCommentFetch({ [READ]: json(null, 204) });
    const { result, queryClient } = setup();
    queryClient.setQueryData(commentUnreadKey(COMMENT_NOTE, null), { count: 4 });
    act(() => result.current.open());
    await waitFor(() => expect(queryClient.getQueryData(commentUnreadKey(COMMENT_NOTE, null))).toEqual({ count: 0 }));
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("live: created appends to a range that reaches the newest comment, edited replaces in place, deleted removes and marks replies as answering a deleted comment", async () => {
    const edited = comment(2, { body: "changed", editedAt: "2026-01-02T00:00:00.000Z" });
    stubCommentFetch({
      [`/api/comments/${cid(3)}`]: json(comment(3)),
      [`/api/comments/${cid(2)}`]: json(edited),
      [`/api/notes/${COMMENT_NOTE}/comments/unread-count`]: json({ count: 1 }),
    });
    const { queryClient, live } = setup();
    const reply = comment(4, { replyToId: cid(1), replyTo: { id: cid(1), authorHandle: "bob", excerpt: "comment 1" } });
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, null), {
      pages: [{ comments: [comment(1), comment(2), reply], olderCursor: null, newerCursor: null }],
      pageParams: [{ kind: "newest" }],
    });
    const list = () => queryClient.getQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, null));

    act(() => live.stateless("created", cid(3)));
    await waitFor(() => expect(ids(list())).toEqual([cid(1), cid(2), cid(3), cid(4)]));

    act(() => live.stateless("edited", cid(2)));
    await waitFor(() => expect(list()?.pages[0]!.comments[1]!.body).toBe("changed"));

    act(() => live.stateless("deleted", cid(1)));
    await waitFor(() => expect(ids(list())).toEqual([cid(2), cid(3), cid(4)]));
    const orphan = list()!.pages[0]!.comments.find((c) => c.id === cid(4))!;
    expect(orphan.replyToId).toBe(cid(1));
    expect(orphan.replyTo).toBeNull();
  });

  it("live: with no thread loaded only the unread count is refetched; malformed messages are ignored", async () => {
    const calls = stubCommentFetch({ [`/api/notes/${COMMENT_NOTE}/comments/unread-count`]: json({ count: 2 }) });
    const { live } = setup();
    act(() => {
      live.emit("stateless", { payload: "not json" });
      live.emit("stateless", { payload: JSON.stringify({ type: "other", op: "created", commentId: cid(1) }) });
      live.stateless("created", cid(9));
    });
    await Promise.resolve();
    expect(calls.some((c) => c.url.startsWith("/api/comments/"))).toBe(false);
    expect(parseCommentMessage(JSON.stringify({ type: "comment", op: "renamed", commentId: "x" }))).toBeNull();
    expect(parseCommentMessage(JSON.stringify({ type: "comment", op: "deleted", commentId: "x" }))).toEqual({ op: "deleted", commentId: "x" });
    expect(parseCommentMessage(JSON.stringify({ type: "comment", op: "cleared", commentId: "" }))).toEqual({ op: "cleared", commentId: "" });
  });

  it("live: while opened at a comment whose window doesn't reach the newest, a created comment only raises newCommentsPending; showNewest() clears target and flag", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [`/api/comments/${cid(60)}`]: json(comment(60)),
      [`/api/notes/${COMMENT_NOTE}/comments/unread-count`]: json({ count: 0 }),
    });
    const { result, queryClient, live } = setup();
    act(() => result.current.open({ commentId: cid(5) }));
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, cid(5)), {
      pages: [page([4, 5, 6], "older", "newer")],
      pageParams: [{ kind: "around", commentId: cid(5) }],
    });
    act(() => live.stateless("created", cid(60)));
    await waitFor(() => expect(result.current.newCommentsPending).toBe(true));
    expect(ids(queryClient.getQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, cid(5))))).toEqual([cid(4), cid(5), cid(6)]);
    act(() => result.current.showNewest());
    expect(result.current.target).toBeNull();
    expect(result.current.newCommentsPending).toBe(false);
  });

  it("synced: invalidates the loaded threads and refetches the unread count (closed); while open it marks read again", async () => {
    let unread = 3;
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [`/api/notes/${COMMENT_NOTE}/comments/unread-count`]: () => json({ count: unread }),
    });
    const { result, queryClient, live } = setup();
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, null), { pages: [page([1])], pageParams: [{ kind: "newest" }] });
    act(() => live.emit("synced"));
    expect(queryClient.getQueryState(commentListKey(COMMENT_NOTE, null, null))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(commentUnreadKey(COMMENT_NOTE, null))).toBeUndefined();
    act(() => result.current.open());
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    unread = 0;
    act(() => live.emit("synced"));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
  });

  it("cleared: invalidates every loaded list and the unread count without fetching a comment", async () => {
    const calls = stubCommentFetch({});
    const { queryClient, live } = setup();
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, null), { pages: [page([1])], pageParams: [{ kind: "newest" }] });
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, cid(1)), { pages: [page([1])], pageParams: [{ kind: "around", commentId: cid(1) }] });
    queryClient.setQueryData(commentUnreadKey(COMMENT_NOTE, null), { count: 4 });
    act(() => live.stateless("cleared", ""));
    expect(queryClient.getQueryState(commentListKey(COMMENT_NOTE, null, null))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(commentListKey(COMMENT_NOTE, null, cid(1)))?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(commentUnreadKey(COMMENT_NOTE, null))?.isInvalidated).toBe(true);
    expect(calls.some((c) => c.url.startsWith("/api/comments/"))).toBe(false);
  });

  it("a created comment while the thread is open marks it read again (debounced)", async () => {
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [`/api/comments/${cid(2)}`]: json(comment(2)),
      [`/api/notes/${COMMENT_NOTE}/comments/unread-count`]: json({ count: 1 }),
    });
    const { result, queryClient, live } = setup();
    queryClient.setQueryData<CommentPages>(commentListKey(COMMENT_NOTE, null, null), { pages: [page([1])], pageParams: [{ kind: "newest" }] });
    act(() => result.current.open());
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(1));
    act(() => live.stateless("created", cid(2)));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2), { timeout: 3000 });
  });

  it("unsubscribes when the note changes or comments turn off; the sheet closes on a note change, the panel stays", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const { result, rerender, live } = setup();
    expect(live.count("stateless")).toBe(1);
    act(() => result.current.open());
    rerender({ noteId: null, enabled: false });
    expect(live.count("stateless")).toBe(0);
    rerender({ noteId: COMMENT_NOTE, enabled: true });
    expect(result.current.panelOpen).toBe(true);
    rerender({ noteId: COMMENT_NOTE, enabled: false });
    expect(result.current.mode).toBeNull();
  });

  it("the unsent comment and its passage outlive close() and a note change, per note; saving an empty draft forgets it; losing access drops both", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const reply = comment(3);
    const { result, rerender } = setup();
    expect(result.current.readDraft()).toEqual({ text: "", replyTo: null });
    act(() => result.current.open({ draftAnchor: { blockId: "b1", quote: "hello" } }));
    act(() => result.current.saveDraft({ text: "half a thought" }));
    act(() => result.current.saveDraft({ replyTo: reply }));
    act(() => result.current.close());
    expect(result.current.draftAnchor).toEqual({ blockId: "b1", quote: "hello" });
    expect(result.current.readDraft()).toEqual({ text: "half a thought", replyTo: reply });

    rerender({ noteId: null, enabled: true });
    rerender({ noteId: OTHER, enabled: true });
    expect(result.current.draftAnchor).toBeNull();
    expect(result.current.readDraft()).toEqual({ text: "", replyTo: null });
    act(() => result.current.saveDraft({ text: "on the other note" }));

    rerender({ noteId: COMMENT_NOTE, enabled: true });
    expect(result.current.draftAnchor).toEqual({ blockId: "b1", quote: "hello" });
    expect(result.current.readDraft().text).toBe("half a thought");
    act(() => result.current.saveDraft({ text: "", replyTo: null }));
    expect(result.current.readDraft()).toEqual({ text: "", replyTo: null });

    rerender({ noteId: OTHER, enabled: true });
    expect(result.current.readDraft().text).toBe("on the other note");
    rerender({ noteId: OTHER, enabled: false });
    rerender({ noteId: OTHER, enabled: true });
    expect(result.current.readDraft().text).toBe("");
    rerender({ noteId: COMMENT_NOTE, enabled: false });
    rerender({ noteId: COMMENT_NOTE, enabled: true });
    expect(result.current.draftAnchor).toBeNull();
  });

  it("takeDraft() empties the note's draft when a post starts; settleSentDraft() puts a failed one back only into an empty store, and gives text written meanwhile the sent reply and passage", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const OTHER = "22222222-2222-4222-8222-222222222222";
    const anchor = { blockId: "b1", quote: "hello" };
    const reply = comment(3);
    const sent = { noteId: COMMENT_NOTE, text: "sent", replyTo: reply, anchor };
    const { result, rerender } = setup();
    act(() => result.current.open({ draftAnchor: anchor }));
    act(() => result.current.saveDraft({ text: "sent", replyTo: reply }));
    act(() => result.current.takeDraft(COMMENT_NOTE));
    expect(result.current.readDraft()).toEqual({ text: "", replyTo: null });
    expect(result.current.draftAnchor).toBeNull();

    // Settled after a note change: the note it names is the one changed.
    rerender({ noteId: OTHER, enabled: true });
    act(() => result.current.settleSentDraft(sent, false));
    rerender({ noteId: COMMENT_NOTE, enabled: true });
    expect(result.current.readDraft()).toEqual({ text: "sent", replyTo: reply });
    expect(result.current.draftAnchor).toBe(anchor);

    act(() => result.current.takeDraft(COMMENT_NOTE));
    act(() => result.current.settleSentDraft(sent, true));
    expect(result.current.readDraft()).toEqual({ text: "", replyTo: null });
    expect(result.current.draftAnchor).toBeNull();

    act(() => result.current.takeDraft(COMMENT_NOTE));
    act(() => result.current.saveDraft({ text: "written meanwhile" }));
    act(() => result.current.settleSentDraft(sent, false));
    expect(result.current.readDraft()).toEqual({ text: "written meanwhile", replyTo: reply });
    expect(result.current.draftAnchor).toBe(anchor);
  });

  it("takeAnchorFocus(): true once after open({draftAnchor}), not for a plain open", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const { result } = setup();
    act(() => result.current.open());
    expect(result.current.takeAnchorFocus()).toBe(false);
    act(() => result.current.open({ draftAnchor: { blockId: "b1", quote: "" } }));
    expect(result.current.takeAnchorFocus()).toBe(true);
    expect(result.current.takeAnchorFocus()).toBe(false);
  });

  it("reportTargetMissing(): back to the newest page with the notice; the next open at a comment clears it", () => {
    stubCommentFetch({ [READ]: json(null, 204) });
    const { result } = setup();
    act(() => result.current.open({ commentId: cid(1) }));
    act(() => result.current.reportTargetMissing());
    expect(result.current.target).toBeNull();
    expect(result.current.targetMissing).toBe(true);
    act(() => result.current.open({ commentId: cid(2) }));
    expect(result.current.targetMissing).toBe(false);
  });
});
