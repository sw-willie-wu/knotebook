import { describe, expect, it } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import { KNOWLEDGE_PROP_NAMES, createHeadlessNoteSchema } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { toNoteMarkdown } from "../../src/notes/editing/read.js";
import { preUpgradeSchema } from "../helpers/knowledge-docs.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const VALUES = ["alice-when-7f3e", "bob-conclusion-91c2", "2031-04-05", "k_5a5a5a5a", "tested", "outdated", "k_6b6b6b6b"];
const KNOWLEDGE_PROPS = {
  knowledgeId: "k_5a5a5a5a",
  knowledgeWhen: "alice-when-7f3e",
  knowledgeConclusion: "bob-conclusion-91c2",
  knowledgeEvidence: "tested",
  knowledgeVerified: "2031-04-05",
  knowledgeStatus: "outdated",
  knowledgeSupersededBy: "k_6b6b6b6b",
};

const plainBlocks = () => [
  { id: "h1", type: "heading", props: { level: 1 }, content: "Alpha" },
  { id: "h2", type: "heading", props: { level: 2, textColor: "red" }, content: "Beta" },
  { id: "h3", type: "heading", props: { level: 3, isToggleable: true }, content: "Gamma" },
  { id: "p1", type: "paragraph", content: "text" },
];

type AnyEditor = ReturnType<typeof BlockNoteEditor.create>;

function exportAll(editor: AnyEditor) {
  const doc = editor.document;
  return {
    external: editor.blocksToHTMLLossy(doc),
    internal: editor.blocksToFullHTML(doc),
    lossyMarkdown: editor.blocksToMarkdownLossy(doc),
    noteMarkdown: toNoteMarkdown(editor, doc, new Map()),
  };
}

describe("knowledge props in exported HTML", () => {
  it("a heading without knowledge is exported exactly as the pre-upgrade schema exports it, in every format", () => {
    const current = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/") });
    const before = BlockNoteEditor.create({ schema: preUpgradeSchema() });
    current.replaceBlocks(current.document, plainBlocks() as never);
    before.replaceBlocks(before.document, plainBlocks() as never);
    const a = exportAll(current);
    expect(a).toEqual(exportAll(before));
    expect(JSON.stringify(a)).not.toContain("data-knowledge");
  });

  it("a knowledge heading's external HTML and Markdown carry no knowledge name or value, while its text, level and color stay", () => {
    const editor = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/") });
    editor.replaceBlocks(editor.document, [
      { id: "h1", type: "heading", props: { level: 2, textColor: "red", ...KNOWLEDGE_PROPS }, content: "Alpha" },
      { id: "h2", type: "heading", props: { level: 1, ...KNOWLEDGE_PROPS }, content: "Beta" },
    ] as never);
    const out = exportAll(editor);
    // The note Markdown carries knowledge only as the comment under each heading.
    expect(out.noteMarkdown.match(/<!-- knotebook:knowledge\n/g)).toHaveLength(2);
    out.noteMarkdown = out.noteMarkdown.replace(/\n<!-- knotebook:knowledge[\s\S]*?\n-->/g, "");
    for (const key of ["external", "lossyMarkdown", "noteMarkdown"] as const) {
      expect(out[key], key).not.toMatch(/data-knowledge|knowledge/i);
      for (const v of VALUES) expect(out[key], `${key} ${v}`).not.toContain(v);
    }
    expect(out.external).toContain("Alpha");
    expect(out.external).toContain("<h2");
    expect(out.external).toContain('data-text-color="red"');
    // The note Markdown keeps a colored heading as raw HTML; it must not carry the attributes either.
    expect(out.noteMarkdown).toContain('data-text-color="red"');
  });

  it("the internal HTML keeps every knowledge attribute so a copy inside the note round-trips", () => {
    const editor = BlockNoteEditor.create({ schema: createHeadlessNoteSchema("http://localhost/") });
    editor.replaceBlocks(editor.document, [{ id: "h1", type: "heading", props: { level: 1, ...KNOWLEDGE_PROPS }, content: "Alpha" }] as never);
    const internal = editor.blocksToFullHTML(editor.document);
    for (const name of KNOWLEDGE_PROP_NAMES) expect(internal, name).toContain(`data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  });
});
