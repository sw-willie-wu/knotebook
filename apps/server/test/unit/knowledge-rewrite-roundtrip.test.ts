// The keep-knowledge pairing against blocks produced by the real read → parse path, not hand-written ones.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { knowledgePairs, resolveKnowledgeForWrite } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { toNoteMarkdown } from "../../src/notes/editing/read.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const TARGET = "33333333-3333-4333-8333-333333333333";
const K = { knowledgeId: "k_8f3a2c1d", knowledgeWhen: "alice reads this", knowledgeEvidence: "tested" };
const candidate = (title: string) => ({ id: TARGET, title, slug: "target", groupId: null, ownerHandle: "alice" });

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple
type AnyBlock = any;

async function readThenWrite(blocks: AnyBlock[], titleNow: string, dropComment = false) {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    s.editor.replaceBlocks(s.editor.document, blocks);
    const before = s.editor.document as AnyBlock[];
    const markdown = toNoteMarkdown(s.editor, s.editor.document, new Map([[TARGET, titleNow]]));
    const parsed = parseMarkdownForNote(s.editor, dropComment ? markdown.replace(/^<!-- knotebook:knowledge[\s\S]*?\n-->\n/m, "") : markdown, [candidate(titleNow)], "http://localhost");
    if (!("blocks" in parsed)) throw new Error(`parse failed: ${JSON.stringify(parsed)}`);
    return { before, after: parsed.blocks as AnyBlock[], markdown };
  } finally {
    s.close();
  }
}

const wikilink = (props: Record<string, string>) => ({ type: "wikilink", props: { targetNoteId: TARGET, snapshotTitle: "Old title", label: "", anchorBlockId: "", ...props } });
const heading = (content: AnyBlock[]) => ({ type: "heading", props: { level: 2, ...K }, content });

describe("knowledge pairing across a real read and write", () => {
  it("a heading holding a wikilink without label pairs with the same heading read back and written again, also after the linked note was renamed", async () => {
    for (const titleNow of ["Old title", "Renamed since"]) {
      const { before, after } = await readThenWrite([heading([{ type: "text", text: "See ", styles: {} }, wikilink({})]), { type: "paragraph", content: "body" }], titleNow, true);
      expect(knowledgePairs(before, after), titleNow).toEqual([[0, 0]]);
      const r = resolveKnowledgeForWrite({ before, after, keep: true, taken: new Set() });
      expect(r.kept, titleNow).toHaveLength(1);
      expect(r.blocks[0].props).toMatchObject({ knowledgeId: "k_8f3a2c1d", knowledgeWhen: "alice reads this", knowledgeEvidence: "tested" });
    }
  });

  it("a heading with a labelled wikilink pairs too", async () => {
    const { before, after } = await readThenWrite([heading([wikilink({ label: "Custom label" })]), { type: "paragraph", content: "body" }], "Renamed since");
    expect(knowledgePairs(before, after)).toEqual([[0, 0]]);
  });

  it("an unchanged read-back, with its comment dropped by the agent, keeps the knowledge; a re-read shows the comment again", async () => {
    const blocks = [heading([{ type: "text", text: "Decision", styles: {} }]), { type: "paragraph", content: "body" }];
    const { before, after, markdown } = await readThenWrite(blocks, "x", true);
    expect(markdown).toContain("<!-- knotebook:knowledge");
    expect(after[0].props.knowledgeId).toBe("");
    const r = resolveKnowledgeForWrite({ before, after, keep: true, taken: new Set() });
    expect(r.kept).toEqual([{ id: "k_8f3a2c1d", heading: "Decision" }]);
    expect(r.blocks[0].props.knowledgeId).toBe("k_8f3a2c1d");
  });
});
