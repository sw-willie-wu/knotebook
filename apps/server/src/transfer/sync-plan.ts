/**
 * bulk transfer spec 2026-11-02 §9.5 第 1–4 步：規劃（plan PR-2 T6）。**零 DB**；scratch session 只在寫進預解析 block 時開，
 * 與之後的 fork mount（`sync-apply.ts`）是**先後、不巢狀**（`runtime.acquire()` 不可重入）。
 *
 * 流程：① 無條件讓出一次 ② `findRegions`（未閉合 fence 的整檔判斷也經 `runtime.parser`），邊界回呼＝`runtime.parser` 解析（#398：parse worker；`makeBoundaryCheck`：去 id、忽略 start、取
 * parse(k) 顆數、parse 失敗 → false）③ `anchors`／`placeFor`（要 `cur.types` 判插入點前一顆是不是 numbered）④ 每個非刪除區
 * 解析（同上）：失敗 → 整篇 400（含「拿掉閉合註解後還有字、但 parse 成 `empty_content`」，§9.3-6）；有
 * `exportedLinkText` 時 parse 出的 wikilink 過一次 `keepLabelFree`（F1：文字仍是下載時匯出的那個 → 不存成自訂文字）；`stripStart` 的區
 * 拿掉第一顆 numbered 的 `props.start` ⑤ 開 scratch session（`try/finally close`），預解析 block `insertBlocks` 進 scratch doc、記每區插入的 id ⑥ close ⑦ 在未 mount 的
 * scratch 結構與 `curFragment` 上以 `sameCanonicalSeq` 算序列 ⑧ `decide`（改寫區的預解析與基底那幾顆逐顆比，`same`）。
 * 前提同 `decide.ts`：呼叫端已確認筆記自下載後沒有被動過（現況頂層與基底段表逐顆相同）。
 * 讓出按時間預算（同一個計時器）：每次邊界 parse、每區 parse 之間、寫進 scratch 之後。
 * 重試（gate r1 m8）：`SyncPlan` 不保留 scratch doc；合併指紋不符時呼叫端直接重跑 `planSync`（新 fork、新 `cur`）。
 * #398：解析的 worker 全忙排太久 → `ParserBusyError` 原樣丟出（呼叫端映成 503）；同一人的解析在 pool 裡一次一筆。
 */
import type { PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
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
  /** #398：解析排隊用的使用者鍵（寫入者 id）。 */
  owner: string;
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
  /**
   * F1：`(目標 id, 文字)` 是不是下載時某個沒有自訂文字的 wikilink 匯出的文字（呼叫端由基底段表的 `links` 組）。是 → parse 出的
   * 那個 wikilink 照「沒有自訂文字」存（`keepLabelFree`）。不給＝舊規則（只認目標現在的標題）。
   */
  exportedLinkText?: (targetId: string, text: string) => boolean;
  /**
   * #398 審查 C2：這個檔的 worker 時間總預算（`runtime.parser.fileBudget()`）。指紋不符重來時呼叫端傳同一份，整個寫回共用；
   * 不給＝這次規劃自己開一份。用完 → 整篇 `unsupported_block`／`too_complex`。
   */
  fileBudget?: ParseBudget;
  yieldFn?: () => Promise<void>;
  /** 測試縫：時鐘（預設 `performance.now`）。 */
  now?: () => number;
}

/** `unclosed_fence`：檔案層級有未閉合的 code fence（審查 m3，`regions.ts` 的 `UNCLOSED_FENCE_MESSAGE`）；其餘是 parse 的錯誤碼。 */
export type PlanSyncError = ParseError | "unclosed_fence";
/** 失敗形：`detail`＝parse 成因（`ParseDetail`）；`fence`＝未閉合的 fence 記號。只給 HTTP 層挑訊息（探索測試 E）。 */
export type PlanSyncFailure = { ok: false; code: PlanSyncError; detail?: ParseDetail; fence?: string };

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
  const exported = input.exportedLinkText;
  let titles: Map<string, string> | null = null;
  const titleOf = (id: string): string | undefined => {
    titles ??= new Map(input.candidates.map(c => [c.id.toLowerCase(), c.title]));
    return titles.get(id.toLowerCase());
  };
  const fileBudget = input.fileBudget ?? runtime.parser.fileBudget();
  const parseMd = (markdown: string) => runtime.parser.parse({ owner: input.owner, markdown, candidates: input.candidates, siteOrigin: input.siteOrigin, budget: fileBudget });
  {
    await yieldFn();
    last = now();
    // #398 審查 C2：邊界檢查的解析回太複雜（逾時、記憶體、預算用完）→ 整篇 400，不當成「邊界不成立」繼續解析下一段。
    const check = makeBoundaryCheck(async md => {
      const p = await parseMd(md);
      await budget();
      if ("error" in p && p.detail === "too_complex") throw new TooComplexAbort();
      return "error" in p ? null : p.blocks;
    });
    let rr: Awaited<ReturnType<typeof findRegions>>;
    try {
      rr = await findRegions(input.segments, input.baseLineCount, input.agentLines, input.diff, check, lines => runtime.parser.openFenceLine(input.owner, lines, fileBudget), { yieldFn, now });
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
      const p = await parseMd(r.text);
      if ("error" in p) return { ok: false, code: p.error, ...(p.detail ? { detail: p.detail } : {}) };
      unbound += p.unbound;
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
