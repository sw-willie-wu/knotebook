/**
 * #553: `editOnFork` removes the old blocks of `replace_all`, `replace_section` and `delete_section` at the Yjs layer. The update, the ids and the
 * snapshots it returns must equal what removal through the editor gave, and the cost must not depend on blocks removed x note size.
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, keptIdRenames, type EditOp } from "@knotebook/shared";
import { editOnFork, type Anchor } from "../../src/notes/editing/doc-jobs.js";
import { outlineOf, type OutlineEntry } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, forkFrom, type AnyBlock, type AnyEditor, type AnyPartialBlock } from "../../src/notes/editing/session.js";
import { timeIt, yieldToLoop } from "../perf-helpers.js";
import { topIds, totalClock } from "./fixtures/block-ids.js";
import { forkWithClient, referenceWrite } from "./fixtures/removal-reference.js";
import { yjsNote } from "./fixtures/yjs-note.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();

const H = (id: string, t: string): AnyPartialBlock => ({ id, type: "heading", props: { level: 1 }, content: t });
const P = (id: string, t: string): AnyPartialBlock => ({ id, type: "paragraph", content: t });
const xmlOf = (doc: Y.Doc): string => doc.getXmlFragment(YDOC_FRAGMENT).toString();
const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a).equals(Buffer.from(b));
const stateOf = (doc: Y.Doc): Uint8Array => Y.encodeStateAsUpdate(doc);

type Plan = Parameters<typeof editOnFork>[3];
interface EditResult {
  beforeBlocks: AnyBlock[];
  afterIds: string[];
  anchor: Anchor | null;
}

async function docOf(blocks: AnyPartialBlock[]): Promise<Y.Doc> {
  await yieldToLoop();
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    s.editor.replaceBlocks(s.editor.document, blocks as never);
  } finally {
    s.close();
  }
  return doc;
}

const baseBlocks = (): AnyPartialBlock[] => [H("hA", "A"), P("a1", "a1 text"), P("a2", "a2 text"), H("hB", "B"), P("b1", "b1 text"), P("b2", "b2 text"), H("hC", "C"), P("c1", "c1 text")];

function sectionsOf(state: Uint8Array): OutlineEntry[] {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return outlineOf(doc.getXmlFragment(YDOC_FRAGMENT)).outline;
}
const sectionStartingAt = (state: Uint8Array, firstId: string): OutlineEntry => {
  const s = sectionsOf(state).find(o => o.blockIds[0] === firstId);
  if (!s) throw new Error(`no section starts at ${firstId}`);
  return s;
};

/** The removal through the editor that `editOnFork` did before removal moved to the Yjs layer. */
function oldEdit(ed: AnyEditor, plan: Plan, blocks: AnyPartialBlock[]): { out: EditResult; renames: Map<string, string> } {
  const top = ed.document;
  let renames = new Map<string, string>();
  const fresh = (ids: string[]): AnyBlock[] => {
    const inserted = blocks.length === 0 ? [] : ed.insertBlocks(blocks, ids[ids.length - 1]!, "after");
    ed.removeBlocks(ids);
    return inserted as AnyBlock[];
  };
  const keep = (before: AnyBlock[], inserted: AnyBlock[]): void => {
    if (plan.keepIds) renames = keptIdRenames(before, inserted);
  };
  let beforeBlocks: AnyBlock[] = [];
  let afterIds: string[] = [];
  let anchor: Anchor | null = null;
  if (plan.op === "replace_all") {
    beforeBlocks = plan.isEmptyDoc ? [] : top;
    const inserted = fresh(top.map(b => b.id));
    afterIds = inserted.map(b => b.id);
    if (!plan.isEmptyDoc) keep(beforeBlocks, inserted);
  } else if (plan.op === "replace_section") {
    const ids = plan.section!.blockIds;
    beforeBlocks = ids.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined) as AnyBlock[];
    const inserted = fresh(ids);
    afterIds = inserted.map(b => b.id);
    keep(beforeBlocks, inserted);
  } else if (plan.op === "delete_section") {
    const ids = plan.section!.blockIds;
    beforeBlocks = ids.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined) as AnyBlock[];
    const idx = top.findIndex(b => b.id === ids[0]);
    const prev = top[idx - 1];
    const next = top[idx + ids.length];
    if (ids.length === top.length) {
      const inserted = ed.replaceBlocks(ids, [{ type: "paragraph" }]).insertedBlocks;
      anchor = { block_id: inserted[0]!.id, position: "before" };
    } else {
      ed.replaceBlocks(ids, []);
      anchor = prev ? { block_id: prev.id, position: "after" } : { block_id: next!.id, position: "before" };
    }
  }
  return { out: { beforeBlocks, afterIds, anchor }, renames };
}

async function oldPath(state: Uint8Array, plan: Plan, blocks: AnyPartialBlock[]): Promise<{ doc: Y.Doc; diff: Uint8Array; out: EditResult }> {
  let captured: ReturnType<typeof oldEdit> | undefined;
  const r = await referenceWrite(rt, state, 4242, ed => {
    captured = oldEdit(ed, plan, blocks);
    return captured.renames;
  });
  const { out, renames } = captured!;
  return { doc: r.doc, diff: r.diff, out: { ...out, afterIds: out.afterIds.map(id => renames.get(id) ?? id) } };
}

async function newPath(state: Uint8Array, plan: Plan, blocks: AnyPartialBlock[]): Promise<{ fork: Y.Doc; diff: Uint8Array; out: EditResult }> {
  const { fork, sv } = forkWithClient(state, 4242);
  const r = await editOnFork(rt, fork, sv, plan, blocks);
  return { fork, diff: r.diff, out: { beforeBlocks: r.beforeBlocks, afterIds: r.afterIds, anchor: r.anchor } };
}

/** A copy of `state` with `diff` applied; mounting an editor on it must not write anything back. */
async function applied(state: Uint8Array, diff: Uint8Array): Promise<Y.Doc> {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, state);
  Y.applyUpdate(copy, diff);
  const clock = totalClock(copy);
  const s = await EditorSession.open(rt, copy);
  s.close();
  expect(totalClock(copy)).toBe(clock);
  return copy;
}

describe("editOnFork removal (#553)", () => {
  const rewriteB = (): AnyPartialBlock[] => [H("n1", "B"), P("n2", "b1 text"), P("n3", "AI-NEW")];
  const allNew = (): AnyPartialBlock[] => baseBlocks().map(b => ({ ...b, id: `n_${b.id}` }) as AnyPartialBlock);

  it.each([
    ["replace_all", "replace_all", undefined, false, allNew],
    ["replace_section", "replace_section", "hB", false, rewriteB],
    ["replace_section keepIds", "replace_section", "hB", true, rewriteB],
    ["replace_all keepIds", "replace_all", undefined, true, allNew],
    ["delete_section of a middle section", "delete_section", "hB", false, () => []],
    ["delete_section of the first section", "delete_section", "hA", false, () => []],
  ] as Array<[string, EditOp, string | undefined, boolean, () => AnyPartialBlock[]]>)(
    "%s: byte-identical diff, same afterIds, beforeBlocks and anchor as the editor-level removal",
    async (_name, op, firstId, keepIds, makeBlocks) => {
      const state = stateOf(await docOf(baseBlocks()));
      const plan: Plan = { op, isEmptyDoc: false, section: firstId === undefined ? undefined : sectionStartingAt(state, firstId), keepIds };
      const blocks = makeBlocks();
      const o = await oldPath(state, plan, blocks);
      const n = await newPath(state, plan, blocks);
      expect(sameBytes(n.diff, o.diff)).toBe(true);
      expect(xmlOf(n.fork)).toBe(xmlOf(o.doc));
      expect(topIds(n.fork)).toEqual(topIds(o.doc));
      expect(n.out.afterIds).toEqual(o.out.afterIds);
      expect(n.out.beforeBlocks).toEqual(o.out.beforeBlocks);
      expect(n.out.anchor).toEqual(o.out.anchor);
      expect(xmlOf(await applied(state, n.diff))).toBe(xmlOf(o.doc));
      if (keepIds) expect(n.out.afterIds.length).toBeGreaterThan(0);
    },
    60_000
  );

  it("delete_section of the only section leaves one empty paragraph and anchors before it", async () => {
    const state = stateOf(await docOf([H("hA", "A"), P("a1", "a1 text")]));
    const section = sectionStartingAt(state, "hA");
    const n = await newPath(state, { op: "delete_section", isEmptyDoc: false, section }, []);
    const copy = await applied(state, n.diff);
    const ids = topIds(copy);
    expect(ids).toHaveLength(1);
    expect(n.out.anchor).toEqual({ block_id: ids[0], position: "before" });
    expect(n.out.beforeBlocks.map(b => b.id)).toEqual(["hA", "a1"]);
    const s = await EditorSession.open(rt, copy);
    try {
      expect(s.editor.document).toHaveLength(1);
      expect(s.editor.document[0]!.type).toBe("paragraph");
      expect(s.editor.document[0]!.content).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("replace_all with no blocks (an empty version) leaves one empty paragraph", async () => {
    const state = stateOf(await docOf(baseBlocks()));
    const n = await newPath(state, { op: "replace_all", isEmptyDoc: false, section: undefined }, []);
    expect(n.out.afterIds).toEqual([]);
    const copy = await applied(state, n.diff);
    expect(topIds(copy)).toHaveLength(1);
    expect(xmlOf(copy)).not.toContain("a1 text");
    const s = await EditorSession.open(rt, copy);
    try {
      expect(s.editor.document[0]!.type).toBe("paragraph");
      expect(s.editor.document[0]!.content).toEqual([]);
    } finally {
      s.close();
    }
  });

  it("delete_section of a 4,000-block section costs little more than mounting the note", async () => {
    const state = stateOf(yjsNote(4_000, i => (i === 0 ? { id: "s", type: "h", level: 1, text: "S" } : { id: `q${i}`, type: "p", text: `p${i}` })));
    const section = sectionStartingAt(state, "s");
    expect(section.blockIds).toHaveLength(4_000);
    let minDelete = Infinity;
    let minMount = Infinity;
    for (let run = 0; run < 3; run++) {
      const a = forkFrom(state);
      minDelete = Math.min(
        minDelete,
        await timeIt(async () => {
          const r = await editOnFork(rt, a.fork, a.sv, { op: "delete_section", isEmptyDoc: false, section }, []);
          expect(r.beforeBlocks).toHaveLength(4_000);
        })
      );
      expect(topIds(a.fork)).toHaveLength(1);
      const b = forkFrom(state);
      minMount = Math.min(
        minMount,
        await timeIt(async () => {
          const s = await EditorSession.open(rt, b.fork);
          s.close();
        })
      );
    }
    console.log(`[perf] #553 delete_section 4,000: minDelete=${Math.round(minDelete)} ms minMount=${Math.round(minMount)} ms`);
    expect(minDelete).toBeLessThanOrEqual(1.5 * minMount + 200);
  }, 120_000);

  it("replace_section of a 4,000-block section costs little more than appending the same blocks", async () => {
    const state = stateOf(yjsNote(4_000, i => (i === 0 ? { id: "s", type: "h", level: 1, text: "S" } : { id: `q${i}`, type: "p", text: `p${i}` })));
    const section = sectionStartingAt(state, "s");
    const blocks = Array.from({ length: 4_000 }, (_, i) => P(`m${i}`, `m${i}`));
    let minReplace = Infinity;
    let minAppend = Infinity;
    for (let run = 0; run < 3; run++) {
      for (const replace of [true, false]) {
        const { fork, sv } = forkFrom(state);
        const plan: Plan = replace ? { op: "replace_section", isEmptyDoc: false, section } : { op: "append", isEmptyDoc: false, section: undefined };
        const ms = await timeIt(() => editOnFork(rt, fork, sv, plan, blocks));
        if (replace) {
          minReplace = Math.min(minReplace, ms);
          expect(topIds(fork)).toHaveLength(4_000);
        } else minAppend = Math.min(minAppend, ms);
      }
    }
    console.log(`[perf] #553 replace_section 4,000: minReplace=${Math.round(minReplace)} ms minAppend=${Math.round(minAppend)} ms`);
    expect(minReplace).toBeLessThanOrEqual(1.5 * minAppend + 200);
  }, 120_000);
});
