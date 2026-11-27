import { describe, expect, it } from "vitest";
import { COMMENT_QUOTE_MAX } from "@knotebook/shared";
import { contentEnd, contentStart, createTestEditor } from "@/test/ai-host";
import { P, row, withChildren } from "@/test/columns-fixtures";
import { cutQuote, passageOf } from "./passage";

const codePoints = (s: string) => Array.from(s).length;

describe("cutQuote", () => {
  it("keeps a quote of exactly the cap and cuts a longer one to the cap with the ellipsis counted in", () => {
    const exact = "a".repeat(COMMENT_QUOTE_MAX);
    expect(cutQuote(exact)).toBe(exact);
    const cut = cutQuote("a".repeat(COMMENT_QUOTE_MAX + 1));
    expect(codePoints(cut)).toBe(COMMENT_QUOTE_MAX);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toBe(`${"a".repeat(COMMENT_QUOTE_MAX - 1)}…`);
  });

  it("counts code points, so an emoji is never split", () => {
    const cut = cutQuote("😀".repeat(COMMENT_QUOTE_MAX + 5));
    expect(codePoints(cut)).toBe(COMMENT_QUOTE_MAX);
    expect(cut).toBe(`${"😀".repeat(COMMENT_QUOTE_MAX - 1)}…`);
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe("passageOf", () => {
  it("anchors to the first selected block and quotes the selected text across blocks", () => {
    const editor = createTestEditor([P("alpha beta", "p1"), P("gamma delta", "p2")]);
    const doc = editor.prosemirrorState.doc;
    expect(passageOf(doc, contentStart(editor, "p1") + 6, contentStart(editor, "p2") + 5)).toEqual({ blockId: "p1", quote: "beta\ngamma" });
  });

  it("a selection starting at the very end of a block anchors to the next block that has selected text", () => {
    const editor = createTestEditor([P("alpha", "p1"), P("gamma", "p2")]);
    expect(passageOf(editor.prosemirrorState.doc, contentEnd(editor, "p1"), contentStart(editor, "p2") + 3)).toEqual({ blockId: "p2", quote: "gam" });
  });

  it("a nested list item is anchored by its own id", () => {
    const editor = createTestEditor([
      withChildren({ id: "li1", type: "bulletListItem", content: "parent" }, [{ id: "li2", type: "bulletListItem", content: "child item" }]),
    ]);
    expect(passageOf(editor.prosemirrorState.doc, contentStart(editor, "li2"), contentStart(editor, "li2") + 5)).toEqual({ blockId: "li2", quote: "child" });
  });

  it("a block inside a column is anchored by its own id", () => {
    const editor = createTestEditor([row([[P("left side", "a1")], [P("right side", "b1")]], "r")]);
    expect(passageOf(editor.prosemirrorState.doc, contentStart(editor, "b1"), contentStart(editor, "b1") + 5)).toEqual({ blockId: "b1", quote: "right" });
  });

  it("a long selection is cut to the cap with the ellipsis counted in", () => {
    const editor = createTestEditor([P("x".repeat(500), "p1")]);
    const passage = passageOf(editor.prosemirrorState.doc, contentStart(editor, "p1"), contentEnd(editor, "p1"));
    expect(passage?.blockId).toBe("p1");
    expect(codePoints(passage!.quote)).toBe(COMMENT_QUOTE_MAX);
    expect(passage!.quote.endsWith("…")).toBe(true);
  });

  it("whitespace around the selection is trimmed; a whitespace-only selection keeps the block with an empty quote", () => {
    const editor = createTestEditor([P("  word  ", "p1")]);
    const doc = editor.prosemirrorState.doc;
    expect(passageOf(doc, contentStart(editor, "p1"), contentEnd(editor, "p1"))).toEqual({ blockId: "p1", quote: "word" });
    expect(passageOf(doc, contentStart(editor, "p1"), contentStart(editor, "p1") + 2)).toEqual({ blockId: "p1", quote: "" });
  });

  it("an empty range is no passage", () => {
    const editor = createTestEditor([P("alpha", "p1")]);
    const at = contentStart(editor, "p1") + 2;
    expect(passageOf(editor.prosemirrorState.doc, at, at)).toBeNull();
  });
});
