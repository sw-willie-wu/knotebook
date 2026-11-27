import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import i18n from "@/i18n";
import { CommentsProvider, NOOP_COMMENTS, type CommentsContextValue } from "@/lib/comments-context";
import { createTestEditor, renderAiHost, stubAiFetch } from "@/test/ai-host";
import { P, row, withChildren } from "@/test/columns-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { ViewerCommentToolbar } from "./ViewerCommentToolbar";

function commentsValue(over: Partial<CommentsContextValue> = {}): CommentsContextValue {
  return { ...NOOP_COMMENTS, enabled: true, noteId: "note-1", open: vi.fn(), ...over };
}

function mount(doc: unknown[], comments: CommentsContextValue = commentsValue()) {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [] });
  renderAiHost({
    editor,
    editable: false,
    children: (
      <CommentsProvider value={comments}>
        <ViewerCommentToolbar />
      </CommentsProvider>
    ),
  });
  return { editor, comments };
}

function textNodeOf(blockId: string): Text {
  const inline = document.querySelector(`.bn-block-outer[data-id="${blockId}"] .bn-inline-content`);
  const node = inline?.firstChild;
  if (!(node instanceof Text)) throw new Error(`no text in block ${blockId}`);
  return node;
}

/** Sets the DOM selection the way a drag would and reports it the way the browser does. */
function selectDom(start: [Node, number], end: [Node, number] = start): void {
  act(() => {
    const range = document.createRange();
    range.setStart(...start);
    range.setEnd(...end);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}

const commentButton = () => screen.queryByRole("button", { name: "Comment" });

describe("ViewerCommentToolbar (read-only editor)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    vi.unstubAllGlobals();
  });

  it("a text selection shows just the Comment button; pressing it opens the comments with the passage", async () => {
    const { comments } = mount([P("alpha beta", "p1"), P("gamma", "p2")]);
    expect(commentButton()).not.toBeInTheDocument();
    selectDom([textNodeOf("p1"), 6], [textNodeOf("p2"), 3]);
    const button = await screen.findByRole("button", { name: "Comment" });
    expect(button.closest('[role="toolbar"]')!.querySelectorAll("button")).toHaveLength(1);
    fireEvent.click(button);
    expect(comments.open).toHaveBeenCalledWith({ draftAnchor: { blockId: "p1", quote: "beta\ngam" } });
  });

  it("an edit earlier in the note while the selection stays put does not move the anchor", async () => {
    const { editor, comments } = mount([P("alpha beta", "p1"), P("gamma delta", "p2")]);
    selectDom([textNodeOf("p2"), 6], [textNodeOf("p2"), 11]);
    const button = await screen.findByRole("button", { name: "Comment" });
    act(() => {
      editor.insertBlocks([{ type: "paragraph", content: "inserted by carol" }], "p1", "before");
    });
    fireEvent.click(button);
    expect(comments.open).toHaveBeenCalledWith({ draftAnchor: { blockId: "p2", quote: "delta" } });
  });

  it("a nested block in a column is anchored by its own id", async () => {
    const { comments } = mount([row([[P("left", "a1")], [withChildren(P("parent", "pp"), [P("nested text", "c1")])]], "r")]);
    selectDom([textNodeOf("c1"), 0], [textNodeOf("c1"), 6]);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    expect(comments.open).toHaveBeenCalledWith({ draftAnchor: { blockId: "c1", quote: "nested" } });
  });

  it("collapsing the selection or moving it outside the note hides the button", async () => {
    mount([P("alpha beta", "p1")]);
    selectDom([textNodeOf("p1"), 0], [textNodeOf("p1"), 5]);
    await screen.findByRole("button", { name: "Comment" });
    selectDom([textNodeOf("p1"), 2]);
    await waitFor(() => expect(commentButton()).not.toBeInTheDocument());

    selectDom([textNodeOf("p1"), 0], [textNodeOf("p1"), 5]);
    await screen.findByRole("button", { name: "Comment" });
    const outside = document.createElement("p");
    outside.textContent = "outside the note";
    document.body.append(outside);
    selectDom([outside.firstChild!, 0], [outside.firstChild!, 7]);
    await waitFor(() => expect(commentButton()).not.toBeInTheDocument());
    outside.remove();
  });

  it("stays hidden while the mouse button is held and appears on release", async () => {
    mount([P("alpha beta", "p1")]);
    const text = textNodeOf("p1");
    // Fired outside the editor view: jsdom lacks elementFromPoint, which the view's own mousedown handler calls.
    fireEvent.mouseDown(document.body, { button: 0 });
    selectDom([text, 0], [text, 5]);
    await act(async () => {});
    expect(commentButton()).not.toBeInTheDocument();
    fireEvent.mouseUp(document.body, { button: 0 });
    expect(await screen.findByRole("button", { name: "Comment" })).toBeInTheDocument();
  });

  it("a whitespace-only selection shows nothing", async () => {
    mount([P("a     b", "p1")]);
    selectDom([textNodeOf("p1"), 1], [textNodeOf("p1"), 5]);
    await act(async () => {});
    expect(commentButton()).not.toBeInTheDocument();
  });

  it("phones get no toolbar", async () => {
    stubLayoutTier("phone");
    mount([P("alpha beta", "p1")]);
    selectDom([textNodeOf("p1"), 0], [textNodeOf("p1"), 5]);
    await act(async () => {});
    expect(commentButton()).not.toBeInTheDocument();
  });

  it("nothing while comments are off for this note", async () => {
    mount([P("alpha beta", "p1")], commentsValue({ enabled: false }));
    selectDom([textNodeOf("p1"), 0], [textNodeOf("p1"), 5]);
    await act(async () => {});
    expect(commentButton()).not.toBeInTheDocument();
  });

  it("Esc hides it until the selection changes", async () => {
    mount([P("alpha beta", "p1")]);
    selectDom([textNodeOf("p1"), 0], [textNodeOf("p1"), 5]);
    await screen.findByRole("button", { name: "Comment" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(commentButton()).not.toBeInTheDocument());
    selectDom([textNodeOf("p1"), 0], [textNodeOf("p1"), 4]);
    expect(await screen.findByRole("button", { name: "Comment" })).toBeInTheDocument();
  });
});
