import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  YDOC_FRAGMENT,
  createHeadlessNoteSchema,
  listKnowledge,
  listKnowledgeInBlocks,
  renewKnowledgeId,
  topLevelBlocks,
} from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";
import { collabUndoManager } from "./undo";
import { knowledgeEntriesOf, KNOWLEDGE_OUTDATED_ATTR } from "./knowledge-decorations";
import { knowledgeItemsFromPmDoc } from "./knowledge-pm";

vi.mock("./knowledge-pm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./knowledge-pm")>();
  return { ...actual, scanPmKnowledge: vi.fn(actual.scanPmKnowledge) };
});
const { scanPmKnowledge } = await import("./knowledge-pm");

const toastMock = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/toast", () => ({ toast: toastMock }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");
const { BlockNoteEditor: BNEditor } = await import("@blocknote/core");

type Ed = BlockNoteEditor<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- BlockNote's three generics
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const K = (n: number, extra: Record<string, string> = {}) => ({ knowledgeId: `k_0000000${n}`, knowledgeWhen: `when ${n}`, ...extra });
const H = (id: string, level: number, text: string, props: Record<string, unknown> = {}) => ({ id, type: "heading", props: { level, ...props }, content: text });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });

function open(doc: Y.Doc, opts: { editable?: boolean; mount?: boolean } = {}): { editor: Ed; el: HTMLElement } {
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
  if (opts.editable === false) editor.isEditable = false;
  cleanups.push(() => {
    editor.unmount();
    el.remove();
  });
  return { editor, el };
}

// The seeding editor is detached again: a live editor on the same doc would also react to what the test then does.
function seeded(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  const { editor, el } = open(doc);
  editor.replaceBlocks(editor.document, blocks as never);
  editor.unmount();
  el.remove();
  cleanups.pop();
  return doc;
}

function headingsOf(doc: Y.Doc): Array<{ blockId: string; knowledgeId: string; text: string; attrs: Record<string, unknown> }> {
  return topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT)).flatMap((c) => {
    const first = c.get(0);
    if (!(first instanceof Y.XmlElement) || first.nodeName !== "heading") return [];
    const attrs = first.getAttributes() as Record<string, unknown>;
    return [{ blockId: String(c.getAttribute("id")), knowledgeId: String(attrs.knowledgeId ?? ""), text: first.toString(), attrs }];
  });
}
const idsOf = (doc: Y.Doc) => headingsOf(doc).map((h) => `${h.blockId}=${h.knowledgeId}`);

function countUpdates(doc: Y.Doc): () => number {
  let n = 0;
  doc.on("update", () => {
    n += 1;
  });
  return () => n;
}

// Two Y.Docs relaying updates to each other, each with an editor.
function pair(blocks: unknown[]) {
  const a = seeded(blocks);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "relay" && Y.applyUpdate(b, u, "relay"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "relay" && Y.applyUpdate(a, u, "relay"));
  const ea = open(a);
  const eb = open(b);
  return { a, b, ea: ea.editor, eb: eb.editor };
}

// A copy of heading `fromId` inserted right after it, written straight into the Y.Doc as another client would.
function remoteDuplicate(doc: Y.Doc, fromId: string, newBlockId: string): void {
  const frag = doc.getXmlFragment(YDOC_FRAGMENT);
  const containers = topLevelBlocks(frag);
  const index = containers.findIndex((c) => c.getAttribute("id") === fromId);
  const copy = containers[index]!.clone() as Y.XmlElement;
  copy.setAttribute("id", newBlockId);
  const group = containers[index]!.parent as Y.XmlElement;
  group.insert(containers[index]!.parent === frag ? index + 1 : group.toArray().indexOf(containers[index]!) + 1, [copy]);
}

const PROPS = { ...K(1) };

describe("duplicate knowledge ids inside one note", () => {
  it("inserting a copy of a knowledge heading after it renews the copy and keeps the original", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    editor.insertBlocks([{ type: "heading", props: { level: 1, ...PROPS }, content: "A" } as never], "e1", "after");
    await tick();
    const hs = headingsOf(doc);
    expect(hs).toHaveLength(2);
    expect(hs[0]!.knowledgeId).toBe("k_00000001");
    expect(hs[1]!.knowledgeId).toBe(renewKnowledgeId(hs[1]!.blockId, "k_00000001", new Set(["k_00000001"])));
    expect(hs[1]!.attrs.knowledgeWhen).toBe("when 1");
  });

  it("inserting a copy above the original still renews the copy, not the original", async () => {
    const doc = seeded([H("hA", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    editor.insertBlocks([{ type: "heading", props: { level: 1, ...PROPS }, content: "A" } as never], "hA", "before");
    await tick();
    const hs = headingsOf(doc);
    expect(hs).toHaveLength(2);
    expect(hs[1]!.blockId).toBe("hA");
    expect(hs[1]!.knowledgeId).toBe("k_00000001");
    expect(hs[0]!.knowledgeId).not.toBe("k_00000001");
    expect(hs[0]!.knowledgeId).toMatch(/^k_[0-9a-f]{8}$/);
  });

  it("pasting a knowledge heading copied from the same note gives the pasted one a new id", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    const view = editor._tiptapEditor.view;
    // The editor's own clipboard serialization, as a copy inside the app produces it.
    const slice = view.state.doc.slice(1, 1 + view.state.doc.firstChild!.firstChild!.nodeSize);
    const html = view.serializeForClipboard(slice).dom.innerHTML;
    editor.setTextCursorPosition("p1", "end");
    editor.pasteHTML(html, true);
    await tick();
    const hs = headingsOf(doc);
    expect(hs.length).toBe(2);
    expect(hs[0]!.knowledgeId).toBe("k_00000001");
    expect(hs[1]!.knowledgeId).not.toBe("k_00000001");
    expect(hs[1]!.knowledgeId).toMatch(/^k_[0-9a-f]{8}$/);
  });

  it("the renewal of a local insert lands in the same undo step as the insert", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    editor.insertBlocks([{ type: "heading", props: { level: 1, ...PROPS }, content: "A" } as never], "e1", "after");
    await tick();
    editor.undo();
    await tick();
    expect(idsOf(doc)).toEqual(["e1=k_00000001"]);
  });

  it("a duplicate arriving from another editor is renewed, written to the Y.Doc, and not undoable", async () => {
    const { a, b, ea } = pair([H("e1", 1, "A", PROPS), P("p1", "x")]);
    ea.insertBlocks([P("p2", "mine")] as never, "p1", "after");
    await tick();
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    remoteDuplicate(c, "e1", "dup");
    Y.applyUpdate(a, Y.encodeStateAsUpdate(c, Y.encodeStateVector(a)), "remote-test");
    await tick(150);
    const fromA = headingsOf(a);
    const fromB = headingsOf(b);
    expect(fromA.map((h) => h.blockId)).toEqual(["e1", "dup"]);
    expect(fromA[0]!.knowledgeId).toBe("k_00000001");
    expect(fromA[1]!.knowledgeId).not.toBe("k_00000001");
    expect(fromB.map((h) => h.knowledgeId)).toEqual(fromA.map((h) => h.knowledgeId));
    const renewed = fromA[1]!.knowledgeId;
    ea.undo();
    await tick(150);
    expect(headingsOf(a)[1]!.knowledgeId).toBe(renewed);
    expect(ea.document.some((blk) => blk.id === "p2")).toBe(false);
  });

  it("a renewal of a remote duplicate adds nothing to the undo stack", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    editor.insertBlocks([P("p2", "mine")] as never, "p1", "after");
    await tick();
    const manager = collabUndoManager(editor)!;
    manager.stopCapturing();
    const depth = manager.undoStack.length;
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
    remoteDuplicate(c, "e1", "dup");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(c, Y.encodeStateVector(doc)), "remote-test");
    await tick(150);
    expect(headingsOf(doc)[1]!.knowledgeId).not.toBe("k_00000001");
    expect(manager.undoStack.length).toBe(depth);
  });

  it("two editors processing the same duplicate converge on one id and stop dispatching", async () => {
    const { a, b } = pair([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const ua = countUpdates(a);
    const ub = countUpdates(b);
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    remoteDuplicate(c, "e1", "dup");
    const update = Y.encodeStateAsUpdate(c, Y.encodeStateVector(a));
    Y.applyUpdate(a, update, "remote-test");
    await tick(150);
    expect(idsOf(a)).toEqual(idsOf(b));
    const settledA = ua();
    const settledB = ub();
    await tick(250);
    expect(ua()).toBe(settledA);
    expect(ub()).toBe(settledB);
    expect(settledA).toBeLessThan(8);
  });

  it("undoing a removal that brings back a duplicate renews the later one in the Y.Doc", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
    remoteDuplicate(c, "e1", "e2");
    editor.removeBlocks(["e1"]);
    await tick();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(c, Y.encodeStateVector(doc)), "remote-test");
    await tick(150);
    expect(idsOf(doc)).toEqual(["e2=k_00000001"]);
    editor.undo();
    await tick(200);
    const hs = headingsOf(doc);
    expect(hs.map((h) => h.blockId)).toEqual(["e1", "e2"]);
    expect(hs[0]!.knowledgeId).toBe("k_00000001");
    expect(hs[1]!.knowledgeId).toBe(renewKnowledgeId("e2", "k_00000001", new Set(["k_00000001"])));
  });

  it("a read-only editor does not renew duplicates", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc, { editable: false });
    void editor;
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
    remoteDuplicate(c, "e1", "dup");
    const updates = countUpdates(doc);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(c, Y.encodeStateVector(doc)), "remote-test");
    const afterApply = updates();
    await tick(150);
    expect(updates()).toBe(afterApply);
    expect(headingsOf(doc).map((h) => h.knowledgeId)).toEqual(["k_00000001", "k_00000001"]);
  });

  it("a read-only editor does not renew a duplicate inserted by a local transaction either", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc, { editable: false });
    const view = editor._tiptapEditor.view;
    const container = view.state.doc.firstChild!.child(0);
    const copy = container.type.create({ ...container.attrs, id: "dup" }, container.content);
    view.dispatch(view.state.tr.insert(1 + container.nodeSize, copy));
    await tick(100);
    expect(headingsOf(doc).map((h) => h.knowledgeId)).toEqual(["k_00000001", "k_00000001"]);
  });

  it("a duplicate loaded while read-only is renewed once the editor becomes editable", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const c = new Y.Doc();
    Y.applyUpdate(c, Y.encodeStateAsUpdate(doc));
    remoteDuplicate(c, "e1", "dup");
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(c, Y.encodeStateVector(doc)), "remote-test");
    const { editor, el } = open(doc, { editable: false });
    await tick(100);
    expect(headingsOf(doc).map((h) => h.knowledgeId)).toEqual(["k_00000001", "k_00000001"]);
    // What the view does when a note turns editable: it is unmounted and mounted again.
    editor.unmount();
    editor.isEditable = true;
    editor.mount(el);
    await tick(100);
    const ids = headingsOf(doc).map((h) => h.knowledgeId);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe("k_00000001");
  });

  it("turning a knowledge heading into a paragraph removes the knowledge, and undo brings it back with the same id", async () => {
    const doc = seeded([H("e1", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.updateBlock("e1", { type: "paragraph" } as never);
    await tick();
    expect(headingsOf(doc)).toHaveLength(0);
    editor.undo();
    await tick(150);
    expect(idsOf(doc)).toEqual(["e1=k_00000001"]);
  });

  it("in a note without knowledge info one keystroke still produces exactly one Yjs update", async () => {
    const doc = seeded([H("h1", 1, "A"), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("p1", "end");
    const updates = countUpdates(doc);
    editor._tiptapEditor.view.dispatch(editor._tiptapEditor.view.state.tr.insertText("y"));
    await tick(150);
    expect(updates()).toBe(1);
  });

  it("opening a pre-upgrade document still writes no Yjs update with these extensions attached", async () => {
    const seed = seeded([H("h1", 1, "A"), P("p1", "x"), H("h2", 2, "B")]);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed));
    const updates = countUpdates(doc);
    open(doc);
    await tick(150);
    expect(updates()).toBe(0);
  });
});

describe("outdated decoration", () => {
  it("an outdated parent marks its knowledge descendants with the outdated attribute, not plain headings", async () => {
    const doc = seeded([
      H("h1", 1, "Parent", { ...K(1), knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" }),
      H("h2", 2, "Child", K(2)),
      H("h3", 2, "Plain child"),
      H("h4", 3, "Grandchild", K(3)),
      H("h5", 1, "Next", K(4)),
      P("p1", "x"),
    ]);
    const { el } = open(doc);
    await tick();
    const marked = (id: string) => el.querySelector(`[data-id="${id}"] .bn-block-content`)?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR);
    expect(marked("h1")).toBe(true);
    expect(marked("h2")).toBe(true);
    expect(marked("h3")).toBe(false);
    expect(marked("h4")).toBe(true);
    expect(marked("h5")).toBe(false);
  });

  it("the outdated mark reaches deeper knowledge past a plain heading, follows later edits, and drops when the parent is no longer outdated", async () => {
    const doc = seeded([
      H("h1", 1, "Parent", { ...K(1), knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" }),
      H("h2", 2, "Plain", {}),
      H("h3", 3, "Deep", K(3)),
    ]);
    const { editor, el } = open(doc);
    await tick();
    expect(el.querySelector('[data-id="h3"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(true);
    expect(el.querySelector('[data-id="h2"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(false);
    editor.updateBlock("h2", { props: K(2) } as never);
    await tick();
    expect(el.querySelector('[data-id="h3"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(true);
    expect(el.querySelector('[data-id="h2"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(true);
    editor.updateBlock("h1", { props: { knowledgeStatus: "" } } as never);
    await tick();
    expect(el.querySelector('[data-id="h3"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(false);
    expect(el.querySelector('[data-id="h1"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(false);
  });

  it("changing decorations keeps the same block DOM element", async () => {
    const doc = seeded([H("h1", 1, "Parent", K(1)), H("h2", 2, "Child", K(2)), P("p1", "x")]);
    const { editor, el } = open(doc);
    await tick();
    const before = el.querySelector('[data-id="h2"] .bn-block-content');
    editor.updateBlock("h1", { props: { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" } } as never);
    await tick();
    const after = el.querySelector('[data-id="h2"] .bn-block-content');
    expect(after?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(true);
    expect(after).toBe(before);
  });

  it("exposes the computed entries with a stable identity while the document is unchanged", async () => {
    const doc = seeded([H("h1", 1, "Parent", K(1)), H("h2", 2, "Child", K(2)), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    const first = knowledgeEntriesOf(editor._tiptapEditor.state);
    expect(first.map((e) => e.blockId)).toEqual(["h1", "h2"]);
    editor._tiptapEditor.view.dispatch(editor._tiptapEditor.state.tr.setMeta("x", 1));
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toBe(first);
  });

  it("returns an empty list for a document without knowledge, and for a state without the plugin", async () => {
    const doc = seeded([H("h1", 1, "A"), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toEqual([]);
    expect(knowledgeEntriesOf({ plugins: [] } as never)).toEqual([]);
  });

  it("typing in a note without knowledge keeps the same empty entries array (the plugin takes its cheap path)", async () => {
    const doc = seeded([H("h1", 1, "A"), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.setTextCursorPosition("p1", "end");
    editor._tiptapEditor.view.dispatch(editor._tiptapEditor.state.tr.insertText("y"));
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toBe(before);
  });

  it("a plain heading outside any knowledge never gets the outdated attribute", async () => {
    const doc = seeded([H("h1", 1, "Plain"), P("p1", "x")]);
    const { el } = open(doc);
    await tick();
    expect(el.querySelector(`[${KNOWLEDGE_OUTDATED_ATTR}]`)).toBeNull();
  });
});

// A Ctrl-drag copy inside the editor keeps the source's block id, so block ids cannot identify a heading.
function insertCopy(editor: Ed, sourceId: string, where: "before" | "after", override: Record<string, unknown> = {}): void {
  const view = editor._tiptapEditor.view;
  let pos = 1;
  let found: { node: ReturnType<typeof view.state.doc.child>; pos: number } | null = null;
  view.state.doc.firstChild!.forEach((c) => {
    if (c.attrs.id === sourceId && !found) found = { node: c, pos };
    pos += c.nodeSize;
  });
  const { node, pos: at } = found!;
  const heading = node.firstChild!;
  const copyHeading = heading.type.create({ ...heading.attrs, ...override }, heading.content);
  const copy = node.type.create(node.attrs, [copyHeading]);
  view.dispatch(view.state.tr.insert(where === "before" ? at : at + node.nodeSize, copy));
}

describe("a copy that shares its source's block id", () => {
  it("dropped above the original: the copy is renewed and the original keeps its knowledge id", async () => {
    const doc = seeded([H("hA", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    insertCopy(editor, "hA", "before");
    await tick();
    const hs = headingsOf(doc);
    expect(hs.map((h) => h.blockId)).toEqual(["hA", "hA"]);
    expect(hs[0]!.knowledgeId).not.toBe("k_00000001");
    expect(hs[1]!.knowledgeId).toBe("k_00000001");
  });

  it("dropped below the original: the copy is renewed and the original keeps its knowledge id", async () => {
    const doc = seeded([H("hA", 1, "A", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    insertCopy(editor, "hA", "after");
    await tick();
    const hs = headingsOf(doc);
    expect(hs[0]!.knowledgeId).toBe("k_00000001");
    expect(hs[1]!.knowledgeId).not.toBe("k_00000001");
  });

  it("the outdated mark goes on the heading that is outdated, not on the one sharing its block id", async () => {
    const doc = seeded([H("hA", 1, "A", K(1)), P("p1", "x")]);
    const { editor, el } = open(doc);
    await tick();
    insertCopy(editor, "hA", "before", { knowledgeId: "k_00000002", knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" });
    await tick();
    const contents = [...el.querySelectorAll('.bn-block-content[data-content-type="heading"]')];
    expect(contents).toHaveLength(2);
    expect(contents.map((c) => c.hasAttribute(KNOWLEDGE_OUTDATED_ATTR))).toEqual([true, false]);
  });
});

describe("a knowledge heading moved to the top level by outdenting", () => {
  const outdated = { ...K(1), knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" };

  it("a nested knowledge heading outdented into a note without top-level knowledge gets its entry and its outdated mark", async () => {
    const doc = seeded([P("p0", "intro"), { id: "l1", type: "bulletListItem", content: "item", children: [H("n1", 1, "Nested", outdated)] }]);
    const { editor, el } = open(doc);
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toEqual([]);
    editor.setTextCursorPosition("n1", "start");
    editor.unnestBlock();
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state).map((e) => e.blockId)).toEqual(["n1"]);
    expect(el.querySelector('[data-id="n1"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(true);
  });

  it("the only top-level knowledge heading can be indented and outdented again", async () => {
    const doc = seeded([P("p0", "intro"), H("h1", 1, "Heading", outdated)]);
    const { editor, el } = open(doc);
    await tick();
    editor.setTextCursorPosition("h1", "start");
    editor.nestBlock();
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toEqual([]);
    editor.setTextCursorPosition("h1", "start");
    editor.unnestBlock();
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state).map((e) => e.blockId)).toEqual(["h1"]);
    expect(el.querySelector('[data-id="h1"] .bn-block-content')?.hasAttribute(KNOWLEDGE_OUTDATED_ATTR)).toBe(true);
  });

  it("outdenting a nested heading whose knowledge id exists at the top level renews one of them", async () => {
    const doc = seeded([H("h1", 1, "Top", PROPS), { id: "l1", type: "bulletListItem", content: "item", children: [H("n1", 1, "Nested", PROPS)] }]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("n1", "start");
    editor.unnestBlock();
    await tick(150);
    const ids = headingsOf(doc).map((h) => h.knowledgeId);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("entries and decorations while editing", () => {
  const blocks = () => [
    P("p0", "intro"),
    H("h1", 1, "Parent", { ...K(1), knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000009" }),
    P("p1", "body"),
    H("h2", 2, "Child", K(2)),
    P("p2", "more"),
  ];
  const type = (editor: Ed, text: string) => editor._tiptapEditor.view.dispatch(editor._tiptapEditor.state.tr.insertText(text));
  const markedIds = (el: HTMLElement) => [...el.querySelectorAll(`[${KNOWLEDGE_OUTDATED_ATTR}]`)].map((e) => e.closest("[data-id]")?.getAttribute("data-id"));

  it("Backspace at the start of the paragraph under a knowledge heading joins it into the heading and updates the entry text", async () => {
    const { editor } = open(seeded(blocks()));
    await tick();
    editor.setTextCursorPosition("p2", "start");
    const view = editor._tiptapEditor.view as unknown as { someProp: (n: string, f: (fn: (...a: unknown[]) => boolean) => boolean | undefined) => boolean };
    const event = new KeyboardEvent("keydown", { key: "Backspace", code: "Backspace", keyCode: 8, bubbles: true, cancelable: true } as KeyboardEventInit);
    view.someProp("handleKeyDown", (f) => f(view, event));
    await tick();
    expect(editor.document.some((b) => b.id === "p2")).toBe(false);
    const entry = knowledgeEntriesOf(editor._tiptapEditor.state).find((e) => e.blockId === "h2")!;
    expect(entry.heading).toBe("Childmore");
  });

  it("typing over a selection that runs from a paragraph into a knowledge heading keeps the entries equal to the document", async () => {
    const { editor } = open(seeded(blocks()));
    await tick();
    const view = editor._tiptapEditor.view;
    let from = 0;
    let to = 0;
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === "blockContainer" && node.attrs.id === "p1") from = pos + 2 + 1;
      if (node.type.name === "blockContainer" && node.attrs.id === "h2") to = pos + 2 + 2;
      return true;
    });
    editor._tiptapEditor.commands.setTextSelection({ from, to });
    view.dispatch(view.state.tr.insertText("X"));
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toEqual(listKnowledgeInBlocks(editor.document as never));
  });

  it("typing in a paragraph keeps the same entries array and moves the decorations with the text", async () => {
    const { editor, el } = open(seeded(blocks()));
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.setTextCursorPosition("p0", "start");
    type(editor, "abc");
    type(editor, "def");
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toBe(before);
    expect(markedIds(el)).toEqual(["h1", "h2"]);
  });

  it("typing in a paragraph does not rescan the document, typing in a heading does", async () => {
    const { editor } = open(seeded(blocks()));
    await tick();
    const scans = vi.mocked(scanPmKnowledge);
    scans.mockClear();
    editor.setTextCursorPosition("p0", "start");
    type(editor, "abc");
    expect(scans).not.toHaveBeenCalled();
    editor.setTextCursorPosition("h2", "end");
    type(editor, "!");
    expect(scans).toHaveBeenCalled();
  });

  it("typing in a plain heading rescans but keeps the same entries array when nothing changed", async () => {
    const { editor } = open(seeded([...blocks(), H("h9", 1, "Plain")]));
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.setTextCursorPosition("h9", "end");
    type(editor, "!");
    expect(vi.mocked(scanPmKnowledge)).toHaveBeenCalled();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toBe(before);
  });

  it("typing in a knowledge heading recomputes the entries", async () => {
    const { editor } = open(seeded(blocks()));
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.setTextCursorPosition("h2", "end");
    type(editor, "!");
    const after = knowledgeEntriesOf(editor._tiptapEditor.state);
    expect(after).not.toBe(before);
    expect(after.find((e) => e.blockId === "h2")!.heading).toBe("Child!");
  });

  it("changing a knowledge property recomputes the entries", async () => {
    const { editor } = open(seeded(blocks()));
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.updateBlock("h2", { props: { knowledgeWhen: "changed" } } as never);
    await tick();
    const after = knowledgeEntriesOf(editor._tiptapEditor.state);
    expect(after).not.toBe(before);
    expect(after.find((e) => e.blockId === "h2")!.info.when).toBe("changed");
  });

  it("a block added inside a range updates that range's entries", async () => {
    const { editor, el } = open(seeded(blocks()));
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.insertBlocks([P("p9", "inside the range")] as never, "p1", "after");
    await tick();
    const after = knowledgeEntriesOf(editor._tiptapEditor.state);
    expect(after).not.toBe(before);
    expect(after.find((e) => e.blockId === "h1")!.rangeBlockIds).toContain("p9");
    expect(markedIds(el)).toEqual(["h1", "h2"]);
  });

  it("inserting and removing blocks between headings keeps the decorations on the right headings", async () => {
    const { editor, el } = open(seeded(blocks()));
    await tick();
    editor.insertBlocks([P("a", "one"), P("b", "two")] as never, "p0", "after");
    await tick();
    expect(markedIds(el)).toEqual(["h1", "h2"]);
    editor.removeBlocks(["p1", "a"]);
    await tick();
    expect(markedIds(el)).toEqual(["h1", "h2"]);
    editor.removeBlocks(["h1"]);
    await tick();
    expect(markedIds(el)).toEqual([]);
  });

  it("rewriting a property with the value it already has keeps the same array", async () => {
    const { editor } = open(seeded(blocks()));
    await tick();
    const before = knowledgeEntriesOf(editor._tiptapEditor.state);
    editor.updateBlock("h2", { props: { knowledgeWhen: "when 2" } } as never);
    await tick();
    expect(knowledgeEntriesOf(editor._tiptapEditor.state)).toBe(before);
  });
});

describe("reading headings from the ProseMirror document", () => {
  it("matches listKnowledgeInBlocks for line breaks, wikilinks, nesting and non-top-level headings", () => {
    const schema = createHeadlessNoteSchema("http://localhost/");
    const editor = BNEditor.create({ schema }) as unknown as Ed;
    editor.replaceBlocks(editor.document, [
      H("h1", 1, "Plain  title", K(1)),
      { id: "h2", type: "heading", props: { level: 2, ...K(2) }, content: [{ type: "text", text: "line one", styles: {} }, { type: "text", text: "\n", styles: {} }, { type: "text", text: "two", styles: {} }] },
      {
        id: "h3",
        type: "heading",
        props: { level: 3, ...K(3, { knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000001" }) },
        content: [
          { type: "text", text: "see ", styles: {} },
          { type: "wikilink", props: { label: "Linked", snapshotTitle: "Snap", targetNoteId: "00000000-0000-4000-8000-000000000001", anchorBlockId: "" } },
          { type: "wikilink", props: { label: "", snapshotTitle: "OnlySnap", targetNoteId: "00000000-0000-4000-8000-000000000002", anchorBlockId: "" } },
        ],
      },
      { id: "list", type: "bulletListItem", content: "item", children: [H("nested", 1, "Nested heading", K(5))] },
      H("h4", 2, "Next", K(4)),
      H("h5", 9 as number, "Odd level", K(6)),
      P("p1", "x"),
    ] as never);
    const state = (editor as unknown as { prosemirrorState: { doc: Parameters<typeof knowledgeItemsFromPmDoc>[0] } }).prosemirrorState;
    const fromPm = listKnowledge(knowledgeItemsFromPmDoc(state.doc));
    const fromBlocks = listKnowledgeInBlocks(editor.document as never);
    expect(fromPm.length).toBeGreaterThan(3);
    expect(fromPm).toEqual(fromBlocks);
    expect(fromPm.find((e) => e.blockId === "h2")!.heading).toBe("line one two");
    expect(fromPm.find((e) => e.blockId === "h3")!.heading).toBe("see LinkedOnlySnap");
    expect(fromPm.some((e) => e.blockId === "nested")).toBe(false);
  });

  it("treats a non-string or out-of-range level and non-string props as empty without throwing", () => {
    const schema = createHeadlessNoteSchema("http://localhost/");
    void schema;
    const heading = { type: { name: "heading" }, attrs: { level: 9, knowledgeId: 5 }, forEach: () => undefined };
    const container = { type: { name: "blockContainer" }, attrs: { id: "x" }, firstChild: heading, nodeSize: 3 };
    const group = { type: { name: "blockGroup" }, forEach: (f: (n: unknown) => void) => f(container), childCount: 1 };
    const items = knowledgeItemsFromPmDoc({ firstChild: group } as never);
    expect(items).toEqual([{ blockId: "x", heading: { level: 1, text: "", props: expect.any(Object) } }]);
  });
});

describe("Enter at the start of a knowledge heading", () => {
  function pressEnter(editor: Ed, composing = false): boolean {
    const view = editor._tiptapEditor.view as unknown as { composing: boolean; someProp: (n: string, f: (fn: (...a: unknown[]) => boolean) => boolean | undefined) => boolean };
    const event = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true } as KeyboardEventInit);
    Object.defineProperty(view, "composing", { value: composing, configurable: true });
    try {
      return Boolean(view.someProp("handleKeyDown", (f) => f(view, event)));
    } finally {
      delete (view as unknown as Record<string, unknown>).composing;
    }
  }

  it("Enter at the start of a non-empty knowledge heading inserts an empty paragraph above and leaves the heading, its block id and its knowledge in place", async () => {
    const doc = seeded([H("e1", 1, "Hello", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    expect(pressEnter(editor)).toBe(true);
    await tick();
    const blocks = editor.document;
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(blocks[0]!.content).toEqual([]);
    expect(blocks[1]).toMatchObject({ id: "e1", props: { knowledgeId: "k_00000001", knowledgeWhen: "when 1" } });
    expect(headingsOf(doc).map((h) => `${h.blockId}=${h.knowledgeId}`)).toEqual(["e1=k_00000001"]);
    const sel = editor.getTextCursorPosition();
    expect(sel.block.id).toBe("e1");
    editor._tiptapEditor.view.dispatch(editor._tiptapEditor.state.tr.insertText("Z"));
    expect(editor.document[1]!.content).toEqual([expect.objectContaining({ text: "ZHello" })]);
  });

  it("Enter at the start of a knowledge heading during IME composition is left to the editor", async () => {
    const doc = seeded([H("e1", 1, "Hello", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    pressEnter(editor, true);
    await tick();
    expect(editor.document[0]).toMatchObject({ type: "heading" });
  });

  it("Enter at the start of a plain heading keeps the editor's behaviour", async () => {
    const doc = seeded([H("e1", 1, "Hello"), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    pressEnter(editor);
    await tick();
    const blocks = editor.document;
    expect(blocks[0]).toMatchObject({ type: "heading", content: [] });
    expect(blocks[1]).toMatchObject({ id: expect.not.stringMatching(/^e1$/), type: "heading" });
    expect(blocks[1]!.content).toEqual([expect.objectContaining({ text: "Hello" })]);
  });

  it("Enter in the middle of a knowledge heading keeps the editor's behaviour", async () => {
    const doc = seeded([H("e1", 1, "Hello", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    const view = editor._tiptapEditor.view;
    editor._tiptapEditor.commands.setTextSelection(view.state.selection.from + 2);
    pressEnter(editor);
    await tick();
    const blocks = editor.document;
    expect(blocks[0]).toMatchObject({ id: "e1", type: "heading", props: { knowledgeId: "k_00000001" } });
    expect(blocks[0]!.content).toEqual([expect.objectContaining({ text: "He" })]);
    expect(blocks[1]).toMatchObject({ type: "paragraph" });
    expect(blocks[1]!.content).toEqual([expect.objectContaining({ text: "llo" })]);
    expect(Object.keys(blocks[1]!.props)).not.toContain("knowledgeId");
  });

  it("Enter at the start of an empty knowledge heading keeps the editor's behaviour", async () => {
    const doc = seeded([H("e1", 1, "", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    pressEnter(editor);
    await tick();
    expect(editor.document[0]).toMatchObject({ type: "heading" });
  });

  it("Enter with a selection that starts at the start of a knowledge heading and ends inside it deletes the selection and inserts the paragraph above, in one Yjs update", async () => {
    const doc = seeded([H("e1", 1, "Hello world", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    const from = editor._tiptapEditor.view.state.selection.from;
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 6 });
    const updates = countUpdates(doc);
    expect(pressEnter(editor)).toBe(true);
    await tick();
    expect(updates()).toBe(1);
    const blocks = editor.document;
    expect(blocks.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(blocks[1]).toMatchObject({ id: "e1", props: { knowledgeId: "k_00000001", knowledgeWhen: "when 1" } });
    expect(blocks[1]!.content).toEqual([expect.objectContaining({ text: "world" })]);
    expect(headingsOf(doc).map((h) => `${h.blockId}=${h.knowledgeId}`)).toEqual(["e1=k_00000001"]);
  });

  it("Enter with the whole heading text selected leaves an empty knowledge heading under a new paragraph", async () => {
    const doc = seeded([H("e1", 1, "Hello", PROPS), P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    const from = editor._tiptapEditor.view.state.selection.from;
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 5 });
    pressEnter(editor);
    await tick();
    expect(editor.document.map((b) => b.type)).toEqual(["paragraph", "heading", "paragraph"]);
    expect(editor.document[1]).toMatchObject({ id: "e1", content: [], props: { knowledgeId: "k_00000001" } });
  });

  it("Enter with a selection that reaches into another block is left to the editor", async () => {
    const doc = seeded([H("e1", 1, "Hello", PROPS), P("p1", "next block")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("e1", "start");
    const from = editor._tiptapEditor.view.state.selection.from;
    editor._tiptapEditor.commands.setTextSelection({ from, to: from + 9 });
    pressEnter(editor);
    await tick();
    // The editor's own handling merges into the later block; the new behaviour would put a fresh empty paragraph first.
    expect(editor.document[0]!.id).toBe("p1");
  });

  it("Enter at the start of a knowledge-carrying heading nested in a list keeps the editor's behaviour", async () => {
    const doc = seeded([{ id: "l1", type: "bulletListItem", content: "item", children: [H("n1", 1, "Nested", PROPS)] }, P("p1", "x")]);
    const { editor } = open(doc);
    await tick();
    editor.setTextCursorPosition("n1", "start");
    pressEnter(editor);
    await tick();
    const children = editor.document[0]!.children;
    expect(children.map((b) => b.type)).toEqual(["heading", "heading"]);
    expect(children[0]).toMatchObject({ content: [] });
  });
});
