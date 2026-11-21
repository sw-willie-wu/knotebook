/**
 * Zero DB; the scratch session is opened only to write the pre-parsed blocks, before/after
 * the fork mount in `sync-apply.ts`, never nested (`runtime.acquire()` isn't re-entrant).
 * Same precondition as `decide.ts`. `SyncPlan` keeps no scratch doc: on a merge-fingerprint
 * mismatch the caller reruns `planSync` with a new fork. `ParserBusyError` propagates (→ 503).
 * Any region parse failure is a whole-file 400 (including text that survives comment stripping
 * but parses to `empty_content`). One user's parses run one at a time in the pool.
 */
import type { PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { YDOC_FRAGMENT, type KnowledgeProblem } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import type { VisibleNoteTarget } from "../notes/editing/candidates.js";
import type { ParseBudget } from "../notes/editing/parse-core.js";
import type { ParseDetail, ParseError } from "../notes/editing/markdown.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { EditorSession } from "../notes/editing/session.js";
import { chainKeyOf, decide, anchors as anchorsOf, placeFor, shouldStripStart, type Decision } from "./decide.js";
import type { LineDiff } from "./line-diff.js";
import { keepLabelFree } from "./link-texts.js";
import { findRegions, makeBoundaryCheck, type Region } from "./regions.js";
import { indexTopLevel, sameCanonicalSeqIn } from "./same-canonical.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote's three generic type parameters; repo convention (as in notes/editing/session.ts)
export type AnyPartialBlock = PartialBlock<any, any, any>;

export interface SyncPlan {
  regions: Region[];
  decisions: Decision[];
  parsed: AnyPartialBlock[][];
  unbound: number;
  ignoredKnowledgeComments: number;
  boundaryChecks: number;
}

export interface PlanSyncInput {
  /** The writer's user id: the parse queue key (not the note owner). */
  writerId: string;
  segments: TransferSegment[];
  baseLineCount: number;
  agentLines: string[];
  diff: LineDiff;
  cur: { ids: string[]; fps: string[]; types: string[] };
  curFragment: Y.XmlFragment;
  candidates: readonly VisibleNoteTarget[];
  siteOrigin: string;
  /** Not given = the old rule (only the target's current title counts). */
  exportedLinkText?: (targetId: string, text: string) => boolean;
  /** Shared across fingerprint-mismatch retries so the whole write-back has one worker-time budget; not given = a fresh budget for this run, and exhausting it fails the whole file (`unsupported_block`/`too_complex`). */
  fileBudget?: ParseBudget;
  yieldFn?: () => Promise<void>;
  now?: () => number;
}

export type PlanSyncError = ParseError | "unclosed_fence";
export type PlanSyncFailure = { ok: false; code: PlanSyncError; detail?: ParseDetail; fence?: string; knowledge?: KnowledgeProblem };

class TooComplexAbort extends Error {}

export async function planSync(runtime: EditingRuntime, input: PlanSyncInput): Promise<{ ok: true; plan: SyncPlan } | PlanSyncFailure> {
  const yieldFn = input.yieldFn ?? yieldToLoop;
  const now = input.now ?? (() => performance.now());
  let last = now();
  const budget = async () => {
    if (now() - last >= YIELD_AFTER_MS) {
      await yieldFn();
      last = now();
    }
  };
  const scratch = new Y.Doc();
  let regions: Region[];
  let boundaryChecks: number;
  const parsed: AnyPartialBlock[][] = [];
  const firstTypes: Array<string | undefined> = [];
  const prevTypes: Array<string | null> = [];
  const insertedIds: string[][] = [];
  let unbound = 0;
  let ignoredKnowledgeComments = 0;
  const exported = input.exportedLinkText;
  let titles: Map<string, string> | null = null;
  const titleOf = (id: string): string | undefined => {
    titles ??= new Map(input.candidates.map(c => [c.id.toLowerCase(), c.title]));
    return titles.get(id.toLowerCase());
  };
  const fileBudget = input.fileBudget ?? runtime.parser.fileBudget();
  const parseMd = (markdown: string) => runtime.parser.parse({ owner: input.writerId, markdown, candidates: input.candidates, siteOrigin: input.siteOrigin, budget: fileBudget });
  {
    await yieldFn();
    last = now();
    // Too complex → the whole file is a 400, not "boundary doesn't hold".
    const check = makeBoundaryCheck(async md => {
      const p = await parseMd(md);
      await budget();
      if ("error" in p && p.detail === "too_complex") throw new TooComplexAbort();
      return "error" in p ? null : p.blocks;
    });
    let rr: Awaited<ReturnType<typeof findRegions>>;
    try {
      rr = await findRegions(input.segments, input.baseLineCount, input.agentLines, input.diff, check, lines => runtime.parser.openFenceLine(input.writerId, lines, fileBudget), { yieldFn, now });
    } catch (err) {
      if (err instanceof TooComplexAbort) return { ok: false, code: "unsupported_block", detail: "too_complex" };
      throw err;
    }
    if (!rr.ok) {
      if (rr.code === "unclosed_fence") return { ok: false, code: rr.code, fence: rr.fence };
      if (rr.code === "too_complex") return { ok: false, code: "unsupported_block", detail: "too_complex" };
      return { ok: false, code: rr.code };
    }
    regions = rr.regions;
    boundaryChecks = rr.boundaryChecks;
    const anc = anchorsOf(input.segments, regions);
    const curIdx = new Map(input.cur.ids.map((id, i) => [id, i]));
    // `applySync` chains a later region at the same attachment point after the earlier one's last block, so remember that type under the chain key (rewrite regions sit before base blocks and don't use the chain).
    const lastTypeByKey = new Map<string, string>();
    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri]!;
      if (r.kind === "delete") {
        parsed.push([]);
        firstTypes.push(undefined);
        prevTypes.push(null);
        continue;
      }
      const p = await parseMd(r.text);
      if ("error" in p) return { ok: false, code: p.error, ...(p.detail ? { detail: p.detail } : {}), ...(p.knowledge ? { knowledge: p.knowledge } : {}) };
      unbound += p.unbound;
      ignoredKnowledgeComments += p.ignoredKnowledgeComments;
      const blocks = exported === undefined ? p.blocks : keepLabelFree(p.blocks, exported, titleOf)[0];
      const firstType = blocks[0]?.type as string | undefined;
      firstTypes.push(firstType);
      const { place, prevType: placePrev } = placeFor(r, input.cur, anc[ri]!, { idx: curIdx });
      const key = chainKeyOf(place);
      const prevType = key !== null && lastTypeByKey.has(key) ? lastTypeByKey.get(key)! : placePrev;
      prevTypes.push(prevType);
      if (key !== null && blocks.length > 0) lastTypeByKey.set(key, blocks[blocks.length - 1]!.type as string);
      if (shouldStripStart(prevType, firstType) && blocks[0]!.props) {
        const { start: _s, ...rest } = blocks[0]!.props as Record<string, unknown>;
        blocks[0] = { ...blocks[0]!, props: rest };
      }
      parsed.push(blocks);
      await budget();
    }
  }
  const s = await EditorSession.open(runtime, scratch);
  try {
    // The attachment point is kept in `tail`: re-reading `editor.document` per region is O(regions × top level).
    // The empty paragraph mount normalizes in; it takes no part in comparison.
    let tail = s.editor.document[0]!.id;
    for (let ri = 0; ri < regions.length; ri++) {
      const blocks = parsed[ri]!;
      if (blocks.length === 0) {
        insertedIds.push([]);
        continue;
      }
      const ids = s.editor.insertBlocks(blocks, tail, "after").map(b => b.id);
      insertedIds.push(ids);
      tail = ids[ids.length - 1]!;
      await budget();
    }
  } finally {
    s.close();
  }
  const scratchIdx = indexTopLevel(scratch.getXmlFragment(YDOC_FRAGMENT));
  const curIdxSame = indexTopLevel(input.curFragment);
  const pre = insertedIds.map(ids => sameCanonicalSeqIn(scratchIdx, ids) ?? []);
  const same = (ri: number, against: string[]): boolean => {
    const p = pre[ri]!;
    if (against.length !== p.length) return false;
    const seq = sameCanonicalSeqIn(curIdxSame, against);
    return seq !== null && seq.every((x, i) => x === p[i]);
  };
  const decisions = decide(input.segments, regions, input.cur, same, { firstTypes, prevTypes });
  return { ok: true, plan: { regions, decisions, parsed, unbound, ignoredKnowledgeComments, boundaryChecks } };
}
