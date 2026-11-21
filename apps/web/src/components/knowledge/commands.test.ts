import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { BlockNoteEditor } from "@blocknote/core";
import { YDOC_FRAGMENT, readKnowledgeInfo, topLevelBlocks, type KnowledgeDraft, type KnowledgeInfo } from "@knotebook/shared";
import type { EditorRef } from "@/components/wikilink/menu";

vi.mock("@/components/ui/toast", () => ({ toast: vi.fn() }));
const { buildNoteEditorOptions } = await import("@/components/NoteEditor");
const { BlockNoteEditor: BNEditor } = await import("@blocknote/core");
const { currentKnowledgeTarget, isKnowledgeEligible, markKnowledgeVerified, removeKnowledge, saveKnowledge, todayLocalDate } = await import("./commands");

type Ed = BlockNoteEditor<any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- BlockNote's three generics
const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.restoreAllMocks();
});

const H = (id: string, text: string, props: Record<string, unknown> = {}) => ({ id, type: "heading", props: { level: 1, ...props }, content: text });
const P = (id: string, text: string) => ({ id, type: "paragraph", content: text });

function open(doc: Y.Doc, editable = true): Ed {
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
  if (!editable) editor.isEditable = false;
  cleanups.push(() => {
    editor.unmount();
    el.remove();
  });
  return editor;
}

function seeded(blocks: unknown[]): Y.Doc {
  const doc = new Y.Doc();
  const editor = open(doc);
  editor.replaceBlocks(editor.document, blocks as never);
  cleanups.pop()!();
  return doc;
}

function attrsOf(doc: Y.Doc, blockId: string): Record<string, unknown> {
  for (const c of topLevelBlocks(doc.getXmlFragment(YDOC_FRAGMENT))) {
    if (c.getAttribute("id") === blockId) return (c.get(0) as Y.XmlElement).getAttributes() as Record<string, unknown>;
  }
  throw new Error(`no block ${blockId}`);
}

function pair(blocks: unknown[]) {
  const a = seeded(blocks);
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  a.on("update", (u: Uint8Array, origin: unknown) => origin !== "relay" && Y.applyUpdate(b, u, "relay"));
  b.on("update", (u: Uint8Array, origin: unknown) => origin !== "relay" && Y.applyUpdate(a, u, "relay"));
  return { a, b, ea: open(a), eb: open(b) };
}

const EMPTY: KnowledgeDraft = { when: "", conclusion: "", evidence: "", verified: "", status: "", supersededBy: "" };
const draft = (over: Partial<KnowledgeDraft>): KnowledgeDraft => ({ ...EMPTY, ...over });
const infoOf = (editor: Ed, id: string): KnowledgeInfo | null => readKnowledgeInfo(editor.getBlock(id)?.props as Record<string, unknown>);
const K1 = { knowledgeId: "k_00000001", knowledgeWhen: "alice reads", knowledgeConclusion: "bob concludes" };

describe("saveKnowledge", () => {
  it("saving on a plain top-level heading creates knowledge with a new id and only the filled props", async () => {
    const doc = seeded([H("h1", "Title"), P("p1", "x")]);
    const editor = open(doc);
    const result = saveKnowledge(editor, "h1", null, draft({ when: "alice" }), null);
    await tick();
    expect(result.ok).toBe(true);
    const attrs = attrsOf(doc, "h1");
    expect(attrs.knowledgeId).toMatch(/^k_[0-9a-f]{8}$/);
    expect(attrs.knowledgeWhen).toBe("alice");
    expect(attrs.knowledgeConclusion ?? "").toBe("");
    expect(attrs.knowledgeEvidence ?? "").toBe("");
    expect(attrs.knowledgeStatus ?? "").toBe("");
  });

  it("a new id never collides with another heading's id", () => {
    const editor = open(seeded([H("h1", "A", K1), H("h2", "B")]));
    const result = saveKnowledge(editor, "h2", null, draft({ when: "x" }), null);
    expect(result.ok && result.knowledgeId).not.toBe("k_00000001");
  });

  it("saving with every field empty writes nothing and reports empty", async () => {
    const doc = seeded([H("h1", "Title")]);
    const editor = open(doc);
    const update = vi.fn();
    doc.on("update", update);
    expect(saveKnowledge(editor, "h1", null, EMPTY, null)).toEqual({ ok: false, reason: "empty" });
    await tick();
    expect(update).not.toHaveBeenCalled();
  });

  it("saving writes only the props that differ from the snapshot taken when the form opened", () => {
    const editor = open(seeded([H("h1", "Title", K1)]));
    const base = infoOf(editor, "h1")!;
    const spy = vi.spyOn(editor, "updateBlock");
    const result = saveKnowledge(editor, "h1", base, draft({ when: base.when, conclusion: "new conclusion" }), null);
    expect(result).toEqual({ ok: true, knowledgeId: "k_00000001" });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toEqual({ props: { knowledgeConclusion: "new conclusion" } });
  });

  it("a field a collaborator changed after the form opened keeps their value when the form saves another field", async () => {
    const { a, ea, eb } = pair([H("h1", "Title", K1)]);
    const base = infoOf(ea, "h1")!;
    eb.updateBlock("h1", { props: { knowledgeConclusion: "from b" } } as never);
    await tick();
    saveKnowledge(ea, "h1", base, draft({ when: "from a", conclusion: base.conclusion }), null);
    await tick();
    expect(attrsOf(a, "h1").knowledgeWhen).toBe("from a");
    expect(attrsOf(a, "h1").knowledgeConclusion).toBe("from b");
  });

  it("two editors changing different fields at the same time keep both changes", async () => {
    const { a, b, ea, eb } = pair([H("h1", "Title", K1)]);
    const base = infoOf(ea, "h1")!;
    saveKnowledge(ea, "h1", base, draft({ when: "a when", conclusion: base.conclusion }), null);
    saveKnowledge(eb, "h1", base, draft({ when: base.when, conclusion: "b conclusion" }), null);
    await tick();
    for (const doc of [a, b]) {
      expect(attrsOf(doc, "h1").knowledgeWhen).toBe("a when");
      expect(attrsOf(doc, "h1").knowledgeConclusion).toBe("b conclusion");
    }
  });

  it("pasted line breaks are saved as spaces and the text is trimmed", () => {
    const editor = open(seeded([H("h1", "Title")]));
    saveKnowledge(editor, "h1", null, draft({ when: "  first\r\nsecond\nthird ", conclusion: "x" }), null);
    expect(infoOf(editor, "h1")!.when).toBe("first second third");
  });

  it("one save is one undo step", async () => {
    const doc = seeded([H("h1", "Title", K1)]);
    const editor = open(doc);
    const base = infoOf(editor, "h1")!;
    saveKnowledge(editor, "h1", base, draft({ when: "w2", conclusion: "c2", evidence: "tested", verified: "2026-01-02", status: "unverified" }), null);
    await tick();
    expect(infoOf(editor, "h1")).toMatchObject({ when: "w2", conclusion: "c2", evidence: "tested", verified: "2026-01-02", status: "unverified" });
    editor.undo();
    await tick();
    expect(infoOf(editor, "h1")).toMatchObject({ when: "alice reads", conclusion: "bob concludes", evidence: "", verified: "", status: "" });
  });

  it("saving to a heading that became a paragraph, moved into a column or was deleted writes nothing and reports notEligible", async () => {
    const doc = seeded([H("h1", "A", K1), H("h2", "B", { knowledgeId: "k_00000002" }), H("h3", "C", { knowledgeId: "k_00000003" })]);
    const editor = open(doc);
    editor.updateBlock("h1", { type: "paragraph" } as never);
    editor.removeBlocks(["h3"]);
    const update = vi.fn();
    doc.on("update", update);
    expect(saveKnowledge(editor, "h1", null, draft({ when: "x" }), null)).toEqual({ ok: false, reason: "notEligible" });
    expect(saveKnowledge(editor, "h3", null, draft({ when: "x" }), null)).toEqual({ ok: false, reason: "notEligible" });
    await tick();
    expect(update).not.toHaveBeenCalled();
  });

  it("a heading nested under another block is not eligible", async () => {
    const editor = open(seeded([P("p1", "x")]));
    editor.insertBlocks([H("c1", "Child") as never], "p1", "after");
    editor.setTextCursorPosition("c1");
    editor.nestBlock();
    await tick();
    expect(isKnowledgeEligible(editor, "c1")).toBe(false);
    expect(saveKnowledge(editor, "c1", null, draft({ when: "x" }), null)).toEqual({ ok: false, reason: "notEligible" });
  });

  it("a read-only editor refuses every write", () => {
    const editor = open(seeded([H("h1", "A", K1)]), false);
    expect(saveKnowledge(editor, "h1", null, draft({ when: "x" }), null)).toEqual({ ok: false, reason: "notEligible" });
    expect(markKnowledgeVerified(editor, "h1")).toBe(false);
    expect(removeKnowledge(editor, "h1")).toBe(false);
  });

  it("when the knowledge was removed while the form was open, saving writes every filled field and keeps the id", async () => {
    const { a, ea, eb } = pair([H("h1", "Title", K1)]);
    const base = infoOf(ea, "h1")!;
    removeKnowledge(eb, "h1");
    await tick();
    const result = saveKnowledge(ea, "h1", base, draft({ when: base.when, conclusion: base.conclusion, evidence: "docs" }), null);
    await tick();
    expect(result.ok).toBe(true);
    expect(attrsOf(a, "h1")).toMatchObject({ knowledgeWhen: "alice reads", knowledgeConclusion: "bob concludes", knowledgeEvidence: "docs" });
    expect(attrsOf(a, "h1").knowledgeId).toBe("k_00000001");
  });

  it("when the knowledge was removed while the form was open and its id is now used elsewhere, saving writes a new id", async () => {
    const { a, ea, eb } = pair([H("h1", "Title", K1), H("h2", "Other")]);
    const base = infoOf(ea, "h1")!;
    removeKnowledge(eb, "h1");
    eb.updateBlock("h2", { props: { knowledgeId: "k_00000001", knowledgeWhen: "taken" } } as never);
    await tick();
    const result = saveKnowledge(ea, "h1", base, draft({ when: base.when }), null);
    await tick();
    expect(result.ok).toBe(true);
    const id = attrsOf(a, "h1").knowledgeId as string;
    expect(id).toMatch(/^k_[0-9a-f]{8}$/);
    expect(id).not.toBe("k_00000001");
  });

  it("rejects an outdated draft without a replacement and a replacement that points at itself", () => {
    const editor = open(seeded([H("h1", "A", K1)]));
    const base = infoOf(editor, "h1")!;
    expect(saveKnowledge(editor, "h1", base, draft({ when: "x", status: "outdated" }), null)).toEqual({ ok: false, reason: "supersededRequired" });
    expect(saveKnowledge(editor, "h1", base, draft({ when: "x", status: "outdated", supersededBy: "k_00000001" }), null)).toEqual({ ok: false, reason: "supersededSelf" });
  });
});

describe("markKnowledgeVerified", () => {
  it("sets today and turns needs review back to current, and refuses outdated knowledge", () => {
    const editor = open(seeded([H("h1", "A", { ...K1, knowledgeStatus: "unverified" }), H("h2", "B", { knowledgeId: "k_00000002", knowledgeStatus: "outdated", knowledgeSupersededBy: "k_00000001" }), P("p1", "x")]));
    expect(markKnowledgeVerified(editor, "h1", new Date(2026, 0, 31, 23, 59))).toBe(true);
    expect(infoOf(editor, "h1")).toMatchObject({ verified: "2026-01-31", status: "" });
    expect(markKnowledgeVerified(editor, "h2")).toBe(false);
    expect(infoOf(editor, "h2")!.verified).toBe("");
    expect(markKnowledgeVerified(editor, "p1")).toBe(false);
  });

  it("refuses a heading that is not knowledge", () => {
    const editor = open(seeded([H("h1", "A")]));
    expect(markKnowledgeVerified(editor, "h1")).toBe(false);
  });
});

describe("removeKnowledge", () => {
  it("empties all seven props and undo restores them", async () => {
    const doc = seeded([H("h1", "A", { ...K1, knowledgeEvidence: "tested", knowledgeVerified: "2026-01-01", knowledgeStatus: "unverified" })]);
    const editor = open(doc);
    expect(removeKnowledge(editor, "h1")).toBe(true);
    await tick();
    expect(infoOf(editor, "h1")).toBeNull();
    const attrs = attrsOf(doc, "h1");
    for (const name of ["knowledgeId", "knowledgeWhen", "knowledgeConclusion", "knowledgeEvidence", "knowledgeVerified", "knowledgeStatus", "knowledgeSupersededBy"]) {
      expect(attrs[name] ?? "").toBe("");
    }
    editor.undo();
    await tick();
    expect(infoOf(editor, "h1")).toMatchObject({ id: "k_00000001", when: "alice reads", evidence: "tested", status: "unverified" });
  });

  it("does nothing for a heading that is not knowledge", () => {
    const editor = open(seeded([H("h1", "A")]));
    expect(removeKnowledge(editor, "h1")).toBe(false);
  });
});

describe("currentKnowledgeTarget", () => {
  it("is the cursor block when it is a top-level heading, otherwise null", () => {
    const editor = open(seeded([H("h1", "A"), P("p1", "x")]));
    editor.setTextCursorPosition("h1", "end");
    expect(currentKnowledgeTarget(editor)).toBe("h1");
    editor.setTextCursorPosition("p1", "end");
    expect(currentKnowledgeTarget(editor)).toBeNull();
  });
});

describe("todayLocalDate", () => {
  it("uses the local calendar date", () => {
    expect(todayLocalDate(new Date(2026, 0, 31, 23, 59))).toBe("2026-01-31");
    expect(todayLocalDate(new Date(2026, 8, 5, 0, 1))).toBe("2026-09-05");
  });
});
