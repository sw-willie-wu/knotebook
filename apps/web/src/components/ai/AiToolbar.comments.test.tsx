import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import i18n from "@/i18n";
import { CommentsProvider, NOOP_COMMENTS, type CommentsContextValue } from "@/lib/comments-context";
import { contentStart, createTestEditor, renderAiHost, selectInBlock, stubAiFetch, type AnyEditor } from "@/test/ai-host";
import { IMG, P, row, withChildren } from "@/test/columns-fixtures";
import { stubLayoutTier } from "@/test/layout-tier";
import { SelectionAiController } from "./SelectionAiController";

const toolbar = () => document.querySelector(".bn-formatting-toolbar");

function commentsValue(over: Partial<CommentsContextValue> = {}): CommentsContextValue {
  return { ...NOOP_COMMENTS, enabled: true, noteId: "note-1", open: vi.fn(), ...over };
}

function mount(doc: unknown[], comments: CommentsContextValue | null, editable = true): AnyEditor {
  const editor = createTestEditor(doc);
  stubAiFetch({ actions: [] });
  const wrap = (node: ReactNode) => (comments === null ? node : <CommentsProvider value={comments}>{node}</CommentsProvider>);
  renderAiHost({ editor, editable, children: wrap(<SelectionAiController />) });
  return editor;
}

describe("AiToolbar Comment button (editors)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("a text selection shows Comment; pressing it opens the comments with the first selected block and the selected text", async () => {
    const comments = commentsValue();
    const editor = mount([P("alpha beta", "p1"), P("gamma", "p2")], comments);
    act(() => {
      editor._tiptapEditor.commands.setTextSelection({ from: contentStart(editor, "p1") + 6, to: contentStart(editor, "p2") + 3 });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    expect(comments.open).toHaveBeenCalledWith({ draftAnchor: { blockId: "p1", quote: "beta\ngam" } });
  });

  it("a selection in a nested block inside a column anchors to that block", async () => {
    const comments = commentsValue();
    const editor = mount([row([[P("left", "a1")], [withChildren(P("parent", "pp"), [P("nested text", "c1")])]], "r")], comments);
    selectInBlock(editor, "c1", 0, 6);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    expect(comments.open).toHaveBeenCalledWith({ draftAnchor: { blockId: "c1", quote: "nested" } });
  });

  it("a whitespace-only selection has no Comment button", async () => {
    const editor = mount([P("a     b", "p1")], commentsValue());
    selectInBlock(editor, "p1", 1, 5);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("a selection of a site link and whitespace shows Comment, quoting the link text", async () => {
    const comments = commentsValue();
    const editor = mount(
      [{ id: "w", type: "paragraph", content: [" ", { type: "wikilink", props: { targetNoteId: "x", snapshotTitle: "Plan" } }] }] as never,
      comments,
    );
    selectInBlock(editor, "w", 0, 2);
    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    expect(comments.open).toHaveBeenCalledWith({ draftAnchor: { blockId: "w", quote: "Plan" } });
  });

  it("an image selection has no Comment button", async () => {
    const editor = mount([P("x", "x"), IMG("img")], commentsValue());
    act(() => {
      editor._tiptapEditor.commands.setNodeSelection(contentStart(editor, "img") - 1);
    });
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("without comments (no provider, e.g. the connection is gone) there is no Comment button", async () => {
    const editor = mount([P("alpha", "p1")], null);
    selectInBlock(editor, "p1", 0, 5);
    await waitFor(() => expect(toolbar()).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });

  it("a read-only editor gets no formatting toolbar at all: every item in it would render nothing", async () => {
    const editor = mount([P("alpha", "p1")], commentsValue(), false);
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(toolbar()).toBeNull();
  });

  it("on phones the text-selection toolbar stays hidden, so there is no Comment button", async () => {
    stubLayoutTier("phone");
    const editor = mount([P("alpha", "p1")], commentsValue());
    selectInBlock(editor, "p1", 0, 5);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: "Comment" })).not.toBeInTheDocument();
  });
});
