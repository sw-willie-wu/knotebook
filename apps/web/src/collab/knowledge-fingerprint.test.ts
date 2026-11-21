/**
 * Documents written before headings carried knowledge props go through the real editor binding (y-prosemirror via
 * buildNoteEditorOptions): the binding must not write the new props back or touch blocks nobody edited, because every
 * written byte changes block fingerprints that stored `if_match` values and bulk downloads depend on.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BlockNoteEditor, BlockNoteSchema, defaultBlockSpecs } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { KNOWLEDGE_PROP_NAMES, YDOC_FRAGMENT, canonicalizeElements, createHeadlessNoteSchema, topLevelBlocks } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { captureAnchor } from "@/ai/anchor";

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");
const { applyAiResult, prepareAiResult } = await import("@/ai/apply");

const tick = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const H = (id: string, level: number, text: string, props: Record<string, unknown> = {}) => ({ id, type: "heading", props: { level, ...props }, content: text });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });
const OLD_BLOCKS = [
  P("p0", "intro"),
  H("hA", 1, "A"), P("a1", "one"), P("a2", "two"),
  H("hB", 1, "B", { textColor: "red" }), P("b1", "three"),
  H("hC", 1, "C", { isToggleable: true }), P("c1", "four"),
  H("hD", 1, "D"), P("d1", "five"), H("hE", 2, "E"), P("e1", "six"),
];
const NOT_TOGGLEABLE_BLOCKS = OLD_BLOCKS.map((b) => ("props" in b ? H(b.id, (b.props as { level: number }).level, b.content, b.id === "hB" ? { textColor: "red" } : {}) : b));

// The document is written with the schema as it was before headings carried knowledge props.
function buildOld(blocks: unknown[]): Y.Doc {
  const current = createHeadlessNoteSchema("http://localhost/");
  const schema = BlockNoteSchema.create({ blockSpecs: { ...current.blockSpecs, heading: defaultBlockSpecs.heading }, inlineContentSpecs: current.inlineContentSpecs });
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration's option type requires the full schema triple
    withCollaboration({ schema, collaboration: { provider: { awareness: undefined }, fragment: doc.getXmlFragment(YDOC_FRAGMENT), user: { name: "seed", color: "#000" } } } as any),
  );
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  editor.replaceBlocks(editor.document, blocks as never);
  editor.unmount();
  el.remove();
  return doc;
}

interface Snap {
  headingAttrs: Record<string, string[]>;
  perBlock: Record<string, string>;
}
function measure(doc: Y.Doc): Snap {
  const headingAttrs: Record<string, string[]> = {};
  const perBlock: Record<string, string> = {};
  for (const c of topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))) {
    const id = String(c.getAttribute("id"));
    const first = c.get(0);
    if (first instanceof Y.XmlElement && first.nodeName === "heading") headingAttrs[id] = Object.keys(first.getAttributes()).sort();
    perBlock[id] = canonicalizeElements([c]);
  }
  return { headingAttrs, perBlock };
}
const changedIds = (a: Snap, b: Snap) => Object.keys(a.perBlock).filter((k) => a.perBlock[k] !== b.perBlock[k]);

function openWeb(doc: Y.Doc) {
  const editorRef: EditorRef = { current: null };
  const editor = BlockNoteEditor.create(
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
  ) as any as BlockNoteEditor<any, any, any>;
  editorRef.current = editor as never;
  const el = document.createElement("div");
  document.body.appendChild(el);
  editor.mount(el);
  cleanups.push(() => {
    editor.unmount();
    el.remove();
    doc.destroy();
  });
  return editor;
}

function copyOf(old: Y.Doc): Y.Doc {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(old));
  return doc;
}

function countUpdates(doc: Y.Doc): () => number {
  let n = 0;
  doc.on("update", () => {
    n += 1;
  });
  return () => n;
}

describe("web editor binding with knowledge props on headings", () => {
  it("the web schema's heading carries the knowledge props", () => {
    const editor = openWeb(new Y.Doc());
    const props = Object.keys(editor.schema.blockSchema.heading.propSchema as Record<string, unknown>);
    for (const name of KNOWLEDGE_PROP_NAMES) expect(props).toContain(name);
  });

  it("opening a pre-upgrade document writes no Yjs update and changes no block", async () => {
    const old = buildOld(OLD_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const updates = countUpdates(doc);
    openWeb(doc);
    await tick();
    expect(updates()).toBe(0);
    expect(changedIds(base, measure(doc))).toEqual([]);
    expect(measure(doc).headingAttrs).toEqual(base.headingAttrs);
  });

  it("moving the caret into a heading writes no Yjs update", async () => {
    const old = buildOld(OLD_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const updates = countUpdates(doc);
    const editor = openWeb(doc);
    await tick();
    editor.setTextCursorPosition("hB", "end");
    await tick();
    expect(updates()).toBe(0);
    expect(changedIds(base, measure(doc))).toEqual([]);
  });

  it("editing one paragraph changes only that paragraph", async () => {
    const old = buildOld(OLD_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const editor = openWeb(doc);
    await tick();
    editor.updateBlock("b1", { content: "three edited" });
    await tick();
    const now = measure(doc);
    expect(changedIds(base, now)).toEqual(["b1"]);
    expect(now.headingAttrs).toEqual(base.headingAttrs);
  });

  it("editing a paragraph and inserting another changes only the edited one", async () => {
    const old = buildOld(OLD_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const editor = openWeb(doc);
    await tick();
    editor.updateBlock("a1", { content: "one edited" });
    await tick();
    editor.insertBlocks([{ type: "paragraph", content: "tail" }], "e1", "after");
    await tick();
    const now = measure(doc);
    expect(changedIds(base, now)).toEqual(["a1"]);
    expect(now.headingAttrs).toEqual(base.headingAttrs);
  });

  it("typing in a heading changes only that heading", async () => {
    const old = buildOld(OLD_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const editor = openWeb(doc);
    await tick();
    editor.updateBlock("hB", { content: "B edited" });
    await tick();
    expect(changedIds(base, measure(doc))).toEqual(["hB"]);
  });

  it("an AI selection rewrite of one paragraph leaves every heading's canonical form unchanged", async () => {
    const old = buildOld(OLD_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const editor = openWeb(doc);
    await tick();
    const anchor = captureAnchor(editor as never, "n", ["b1"]);
    const prepared = prepareAiResult(editor as never, "three rewritten", { notes: [], placement: "top" });
    if ("empty" in prepared || "invalid" in prepared) throw new Error("expected a non-empty result");
    const out = applyAiResult(editor as never, anchor, prepared);
    expect(out.ok).toBe(true);
    await tick();
    const now = measure(doc);
    for (const id of ["hA", "hB", "hC", "hD", "hE"]) expect(now.perBlock[id], id).toBe(base.perBlock[id]);
    expect(now.headingAttrs).toEqual(base.headingAttrs);
  });

  it("an AI selection rewrite that returns a heading with the same text gives that heading the same canonical form", async () => {
    // A coloured heading round-trips as raw HTML; isToggleable has no markdown form, so hC is not toggleable here.
    const old = buildOld(NOT_TOGGLEABLE_BLOCKS);
    const base = measure(old);
    const doc = copyOf(old);
    const editor = openWeb(doc);
    await tick();
    const anchor = captureAnchor(editor as never, "n", ["hB", "b1"]);
    const prepared = prepareAiResult(editor as never, '<h1 data-text-color="red">B</h1>\n\nthree edited', { notes: [], placement: "top" });
    if ("empty" in prepared || "invalid" in prepared) throw new Error("expected a non-empty result");
    expect(applyAiResult(editor as never, anchor, prepared).ok).toBe(true);
    await tick();
    const now = measure(doc);
    const rewritten = topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).find((c) => {
      const first = c.get(0);
      return first instanceof Y.XmlElement && first.nodeName === "heading" && String((first.get(0) as Y.XmlText | undefined)?.toString() ?? "").includes("B");
    });
    expect(rewritten).toBeDefined();
    expect(canonicalizeElements([rewritten!])).toBe(base.perBlock.hB);
    for (const id of ["hA", "hC", "hD", "hE"]) expect(now.perBlock[id], id).toBe(base.perBlock[id]);
  });
});
