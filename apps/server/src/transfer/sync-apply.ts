/**
 * Holds the fork lease with zero DB; runs before/after scratch planning, never nested. Same
 * precondition as `decide.ts`. Yields once before the mount (one synchronous stretch, not to
 * be chained onto the tail of planning) and after it. Neighbours for `deferred` deletes are
 * found before the diff is taken, so we never write content and then hit `anchor_chk`. With
 * zero top-level blocks, the empty paragraph mount normalizes is replaced once; an empty
 * note has a single insert region, equal to `replace_all`.
 */
import type { Block } from "@blocknote/core";
import * as Y from "yjs";
import type { noteAiEdits } from "../db/schema.js";
import {
  YDOC_FRAGMENT,
  keptIdRenames,
  knowledgeRefsIn,
  knowledgeWriteProblem,
  normalizeKnowledgeRefs,
  resolveKnowledgeForWrite,
  type KnowledgeBlockShape,
  type KnowledgeInfo,
} from "@knotebook/shared";
import { KnowledgeWriteError, createdKnowledge, knowledgeIdsByBlock, mergeKnowledgeReports, type KnowledgeEditReport } from "../notes/editing/knowledge-write.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { pickBlocks, topLevelBlocksById, withForkEditor } from "../notes/editing/session.js";
import { chainKeyOf, type Anchor } from "./decide.js";
import type { SyncPlan } from "./sync-plan.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic type parameters; repo convention (as in notes/editing/session.ts)
export type AnyBlock = Block<any, any, any>;

export interface Applied {
  diff: Uint8Array;
  perRegion: Array<{ beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null }>;
  knowledge: KnowledgeEditReport;
}

/** `same` regions aren't recorded. Delete rows carry `anchor` and `after_block_ids: []`, others `anchor: null` (the file_sync branch of `note_ai_edits_anchor_chk`). `recordable` degenerate form (`after_block_ids: []`, null fingerprint) would hit `anchor_chk` for a non-delete row; unreachable in theory (see `recordableAfter`). */
export function fileSyncRows(p: {
  noteId: string;
  userId: string;
  tokenId: string | null;
  agentLabel: string | null;
  decisions: SyncPlan["decisions"];
  perRegion: Applied["perRegion"];
  /** Index-aligned with `perRegion`. */
  afterFingerprints: ReadonlyArray<string | null>;
  recordable?: (afterIds: string[], afterFingerprint: string | null) => { afterBlockIds: string[]; afterFingerprint: string | null };
}): { rows: Array<typeof noteAiEdits.$inferInsert>; regionIdx: number[] } {
  const rows: Array<typeof noteAiEdits.$inferInsert> = [];
  const regionIdx: number[] = [];
  p.decisions.forEach((d, ri) => {
    if (d.mark === "same") return;
    const pr = p.perRegion[ri]!;
    const after = p.recordable ? p.recordable(pr.afterIds, p.afterFingerprints[ri] ?? null) : { afterBlockIds: pr.afterIds, afterFingerprint: p.afterFingerprints[ri] ?? null };
    rows.push({
      noteId: p.noteId,
      userId: p.userId,
      tokenId: p.tokenId,
      agentLabel: p.agentLabel,
      op: "file_sync",
      sectionId: null,
      beforeBlocks: pr.beforeBlocks,
      anchor: d.kind === "delete" ? pr.anchor : null,
      ...after,
    });
    regionIdx.push(ri);
  });
  return { rows, regionIdx };
}

export async function applySync(
  runtime: EditingRuntime,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: SyncPlan,
  cur: { ids: string[] },
  // `normalizedId`: the base had 0 blocks and the current doc is one empty paragraph; replaced once, like the `cur.ids.length === 0` case.
  opts: { yieldFn?: () => Promise<void>; now?: () => number; normalizedId?: string; knowledge?: { current: ReadonlyMap<string, KnowledgeInfo>; noteId: string } } = {},
): Promise<Applied> {
  const yieldFn = opts.yieldFn ?? yieldToLoop;
  const now = opts.now ?? (() => performance.now());
  const { regions, decisions, parsed } = plan;
  const perRegion: Applied["perRegion"] = regions.map(() => ({ beforeBlocks: [], afterIds: [], anchor: null }));
  const reports: KnowledgeEditReport[] = [];
  const removedCandidates: AnyBlock[] = [];

  // The fork mount can't be split; without this yield it would extend the tail of planning into a longer stall.
  await yieldFn();
  const w = await withForkEditor(runtime, fork, sv, async (ed, edits) => {
    await yieldFn();
    let last = now();
    const budget = async () => {
      if (now() - last >= YIELD_AFTER_MS) {
        await yieldFn();
        last = now();
      }
    };
    // Survivors are unchanged base blocks and inserting other regions doesn't alter them, so one pass serves every region.
    const byId = topLevelBlocksById(ed);
    const taken = new Set(opts.knowledge?.current.keys());

    // Throws before diffSince/merge, so nothing is written (never content merged and then a CHECK failing).
    const assertTopLevel = () => {
      const top = new Set(ed.document.map(b => b.id));
      for (let ri = 0; ri < regions.length; ri++) {
        const d = decisions[ri]!;
        if (d.mark === "same" || d.kind === "delete") continue;
        if (perRegion[ri]!.afterIds.length === 0 || perRegion[ri]!.afterIds.some(id => !top.has(id))) throw new Error("applySync：插入的 block 不在頂層（套用與決策不一致）");
      }
    };

    // A later region at the same attachment point goes after the earlier region's last block, else it would land before it.
    let normalized: string | null = cur.ids.length === 0 ? (ed.document[0]?.id ?? null) : (opts.normalizedId ?? null);
    const chain = new Map<string, string>();
    for (let ri = 0; ri < regions.length; ri++) {
      const d = decisions[ri]!;
      if (d.mark === "same" || d.kind === "delete") continue;
      let blocks = parsed[ri]!;
      const k = opts.knowledge;
      if (k !== undefined) {
        // A comment without an id takes the id of the heading it rewrites; headings written without a comment are never given knowledge.
        const old = d.kind === "rewrite" ? (pickBlocks(byId, d.survivors) as unknown as readonly KnowledgeBlockShape[]) : [];
        const r = resolveKnowledgeForWrite({ before: old, after: normalizeKnowledgeRefs(blocks as unknown as readonly KnowledgeBlockShape[], k.noteId), keep: false, taken });
        const problem = knowledgeWriteProblem(r.blocks, k.current, k.noteId);
        if (problem !== null) throw new KnowledgeWriteError(problem);
        for (const ref of [...r.created, ...r.renewed]) taken.add(ref.id);
        blocks = r.blocks as unknown as typeof blocks;
        reports.push({ kept: r.kept, created: r.created, removed: [], renewed: r.renewed });
      }
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
        perRegion[ri]!.beforeBlocks = pickBlocks(byId, d.survivors);
        removedCandidates.push(...perRegion[ri]!.beforeBlocks);
        edits.rename(keptIdRenames(perRegion[ri]!.beforeBlocks, inserted));
        edits.remove(d.survivors);
      }
      await budget();
    }

    const deleting = new Set<string>();
    for (const d of decisions) if (d.kind === "delete" && d.mark !== "same") for (const id of d.survivors) deleting.add(id);
    const toEmpty: number[] = [];
    // Valid for all deletes: removed blocks are in `deleting` and skipped while scanning. Rewrite survivors are only queued, still in the document, so they are skipped too.
    let topIds: string[] | null = null;
    let topPos: Map<string, number> | null = null;
    for (let ri = 0; ri < regions.length; ri++) {
      const d = decisions[ri]!;
      if (d.kind !== "delete" || d.mark === "same") continue;
      perRegion[ri]!.beforeBlocks = pickBlocks(byId, d.survivors);
      removedCandidates.push(...perRegion[ri]!.beforeBlocks);
      let anchor: Anchor | null = typeof d.anchor === "object" ? d.anchor : null;
      if (d.anchor === "deferred") {
        topIds ??= ed.document.map(b => b.id);
        topPos ??= new Map(topIds.map((id, i) => [id, i]));
        const top = topIds;
        const first = topPos.get(d.survivors[0]!)!;
        const lastIdx = topPos.get(d.survivors[d.survivors.length - 1]!)!;
        for (let i = first - 1; i >= 0 && anchor === null; i--) if (!deleting.has(top[i]!) && !edits.isQueued(top[i]!)) anchor = { block_id: top[i]!, position: "after" };
        for (let i = lastIdx + 1; i < top.length && anchor === null; i++) if (!deleting.has(top[i]!) && !edits.isQueued(top[i]!)) anchor = { block_id: top[i]!, position: "before" };
      }
      if (anchor === null) {
        toEmpty.push(ri);
        continue;
      }
      perRegion[ri]!.anchor = anchor;
      edits.remove(d.survivors);
      await budget();
    }
    if (toEmpty.length > 0) {
      // The last removal becomes one empty paragraph (the top level is never empty, as in `delete_section`); these regions anchor on it as a placeholder. Survivors of the first region (document order) go "before" it, the rest "after", so a revert restores the order (3+ regions reverted out of order is only approximate, known-limitations).
      const ids = toEmpty.flatMap(ri => decisions[ri]!.survivors);
      const empty = edits.remove(ids);
      if (empty === null) throw new Error("applySync: removing every top-level block left one standing");
      toEmpty.forEach((ri, i) => {
        perRegion[ri]!.anchor = { block_id: empty.id, position: i === 0 ? "before" : "after", placeholder: true };
      });
    }
    assertTopLevel();
  });
  // Ids are mapped through what was applied, since a rename can be skipped.
  if (w.renamed.size > 0) {
    for (const pr of perRegion) {
      pr.afterIds = pr.afterIds.map(id => w.renamed.get(id) ?? id);
      if (pr.anchor !== null) pr.anchor = { ...pr.anchor, block_id: w.renamed.get(pr.anchor.block_id) ?? pr.anchor.block_id };
    }
  }
  const knowledge = mergeKnowledgeReports(reports.map(r => ({ ...r, ignoredComments: 0 })));
  if (opts.knowledge !== undefined) {
    const surviving = new Set(knowledgeIdsByBlock(fork.getXmlFragment(YDOC_FRAGMENT)).values());
    knowledge.removed = knowledgeRefsIn(removedCandidates as unknown as readonly KnowledgeBlockShape[]).filter(r => !surviving.has(r.id));
    const renewedIds = new Set(knowledge.renewed.map(r => r.id));
    knowledge.renewed = [...knowledge.renewed, ...w.renewed.filter(x => !renewedIds.has(x.id))];
    knowledge.created = createdKnowledge(fork.getXmlFragment(YDOC_FRAGMENT), w.knowledgeBefore, knowledge.renewed);
  }
  const { ignoredComments: _ignored, ...edit } = knowledge;
  return { diff: w.diff, perRegion, knowledge: edit };
}
