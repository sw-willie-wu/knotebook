import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import i18n from "@/i18n";
import { BlockAnchorContext, type BlockAnchorApi } from "@/hooks/block-anchor-context";
import { CommentsProvider, useComments, useCommentsController } from "@/lib/comments-context";
import { stubLayoutTier } from "@/test/layout-tier";
import {
  COMMENT_NOTE,
  NEWEST_URL,
  cid,
  comment,
  createLiveSource,
  json,
  listUrl,
  notFound,
  page,
  stubCommentFetch,
} from "@/test/comment-fixtures";
import { CommentsPanel } from "./CommentsPanel";

const READ = `POST /api/notes/${COMMENT_NOTE}/comments/read`;
const UNREAD = `/api/notes/${COMMENT_NOTE}/comments/unread-count`;

function docWithBlocks(...ids: string[]): Y.Doc {
  const doc = new Y.Doc();
  const group = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [group]);
  group.insert(
    0,
    ids.map((id) => {
      const el = new Y.XmlElement("blockContainer");
      el.setAttribute("id", id);
      return el;
    }),
  );
  return doc;
}

function Controls() {
  const c = useComments();
  return (
    <div>
      <button type="button" onClick={() => c.open()}>host-open</button>
      <button type="button" onClick={() => c.open({ commentId: cid(5) })}>host-open-at-5</button>
      <button type="button" onClick={() => c.open({ draftAnchor: { blockId: "b1", quote: "the passage" } })}>host-open-passage</button>
      <span data-testid="target">{String(c.target)}</span>
    </div>
  );
}

function Host({ doc, live }: { doc: Y.Doc; live: ReturnType<typeof createLiveSource> }) {
  const value = useCommentsController({ noteId: COMMENT_NOTE, enabled: true, provider: live });
  // NoteEditor (and with it the open panel) remounts on every note switch.
  const [gen, setGen] = useState(0);
  return (
    <CommentsProvider value={value}>
      <Controls />
      <button type="button" onClick={() => setGen((n) => n + 1)}>host-remount</button>
      {value.panelOpen && <CommentsPanel key={gen} doc={doc} width={320} onWidthChange={() => {}} />}
    </CommentsProvider>
  );
}

function renderPanel({ doc = docWithBlocks("b1"), open = "host-open" }: { doc?: Y.Doc; open?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const live = createLiveSource();
  const anchor: BlockAnchorApi = { currentNoteId: COMMENT_NOTE, requestAnchor: vi.fn(), scrollToTop: vi.fn() };
  render(
    <QueryClientProvider client={queryClient}>
      <BlockAnchorContext.Provider value={anchor}>
        <Host doc={doc} live={live} />
      </BlockAnchorContext.Provider>
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByText(open));
  return { queryClient, live, anchor, doc };
}

const rows = () => screen.getAllByTestId("comment");
const bodies = () => rows().map((r) => r.querySelector("p.whitespace-pre-wrap")?.textContent);

describe("CommentsPanel", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubLayoutTier("docked");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the version panel's slot classes, width handle and the lazy strings; close() closes it", async () => {
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json(page([])) });
    renderPanel();
    const panel = await screen.findByTestId("comments-panel");
    expect(panel).toHaveAttribute("aria-label", "Comments");
    expect(panel).toHaveClass("absolute", "right-0", "bottom-[var(--corner-stack-clearance,0px)]", "z-20", "xl:relative", "xl:w-[var(--versions-panel-width)]");
    expect(within(panel).getByRole("separator", { name: "Resize comments panel" })).toHaveAttribute("aria-valuenow", "320");
    expect(await screen.findByText("No comments yet.")).toBeInTheDocument();
    // The bubble that opened it is gone, so focus goes to the composer.
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" }));
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByTestId("comments-panel")).not.toBeInTheDocument();
  });

  it("renders a comment: agent author as handle (label), edited mark, quote chip that scrolls the note, reply summary, mention chips only from `mentions`, actions by permission", async () => {
    const agentReply = comment(2, {
      authorHandle: "alice",
      authorDisplayName: "Alice",
      agentLabel: "claude",
      editedAt: "2026-01-02T00:00:00.000Z",
      anchor: { blockId: "b1", quote: "the passage" },
      replyToId: cid(1),
      replyTo: { id: cid(1), authorHandle: "bob", excerpt: "comment 1" },
      // "@carol" is typed text with no mention row: it must stay plain text.
      body: "ask @bob and @carol",
      mentions: [{ start: 4, length: 4, userId: "u-bob", handle: "bob", displayName: "Bob Chen", avatar: null, agentLabel: null }],
      canEdit: true,
      canDelete: true,
    });
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json({ comments: [comment(1), agentReply], olderCursor: null, newerCursor: null }) });
    const { anchor } = renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(2));
    const row = rows()[1]!;
    expect(within(row).getByTestId("comment-author")).toHaveTextContent("alice (claude)");
    expect(within(row).getByTestId("comment-edited")).toHaveTextContent("(edited)");
    const chips = within(row).getAllByTestId("mention-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("@Bob Chen");
    expect(chips[0]).toHaveAttribute("title", "@bob");
    expect(row.querySelector("p.whitespace-pre-wrap")).toHaveTextContent("ask @Bob Chen and @carol");
    fireEvent.click(within(row).getByTestId("comment-quote"));
    expect(anchor.requestAnchor).toHaveBeenCalledWith("b1");
    expect(within(row).getByTestId("comment-reply-summary")).toHaveTextContent("@bobcomment 1");
    expect(within(row).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(within(row).getByRole("button", { name: "Delete" })).toBeInTheDocument();
    const plain = rows()[0]!;
    expect(within(plain).getByRole("button", { name: "Reply" })).toBeInTheDocument();
    expect(within(plain).queryByRole("button", { name: "Edit" })).toBeNull();
    expect(within(plain).queryByRole("button", { name: "Delete" })).toBeNull();
    expect(within(plain).queryByTestId("comment-edited")).toBeNull();
  });

  it("a reply whose comment was deleted says so; a quote whose block is gone shows Passage deleted and is not clickable", async () => {
    const orphan = comment(3, { replyToId: cid(1), replyTo: null, anchor: { blockId: "gone", quote: "old text" } });
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json({ comments: [orphan], olderCursor: null, newerCursor: null }) });
    const { anchor } = renderPanel();
    expect(await screen.findByTestId("comment-reply-deleted")).toHaveTextContent("The comment it answered was deleted.");
    const quote = screen.getByTestId("comment-quote");
    expect(quote.tagName).toBe("P");
    expect(quote).toHaveTextContent("Passage deleted");
    fireEvent.click(quote);
    expect(anchor.requestAnchor).not.toHaveBeenCalled();
  });

  it("before the document has any block (not synced yet) a quote stays clickable instead of showing Passage deleted", async () => {
    const doc = new Y.Doc();
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json({ comments: [comment(1, { anchor: { blockId: "b1", quote: "q" } })], olderCursor: null, newerCursor: null }) });
    const { anchor } = renderPanel({ doc });
    const quote = await screen.findByTestId("comment-quote");
    expect(quote.tagName).toBe("BUTTON");
    expect(quote).not.toHaveAttribute("data-passage-deleted");
    fireEvent.click(quote);
    expect(anchor.requestAnchor).toHaveBeenCalledWith("b1");
  });

  it("the passage state follows the live document", async () => {
    const doc = docWithBlocks("b1");
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json({ comments: [comment(1, { anchor: { blockId: "b2", quote: "q" } })], olderCursor: null, newerCursor: null }) });
    renderPanel({ doc });
    await waitFor(() => expect(screen.getByTestId("comment-quote")).toHaveAttribute("data-passage-deleted"));
    vi.useFakeTimers();
    try {
      act(() => {
        const el = new Y.XmlElement("blockContainer");
        el.setAttribute("id", "b2");
        (doc.getXmlFragment(YDOC_FRAGMENT).get(0) as Y.XmlElement).insert(1, [el]);
      });
      act(() => vi.advanceTimersByTime(400));
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByTestId("comment-quote").tagName).toBe("BUTTON");
  });

  it("older pages load on scrolling up (and with the button), prepended in order", async () => {
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([3, 4], "c-old", null)),
      [listUrl("before=c-old&limit=50")]: json(page([1, 2], null, "c-mid")),
    });
    renderPanel();
    await waitFor(() => expect(bodies()).toEqual(["comment 3", "comment 4"]));
    const scroller = screen.getByTestId("comments-scroll");
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);
    await waitFor(() => expect(bodies()).toEqual(["comment 1", "comment 2", "comment 3", "comment 4"]));
    expect(calls.filter((c) => c.url.includes("before=")).length).toBe(1);
    expect(screen.queryByRole("button", { name: "Load older comments" })).toBeNull();
  });

  it("opened at a comment: loads the window around it, a live created comment shows New comments, which jumps to the newest page", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [UNREAD]: json({ count: 0 }),
      [listUrl(`around=${cid(5)}&limit=50`)]: json(page([4, 5, 6], "c4", "c6")),
      [`/api/comments/${cid(90)}`]: json(comment(90)),
      [NEWEST_URL]: json(page([89, 90], "c89", null)),
    });
    const { live } = renderPanel({ open: "host-open-at-5" });
    await waitFor(() => expect(bodies()).toEqual(["comment 4", "comment 5", "comment 6"]));
    expect(rows()[1]).toHaveClass("bg-brand-soft");
    expect(screen.getByRole("button", { name: "Load newer comments" })).toBeInTheDocument();
    expect(screen.queryByTestId("comments-new")).toBeNull();
    act(() => live.stateless("created", cid(90)));
    const jump = await screen.findByRole("button", { name: "New comments" });
    expect(bodies()).toEqual(["comment 4", "comment 5", "comment 6"]);
    fireEvent.click(jump);
    await waitFor(() => expect(bodies()).toEqual(["comment 89", "comment 90"]));
    expect(screen.getByTestId("target")).toHaveTextContent("null");
  });

  it("opened at a comment that was deleted: says so and shows the newest page", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [listUrl(`around=${cid(5)}&limit=50`)]: notFound("comment_not_found"),
      [NEWEST_URL]: json(page([1])),
    });
    renderPanel({ open: "host-open-at-5" });
    expect(await screen.findByTestId("comments-target-missing")).toHaveTextContent("That comment was deleted.");
    await waitFor(() => expect(bodies()).toEqual(["comment 1"]));
  });

  it("a remount while open (note switch) leaves focus where it was", async () => {
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json(page([1])) });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    const elsewhere = screen.getByText("host-open-at-5");
    elsewhere.focus();
    fireEvent.click(screen.getByText("host-remount"));
    await screen.findByTestId("comments-panel");
    expect(document.activeElement).toBe(elsewhere);
  });

  it("starting and cancelling an edit keeps a reply in progress", async () => {
    const mine = comment(2, { canEdit: true, body: "mine" });
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [comment(1), mine], olderCursor: null, newerCursor: null }),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(comment(3, { replyToId: cid(1), replyTo: { id: cid(1), authorHandle: "bob", excerpt: "comment 1" } }), 201),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "an answer" } });
    fireEvent.click(within(rows()[1]!).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))!.body!)).toEqual({ body: "an answer", replyToId: cid(1) });
  });

  it("opened at a comment on a note that can no longer be read: the normal error state, not \"That comment was deleted\"", async () => {
    stubCommentFetch({ [READ]: json(null, 204), [listUrl(`around=${cid(5)}&limit=50`)]: notFound("not_found") });
    renderPanel({ open: "host-open-at-5" });
    expect(await screen.findByText("Comments couldn't be loaded.")).toBeInTheDocument();
    expect(screen.queryByTestId("comments-target-missing")).toBeNull();
    expect(screen.getByTestId("target")).toHaveTextContent(cid(5));
  });

  it("a half-written new comment survives starting and ending an edit", async () => {
    const mine = comment(1, { canEdit: true, body: "first" });
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [mine], olderCursor: null, newerCursor: null }),
      [`PATCH /api/comments/${cid(1)}`]: json({ ...mine, body: "first!", editedAt: "2026-01-03T00:00:00.000Z" }),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "half written" } });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("first");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("half written");
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "first!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies()[0]).toBe("first!"));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("half written");
  });

  it("pressing Edit while a new comment is still being sent keeps the edit open", async () => {
    const mine = comment(1, { canEdit: true, body: "first" });
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [mine], olderCursor: null, newerCursor: null }),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(comment(2), 201),
    });
    const base = globalThis.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" && String(input).endsWith("/comments") ? gate.then(() => base(input, init)) : base(input, init)));
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "sending" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Enter", ctrlKey: true });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "first, edited" } });
    await act(async () => release());
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByText("Editing your comment")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("first, edited");
  });

  it("Reply while an edit has unsaved changes keeps the text; the reply composer opens when the edit ends", async () => {
    const mine = comment(1, { canEdit: true, body: "first" });
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [comment(2), mine], olderCursor: null, newerCursor: null }),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(within(rows()[1]!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "first, changed" } });
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("first, changed");
    expect(screen.getByText("Editing your comment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" }));
  });

  it("Reply while an edit is unchanged ends the edit and opens the reply", async () => {
    const mine = comment(1, { canEdit: true, body: "first" });
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [comment(2), mine], olderCursor: null, newerCursor: null }),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(2));
    fireEvent.click(within(rows()[1]!).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    expect(screen.queryByText("Editing your comment")).toBeNull();
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
  });

  it("when an edit ends, focus goes back to that comment's Edit button, or to the composer when a reply is waiting", async () => {
    const mine = comment(1, { canEdit: true, body: "first" });
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [mine], olderCursor: null, newerCursor: null }),
      [`PATCH /api/comments/${cid(1)}`]: json({ ...mine, body: "first!" }),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(within(rows()[0]!).getByRole("button", { name: "Edit" })));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "first!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("Editing your comment")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(within(rows()[0]!).getByRole("button", { name: "Edit" })));
  });

  it("composer: posts the body with the passage; the new comment is shown and the passage chip goes away", async () => {
    const created = comment(2, { authorHandle: "alice", authorDisplayName: "Alice", anchor: { blockId: "b1", quote: "the passage" }, body: "my note" });
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([1])),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(created, 201),
    });
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(bodies()).toEqual(["comment 1"]));
    expect(screen.getByTestId("composer-anchor")).toHaveTextContent("the passage");
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "my note" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(bodies()).toEqual(["comment 1", "my note"]));
    const post = calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))!;
    expect(JSON.parse(post.body!)).toEqual({ body: "my note", anchor: { blockId: "b1", quote: "the passage" } });
    expect(screen.queryByTestId("composer-anchor")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
  });

  it("an unsent comment, its reply target and its passage survive closing and reopening; sending clears them for the next opening", async () => {
    const created = comment(2, { authorHandle: "alice", authorDisplayName: "Alice", anchor: { blockId: "b1", quote: "the passage" }, replyToId: cid(1), body: "kept text" });
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([1])),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(created, 201),
    });
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "kept text" } });
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByTestId("comments-panel")).toBeNull();

    fireEvent.click(screen.getByText("host-open"));
    await screen.findByTestId("comments-panel");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("kept text");
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    expect(screen.getByTestId("composer-anchor")).toHaveTextContent("the passage");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue(""));
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))!.body!)).toEqual({
      body: "kept text",
      replyToId: cid(1),
      anchor: { blockId: "b1", quote: "the passage" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    fireEvent.click(screen.getByText("host-open"));
    await screen.findByTestId("comments-panel");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
    expect(screen.queryByText("Replying to Bob")).toBeNull();
    expect(screen.queryByTestId("composer-anchor")).toBeNull();
  });

  function gatePost() {
    const base = globalThis.fetch;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => (init?.method === "POST" && String(input).endsWith("/comments") ? gate.then(() => base(input, init)) : base(input, init)));
    return () => act(async () => release());
  }

  it("a comment sent just before the panel closes is not kept as a draft: reopening shows an empty composer without the passage or the reply", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([1])),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(comment(2, { body: "sent once" }), 201),
    });
    const release = gatePost();
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "sent once" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    expect(screen.queryByTestId("comments-panel")).toBeNull();
    await release();

    fireEvent.click(screen.getByText("host-open"));
    await screen.findByTestId("comments-panel");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("");
    expect(screen.queryByTestId("composer-anchor")).toBeNull();
    expect(screen.queryByText("Replying to Bob")).toBeNull();
  });

  it("reopened while the comment is still on its way: the composer is empty, and the comment is posted once", async () => {
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([1])),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(comment(2, { body: "sent once" }), 201),
    });
    const release = gatePost();
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "sent once" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    fireEvent.click(screen.getByText("host-open"));
    await screen.findByTestId("comments-panel");
    const box = screen.getByRole("textbox", { name: "Comment" });
    expect(box).toHaveValue("");
    expect(screen.queryByTestId("composer-anchor")).toBeNull();
    expect(screen.queryByText("Replying to Bob")).toBeNull();
    await release();
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(box).toHaveValue("");
    expect(calls.filter((c) => c.method === "POST" && c.url.endsWith("/comments"))).toHaveLength(1);
  });

  it("a post that fails after the panel closed comes back as the draft, with its reply and passage", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([1])),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json({ error: { code: "rate_limited", message: "Slow down" } }, 429),
    });
    const release = gatePost();
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "try again" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await release();
    fireEvent.click(screen.getByText("host-open"));
    await screen.findByTestId("comments-panel");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("try again");
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    expect(screen.getByTestId("composer-anchor")).toHaveTextContent("the passage");
  });

  it.each([
    ["stays open", false],
    ["is closed before the answer", true],
  ])("text typed while a comment is on its way stays with the reply and passage, whether the panel %s", async (_name, closeEarly) => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json(page([1])),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(comment(2, { body: "first part" }), 201),
    });
    const release = gatePost();
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    const box = screen.getByRole("textbox", { name: "Comment" });
    fireEvent.change(box, { target: { value: "first part" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(box, { target: { value: "second thought" } });
    if (closeEarly) fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    await release();
    if (closeEarly) {
      fireEvent.click(screen.getByText("host-open"));
      await screen.findByTestId("comments-panel");
    }
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("second thought");
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("composer-anchor")).toHaveTextContent("the passage"));

    fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
    fireEvent.click(screen.getByText("host-open"));
    await screen.findByTestId("comments-panel");
    expect(screen.getByRole("textbox", { name: "Comment" })).toHaveValue("second thought");
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    expect(screen.getByTestId("composer-anchor")).toHaveTextContent("the passage");
  });

  it("a passage or reply restored when the thread remounts (note switch) doesn't take the focus; a passage picked again does", async () => {
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json(page([1])) });
    renderPanel({ open: "host-open-passage" });
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Comment" })).toHaveFocus());
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    const elsewhere = screen.getByText("host-open-at-5");
    elsewhere.focus();
    fireEvent.click(screen.getByText("host-remount"));
    await screen.findByTestId("comments-panel");
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    expect(screen.getByTestId("composer-anchor")).toBeInTheDocument();
    expect(document.activeElement).toBe(elsewhere);
    fireEvent.click(screen.getByText("host-open-passage"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Comment" })).toHaveFocus());
  });

  it("reply, edit and delete", async () => {
    const mine = comment(1, { canEdit: true, canDelete: true, body: "first" });
    const calls = stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [mine], olderCursor: null, newerCursor: null }),
      [`POST /api/notes/${COMMENT_NOTE}/comments`]: json(comment(2, { replyToId: cid(1), replyTo: { id: cid(1), authorHandle: "bob", excerpt: "first" } }), 201),
      [`PATCH /api/comments/${cid(1)}`]: json({ ...mine, body: "first, fixed", editedAt: "2026-01-03T00:00:00.000Z" }),
      [`DELETE /api/comments/${cid(1)}`]: json(null, 204),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(1));
    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Reply" }));
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "an answer" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Comment" }), { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(JSON.parse(calls.find((c) => c.method === "POST" && c.url.endsWith("/comments"))!.body!)).toEqual({ body: "an answer", replyToId: cid(1) });
    expect(screen.queryByText("Replying to Bob")).toBeNull();

    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Edit" }));
    const box = screen.getByRole("textbox", { name: "Comment" });
    expect(box).toHaveValue("first");
    fireEvent.change(box, { target: { value: "first, fixed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies()[0]).toBe("first, fixed"));
    expect(within(rows()[0]!).getByTestId("comment-edited")).toBeInTheDocument();

    fireEvent.click(within(rows()[0]!).getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this comment?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(within(rows()[0]!).getByTestId("comment-reply-deleted")).toBeInTheDocument();
  });

  it("after a confirmed delete focus goes to the next comment's first action, the previous one's for the last, the composer when none is left", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [NEWEST_URL]: json({ comments: [comment(1, { canDelete: true }), comment(2, { canDelete: true }), comment(3, { canDelete: true })], olderCursor: null, newerCursor: null }),
      [`DELETE /api/comments/${cid(1)}`]: json(null, 204),
      [`DELETE /api/comments/${cid(3)}`]: json(null, 204),
      [`DELETE /api/comments/${cid(2)}`]: json(null, 204),
    });
    renderPanel();
    await waitFor(() => expect(rows()).toHaveLength(3));
    const del = async (row: HTMLElement) => {
      fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
      const dialog = await screen.findByRole("dialog", { name: "Delete this comment?" });
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    };
    await del(rows()[0]!);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await waitFor(() => expect(document.activeElement).toBe(within(rows()[0]!).getByRole("button", { name: "Reply" })));
    await del(rows()[1]!);
    await waitFor(() => expect(rows()).toHaveLength(1));
    await waitFor(() => expect(document.activeElement).toBe(within(rows()[0]!).getByRole("button", { name: "Reply" })));
    await del(rows()[0]!);
    await waitFor(() => expect(screen.queryAllByTestId("comment")).toHaveLength(0));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Comment" })));
  });

  it("closing with ✕ gives the focus to the bubble when one is there", async () => {
    stubCommentFetch({ [READ]: json(null, 204), [NEWEST_URL]: json(page([])) });
    renderPanel();
    await screen.findByText("No comments yet.");
    const bubble = document.createElement("button");
    bubble.setAttribute("data-testid", "comments-bubble");
    document.body.appendChild(bubble);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Close comments" }));
      await waitFor(() => expect(document.activeElement).toBe(bubble));
    } finally {
      bubble.remove();
    }
  });

  it("live edited and deleted update the loaded comments in place", async () => {
    stubCommentFetch({
      [READ]: json(null, 204),
      [UNREAD]: json({ count: 0 }),
      [NEWEST_URL]: json(page([1, 2])),
      [`/api/comments/${cid(2)}`]: json(comment(2, { body: "edited text", editedAt: "2026-01-05T00:00:00.000Z" })),
    });
    const { live } = renderPanel();
    await waitFor(() => expect(bodies()).toEqual(["comment 1", "comment 2"]));
    act(() => live.stateless("edited", cid(2)));
    await waitFor(() => expect(bodies()).toEqual(["comment 1", "edited text"]));
    act(() => live.stateless("deleted", cid(1)));
    await waitFor(() => expect(bodies()).toEqual(["edited text"]));
  });

  it("synced refetches the thread", async () => {
    let n = 1;
    stubCommentFetch({ [READ]: json(null, 204), [UNREAD]: json({ count: 0 }), [NEWEST_URL]: () => json(page(Array.from({ length: n }, (_, i) => i + 1))) });
    const { live } = renderPanel();
    await waitFor(() => expect(bodies()).toEqual(["comment 1"]));
    n = 2;
    act(() => live.emit("synced"));
    await waitFor(() => expect(bodies()).toEqual(["comment 1", "comment 2"]));
  });
});
