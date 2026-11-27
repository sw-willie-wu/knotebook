import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MentionCandidateDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { COMMENT_NOTE, cid, comment, json, stubCommentFetch } from "@/test/comment-fixtures";
import { CommentComposer, type CommentComposerProps } from "./CommentComposer";
import { mentionTokenAt } from "./mention-token";

const cand = (handle: string, over: Partial<MentionCandidateDto> = {}): MentionCandidateDto => ({
  userId: `u-${handle}`,
  handle,
  displayName: handle[0]!.toUpperCase() + handle.slice(1),
  avatar: null,
  agentLabels: [],
  ...over,
});
const candidatesUrl = (q: string) => `/api/notes/${COMMENT_NOTE}/mention-candidates?q=${encodeURIComponent(q)}`;
const POST = `POST /api/notes/${COMMENT_NOTE}/comments`;

function setup(props: Partial<CommentComposerProps> = {}) {
  const onDone = vi.fn();
  const onClearAnchor = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const all: CommentComposerProps = { noteId: COMMENT_NOTE, draftAnchor: null, onClearAnchor, replyTo: null, editing: null, onDone, ...props };
  render(
    <QueryClientProvider client={queryClient}>
      <CommentComposer {...all} />
    </QueryClientProvider>,
  );
  return { onDone, onClearAnchor, box: screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement };
}

const type = (box: HTMLTextAreaElement, value: string) => fireEvent.change(box, { target: { value } });
const options = () => screen.queryAllByRole("option").map((o) => o.textContent);

describe("mentionTokenAt", () => {
  it("finds the token that ends at the caret, also after Chinese text", () => {
    expect(mentionTokenAt("請@bob", 5)).toEqual({ start: 1, end: 5, handle: "bob", label: null });
    expect(mentionTokenAt("hi @", 4)).toEqual({ start: 3, end: 4, handle: "", label: null });
    expect(mentionTokenAt("@Alice/cl", 9)).toEqual({ start: 0, end: 9, handle: "alice", label: "cl" });
    expect(mentionTokenAt("@alice/", 7)).toEqual({ start: 0, end: 7, handle: "alice", label: "" });
  });
  it("is null for an email address, a finished word and a caret elsewhere", () => {
    expect(mentionTokenAt("a@b.com", 7)).toBeNull();
    expect(mentionTokenAt("@bob ", 5)).toBeNull();
    expect(mentionTokenAt("@bob hi", 3)).not.toBeNull();
    expect(mentionTokenAt("@bob hi", 7)).toBeNull();
  });
  it("counts the caret in UTF-16 units after an astral character", () => {
    expect(mentionTokenAt("😀@bo", 5)).toEqual({ start: 2, end: 5, handle: "bo", label: null });
  });
});

describe("CommentComposer", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("@ lists candidates (debounced), agent labels under their person; keys move, Tab inserts @handle and a space", async () => {
    const calls = stubCommentFetch({
      [candidatesUrl("")]: json({ candidates: [cand("alice", { agentLabels: ["claude", "gpt"] }), cand("bob")] }),
    });
    const { box } = setup();
    type(box, "hi @");
    expect(calls).toHaveLength(0);
    await waitFor(() => expect(options()).toEqual(["AAlice@alice", "@alice/claude", "@alice/gpt", "BBob@bob"]));
    expect(calls.filter((c) => c.url === candidatesUrl(""))).toHaveLength(1);
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[3]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(box).toHaveAttribute("aria-activedescendant", screen.getAllByRole("option")[3]!.id);
    fireEvent.keyDown(box, { key: "Tab" });
    expect(box.value).toBe("hi @bob ");
    expect(box.selectionStart).toBe(8);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("inserts @handle/label for a label row, by click", async () => {
    stubCommentFetch({ [candidatesUrl("al")]: json({ candidates: [cand("alice", { agentLabels: ["claude"] })] }) });
    const { box } = setup();
    type(box, "@al");
    const row = await screen.findByText("@alice/claude");
    fireEvent.click(row);
    expect(box.value).toBe("@alice/claude ");
  });

  it("after @handle/ only that person's matching labels are offered", async () => {
    stubCommentFetch({ [candidatesUrl("alice")]: json({ candidates: [cand("alice", { agentLabels: ["claude", "gpt"] }), cand("alicia", { agentLabels: ["x"] })] }) });
    const { box } = setup();
    type(box, "@alice/c");
    await waitFor(() => expect(options()).toEqual(["@alice/claude"]));
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@alice/claude ");
  });

  it("recognises 請@bob and replaces only the token", async () => {
    const calls = stubCommentFetch({ [candidatesUrl("bob")]: json({ candidates: [cand("bob")] }) });
    const { box } = setup();
    type(box, "請@bob");
    await screen.findByRole("listbox");
    expect(calls.map((c) => c.url)).toEqual([candidatesUrl("bob")]);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("請@bob ");
  });

  it("Esc closes the list for that token and keeps the text; a new @ opens it again", async () => {
    stubCommentFetch({ [candidatesUrl("bo")]: json({ candidates: [cand("bob")] }), [candidatesUrl("")]: json({ candidates: [cand("bob")] }) });
    const { box } = setup();
    type(box, "@bo");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(box.value).toBe("@bo");
    type(box, "@bo @");
    await screen.findByRole("listbox");
  });

  it("an IME keystroke never picks", async () => {
    stubCommentFetch({ [candidatesUrl("bo")]: json({ candidates: [cand("bob")] }) });
    const { box } = setup();
    type(box, "@bo");
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter", isComposing: true });
    expect(box.value).toBe("@bo");
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(box.value).toBe("@bo");
  });

  it("an IME-ending Ctrl+Enter (keyCode 229) does not send", async () => {
    const calls = stubCommentFetch({});
    const { box } = setup();
    type(box, "ok");
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true, keyCode: 229 });
    await act(async () => {});
    expect(calls).toHaveLength(0);
  });

  it("no list for an email address", async () => {
    const calls = stubCommentFetch({});
    const { box } = setup();
    type(box, "write to a@b.com");
    await new Promise((r) => setTimeout(r, 300));
    expect(calls).toHaveLength(0);
  });

  it("marks a typed handle that no candidate matches, not the one still being typed", async () => {
    stubCommentFetch({
      [candidatesUrl("zed")]: json({ candidates: [cand("zedd")] }),
      [candidatesUrl("bob")]: json({ candidates: [cand("bob")] }),
      [candidatesUrl("car")]: json({ candidates: [] }),
    });
    const { box } = setup();
    type(box, "@zed @bob thanks @car");
    await new Promise((r) => setTimeout(r, 300));
    await waitFor(() => expect(screen.getByTestId("mention-unmatched")).toHaveTextContent("@zed"));
    expect(screen.getByTestId("mention-unmatched")).toHaveTextContent("No one will be notified for @zed: they can't see this note, or no one has that handle.");
    expect(screen.getByTestId("mention-unmatched")).not.toHaveTextContent("@car");
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    type(box, "@zed @bob thanks @car ");
    await waitFor(() => expect(screen.getByTestId("mention-unmatched")).toHaveTextContent("@zed, @car"));
  });

  it("a failed candidate query marks nothing", async () => {
    stubCommentFetch({ [candidatesUrl("zed")]: json({ error: { code: "internal", message: "x" } }, 500) });
    const { box } = setup();
    type(box, "@zed ok");
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByTestId("mention-unmatched")).toBeEmptyDOMElement();
  });

  it("a full page that lacks the handle is no verdict", async () => {
    const full = Array.from({ length: 8 }, (_, i) => cand(`lin${i}`));
    stubCommentFetch({ [candidatesUrl("lin")]: json({ candidates: full }) });
    const { box } = setup();
    type(box, "@lin ok");
    await new Promise((r) => setTimeout(r, 400));
    expect(screen.getByTestId("mention-unmatched")).toBeEmptyDOMElement();
  });

  it("picking from the list never flashes the half-typed handle as unmatched", async () => {
    stubCommentFetch({ [candidatesUrl("b")]: json({ candidates: [cand("bob")] }), [candidatesUrl("bob")]: json({ candidates: [cand("bob")] }) });
    const { box } = setup();
    type(box, "@b");
    await screen.findByRole("listbox");
    const seen: string[] = [];
    const observer = new MutationObserver(() => seen.push(screen.getByTestId("mention-unmatched").textContent ?? ""));
    observer.observe(screen.getByTestId("mention-unmatched"), { childList: true, characterData: true, subtree: true });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@bob ");
    await new Promise((r) => setTimeout(r, 500));
    observer.disconnect();
    expect(seen.filter((x) => x !== "")).toEqual([]);
    expect(screen.getByTestId("mention-unmatched")).toBeEmptyDOMElement();
  });

  it("a pick replaces the whole word around the caret and adds no second space", async () => {
    stubCommentFetch({ [candidatesUrl("b")]: json({ candidates: [cand("bob")] }), [candidatesUrl("al")]: json({ candidates: [cand("alice")] }) });
    const { box } = setup();
    type(box, "@bobby hi");
    box.focus();
    box.setSelectionRange(2, 2);
    fireEvent.keyUp(box);
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@bob hi");
    expect(box.selectionStart).toBe(5);
    type(box, "@al thanks");
    box.focus();
    box.setSelectionRange(3, 3);
    fireEvent.keyUp(box);
    await screen.findByRole("listbox");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box.value).toBe("@alice thanks");
    expect(box.selectionStart).toBe(7);
  });

  it("counts code points: shown from 3,600, blocks sending over 4,000", async () => {
    const calls = stubCommentFetch({});
    const { box } = setup();
    type(box, "😀".repeat(3599));
    expect(screen.queryByTestId("comment-counter")).toBeNull();
    type(box, "😀".repeat(3600));
    expect(screen.getByTestId("comment-counter")).toHaveTextContent("3600 / 4000");
    type(box, "😀".repeat(4000));
    expect(screen.getByRole("button", { name: "Send" })).toBeEnabled();
    type(box, "😀".repeat(4001));
    expect(screen.getByTestId("comment-counter")).toHaveClass("text-destructive");
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    await act(async () => {});
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("Ctrl+Enter and Cmd+Enter send; the passage chip's X clears; reply sends replyToId", async () => {
    const calls = stubCommentFetch({ [POST]: json(comment(2), 201) });
    const { box, onDone, onClearAnchor } = setup({ draftAnchor: { blockId: "b1", quote: "q" }, replyTo: comment(1) });
    expect(screen.getByText("Replying to Bob")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Don't attach the passage" }));
    expect(onClearAnchor).toHaveBeenCalledTimes(1);
    type(box, "ok");
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ id: cid(2) })));
    expect(JSON.parse(calls.find((c) => c.method === "POST")!.body!)).toEqual({ body: "ok", replyToId: cid(1), anchor: { blockId: "b1", quote: "q" } });
    expect(box.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenLastCalledWith(null);
  });

  it("edit mode starts from the body, saves only a changed text, and has no passage chip", async () => {
    const mine = comment(1, { body: "first", canEdit: true });
    const calls = stubCommentFetch({ [`PATCH /api/comments/${cid(1)}`]: json({ ...mine, body: "first!" }) });
    const onDirtyChange = vi.fn();
    const { box, onDone } = setup({ editing: mine, draftAnchor: { blockId: "b1", quote: "q" }, onDirtyChange });
    expect(box.value).toBe("first");
    expect(screen.queryByTestId("composer-anchor")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    type(box, "first!");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(JSON.parse(calls.find((c) => c.method === "PATCH")!.body!)).toEqual({ body: "first!" });
  });
});
