/**
 * `live-watch.ts`: which top-level blocks of the live document were changed during apply; on merge, a conflict only counts when a block this write cares about was changed.
 * Documents are built with the real editor (BlockNote's blockGroup/blockContainer structure); the "browser" is another document whose update is applied to the live one after editing.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { LiveWatch, containerItems, type MergeGuard } from "../../src/notes/editing/live-watch.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { allBlockIds, topIds } from "./fixtures/block-ids.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

async function liveDoc(): Promise<Y.Doc> {
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, [
      { id: "h1", type: "heading", content: "A" },
      { id: "a1", type: "paragraph", content: "first" },
      { id: "a2", type: "paragraph", content: "second" },
      { id: "h2", type: "heading", content: "B" },
      { id: "b1", type: "paragraph", content: "third" },
    ] as never);
  } finally {
    s.close();
  }
  return doc;
}
/** The "browser": a document synced from live runs `f` (an editor operation), then its update is applied back to live. */
async function browser(live: Y.Doc, f: (ed: EditorSession["editor"]) => void): Promise<void> {
  const b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(live));
  const sv = Y.encodeStateVector(b);
  const s = await EditorSession.open(rt, b);
  try {
    f(s.editor);
  } finally {
    s.close();
  }
  Y.applyUpdate(live, Y.encodeStateAsUpdate(b, sv));
}
const guardA = (live: Y.Doc): MergeGuard => ({ kind: "blocks", items: containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["h1", "a1", "a2"]), anchors: [] });

describe("LiveWatch", () => {
  it("containerItems: the top-level container item ids of these blocks in the base (the same in another document)", async () => {
    const live = await liveDoc();
    const ids = containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["a1", "b1"]);
    expect(ids).toHaveLength(2);
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(live));
    expect(containerItems(copy.getXmlFragment(YDOC_FRAGMENT), ["a1", "b1"])).toEqual(ids);
  });

  it("typing in another section (B) or adding a paragraph at the end of the document -> no conflict; none never conflicts; any conflicts", async () => {
    const live = await liveDoc();
    const w = new LiveWatch(live);
    await browser(live, ed => ed.updateBlock("b1", { content: "third, typed" }));
    await browser(live, ed => ed.insertBlocks([{ type: "paragraph", content: "new at end" }], "b1", "after"));
    expect(w.conflicts(guardA(live))).toBe(false);
    expect(w.conflicts({ kind: "none" })).toBe(false);
    expect(w.conflicts({ kind: "any" })).toBe(true);
    w.stop();
  });

  it("changing the target section's block (typing, changing attributes, deleting) -> conflict", async () => {
    for (const f of [
      (ed: EditorSession["editor"]) => ed.updateBlock("a2", { content: "second, typed" }),
      (ed: EditorSession["editor"]) => ed.updateBlock("a1", { props: { textColor: "red" } } as never),
      (ed: EditorSession["editor"]) => ed.removeBlocks(["a1"]),
      (ed: EditorSession["editor"]) => ed.updateBlock("h1", { content: "A renamed" }),
    ]) {
      const live = await liveDoc();
      const guard = guardA(live);
      const w = new LiveWatch(live);
      await browser(live, f);
      expect(w.conflicts(guard)).toBe(true);
      w.stop();
    }
  });

  it("a new paragraph right after the target section's last block (it would land in the target section) -> conflict; inserted after the start of the next section -> no conflict", async () => {
    const live = await liveDoc();
    const guard = guardA(live);
    const w = new LiveWatch(live);
    await browser(live, ed => ed.insertBlocks([{ type: "paragraph", content: "x" }, { type: "paragraph", content: "y" }], "a2", "after"));
    expect(w.conflicts(guard)).toBe(true);
    w.stop();
    const live2 = await liveDoc();
    const w2 = new LiveWatch(live2);
    await browser(live2, ed => ed.insertBlocks([{ type: "paragraph", content: "x" }], "h2", "after"));
    expect(w2.conflicts(guardA(live2))).toBe(false);
    w2.stop();
  });

  it("anchor (undo of a deleted section): deleted -> conflict; only text changed -> no conflict (re-checked against the same old anchor)", async () => {
    const live = await liveDoc();
    const anchor: MergeGuard = { kind: "blocks", items: [], anchors: containerItems(live.getXmlFragment(YDOC_FRAGMENT), ["b1"]) };
    const w = new LiveWatch(live);
    await browser(live, ed => ed.updateBlock("b1", { content: "edited" }));
    expect(w.conflicts(anchor)).toBe(false);
    await browser(live, ed => ed.removeBlocks(["b1"]));
    expect(w.conflicts(anchor)).toBe(true);
    w.stop();
  });

  it("changes after stop are not recorded; with no changes at all, any doesn't conflict either", async () => {
    const live = await liveDoc();
    const w = new LiveWatch(live);
    expect(w.conflicts({ kind: "any" })).toBe(false);
    w.stop();
    await browser(live, ed => ed.updateBlock("a1", { content: "late" }));
    expect(w.conflicts({ kind: "any" })).toBe(false);
  });
});

/**
 * Content after merging: the real editOp (the same one the worker uses) plus the real LiveWatch; the browser edits the live document while the AI works,
 * and when the guard lets it through the result is merged; the final markdown and order are compared, not just the return value of conflicts.
 */
describe("content merged after the guard lets through", () => {
  const H = (t: string) => ({ type: "heading", props: { level: 1 }, content: t });
  const P = (t: string) => ({ type: "paragraph", content: t });
  const base = [H("A"), P("a1 text"), P("a2 text"), H("B"), P("b1 text"), P("b2 text"), H("C"), P("c1 text")];
  async function scenario(
    user: (ed: EditorSession["editor"]) => void,
    blocks: unknown[] = [H("B"), P("AI-NEW")]
  ): Promise<{ conflict: boolean; markdown: string; baseTop: string[]; liveTop: string[]; liveIds: string[] }> {
    const doc = new Y.Doc();
    const s = await EditorSession.open(rt, doc);
    try {
      s.editor.replaceBlocks(s.editor.document, base as never);
    } finally {
      s.close();
    }
    const st = Y.encodeStateAsUpdate(doc);
    const live = new Y.Doc();
    Y.applyUpdate(live, st);
    const watch = new LiveWatch(live);
    const o = await rt.runDoc("u", { kind: "outline", state: st });
    if (o === "too_complex") throw new Error("outline");
    const b = o.outline.find(x => x.heading === "B")!;
    const r = await rt.runDoc("u", { kind: "edit", noteId: "00000000-0000-4000-8000-000000000000", state: new Uint8Array(st), op: "replace_section", sectionId: b.sectionId, ifMatch: b.fingerprint, blocks: blocks as never });
    if (r === "too_complex" || !r.ok) throw new Error("edit");
    await browser(live, user);
    const conflict = watch.conflicts(r.post.guard);
    watch.stop();
    if (!conflict) Y.applyUpdate(live, r.post.diff);
    const md = await rt.runDoc("u", { kind: "read", state: Y.encodeStateAsUpdate(live), wantShown: false });
    if (md === "too_complex" || typeof md.result === "string" || !("markdown" in md.result)) throw new Error("read");
    return { conflict, markdown: md.result.markdown, baseTop: topIds(doc), liveTop: topIds(live), liveIds: allBlockIds(live) };
  }

  it("typing in another section (A): merged, both A's change and B's new content are present, order unchanged", async () => {
    const r = await scenario(ed => ed.updateBlock(ed.document[1]!.id, { content: "a1 text EDITED" }));
    expect(r.conflict).toBe(false);
    expect(r.markdown).toBe("# A\n\na1 text EDITED\n\na2 text\n\n# B\n\nAI-NEW\n\n# C\n\nc1 text\n");
  });

  it("inserting a paragraph right before the B heading (at the end of A): merged, that paragraph stays in A, before # B (not reordered after the AI's new content or moved into B) - run 10 times (a different client id each time)", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await scenario(ed => ed.insertBlocks([P("USER-NEW")] as never, ed.document[3]!.id, "before"));
      expect(r.conflict).toBe(false);
      expect(r.markdown, `第 ${i + 1} 次`).toBe("# A\n\na1 text\n\na2 text\n\nUSER-NEW\n\n# B\n\nAI-NEW\n\n# C\n\nc1 text\n");
    }
  }, 60_000);

  it("inserting a paragraph after B's last block: conflict, not merged (the paragraph would land in B) - the live document keeps the user's change, with no AI content", async () => {
    const r = await scenario(ed => ed.insertBlocks([P("USER-AFTER-b2")] as never, ed.document[5]!.id, "after"));
    expect(r.conflict).toBe(true);
    expect(r.markdown).toBe("# A\n\na1 text\n\na2 text\n\n# B\n\nb1 text\n\nb2 text\n\nUSER-AFTER-b2\n\n# C\n\nc1 text\n");
  });

  it("rewrite keeping B's ids while the user types in A and inserts before # B: merged, B's ids unchanged, the user's paragraph stays in A (10 runs)", async () => {
    for (let i = 0; i < 10; i++) {
      const r = await scenario(
        ed => {
          ed.updateBlock(ed.document[1]!.id, { content: "a1 text EDITED" });
          ed.insertBlocks([P("USER-NEW")] as never, ed.document[3]!.id, "before");
        },
        [H("B"), P("b1 text"), P("AI-NEW")]
      );
      expect(r.conflict).toBe(false);
      expect(r.markdown, `run ${i + 1}`).toBe("# A\n\na1 text EDITED\n\na2 text\n\nUSER-NEW\n\n# B\n\nb1 text\n\nAI-NEW\n\n# C\n\nc1 text\n");
      // hB, b1 and (rule 2: the one edited block between kept ones) b2's slot
      expect(r.liveTop.slice(4, 7)).toEqual(r.baseTop.slice(3, 6));
      expect(new Set(r.liveIds).size).toBe(r.liveIds.length);
    }
  }, 60_000);

  it("a concurrent move of a block the rewrite would keep: conflict, not merged, live ids unique", async () => {
    const r = await scenario(
      ed => {
        const b2 = ed.document[5]!;
        ed.removeBlocks([b2.id]);
        ed.insertBlocks([b2] as never, ed.document[2]!.id, "after");
      },
      [H("B"), P("b1 text"), P("AI-NEW")]
    );
    expect(r.conflict).toBe(true);
    expect(new Set(r.liveIds).size).toBe(r.liveIds.length);
  });
});
