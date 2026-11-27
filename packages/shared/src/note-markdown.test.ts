import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "./ydoc.js";
import { extractLinkTargets, isBlankParseResult, rebindWikilinks, restoreFenceBlocks } from "./note-markdown.js";

const isInline = (type: string) => type === "paragraph" || type === "heading";

describe("isBlankParseResult (the exact form of the original isBlankParseResult in apps/web/src/ai/apply.ts)", () => {
  it("zero blocks or a single empty paragraph -> blank; a divider is not blank; text is not blank", () => {
    expect(isBlankParseResult([])).toBe(true);
    expect(isBlankParseResult([{ type: "paragraph", content: [], children: [] }])).toBe(true);
    expect(isBlankParseResult([{ type: "divider" }])).toBe(false);
    expect(isBlankParseResult([{ type: "paragraph", content: [{ type: "text", text: "x" }], children: [] }])).toBe(false);
  });
});

describe("restoreFenceBlocks", () => {
  it("codeBlock(language=mermaid) -> mermaid block, code character for character; other codeBlocks untouched; recurses into children", () => {
    const out = restoreFenceBlocks([
      { type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "graph TD\n  A-->B" }] },
      { type: "codeBlock", props: { language: "ts" }, content: [{ type: "text", text: "1" }] },
      { type: "paragraph", content: [], children: [{ type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "x" }] }] },
    ]);
    expect(out[0]).toEqual({ type: "mermaid", props: { code: "graph TD\n  A-->B" } });
    expect(out[1]!.type).toBe("codeBlock");
    expect((out[2] as { children: Array<{ type: string }> }).children[0]!.type).toBe("mermaid");
  });
  it("columnList -> column -> codeBlock(mermaid) is also restored to mermaid", () => {
    const out = restoreFenceBlocks([
      { type: "columnList", children: [
        { type: "column", props: { width: 1 }, children: [{ type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "graph TD" }] }] },
        { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [] }] },
      ] },
    ]);
    const col0 = (out[0] as { children: Array<{ children: unknown[] }> }).children[0]!;
    expect(col0.children[0]).toEqual({ type: "mermaid", props: { code: "graph TD" } });
  });
  it("input with a string id -> the same id is kept after restoring (so the preview diff can match); a non-string id is not carried", () => {
    const out = restoreFenceBlocks([
      { id: "m1", type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "graph TD" }] },
      { id: 7, type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "graph LR" }] },
    ]);
    expect(out[0]).toEqual({ id: "m1", type: "mermaid", props: { code: "graph TD" } });
    expect(out[1]).toEqual({ type: "mermaid", props: { code: "graph LR" } });
  });
});


describe("restoreFenceBlocks", () => {
  const fence = (language: unknown, text: string, id?: unknown) => ({ ...(id === undefined ? {} : { id }), type: "codeBlock", props: { language }, content: [{ type: "text", text }] });

  it("codeBlock(language=math) -> math block, tex character for character, id kept", () => {
    const tex = "\\frac{a_1}{b_2} \\\\\n  x_i";
    const out = restoreFenceBlocks([fence("math", tex, "m1")]);
    expect(out[0]).toEqual({ id: "m1", type: "math", props: { tex } });
  });
  it("a non-string id is not carried onto a math block", () => {
    expect(restoreFenceBlocks([fence("math", "x", 7)])[0]).toEqual({ type: "math", props: { tex: "x" } });
  });
  it("one call restores both mermaid and math", () => {
    const out = restoreFenceBlocks([fence("mermaid", "graph TD"), fence("math", "E=mc^2")]);
    expect(out.map((b) => b.type)).toEqual(["mermaid", "math"]);
  });
  it("a latex fence stays a code block", () => {
    const input = [fence("latex", "\\sum_{i} w_i", "l1")];
    expect(restoreFenceBlocks(input)).toEqual(input);
  });
  it.each(["tex", "LaTeX", "Math", "mathematica", "ts"])("the language %j stays a code block", (language) => {
    const input = [fence(language, "x")];
    expect(restoreFenceBlocks(input)).toEqual(input);
  });
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("the Object.prototype name %j is not treated as a target", (language) => {
    const input = [fence(language, "x")];
    expect(restoreFenceBlocks(input)).toEqual(input);
  });
  it("recurses into paragraph children and columnList -> column -> codeBlock(math)", () => {
    const out = restoreFenceBlocks([
      { type: "paragraph", content: [], children: [fence("math", "a")] },
      { type: "columnList", children: [
        { type: "column", props: { width: 1 }, children: [fence("math", "b")] },
        { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [] }] },
      ] },
    ]);
    expect((out[0] as { children: Array<{ type: string }> }).children[0]!.type).toBe("math");
    const col0 = (out[1] as { children: Array<{ children: unknown[] }> }).children[0]!;
    expect(col0.children[0]).toEqual({ type: "math", props: { tex: "b" } });
  });
});

describe("rebindWikilinks (bind only on a unique hit)", () => {
  it("#269: [[...]] inside table cells is bound too (both cell shapes), a miss also counts in unbound", () => {
    const notes = [{ id: "n1", title: "A" }];
    const [out, unbound] = rebindWikilinks(
      [{ type: "table", content: { type: "tableContent", rows: [{ cells: [
        [{ type: "text", text: "[[A]]", styles: {} }],
        { type: "tableCell", props: {}, content: [{ type: "text", text: "[[Nope]]", styles: {} }] },
      ] }] } }],
      notes,
      isInline,
    );
    expect(unbound).toBe(1);
    const cells = (out[0] as { content: { rows: Array<{ cells: unknown[] }> } }).content.rows[0]!.cells;
    expect((cells[0] as Array<{ type: string; props?: unknown }>)[0]).toEqual({ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "A" } });
    expect((cells[1] as { content: Array<{ text: string }> }).content[0]!.text).toBe("[[Nope]]");
  });
  const notes = [{ id: "11111111-1111-4111-8111-111111111111", title: "A" }, { id: "2", title: "Dup" }, { id: "3", title: "Dup" }];
  it("a unique hit -> wikilink inline; duplicate name / not found -> plain text and counted", () => {
    const [blocks, unbound] = rebindWikilinks(
      [{ type: "paragraph", content: [{ type: "text", text: "see [[A]] and [[Dup]] and [[Nope]]", styles: {} }], children: [] }],
      notes,
      isInline,
    );
    const content = (blocks[0] as { content: Array<{ type: string; props?: { targetNoteId: string }; text?: string }> }).content;
    expect(content.map(c => c.type)).toEqual(["text", "wikilink", "text", "text", "text", "text"]);
    expect(content[1]!.props).toEqual({ targetNoteId: notes[0]!.id, snapshotTitle: "A" });
    expect(unbound).toBe(2);
  });
  it("[[X]] inside a codeBlock (non-inline content) is not rebound", () => {
    const [blocks, unbound] = rebindWikilinks([{ type: "codeBlock", content: [{ type: "text", text: "[[A]]" }] }], notes, isInline);
    expect((blocks[0] as { content: Array<{ type: string }> }).content[0]!.type).toBe("text");
    expect(unbound).toBe(0);
  });
  it("[[A]] in a paragraph inside a column is bound too, unbound 0", () => {
    const [blocks, unbound] = rebindWikilinks(
      [{ type: "columnList", children: [
        { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [{ type: "text", text: "[[A]]", styles: {} }], children: [] }] },
        { type: "column", props: { width: 1 }, children: [{ type: "paragraph", content: [], children: [] }] },
      ] }],
      notes,
      isInline,
    );
    expect(unbound).toBe(0);
    const para = (blocks[0] as { children: Array<{ children: Array<{ content: unknown[] }> }> }).children[0]!.children[0]!;
    expect(para.content).toEqual([{ type: "wikilink", props: { targetNoteId: notes[0]!.id, snapshotTitle: "A" } }]);
  });
});

describe("extractLinkTargets", () => {
  it("walks wikilink elements, accepts only valid uuids, dedupes and sorts", () => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup"); const c = new Y.XmlElement("blockContainer"); c.setAttribute("id", "a");
    const p = new Y.XmlElement("paragraph");
    const w1 = new Y.XmlElement("wikilink"); w1.setAttribute("targetNoteId", "22222222-2222-4222-8222-222222222222");
    const w2 = new Y.XmlElement("wikilink"); w2.setAttribute("targetNoteId", "11111111-1111-4111-8111-111111111111");
    const w3 = new Y.XmlElement("wikilink"); w3.setAttribute("targetNoteId", "not-a-uuid");
    const w4 = new Y.XmlElement("wikilink"); w4.setAttribute("targetNoteId", "11111111-1111-4111-8111-111111111111");
    p.insert(0, [w1, w2, w3, w4]); c.insert(0, [p]); g.insert(0, [c]);
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    expect(extractLinkTargets(doc)).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });
});
