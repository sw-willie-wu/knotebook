/**
 * bulk transfer spec 2026-11-02 §9.5 第 1–4 步：scratch session 內規劃（plan PR-2 T6）。**持 scratch lease、零 DB**；
 * 與之後的 fork mount（`sync-apply.ts`）是**先後、不巢狀**（`runtime.acquire()` 不可重入）。
 *
 * 流程（一個 scratch session，`try/finally close`）：① `EditorSession.open(runtime, new Y.Doc())` → 無條件讓出一次
 * ② `findRegions`，邊界回呼＝在這個 scratch editor 上 `parseMarkdownForNote`（`makeBoundaryCheck`：去 id、忽略 start、取
 * parse(k) 顆數、parse 失敗 → false）③ `anchors`／`placeFor`（要 `cur.types` 判插入點前一顆是不是 numbered）④ 每個非刪除區
 * `parseMarkdownForNote`：失敗 → 整篇 400（含「拿掉閉合註解後還有字、但 parse 成 `empty_content`」，§9.3-6）；`stripStart` 的區
 * 拿掉第一顆 numbered 的 `props.start` ⑤ 預解析 block `insertBlocks` 進 scratch doc、記每區插入的 id ⑥ close ⑦ 在未 mount 的
 * scratch 結構與 `curFragment` 上以 `sameCanonicalSeq` 算序列 ⑧ `decide`（改寫區的預解析與基底那幾顆逐顆比，`same`）。
 * 前提同 `decide.ts`：呼叫端已確認筆記自下載後沒有被動過（現況頂層與基底段表逐顆相同）。
 * 讓出按時間預算（同一個計時器）：每次邊界 parse、每區 parse 之間、寫進 scratch 之後。
 * 重試（gate r1 m8）：`SyncPlan` 不保留 scratch doc；合併指紋不符時呼叫端直接重跑 `planSync`（新 fork、新 `cur`）。
 */
import type { PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { TransferSegment } from "../db/schema.js";
import type { VisibleNoteTarget } from "../notes/editing/candidates.js";
import { parseMarkdownForNote, type ParseDetail, type ParseError } from "../notes/editing/markdown.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { EditorSession } from "../notes/editing/session.js";
import { chainKeyOf, decide, anchors as anchorsOf, placeFor, shouldStripStart, type Decision } from "./decide.js";
import type { LineDiff } from "./line-diff.js";
import { findRegions, makeBoundaryCheck, type Region } from "./regions.js";
import { indexTopLevel, sameCanonicalSeqIn } from "./same-canonical.js";
import { YIELD_AFTER_MS, yieldToLoop } from "./yield.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
export type AnyPartialBlock = PartialBlock<any, any, any>;

export interface SyncPlan {
  regions: Region[];
  decisions: Decision[];
  /** 每區的預解析 block（刪除區＝[]；`stripStart` 已套用）。 */
  parsed: AnyPartialBlock[][];
  /** 所有非刪除區 parse 的 unbound wikilink 數加總。 */
  unbound: number;
  boundaryChecks: number;
}

export interface PlanSyncInput {
  segments: TransferSegment[];
  baseLineCount: number;
  agentLines: string[];
  diff: LineDiff;
  /** fork 的頂層快照（`topLevelSnapshot`）。 */
  cur: { ids: string[]; fps: string[]; types: string[] };
  /** fork 的未 mount 結構。 */
  curFragment: Y.XmlFragment;
  candidates: readonly VisibleNoteTarget[];
  siteOrigin: string;
  yieldFn?: () => Promise<void>;
  /** 測試縫：時鐘（預設 `performance.now`）。 */
  now?: () => number;
}

/** `unclosed_fence`：檔案層級有未閉合的 code fence（審查 m3，`regions.ts` 的 `UNCLOSED_FENCE_MESSAGE`）；其餘是 parse 的錯誤碼。 */
export type PlanSyncError = ParseError | "unclosed_fence";
/** 失敗形：`detail`＝parse 成因（`ParseDetail`）；`fence`＝未閉合的 fence 記號。只給 HTTP 層挑訊息（8000 探索測試 E）。 */
export type PlanSyncFailure = { ok: false; code: PlanSyncError; detail?: ParseDetail; fence?: string };

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
  const s = await EditorSession.open(runtime, scratch);
  let regions: Region[];
  let boundaryChecks: number;
  const parsed: AnyPartialBlock[][] = [];
  const firstTypes: Array<string | undefined> = [];
  const prevTypes: Array<string | null> = [];
  const insertedIds: string[][] = [];
  let unbound = 0;
  try {
    await yieldFn();
    last = now();
    const parse = (md: string): AnyPartialBlock[] | null => {
      const p = parseMarkdownForNote(s.editor, md, input.candidates, input.siteOrigin);
      return "error" in p ? null : p.blocks;
    };
    const check = makeBoundaryCheck(async md => {
      const r = parse(md);
      await budget();
      return r;
    });
    const rr = await findRegions(input.segments, input.baseLineCount, input.agentLines, input.diff, check, { yieldFn, now });
    if (!rr.ok) return rr.code === "unclosed_fence" ? { ok: false, code: rr.code, fence: rr.fence } : { ok: false, code: rr.code };
    regions = rr.regions;
    boundaryChecks = rr.boundaryChecks;
    const anc = anchorsOf(input.segments, regions);
    const curIdx = new Map(input.cur.ids.map((id, i) => [id, i]));
    // 審查 m（stripStart 的前一顆）：同一個接點（`P` 之後、文件開頭）有多區時，`applySync` 把後一區接在前一區最後一顆之後，所以
    // 後一區真正的「前一顆」是前一區的最後一顆——用同一把鏈的 key 記住它的型別（判 same 的只有改寫區，改寫區放在基底 block 之前、不用鏈）。
    const lastTypeByKey = new Map<string, string>();
    for (let ri = 0; ri < regions.length; ri++) {
      const r = regions[ri]!;
      if (r.kind === "delete") {
        parsed.push([]);
        firstTypes.push(undefined);
        prevTypes.push(null);
        continue;
      }
      const p = parseMarkdownForNote(s.editor, r.text, input.candidates, input.siteOrigin);
      if ("error" in p) return { ok: false, code: p.error, ...(p.detail ? { detail: p.detail } : {}) };
      unbound += p.unbound;
      const blocks = p.blocks;
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
    // ⑤ 預解析寫進 scratch doc（接在 mount 正規化出的那顆空段落之後；那顆不參與比較）。接點記在 `tail`，不每區重讀
    // `editor.document`（那是整份 block JSON，逐區讀是 O(區數×頂層數)，審查 Important 1）；每區之後讓出。
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
  // ⑦ 未 mount 的結構上一次走完：兩個 fragment 各建一次索引、每顆至多 canonicalize 一次（審查 Important 1）。
  const scratchIdx = indexTopLevel(scratch.getXmlFragment(YDOC_FRAGMENT));
  const curIdxSame = indexTopLevel(input.curFragment);
  const pre = insertedIds.map(ids => sameCanonicalSeqIn(scratchIdx, ids) ?? []);
  const same = (ri: number, against: string[]): boolean => {
    // 先比長度（不必 canonicalize 就知道不等，審查 m）。
    const p = pre[ri]!;
    if (against.length !== p.length) return false;
    const seq = sameCanonicalSeqIn(curIdxSame, against);
    return seq !== null && seq.every((x, i) => x === p[i]);
  };
  const decisions = decide(input.segments, regions, input.cur, same, { firstTypes, prevTypes });
  return { ok: true, plan: { regions, decisions, parsed, unbound, boundaryChecks } };
}
