import { afterEach, describe, expect, it } from "vitest";
import { selectedFragmentToHTML } from "@blocknote/core";
import { KNOWLEDGE_PROP_NAMES } from "@knotebook/shared";
import { mountEditor, type AnyEditor, type PartialBlockLike } from "@/test/columns-fixtures";

const KNOWLEDGE_PROPS = {
  knowledgeId: "k_5a5a5a5a",
  knowledgeWhen: "alice-when-7f3e",
  knowledgeConclusion: "bob-conclusion-91c2",
  knowledgeEvidence: "tested",
  knowledgeVerified: "2031-04-05",
  knowledgeStatus: "outdated",
  knowledgeSupersededBy: "k_6b6b6b6b",
};
const VALUES = Object.values(KNOWLEDGE_PROPS);

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function mount(content: PartialBlockLike[]): AnyEditor {
  const m = mountEditor(content);
  cleanups.push(m.destroy);
  return m.editor;
}

function copyAll(editor: AnyEditor) {
  const doc = editor.document;
  editor.setSelection(doc[0]!.id, doc[doc.length - 1]!.id);
  return selectedFragmentToHTML(editor.prosemirrorView!, editor);
}

const knowledgeHeading = (): PartialBlockLike => ({ id: "h1", type: "heading", props: { level: 2, ...KNOWLEDGE_PROPS }, content: "Alpha" }) as PartialBlockLike;
const paragraph = (): PartialBlockLike => ({ id: "p1", type: "paragraph", content: "tail" }) as PartialBlockLike;
const empty = (): PartialBlockLike => ({ id: "e1", type: "paragraph", content: "" }) as PartialBlockLike;

describe("copying a heading that carries knowledge", () => {
  it("puts the knowledge only in the in-note clipboard format", () => {
    const clip = copyAll(mount([knowledgeHeading(), paragraph()]));
    for (const name of KNOWLEDGE_PROP_NAMES) expect(clip.clipboardHTML, name).toContain(`data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=`);
    for (const out of [clip.externalHTML, clip.markdown]) {
      expect(out).not.toMatch(/knowledge/i);
      for (const v of VALUES) expect(out).not.toContain(v);
      expect(out).toContain("Alpha");
    }
  });

  it("pasting the in-note format into the same note keeps every knowledge prop on the copy", () => {
    const editor = mount([knowledgeHeading(), paragraph(), empty()]);
    editor.setSelection("h1", "p1");
    const clip = selectedFragmentToHTML(editor.prosemirrorView!, editor);
    editor.setTextCursorPosition("e1", "end");
    editor.pasteHTML(clip.clipboardHTML, true);
    const headings = (editor.document as { type: string; props: Record<string, string> }[]).filter((b) => b.type === "heading");
    expect(headings.length).toBe(2);
    for (const h of headings) {
      expect(h.props.knowledgeWhen).toBe(KNOWLEDGE_PROPS.knowledgeWhen);
      expect(h.props.knowledgeConclusion).toBe(KNOWLEDGE_PROPS.knowledgeConclusion);
      expect(h.props.knowledgeVerified).toBe(KNOWLEDGE_PROPS.knowledgeVerified);
    }
  });

  it("pasting the external format into a note brings no knowledge along", () => {
    const editor = mount([knowledgeHeading(), paragraph(), empty()]);
    editor.setSelection("h1", "p1");
    const clip = selectedFragmentToHTML(editor.prosemirrorView!, editor);
    editor.setTextCursorPosition("e1", "end");
    editor.pasteHTML(clip.externalHTML);
    const pasted = (editor.document as { type: string; props: Record<string, string> }[]).filter((b) => b.type === "heading" && b.props.knowledgeWhen === "");
    expect(pasted.length).toBe(1);
  });
});
