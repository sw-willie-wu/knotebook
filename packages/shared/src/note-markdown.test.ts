import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "./ydoc.js";
import { extractLinkTargets, isBlankParseResult, rebindWikilinks, restoreMermaidBlocks } from "./note-markdown.js";

const isInline = (type: string) => type === "paragraph" || type === "heading";

describe("isBlankParseResult（apps/web/src/ai/apply.ts 原 isBlankParseResult 精確形）", () => {
  it("零 block 或單一空 paragraph → 空；divider 不算空；有文字不算空", () => {
    expect(isBlankParseResult([])).toBe(true);
    expect(isBlankParseResult([{ type: "paragraph", content: [], children: [] }])).toBe(true);
    expect(isBlankParseResult([{ type: "divider" }])).toBe(false);
    expect(isBlankParseResult([{ type: "paragraph", content: [{ type: "text", text: "x" }], children: [] }])).toBe(false);
  });
});

describe("restoreMermaidBlocks", () => {
  it("codeBlock(language=mermaid) → mermaid block，code 一字不差；其他 codeBlock 不動；遞迴 children", () => {
    const out = restoreMermaidBlocks([
      { type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "graph TD\n  A-->B" }] },
      { type: "codeBlock", props: { language: "ts" }, content: [{ type: "text", text: "1" }] },
      { type: "paragraph", content: [], children: [{ type: "codeBlock", props: { language: "mermaid" }, content: [{ type: "text", text: "x" }] }] },
    ]);
    expect(out[0]).toEqual({ type: "mermaid", props: { code: "graph TD\n  A-->B" } });
    expect(out[1]!.type).toBe("codeBlock");
    expect((out[2] as { children: Array<{ type: string }> }).children[0]!.type).toBe("mermaid");
  });
});

describe("rebindWikilinks（唯一命中才綁）", () => {
  const notes = [{ id: "11111111-1111-4111-8111-111111111111", title: "A" }, { id: "2", title: "Dup" }, { id: "3", title: "Dup" }];
  it("唯一命中 → wikilink inline；重名／找不到 → 純文字且計數", () => {
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
  it("codeBlock（非 inline content）裡的 [[X]] 不重綁", () => {
    const [blocks, unbound] = rebindWikilinks([{ type: "codeBlock", content: [{ type: "text", text: "[[A]]" }] }], notes, isInline);
    expect((blocks[0] as { content: Array<{ type: string }> }).content[0]!.type).toBe("text");
    expect(unbound).toBe(0);
  });
});

describe("extractLinkTargets", () => {
  it("走訪 wikilink 元素、只收合法 uuid、去重排序", () => {
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
