import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Block, BlockNoteEditor } from "@blocknote/core";
import { YDOC_FRAGMENT, topLevelBlocks } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { createTestEditor } from "@/test/ai-host";
import { captureAnchor } from "./anchor";
import { aiMarkdownOf } from "./note-markdown";
import { aiKnowledgeContext, applyAiResult, prepareAiResult, type PreparedResult } from "./apply";

vi.mock("@/components/ui/toast", () => ({ toast: vi.fn() }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");
const { BlockNoteEditor: BNEditor } = await import("@blocknote/core");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple, repo convention
type Ed = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same
type AnyBlock = Block<any, any, any>;

const NOTE = "11111111-1111-4111-8111-111111111111";
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const K = (n: number, extra: Record<string, string> = {}) => ({ knowledgeId: `k_0000000${n}`, knowledgeWhen: `when ${n}`, knowledgeConclusion: `conclusion ${n}`, ...extra });
const H = (id: string, text: string, props: Record<string, unknown> = {}) => ({ id, type: "heading", props: { level: 2, ...props }, content: text });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });
const titleOf = () => undefined;

function collabEditor(doc: Y.Doc): Ed {
  const editorRef: EditorRef = { current: null };
  const editor = BNEditor.create(
    buildNoteEditorOptions({
      doc,
      provider: { awareness: null } as never,
      user: { id: "u1", name: "User 1" },
      language: "en",
      translate: (k) => k,
      editorRef,
      noteId: "n",
      siteLinks: { current: null },
    }),
  ) as unknown as Ed;
  editorRef.current = editor as never;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  cleanups.push(() => {
    editor.unmount();
    el.remove();
  });
  return editor;
}

function seededDoc(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  const editor = collabEditor(doc);
  editor.replaceBlocks(editor.document, blocks as never);
  editor.unmount();
  cleanups.pop()!();
  return doc;
}

function headingsOf(doc: Y.Doc): Array<{ blockId: string; text: string; attrs: Record<string, unknown> }> {
  return topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).flatMap((c) => {
    const first = c.get(0);
    if (!(first instanceof Y.XmlElement) || first.nodeName !== "heading") return [];
    return [{ blockId: String(c.getAttribute("id")), text: first.toString(), attrs: first.getAttributes() as Record<string, unknown> }];
  });
}

function prepare(editor: Ed, markdown: string, ids: string[], placement: "top" | "nested" = "top") {
  return prepareAiResult(editor, markdown, { notes: [], placement, knowledge: aiKnowledgeContext(editor, NOTE, ids) });
}
function ok(r: ReturnType<typeof prepareAiResult>): PreparedResult {
  if ("empty" in r || "invalid" in r) throw new Error(`expected a result, got ${JSON.stringify(r)}`);
  return r;
}
const headingProps = (blocks: readonly AnyBlock[], i: number) => (blocks[i] as { props: Record<string, string> }).props;
const sendIds = (editor: Ed) => editor.document.map((b) => b.id);
const markdownOfAll = (editor: Ed, knowledge: boolean) => aiMarkdownOf(editor.document, titleOf, { knowledge });

describe("aiMarkdownOf with knowledge", () => {
  it("writes the comment for a top-level knowledge heading when knowledge is true and none when false", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const on = markdownOfAll(editor, true);
    expect(on).toContain("<!-- knotebook:knowledge");
    expect(on).toContain("id: k_00000001");
    expect(on).toContain("when: when 1");
    expect(markdownOfAll(editor, false)).not.toContain("knotebook:knowledge");
  });

  it("is byte-identical with and without the option when nothing in the selection has knowledge", () => {
    const editor = createTestEditor([H("h1", "Title"), P("p1", "body **bold**")]);
    expect(markdownOfAll(editor, true)).toBe(markdownOfAll(editor, false));
    expect(aiMarkdownOf(editor.document, titleOf)).toBe(markdownOfAll(editor, false));
  });
});

describe("prepareAiResult with knowledge", () => {
  it("sending the selection's markdown back unchanged gives blocks with the same knowledge props", () => {
    const props = K(1, { knowledgeEvidence: "tested", knowledgeVerified: "2026-05-01" });
    const editor = createTestEditor([H("h1", "Title", props), P("p1", "body")]);
    const prepared = ok(prepare(editor, markdownOfAll(editor, true), sendIds(editor)));
    expect(headingProps(prepared.blocks, 0)).toMatchObject(props);
  });

  it("a comment's changed fields replace the old ones and the id stays", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const md = markdownOfAll(editor, true).replace("conclusion: conclusion 1", "conclusion: revised");
    const prepared = ok(prepare(editor, md, sendIds(editor)));
    expect(headingProps(prepared.blocks, 0)).toMatchObject({ knowledgeId: "k_00000001", knowledgeConclusion: "revised", knowledgeWhen: "when 1" });
  });

  it("a result without the comment and the same heading keeps the knowledge and its id", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const prepared = ok(prepare(editor, "## Title\n\nrewritten body", sendIds(editor)));
    expect(headingProps(prepared.blocks, 0)).toMatchObject(K(1));
  });

  it("a result with the heading text changed and no comment has no knowledge", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const prepared = ok(prepare(editor, "## Another title\n\nbody", sendIds(editor)));
    expect(headingProps(prepared.blocks, 0).knowledgeId).toBe("");
  });

  it("a renamed heading that keeps its comment keeps the knowledge and its id", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const md = markdownOfAll(editor, true).replace("## Title", "## Renamed");
    const prepared = ok(prepare(editor, md, sendIds(editor)));
    expect(headingProps(prepared.blocks, 0)).toMatchObject({ ...K(1) });
  });

  it("a comment without an id on the same heading takes the old id; on a new heading it gets a new one", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const md = "## Title\n<!-- knotebook:knowledge\nconclusion: edited\n-->\n\nbody\n\n## Fresh\n<!-- knotebook:knowledge\nconclusion: new one\n-->\n\nmore";
    const prepared = ok(prepare(editor, md, sendIds(editor)));
    expect(headingProps(prepared.blocks, 0)).toMatchObject({ knowledgeId: "k_00000001", knowledgeConclusion: "edited" });
    const fresh = headingProps(prepared.blocks, 2);
    expect(fresh.knowledgeId).toMatch(/^k_[0-9a-f]{8}$/);
    expect(fresh.knowledgeId).not.toBe("k_00000001");
  });

  it("raw HTML data-knowledge attributes in the result are dropped, and a result with <plaintext> after raw data-knowledge attributes is invalid", () => {
    const editor = createTestEditor([P("p1", "body")]);
    const raw = ok(prepare(editor, '<h2 data-knowledge-id="k_00000009" data-knowledge-when="x">Sneaky</h2>\n\ntext', sendIds(editor)));
    expect(headingProps(raw.blocks, 0).knowledgeId).toBe("");
    expect(headingProps(raw.blocks, 0).knowledgeWhen).toBe("");
    expect(prepare(editor, '<h2 data-knowledge-id="k_00000009" data-knowledge-when="x">Sneaky</h2>\n\n<plaintext>tail', sendIds(editor))).toEqual({ invalid: "unsupported_block" });
    // Plain text that only mentions the attribute name is fine, and a comment after <plaintext> is plain text.
    const quoted = ok(prepare(editor, "<plaintext>\n## T\n<!-- knotebook:knowledge\nid: k_00000009\nwhen: x\n-->\n\ndata-knowledge-id", sendIds(editor)));
    expect(quoted.blocks.every((b) => headingProps([b], 0).knowledgeId === undefined || headingProps([b], 0).knowledgeId === "")).toBe(true);
  });

  it("a raw attribute on a nested element or in a second form does not become knowledge", () => {
    const editor = createTestEditor([P("p1", "body")]);
    const md = '> <h2 DATA-KNOWLEDGE-ID="k_00000009" data-knowledge-when="x">Quoted</h2>\n\nafter';
    const r = prepare(editor, md, sendIds(editor));
    if (!("invalid" in r) && !("empty" in r)) {
      const hasKnowledge = JSON.stringify(r.blocks).includes('"knowledgeId":"k_');
      expect(hasKnowledge).toBe(false);
    }
  });

  it("the knowledge props set from a comment survive premergedHtml when nothing is merged, and when something is", () => {
    const editor = createTestEditor([P("p1", "body")]);
    const md = "## Title\n<!-- knotebook:knowledge\nid: k_00000005\nwhen: w\n-->\n\n> one\n>\n> two\n\nlast";
    const prepared = ok(prepare(editor, md, sendIds(editor)));
    expect(headingProps(prepared.blocks, 0)).toMatchObject({ knowledgeId: "k_00000005", knowledgeWhen: "w" });
  });

  it("an invalid comment makes prepareAiResult return invalid_knowledge", () => {
    const editor = createTestEditor([H("h1", "Title", K(1)), P("p1", "body")]);
    const cases = [
      "## T\n<!-- knotebook:knowledge\nid: k_00000005\nevidence: bogus\nwhen: w\n-->\n\nbody",
      "## T\n<!-- knotebook:knowledge\nid: k_00000005\nwhen: w\nwhen: again\n-->\n\nbody",
      "## T\n<!-- knotebook:knowledge\nid: k_00000005\nwhen: w\n-->\nbody without a blank line",
      "## T\n<!-- knotebook:knowledge\nid: k_00000005\n-->\n\nbody",
      "## T\n<!-- knotebook:knowledge\nid: k_00000005\nstatus: outdated\nwhen: w\n-->\n\nbody",
      "## T\n<!-- knotebook:knowledge\nid: k_00000005\nwhen: w\n\nbody that never closes the comment",
      "## T\n<!-- knotebook:knowledge\nid: not-an-id\nwhen: w\n-->\n\nbody",
    ];
    for (const md of cases) expect(prepare(editor, md, sendIds(editor)), md).toEqual({ invalid: "invalid_knowledge" });
  });

  it("a pending id written by the model is refused and never reaches the blocks", () => {
    const editor = createTestEditor([P("p1", "body")]);
    expect(prepare(editor, "## T\n<!-- knotebook:knowledge\nid: k_new:1\nwhen: w\n-->\n\nbody", sendIds(editor))).toEqual({ invalid: "invalid_knowledge" });
  });

  it("in a nested selection comments are ignored", () => {
    const editor = createTestEditor([{ ...P("p1", "parent"), children: [P("c1", "child")] }]);
    const prepared = ok(prepare(editor, "## T\n<!-- knotebook:knowledge\nid: k_00000005\nwhen: w\n-->\n\nbody", ["c1"], "nested"));
    expect(JSON.stringify(prepared.blocks)).not.toContain('"knowledgeId":"k_');
  });

  it("a result without any comment, for a selection without knowledge, gives the same blocks with and without the knowledge context", () => {
    const editor = createTestEditor([P("p1", "body"), P("p2", "more")]);
    const md = "# Heading\n\ntext **bold** and `code`";
    const withContext = ok(prepare(editor, md, sendIds(editor)));
    const without = ok(prepareAiResult(editor, md, { notes: [], placement: "top" }));
    const stripIds = (blocks: readonly AnyBlock[]) => JSON.parse(JSON.stringify(blocks).replace(/"id":"[^"]*"/g, '"id":""'));
    expect(stripIds(withContext.blocks)).toEqual(stripIds(without.blocks));
  });
});

describe("applying a result with knowledge in the editor", () => {
  it("after applying, a knowledge id that already exists elsewhere in the note is renewed in the Y.Doc and the original keeps it", async () => {
    const doc = seededDoc([H("hA", "Alpha", K(1)), P("pA", "a"), P("p2", "target")]);
    const editor = collabEditor(doc);
    const ids = ["p2"];
    const md = "## Beta\n<!-- knotebook:knowledge\nid: k_00000001\nwhen: copied\n-->\n\nnew body";
    const prepared = ok(prepare(editor, md, ids));
    expect(applyAiResult(editor, captureAnchor(editor, NOTE, ids), prepared).ok).toBe(true);
    await tick();
    const hs = headingsOf(doc);
    expect(hs).toHaveLength(2);
    expect(hs[0]!.attrs.knowledgeId).toBe("k_00000001");
    expect(hs[0]!.attrs.knowledgeWhen).toBe("when 1");
    expect(hs[1]!.attrs.knowledgeId).toMatch(/^k_[0-9a-f]{8}$/);
    expect(hs[1]!.attrs.knowledgeId).not.toBe("k_00000001");
    expect(hs[1]!.attrs.knowledgeWhen).toBe("copied");
  });

  it("a comment that repeats the id of a heading inside the replaced range keeps that id", async () => {
    const doc = seededDoc([H("hA", "Alpha", K(1)), P("pA", "a")]);
    const editor = collabEditor(doc);
    const ids = sendIds(editor);
    const prepared = ok(prepare(editor, markdownOfAll(editor, true).replace("when: when 1", "when: edited"), ids));
    expect(applyAiResult(editor, captureAnchor(editor, NOTE, ids), prepared).ok).toBe(true);
    await tick();
    const hs = headingsOf(doc);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.attrs).toMatchObject({ knowledgeId: "k_00000001", knowledgeWhen: "edited" });
  });

  it("applying and undoing once restores the original headings with their knowledge", async () => {
    const doc = seededDoc([H("hA", "Alpha", K(1)), P("pA", "a")]);
    const editor = collabEditor(doc);
    const ids = sendIds(editor);
    const prepared = ok(prepare(editor, "## Alpha\n\nrewritten", ids));
    expect(applyAiResult(editor, captureAnchor(editor, NOTE, ids), prepared).ok).toBe(true);
    await tick();
    expect(headingsOf(doc)[0]!.attrs.knowledgeId).toBe("k_00000001");
    editor.undo();
    await tick();
    const hs = headingsOf(doc);
    expect(hs).toHaveLength(1);
    expect(hs[0]!.blockId).toBe("hA");
    expect(hs[0]!.attrs).toMatchObject(K(1));
  });

  it("when a collaborator changes the knowledge of a heading in the range before apply, nothing is written and nothing throws", async () => {
    const doc = seededDoc([H("hA", "Alpha", K(1)), P("pA", "a")]);
    const editor = collabEditor(doc);
    const ids = sendIds(editor);
    const anchor = captureAnchor(editor, NOTE, ids);
    const prepared = ok(prepare(editor, "## Alpha\n\nrewritten", ids));
    editor.updateBlock("hA", { props: { knowledgeConclusion: "changed by someone else" } } as never);
    await tick();
    expect(applyAiResult(editor, anchor, prepared)).toEqual({ ok: false, reason: "changed" });
    expect(headingsOf(doc)[0]!.attrs.knowledgeConclusion).toBe("changed by someone else");
    editor.removeBlocks(["hA"]);
    await tick();
    expect(applyAiResult(editor, anchor, prepared)).toEqual({ ok: false, reason: "missing" });
  });
});
