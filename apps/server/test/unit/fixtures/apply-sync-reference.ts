import * as Y from "yjs";
import { keptIdRenames } from "@knotebook/shared";
import type { EditingRuntime } from "../../../src/notes/editing/runtime.js";
import { EditorSession, renameBlocksInDoc } from "../../../src/notes/editing/session.js";
import { chainKeyOf, type Anchor } from "../../../src/transfer/decide.js";
import type { AnyBlock, Applied } from "../../../src/transfer/sync-apply.js";
import type { SyncPlan } from "../../../src/transfer/sync-plan.js";
import { forkWithClient } from "./removal-reference.js";

/** `applySync` with removal through the editor (`removeBlocks` / `replaceBlocks`) and no yields: the reference the Yjs-level removal must match byte for byte. */
export async function referenceApplySync(
  rt: EditingRuntime,
  state: Uint8Array,
  clientID: number,
  plan: SyncPlan,
  cur: { ids: string[] },
  opts: { normalizedId?: string } = {}
): Promise<{ doc: Y.Doc; diff: Uint8Array; perRegion: Applied["perRegion"] }> {
  const { fork, sv } = forkWithClient(state, clientID);
  const { regions, decisions, parsed } = plan;
  const perRegion: Applied["perRegion"] = regions.map(() => ({ beforeBlocks: [], afterIds: [], anchor: null }));

  const renames = new Map<string, string>();
  const s = await EditorSession.open(rt, fork);
  try {
    const ed = s.editor;
    const snapshot = (ids: string[]): AnyBlock[] => ids.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);

    const assertTopLevel = () => {
      const top = new Set(ed.document.map(b => b.id));
      for (let ri = 0; ri < regions.length; ri++) {
        const d = decisions[ri]!;
        if (d.mark === "same" || d.kind === "delete") continue;
        if (perRegion[ri]!.afterIds.length === 0 || perRegion[ri]!.afterIds.some(id => !top.has(id))) throw new Error("applySync: inserted block is not at the top level");
      }
    };

    let normalized: string | null = cur.ids.length === 0 ? (ed.document[0]?.id ?? null) : (opts.normalizedId ?? null);
    const chain = new Map<string, string>();
    for (let ri = 0; ri < regions.length; ri++) {
      const d = decisions[ri]!;
      if (d.mark === "same" || d.kind === "delete") continue;
      const blocks = parsed[ri]!;
      const p = d.place;
      let inserted: AnyBlock[];
      const key = chainKeyOf(p);
      if ("ref" in p) {
        const prev = key === null ? undefined : chain.get(key);
        inserted = prev !== undefined ? ed.insertBlocks(blocks, prev, "after") : ed.insertBlocks(blocks, p.ref, p.where);
      } else {
        const prev = chain.get("start");
        if (prev !== undefined) inserted = ed.insertBlocks(blocks, prev, "after");
        else if (normalized !== null) {
          inserted = ed.replaceBlocks([normalized], blocks).insertedBlocks;
          normalized = null;
        } else inserted = ed.insertBlocks(blocks, ed.document[0]!.id, "before");
      }
      if (key !== null && inserted.length > 0) chain.set(key, inserted[inserted.length - 1]!.id);
      perRegion[ri]!.afterIds = inserted.map(b => b.id);
      if (d.kind === "rewrite" && d.survivors.length > 0) {
        perRegion[ri]!.beforeBlocks = snapshot(d.survivors);
        for (const [newId, oldId] of keptIdRenames(perRegion[ri]!.beforeBlocks, inserted)) renames.set(newId, oldId);
        ed.removeBlocks(d.survivors);
      }
    }

    const deleting = new Set<string>();
    for (const d of decisions) if (d.kind === "delete" && d.mark !== "same") for (const id of d.survivors) deleting.add(id);
    const toEmpty: number[] = [];
    let topIds: string[] | null = null;
    let topPos: Map<string, number> | null = null;
    for (let ri = 0; ri < regions.length; ri++) {
      const d = decisions[ri]!;
      if (d.kind !== "delete" || d.mark === "same") continue;
      perRegion[ri]!.beforeBlocks = snapshot(d.survivors);
      let anchor: Anchor | null = typeof d.anchor === "object" ? d.anchor : null;
      if (d.anchor === "deferred") {
        topIds ??= ed.document.map(b => b.id);
        topPos ??= new Map(topIds.map((id, i) => [id, i]));
        const top = topIds;
        const first = topPos.get(d.survivors[0]!)!;
        const lastIdx = topPos.get(d.survivors[d.survivors.length - 1]!)!;
        for (let i = first - 1; i >= 0 && anchor === null; i--) if (!deleting.has(top[i]!)) anchor = { block_id: top[i]!, position: "after" };
        for (let i = lastIdx + 1; i < top.length && anchor === null; i++) if (!deleting.has(top[i]!)) anchor = { block_id: top[i]!, position: "before" };
      }
      if (anchor === null) {
        toEmpty.push(ri);
        continue;
      }
      perRegion[ri]!.anchor = anchor;
      ed.removeBlocks(d.survivors);
    }
    if (toEmpty.length > 0) {
      const ids = toEmpty.flatMap(ri => decisions[ri]!.survivors);
      const empty = ed.replaceBlocks(ids, [{ type: "paragraph" }]).insertedBlocks[0]!;
      toEmpty.forEach((ri, i) => {
        perRegion[ri]!.anchor = { block_id: empty.id, position: i === 0 ? "before" : "after", placeholder: true };
      });
    }
    assertTopLevel();
  } finally {
    s.close();
  }
  const applied = renameBlocksInDoc(fork, renames);
  if (applied.size > 0) {
    for (const pr of perRegion) {
      pr.afterIds = pr.afterIds.map(id => applied.get(id) ?? id);
      if (pr.anchor !== null) pr.anchor = { ...pr.anchor, block_id: applied.get(pr.anchor.block_id) ?? pr.anchor.block_id };
    }
  }
  return { doc: fork, diff: Y.encodeStateAsUpdate(fork, sv), perRegion };
}
