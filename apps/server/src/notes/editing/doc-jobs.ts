/**
 * 讀出與套用的轉換搬出主執行緒：Y 文件 ⇄ BlockNote／markdown 的轉換一律在這裡做，跑在 parse worker（`parse-pool.ts` 的 `doc` 工作）裡，
 * 很小的文件才在主執行緒直接跑（`EditingRuntime.runDoc` 依 {@link DOC_INLINE_MAX_BYTES} 決定）。兩邊跑的是同一支 {@link executeDocOp}，
 * 所以答案逐位元組相同（`test/unit/doc-jobs.test.ts` 比對）。
 *
 * 輸入一律是**文件狀態**（`Y.encodeStateAsUpdate` 的位元組：記憶體中的活文件由主執行緒編碼；沒載入的直接用 `note_states` 的位元組，
 * 主執行緒不解碼），輸出一律是純資料（markdown、大綱、指紋、diff 位元組）。這裡**不碰 DB、不開連線**：需要 DB 的那一步（連結的現行標題、
 * 批次寫回的額度）用 `ask` 問主執行緒（worker 裡經訊息往返，主執行緒直接呼叫）。
 *
 * 套用（`edit`／`revert`／`sync`）回的 {@link DocPost}：diff（`encodeStateAsUpdate(fork, baseStateVector)`）、基底的快照（state vector
 * ＋刪除集，`Y.encodeSnapshot`）、合併守衛（`live-watch.ts`）、以及合併後才算得出來的值（整篇指紋、大綱、寫入落點的指紋、版本指紋、
 * wikilink 目標、大小與內容量）。主執行緒在活文件之後的改動沒碰到守衛裡的 block 時套用 diff（`apply.ts` 的 `mergeAtBase`；Yjs 合併是 CRDT
 * 安全的）；沒有 watch（取狀態時文件不在記憶體）時退回比快照——只比 state vector 不夠：只有刪除的更新不會改 state vector（刪除集才會變）。
 * 回的指紋與大綱是「基底＋這次寫入」的（不含別人在這期間的改動）。
 */
import type { Block, PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { MAX_LINK_TARGETS, YDOC_FRAGMENT, extractLinkTargets, topLevelContainers, type EditOp, type NoteContentDto, type NoteOutlineEntry, type NoteSectionDto } from "@knotebook/shared";
import type { TransferSegment } from "../../db/schema.js";
import { hmacOf } from "../../transfer/base-hash.js";
import { isLoneEmptyParagraph, matchesBase } from "../../transfer/decide.js";
import { exportNoteBody, exportNoteForTransfer, type ExportedNote } from "../../transfer/export-note.js";
import type { LineDiff } from "../../transfer/line-diff.js";
import { exportedLinkTextOf, linkTextHash } from "../../transfer/link-texts.js";
import { normalizeBody } from "../../transfer/normalize.js";
import { applySync, type Applied } from "../../transfer/sync-apply.js";
import { planSync, type PlanSyncError, type SyncPlan } from "../../transfer/sync-plan.js";
import type { Decision } from "../../transfer/decide.js";
import { measureTrial, type SizeMeasure } from "../note-size.js";
import { versionFingerprint } from "../version-fingerprint.js";
import type { VisibleNoteTarget } from "./candidates.js";
import { fingerprintForIds, fingerprintsOfGroups, outlineOf, topLevelSnapshot, type OutlineEntry } from "./fingerprint.js";
import type { ParseDetail, ParseError } from "./markdown.js";
import { readNoteContentFromDoc } from "./read.js";
import { editRevertable, isDeleteShape, prepareRevertOnFork, topLevelIds, type RevertRow } from "./revert-core.js";
import { containerItems, type MergeGuard } from "./live-watch.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, replaceBlocksFresh } from "./session.js";
import type { ShownLinks } from "./shown-link-texts.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyPartialBlock = PartialBlock<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyBlock = Block<any, any, any>;
export type Anchor = { block_id: string; position: "before" | "after"; placeholder?: boolean };

/**
 * 文件狀態（位元組）小於這個就在主執行緒直接轉換，不送 worker（套用另加要寫進去的內容長度）。量測（`docs/self-hosting.md`「Parse
 * workers」）：這個大小以下主執行緒一次轉換的停頓在 10 毫秒上下，與送 worker 來回的延遲同量級；送 worker 反而可能排在別人的大工作
 * 後面等上數秒、甚至在 worker 全忙時回 503。
 */
export const DOC_INLINE_MAX_BYTES = 16 * 1024;

/** 一件轉換工作的時限＝這麼多倍的 `PARSE_TIMEOUT_MS`（讀一份大筆記要 mount＋整篇匯出；套用要 mount＋寫入＋算合併後的值）。 */
export const DOC_TIMEOUT_FACTOR = 3;

/** worker 逾時、用完記憶體或堆疊（或拋 `RangeError`）的答案。 */
export const DOC_TOO_COMPLEX = "too_complex" as const;
export type DocTooComplex = typeof DOC_TOO_COMPLEX;

/** 問主執行緒：連結目標的現行標題（只回讀者看得到的；`[小寫 id, 標題]`），或批次寫回扣一次額度（回 `true`＝扣到了）。 */
export type DocAsk = { kind: "titles"; ids: string[] } | { kind: "charge" };
export type AskFn = (q: DocAsk) => Promise<unknown>;
export type TitlePairs = Array<[string, string]>;

/** 套用的結果裡、合併時要用與合併後才算得出來的值（見檔頭）。 */
export interface DocPost {
  /** 基底的快照（`Y.encodeSnapshot(Y.snapshot(base))`）：活文件的快照等於它才套用。 */
  baseSnapshot: Uint8Array;
  /** 基底的 `docClock`（＝合併前活文件的；links 的 CAS 用）。 */
  clock: number;
  diff: Uint8Array;
  fingerprint: string;
  outline: NoteOutlineEntry[];
  afterFingerprint: string | null;
  afterSectionIndex: number | null;
  versionFingerprint: string | null;
  afterFingerprints?: (string | null)[];
  /** 編輯後的 wikilink 目標（`extractLinkTargets`，未截斷；`syncLinksFromDoc` 截）。 */
  linkTargets: string[];
  /**
   * 筆記大小：基底與「基底＋diff」的狀態位元組數（＝`note_states.ydoc`）與還在的內容位元組數（`measureTrial`）。主執行緒據以擋「長過上限」
   * （`notes/note-size.ts` 的 `capBlocks`，依結果判斷，審查 r6）。
   */
  size: SizeMeasure;
  /** 合併時活文件若已被別人改過，哪些改動算衝突（`live-watch.ts`）。 */
  guard: MergeGuard;
}

export type ReadDocOp = { kind: "read"; state: Uint8Array; section?: string; wantShown: boolean };
export type OutlineDocOp = { kind: "outline"; state: Uint8Array };
export type ExportFileDocOp = { kind: "exportFile"; state: Uint8Array; key: Uint8Array; salt: Uint8Array; forceUnmergeable?: boolean };
export type EditDocOp = {
  kind: "edit";
  state: Uint8Array;
  op: EditOp;
  sectionId?: string;
  ifMatch?: string;
  /** 已解析好的內容（`delete_section` 不給）。 */
  blocks?: AnyPartialBlock[];
  /** 解析失敗：段落與指紋檢查之後才回（錯誤碼的先後同舊）。 */
  parseError?: { error: ParseError; detail?: ParseDetail };
};
export type RevertDocOp = { kind: "revert"; state: Uint8Array; row: RevertRow; othersShareAnchor: boolean };
/**
 * 批次寫回一個檔分兩件工作：`syncPlan`（比對基底、扣額度、解析、規劃）與 `syncApply`（照規劃套用、算合併後的值），兩件用**同一份**文件狀態。
 * 分開的理由：解析一大段密集格式要用到幾百 MiB（`docs/self-hosting.md`），與 mount＋套用疊在同一件工作裡會用完 worker 的記憶體上限；
 * 分開之後 pool 可以在兩件之間換掉用了很多記憶體的 worker（`parse-pool.ts` 的 {@link RECYCLE_HEAP_SHARE}）。
 */
export type SyncPlanDocOp = {
  kind: "syncPlan";
  state: Uint8Array;
  owner: string;
  segments: TransferSegment[] | null;
  baseLineCount: number;
  /** 本文有改才給（只改標題時兩者都不給：只判「筆記自下載後動過沒」）。 */
  body: { agentLines: string[]; diff: LineDiff } | null;
  candidates: readonly VisibleNoteTarget[];
  siteOrigin: string;
  key: Uint8Array;
  salt: Uint8Array;
  /** 下載時整篇本文的雜湊（段表 null 時退回整篇比對用）。 */
  baseBodySha: Uint8Array;
  /** 這個檔剩下的解析預算（毫秒；`ParseBudget`）。 */
  budgetMs: number;
};
export type SyncApplyDocOp = { kind: "syncApply"; state: Uint8Array; plan: SyncPlan; normalizedId: string | null };
/** 狀態＋更新套在新文件上的大小試套（套用版本的大小上限，`notes/editing/apply-version.ts`；`notes/note-size.ts` 的 `measureTrial`）。 */
export type SizeTrialDocOp = { kind: "sizeTrial"; state: Uint8Array; update: Uint8Array };
export type DocOp = ReadDocOp | OutlineDocOp | ExportFileDocOp | EditDocOp | RevertDocOp | SyncPlanDocOp | SyncApplyDocOp | SizeTrialDocOp;

export interface ReadDocResult {
  result: Omit<NoteContentDto, "lastEdited"> | Omit<NoteSectionDto, "lastEdited"> | "section_not_found";
  shown?: ShownLinks;
}
export interface OutlineDocResult {
  outline: OutlineEntry[];
  whole: string;
}
export type EditDocResult =
  | { ok: true; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null; post: DocPost }
  | { ok: false; code: "section_not_found" | "fingerprint_mismatch" | "empty_section" | ParseError; detail?: ParseDetail };
export type RevertDocResult = { ok: true; reinsertedIds: string[]; removedSnapshot: AnyBlock[]; post: DocPost } | { ok: false; code: "stale" };
export type SyncPlanDocResult = { budgetLeft: number } & (
  | { kind: "note_changed" }
  | { kind: "body_checked" }
  | { kind: "rate_limited" }
  | { kind: "parse"; code: PlanSyncError; detail?: ParseDetail; fence?: string }
  | { kind: "zero_region"; same: number }
  | { kind: "planned"; plan: SyncPlan; normalizedId: string | null }
);
export interface SyncApplyDocResult {
  decisions: Decision[];
  unbound: number;
  perRegion: Applied["perRegion"];
  post: DocPost;
}
export interface DocResults {
  read: ReadDocResult;
  outline: OutlineDocResult;
  exportFile: ExportedNote;
  edit: EditDocResult;
  revert: RevertDocResult;
  syncPlan: SyncPlanDocResult;
  syncApply: SyncApplyDocResult;
  sizeTrial: SizeMeasure;
}
export type DocOpOf<K extends DocOp["kind"]> = Extract<DocOp, { kind: K }>;

/** 解開文件狀態（空位元組＝從未開過的筆記：空文件）。 */
export function decodeState(state: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  if (state.byteLength > 0) Y.applyUpdate(doc, state);
  return doc;
}

/** `collab/store.ts` 的 `docClock`（state vector 各 client 的值總和）；這裡另算一份，免得 worker 載入整個協作層。 */
function clockOf(doc: Y.Doc): number {
  let total = 0;
  for (const seq of Y.decodeStateVector(Y.encodeStateVector(doc)).values()) total += seq;
  return total;
}

/** 基底：state vector（取 diff 用）、快照（合併時比對用）、clock、大小（＝送進來的狀態的位元組數）。**mount 之前**算（mount 會正規化空文件）。 */
function baseOf(doc: Y.Doc, state: Uint8Array): { sv: Uint8Array; snapshot: Uint8Array; clock: number; size: number; state: Uint8Array } {
  return { sv: Y.encodeStateVector(doc), snapshot: Y.encodeSnapshot(Y.snapshot(doc)), clock: clockOf(doc), size: state.byteLength, state };
}

/**
 * 合併後存下的大小：基底＋diff 套在一份**新的**文件上再編碼。不能直接編碼編輯過的 fork——編輯器的復原紀錄（y-prosemirror 的 UndoManager）
 * 讓 fork 裡被刪的內容不被回收，整篇換掉之後 fork 仍有原來那麼大；活文件（沒有編輯器）套用 diff 時會回收，存下的是這裡算的大小。
 */
export function measureDiff(state: Uint8Array, diff: Uint8Array): SizeMeasure {
  return measureTrial(state, diff);
}

/** 活文件的快照是否仍等於基底（主執行緒合併前用；線性走一次結構，不轉換）。 */
export function stateEquals(doc: Y.Doc, baseSnapshot: Uint8Array): boolean {
  return Y.equalSnapshots(Y.snapshot(doc), Y.decodeSnapshot(baseSnapshot));
}

const stripIds = (outline: OutlineEntry[]): NoteOutlineEntry[] => outline.map(({ blockIds: _b, ...e }) => e);

/** 編輯後的 fork 上算合併後的值（舊做法是合併後在活文件上算；活文件＝基底＋diff＝這份 fork，值相同）。 */
function postOf(fork: Y.Doc, base: ReturnType<typeof baseOf>, diff: Uint8Array, afterIds: string[], guard: MergeGuard, afterGroups?: string[][]): DocPost {
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  let versionFp: string | null = null;
  try {
    versionFp = versionFingerprint(fragment);
  } catch {
    versionFp = null; // 版本歷史 A14 (3) 保證不丟例外，這裡仍防禦性包住（同舊 `mergeDiff`）
  }
  const merged = outlineOf(fragment);
  const firstAfter = afterIds[0];
  // `-1`（找得到 afterIds 卻不在任何一段裡）證不出不可達，退成 null（呼叫端 `?? 0`；同舊 `mergeDiff`）。
  const afterIndex = firstAfter === undefined ? -1 : merged.outline.findIndex(s => s.blockIds.includes(firstAfter));
  const post: DocPost = {
    baseSnapshot: base.snapshot,
    clock: base.clock,
    diff,
    fingerprint: merged.whole,
    outline: stripIds(merged.outline),
    afterFingerprint: afterIds.length === 0 ? null : fingerprintForIds(fragment, afterIds),
    afterSectionIndex: afterIndex === -1 ? null : afterIndex,
    versionFingerprint: versionFp,
    linkTargets: extractLinkTargets(fork),
    size: measureDiff(base.state, diff),
    guard,
  };
  if (afterGroups !== undefined) post.afterFingerprints = fingerprintsOfGroups(fragment, afterGroups);
  return post;
}

/** 讀者看得到的連結目標的現行標題（`linkTitlesFor` 的 worker 版：抽目標在這裡，查 DB 經 `ask`）。 */
async function titlesFor(doc: Y.Doc, ask: AskFn): Promise<Map<string, string>> {
  const ids = extractLinkTargets(doc).slice(0, MAX_LINK_TARGETS);
  if (ids.length === 0) return new Map();
  return new Map((await ask({ kind: "titles", ids })) as TitlePairs);
}

/**
 * 編輯器那一段（舊 `prepareEdit` 的後半）：mount → 單一編輯器呼叫 → diff → close。**持有 lease 期間不再取得 lease**（`runtime.ts`）。
 */
export async function editOnFork(
  runtime: EditingRuntime,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: { op: EditOp; isEmptyDoc: boolean; section: OutlineEntry | undefined },
  blocks: AnyPartialBlock[],
): Promise<{ diff: Uint8Array; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null }> {
  const { op, isEmptyDoc, section } = plan;
  const s = await EditorSession.open(runtime, fork);
  try {
    const ed = s.editor;
    const top = ed.document;
    const snapshot = (idList: string[]): AnyBlock[] => idList.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
    let beforeBlocks: AnyBlock[] = [];
    let afterIds: string[] = [];
    let anchor: Anchor | null = null;
    switch (op) {
      case "replace_all": {
        beforeBlocks = isEmptyDoc ? [] : top;
        afterIds = replaceBlocksFresh(ed, top.map(b => b.id), blocks).map(b => b.id); // 審查 C1：先插後刪（見 `replaceBlocksFresh`）
        break;
      }
      case "replace_section": {
        const sectionIds = section!.blockIds;
        if (sectionIds.length === 0) afterIds = ed.insertBlocks(blocks, top[0]!.id, "before").map(b => b.id); // 零 block _top：插在第一個 heading 之前
        else {
          beforeBlocks = snapshot(sectionIds);
          afterIds = replaceBlocksFresh(ed, sectionIds, blocks).map(b => b.id);
        }
        break;
      }
      case "insert_after": {
        const sectionIds = section!.blockIds;
        afterIds = (sectionIds.length === 0 ? ed.insertBlocks(blocks, top[0]!.id, "before") : ed.insertBlocks(blocks, sectionIds[sectionIds.length - 1]!, "after")).map(b => b.id);
        break;
      }
      case "append": {
        afterIds = ed.insertBlocks(blocks, top[top.length - 1]!.id, "after").map(b => b.id);
        break;
      }
      case "delete_section": {
        const sectionIds = section!.blockIds;
        beforeBlocks = snapshot(sectionIds);
        const idx = top.findIndex(b => b.id === sectionIds[0]);
        const prev = top[idx - 1];
        const next = top[idx + sectionIds.length];
        if (sectionIds.length === top.length) {
          // 段落涵蓋整篇：永不為空 → 空 paragraph 收尾，id 不記
          const inserted = ed.replaceBlocks(sectionIds, [{ type: "paragraph" }]).insertedBlocks;
          anchor = { block_id: inserted[0]!.id, position: "before" };
        } else {
          ed.replaceBlocks(sectionIds, []);
          anchor = prev ? { block_id: prev.id, position: "after" } : { block_id: next!.id, position: "before" };
        }
        break;
      }
    }
    return { diff: s.diffSince(sv), beforeBlocks, afterIds, anchor };
  } finally {
    s.close(); // ← 編輯器到此為止
  }
}

async function readOp(runtime: EditingRuntime, op: ReadDocOp, ask: AskFn): Promise<ReadDocResult> {
  const doc = decodeState(op.state);
  const titles = await titlesFor(doc, ask);
  let shown: ShownLinks | undefined;
  const result = await readNoteContentFromDoc(runtime, doc, op.section, titles, op.wantShown ? s => (shown = s) : undefined);
  return shown ? { result, shown } : { result };
}

async function editOp(runtime: EditingRuntime, op: EditDocOp): Promise<EditDocResult> {
  const fork = decodeState(op.state);
  const base = baseOf(fork, op.state);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(fragment);
  const isEmptyDoc = topLevelContainers(fragment).length === 0;
  const section = op.sectionId === undefined ? undefined : outline.find(o => o.sectionId === op.sectionId);
  if (op.sectionId !== undefined && !section) return { ok: false, code: "section_not_found" };
  const expect = op.ifMatch ?? null;
  const targetIds = op.op === "replace_all" || op.op === "append" ? null : section!.blockIds;
  if (expect !== null && (targetIds === null ? whole : section!.fingerprint) !== expect) return { ok: false, code: "fingerprint_mismatch" };
  if (op.op === "delete_section" && (isEmptyDoc || section!.blockIds.length === 0)) return { ok: false, code: "empty_section" };
  if (op.parseError) return { ok: false, code: op.parseError.error, ...(op.parseError.detail ? { detail: op.parseError.detail } : {}) };
  // 真空文件：三 op 等同 replace_all（正規化殘留 paragraph 被 replace 掉）
  const editKind: EditOp = isEmptyDoc ? "replace_all" : op.op;
  const blocks = op.blocks ?? [];
  // 合併時的守衛（mount 之前，用基底的 item id）：不帶 if_match＝不在意別人的改動；整篇指紋＝任何改動；段落指紋＝目標段的 block。
  const guard: MergeGuard = expect === null ? { kind: "none" } : targetIds === null || isEmptyDoc ? { kind: "any" } : { kind: "blocks", items: containerItems(fragment, targetIds), anchors: [] };
  const r = await editOnFork(runtime, fork, base.sv, { op: editKind, isEmptyDoc, section }, blocks);
  return { ok: true, beforeBlocks: r.beforeBlocks, afterIds: r.afterIds, anchor: r.anchor, post: postOf(fork, base, r.diff, r.afterIds, guard) };
}

async function revertOp(runtime: EditingRuntime, op: RevertDocOp): Promise<RevertDocResult> {
  const fork = decodeState(op.state);
  const base = baseOf(fork, op.state);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { row } = op;
  const isDelete = isDeleteShape({ op: row.op, anchor: row.anchor });
  // 與 `listEdits` **同一顆述詞**（`editRevertable`）：清單顯示什麼，這裡就放行什麼（理由見 `revert-core.ts`）。
  const revertable = editRevertable(
    { op: row.op, afterBlockIds: row.afterBlockIds, afterFingerprint: row.afterFingerprint, anchorId: row.anchor?.block_id ?? null, beforeIds: isDelete ? row.beforeBlocks.map(b => (b as { id: string }).id) : [] },
    fragment,
    topLevelIds(fragment),
  );
  if (!revertable) return { ok: false, code: "stale" };
  // 守衛＝舊 `mergeDiff` 的合併前重核對：刪除形看錨點還在；其他看寫進去的那幾顆沒被動過。
  const guard: MergeGuard = isDelete
    ? { kind: "blocks", items: [], anchors: containerItems(fragment, row.anchor ? [row.anchor.block_id] : []), absent: row.beforeBlocks.map(b => (b as { id: string }).id) }
    : { kind: "blocks", items: containerItems(fragment, row.afterBlockIds), anchors: [] };
  const r = await prepareRevertOnFork(runtime, row, fork, base.sv, op.othersShareAnchor);
  return { ok: true, reinsertedIds: r.reinsertedIds, removedSnapshot: r.removedSnapshot, post: postOf(fork, base, r.diff, r.reinsertedIds, guard) };
}

/** 批次寫回一個檔的前半（舊 `NoteWriteService.syncFileInQueue` 迴圈裡、套用之前的那一段）。 */
async function syncPlanOp(runtime: EditingRuntime, op: SyncPlanDocOp, ask: AskFn): Promise<SyncPlanDocResult> {
  const budget = { remainingMs: op.budgetMs };
  const left = () => budget.remainingMs;
  const fork = decodeState(op.state);
  const curFragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const cur = topLevelSnapshot(curFragment);
  const key = Buffer.from(op.key);
  const salt = Buffer.from(op.salt);
  let loneEmpty = false;
  if (op.segments !== null) {
    // ⑥ 段表非 null → 結構比對（不 mount、不匯出）
    loneEmpty = op.segments.length === 0 && isLoneEmptyParagraph(curFragment);
    if (!loneEmpty && !matchesBase(op.segments, cur)) return { kind: "note_changed", budgetLeft: left() };
  } else {
    // 段表 null（只會是只改標題）：沒有逐顆指紋可比，退回整篇匯出比對；fork 的副本上匯出（mount 不碰 fork）。
    const titles = await titlesFor(fork, ask);
    const copy = decodeState(Y.encodeStateAsUpdate(fork));
    const nowBody = normalizeBody(await exportNoteBody(runtime, copy, titles));
    if (!hmacOf(key, salt, nowBody).equals(Buffer.from(op.baseBodySha))) return { kind: "note_changed", budgetLeft: left() };
  }
  if (op.body === null || op.segments === null) return { kind: "body_checked", budgetLeft: left() };
  // 全分支審查 I2：寫回額度在解析之前扣（重試時主執行緒不再扣）。
  if (!((await ask({ kind: "charge" })) as boolean)) return { kind: "rate_limited", budgetLeft: left() };
  const planned = await planSync(runtime, {
    owner: op.owner,
    fileBudget: budget,
    segments: op.segments,
    baseLineCount: op.baseLineCount,
    agentLines: op.body.agentLines,
    diff: op.body.diff,
    cur,
    curFragment,
    candidates: op.candidates,
    siteOrigin: op.siteOrigin,
    exportedLinkText: exportedLinkTextOf(op.segments, key, salt),
  });
  if (!planned.ok) return { kind: "parse", code: planned.code, ...(planned.detail ? { detail: planned.detail } : {}), ...(planned.fence ? { fence: planned.fence } : {}), budgetLeft: left() };
  const p = planned.plan;
  if (p.decisions.every(d => d.mark === "same")) return { kind: "zero_region", same: p.decisions.length, budgetLeft: left() };
  return { kind: "planned", plan: p, normalizedId: loneEmpty ? cur.ids[0]! : null, budgetLeft: left() };
}

/** 批次寫回一個檔的後半：同一份文件狀態上照規劃套用（`applySync`），算合併後的值。 */
async function syncApplyOp(runtime: EditingRuntime, op: SyncApplyDocOp): Promise<SyncApplyDocResult> {
  const fork = decodeState(op.state);
  const base = baseOf(fork, op.state);
  const cur = topLevelSnapshot(fork.getXmlFragment(YDOC_FRAGMENT));
  const a = await applySync(runtime, fork, base.sv, op.plan, cur, op.normalizedId !== null ? { normalizedId: op.normalizedId } : {});
  // 批次寫回的前提是「整篇與下載時相同」（舊做法比整篇指紋＋每顆指紋）：任何改動都算衝突。
  const post = postOf(fork, base, a.diff, [], { kind: "any" }, a.perRegion.map(pr => pr.afterIds));
  return { decisions: op.plan.decisions, unbound: op.plan.unbound, perRegion: a.perRegion, post };
}

/**
 * 一件轉換工作的本體（worker 與主執行緒共用）。`RangeError`（堆疊溢位、陣列或字串長度超過上限）＝太大或太複雜，回 {@link DOC_TOO_COMPLEX}；
 * 其他例外原樣丟（程式錯，呼叫端照舊 500）。
 */
export async function executeDocOp<K extends DocOp["kind"]>(runtime: EditingRuntime, op: DocOpOf<K>, ask: AskFn): Promise<DocResults[K] | DocTooComplex> {
  try {
    return (await run(runtime, op as DocOp, ask)) as DocResults[K];
  } catch (err) {
    if (err instanceof RangeError) return DOC_TOO_COMPLEX;
    throw err;
  }
}

async function run(runtime: EditingRuntime, op: DocOp, ask: AskFn): Promise<DocResults[DocOp["kind"]]> {
  switch (op.kind) {
    case "read":
      return readOp(runtime, op, ask);
    case "outline":
      return outlineOf(decodeState(op.state).getXmlFragment(YDOC_FRAGMENT));
    case "exportFile": {
      const doc = decodeState(op.state);
      const titles = await titlesFor(doc, ask);
      const key = Buffer.from(op.key);
      const salt = Buffer.from(op.salt);
      return exportNoteForTransfer(runtime, doc, titles, { ...(op.forceUnmergeable ? { forceUnmergeable: true } : {}), linkHash: (id, text) => linkTextHash(key, salt, id, text) });
    }
    case "edit":
      return editOp(runtime, op);
    case "revert":
      return revertOp(runtime, op);
    case "syncPlan":
      return syncPlanOp(runtime, op, ask);
    case "syncApply":
      return syncApplyOp(runtime, op);
    case "sizeTrial":
      return measureTrial(op.state, op.update);
  }
}

/** 這件工作的「大小」（決定在不在主執行緒跑）：文件狀態的位元組，加上要寫進去的內容的估計。 */
export function docWeight(op: DocOp, extra = 0): number {
  return op.state.byteLength + extra + (op.kind === "sizeTrial" ? op.update.byteLength : 0);
}
