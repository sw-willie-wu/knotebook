import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Block, PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { AI_EDITS_RETENTION, YDOC_FRAGMENT, topLevelContainers, type EditOp, type NoteOutlineEntry } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import type { VersionService } from "../../collab/versions.js";
import { docClock } from "../../collab/store.js";
import type { Db } from "../../db/index.js";
import { noteAiEdits } from "../../db/schema.js";
import { syncLinksFromDoc } from "../links.js";
import { capBlocks, NoteTooLargeError } from "../note-size.js";
import { versionFingerprint } from "../version-fingerprint.js";
import type { VisibleNoteTarget } from "./candidates.js";
import { checkExpectations, fingerprintForIds, fingerprintsOfGroups, outlineOf, type OutlineEntry } from "./fingerprint.js";
import { siteOriginOf, type ParseDetail, type ParseError } from "./markdown.js";
import { DOC_TOO_COMPLEX, editOnFork, stateEquals, type DocPost } from "./doc-jobs.js";
import type { LiveWatch } from "./live-watch.js";
import { ParserBusyError, type ParseOutcome } from "./parse-core.js";
import { loadNoteDoc, loadNoteState } from "./read.js";
import type { EditingRuntime } from "./runtime.js";
import { directTarget, withDirectConnection, type DirectConnectionCtx, type DirectCtx } from "./session.js";
import { shownLinkTextsOf, type ShownLinks, type ShownLinkTexts } from "./shown-link-texts.js";

// 順序（轉換搬出主執行緒後）：parse/驗證（parse worker）→ 文件狀態（活文件編碼，或 `note_states` 的位元組）→ worker 裡
// 指紋比對 → 單一編輯器呼叫 → diff ＋合併後的值（`doc-jobs.ts`）→ mergeAtBase＝withDirectConnection 內一個同步 transact（活文件之後的
// 改動沒碰到這次寫入在意的 block 才 applyUpdate → ctx.applied，`live-watch.ts`；碰到了 → 從頭重來，至多 DOC_MERGE_ATTEMPTS 次，再不行 503）
// → finally disconnect（落盤）
// → note_ai_edits 交易（含裁切 100）→ note_links（writeNoteLinks 自己的交易，CAS 對更晚的瀏覽器寫入 no-op）。
// 套用版本與連結轉換仍走舊的 `mergeDiff`（主執行緒在活文件上重算指紋；見 known-limitations）。
// 沒有任何 DB 交易橫跨合併；先合併落盤、後記錄（記錄失敗＝內容在、紀錄沒有）；before_blocks 無上限。
// ⚠ 「fork→merge 窗口理論為零」只對**目標段非空**成立：零 block 的段（heading 開頭筆記的 `_top`、
// 真空文件）指紋恆為 `EMPTY_SECTION_FINGERPRINT`（常數），重算必等於 `if_match`；`append` 不帶
// `if_match` 時本就跳過核對。那些情形併發插入的 block **不會遺失**（Yjs 兩邊都留），只是 AI 內容
// 的相對位置由 CRDT 決定。⚠ 編輯器（＝runtime lease）只活到取出 diff 為止（`prepareEdit`）：
// **持有 lease 期間絕不再取得 lease**，否則跨過重建門檻時內外層互等，是無訊息的死鎖
// （見 `runtime.ts` 的 acquire 不可重入）。
export interface EditingTestHooks {
  beforeMerge?: () => Promise<void>;
  beforeRecord?: () => Promise<void>;
  /** 紀錄已寫入、`updateNoteLinks` 尚未執行（守「先紀錄後連結」）。 */
  afterRecord?: () => Promise<void>;
  beforeRevertRecord?: () => Promise<void>;
  /** `mergeAtBase` 開了直連之後、transact 之前（測試在這裡改活文件，守 transact 內的比對）。 */
  afterOpenDirect?: () => Promise<void>;
  /** 套用版本的 `beforeDisconnect` 第一步；測試以 throw 模擬基底寫回失敗。 */
  beforeVersionBase?: () => Promise<void>;
  /** bulk transfer：檔案新增扣桶之後、建列之前一刻（測試在這裡刪掉目標資料夾）。 */
  beforeCreateFromFile?: () => Promise<void>;
}
// ⚠ `log` 兩個方法都要：`updateNoteLinks` 用 `warn`、`recordableAfter` 用 `error`。少宣告 `error`
// 就是 typecheck 紅。
export interface ApplyDeps {
  db: Db;
  collab: CollabServer;
  editing: EditingRuntime;
  log: { warn(o: object, m: string): void; error(o: object, m: string): void };
  testHooks?: EditingTestHooks;
  /** 版本歷史：套用（`apply-version.ts`）用。#272：AI／直寫前後不再切版。測試不注入＝no-op。 */
  versions?: VersionService;
  /** #387：寫入者讀到過的連結文字（`NoteWriteService` 那一份）。`prepareEdit` 解析 markdown 後據以不把它凍結成自訂文字，`applyEdit`
   *  合併成功後把寫下去的連結也記進去；不給＝舊規則。 */
  shownLinks?: ShownLinkTexts;
  /** 筆記大小上限（呼叫端傳入的值）；不給＝不擋（直接組 deps 的測試）。`mergeAtBase` 在合併之前比（`notes/note-size.ts`）。 */
  noteMaxBytes?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyPartialBlock = PartialBlock<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyBlock = Block<any, any, any>;
type Anchor = { block_id: string; position: "before" | "after" };

// `blocks`／`unbound` 只有建筆記路徑會傳（管線：空 scratch doc 解析驗證 → 建列 → 把
// **解析出的 block JSON** 套到真 fork）；`/edits` 一律不傳，行為完全不變。
export interface ApplyInput {
  noteId: string; userId: string; tokenId: string | null; agentLabel: string | null; op: EditOp;
  sectionId?: string; markdown?: string; ifMatch?: string; candidates: readonly VisibleNoteTarget[];
  blocks?: AnyPartialBlock[]; unbound?: number;
  /** 帶 `blocks` 時原 markdown 的長度（決定轉換在不在主執行緒跑，`EditingRuntime.runDoc`）；不給就量 block JSON 的長度。 */
  contentLength?: number;
  /**
   * #398：呼叫端已經在佇列外解析好的結果（`NoteWriteService.applyToNote` 在進每篇筆記的佇列之前先解析，不讓解析佔著佇列）。
   * 給了就不再解析；錯誤照樣在段落／指紋檢查之後才回（錯誤碼的先後不變）。
   */
  preparsed?: ParseOutcome;
}
// ⚠ `ApplyResult` 是**內部**型別：`afterBlockIds` 只餵 presence，`NoteEditResultDto` 與 201
// 回應的欄位一個都不動。
export type ApplyResult =
  | {
      ok: true; editId: string; fingerprint: string; outline: NoteOutlineEntry[]; unboundWikilinks: number;
      /**
       * 這次真正寫下去的 block id（文件順序）。presence 的落點只能取自編輯後狀態——請求帶的
       * `section_id` 是 heading 的 block id，`replace_section`／`delete_section` 會把它換掉。
       * `delete_section` 恆為 `[]`。
       */
      afterBlockIds: string[];
      /**
       * #108：這次寫入的落點**在寫完後的 outline 裡的索引**（`edit_note` 用它取
       * 「包含落點的那一頁」）。`delete_section` 恆為 `null`（`afterBlockIds` 是空的，
       * 那一段已經不存在，「落點那一頁」在它身上沒有定義）。
       * ⚠ **REST 那條路上零消費端**（`routes/notes.ts` 不讀它，`NoteEditResultDto` 一欄都沒動）
       * ——留著的唯一理由是它算得到的地方只有 `mergeDiff`（`stripIds` 之前，blockIds 還在）。
       */
      afterSectionIndex: number | null;
    }
  | { ok: false; code: "section_not_found" | "fingerprint_mismatch" | ParseError | "empty_section" | "too_complex"; detail?: ParseDetail };

export const RETENTION = AI_EDITS_RETENTION; // #272：數字搬到 shared（web 的說明句用同一個），行為不變
export class FingerprintMismatch extends Error {}

/**
 * bulk transfer：多期望（選配）。`expectEach`／`anchorIds`／`afterGroups` 任一給了就走「一次走完頂層、逐一查表」
 * 的多期望檢查（`checkExpectations`：每顆各自比指紋、**不比順序**；錨點都在），此時 `targetIds` 必須是 null（給了 → throw，接線錯）；
 * `expectFingerprint` 非 null 時另比整篇指紋（`outlineOf(...).whole`，檔案寫回用：現況整篇沒變才合併）；`applyUpdate` 之後同一次走完
 * 算每組 `afterGroups` 的指紋（`afterFingerprints`）。
 * 三者都不給＝行為逐位元組不變（`edit_note`／撤回／套用版本）。
 */
export interface MergeInput {
  targetIds: string[] | null; expectFingerprint: string | null; anchorId: string | null; diff: Uint8Array; afterIds: string[];
  expectEach?: Array<{ id: string; fp: string }>; anchorIds?: string[]; afterGroups?: string[][];
}
export interface MergeOutput { afterFingerprint: string | null; fingerprint: string; outline: NoteOutlineEntry[]; clock: number; afterSectionIndex: number | null; versionFingerprint: string | null; afterFingerprints?: (string | null)[] }

const stripIds = (o: { outline: Array<NoteOutlineEntry & { blockIds: string[] }> }): NoteOutlineEntry[] =>
  o.outline.map(({ blockIds: _b, ...e }) => e);

/** 把 diff 合併回活文件的入口；撤回（revert.ts）也走這裡。 */
export async function mergeDiff(
  deps: ApplyDeps,
  noteId: string,
  ctx: DirectConnectionCtx,
  input: MergeInput,
  opts?: { beforeDisconnect?: (out: MergeOutput) => Promise<void> }
): Promise<MergeOutput> {
  return withDirectConnection(directTarget(deps.collab, deps.db), noteId, ctx, doc => {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    const multi = input.expectEach !== undefined || input.anchorIds !== undefined || input.afterGroups !== undefined;
    if (multi) {
      if (input.targetIds !== null) throw new Error("mergeDiff：多期望不收 targetIds（接線錯）");
      if (!checkExpectations(fragment, input.expectEach ?? [], input.anchorIds ?? [])) throw new FingerprintMismatch();
      // 檔案寫回：多期望再加整篇指紋——現況與規劃時的 fork 整篇相同才合併（`expectEach` 不管多出來的 block）。
      if (input.expectFingerprint !== null && outlineOf(fragment).whole !== input.expectFingerprint) throw new FingerprintMismatch();
    } else if (input.expectFingerprint !== null) {
      const live = input.targetIds === null ? outlineOf(fragment).whole : fingerprintForIds(fragment, input.targetIds);
      if (live === null || live !== input.expectFingerprint) throw new FingerprintMismatch(); // null＝id 缺或順序變，不退回整篇
    }
    // 交易內的錨點重核對（只有撤回會帶 `anchorId`）：擋「預檢之後、合併之前，人剛好把錨點刪掉」。
    // ⚠ 存活突變：**沒有測試會因為刪掉這一行而變紅**——`revertEdit` 沒有 `beforeMerge` 這種注入點
    // （只有 `applyEdit` 有），那個交錯在整合層造不出來，只能靠審查看程式碼，這裡誠實記下。
    // 保留的理由：拿掉之後 `insertBlocks` 會落在一個已不存在的錨點上；失敗形雖然良性（內容不會
    // 遺失，位置交給 CRDT 決定），但那是「沒守衛」的良性，不是「守了」的良性。
    if (input.anchorId !== null && !topLevelContainers(fragment).some(c => c.getAttribute("id") === input.anchorId)) throw new FingerprintMismatch();
    const clock = docClock(doc);
    Y.applyUpdate(doc, input.diff);
    ctx.applied = true;
    // 版本歷史：合併後活文件的版本指紋（套用把它寫成基底指紋）。版本指紋保證不丟例外，這裡仍防禦性包住。
    let versionFp: string | null = null;
    try {
      versionFp = versionFingerprint(fragment);
    } catch {
      versionFp = null;
    }
    const merged = outlineOf(fragment);
    const afterFingerprint = input.afterIds.length === 0 ? null : fingerprintForIds(fragment, input.afterIds);
    // #108：**一定要在 `stripIds(merged)` 之前算**——那一步就是把 `blockIds` 丟掉的地方，
    // 而 `afterBlockIds` 是 block id、`outline` 的其他欄位一個都對不上它。
    // `afterIds[0]` 是這次寫下去的第一顆 block（`delete_section` 恆為空 → `null`）。
    // ⚠ `-1`（找得到 afterIds 卻不在任何一段裡）在七發實測裡**一次都沒發生**，
    //   但**證不出它不可達**——所以退成 `null`（呼叫端 `?? 0` 回第 0 頁）。**不要寫成「不可能」。**
    const firstAfter = input.afterIds[0];
    const afterIndex = firstAfter === undefined ? -1 : merged.outline.findIndex(s => s.blockIds.includes(firstAfter));
    const out: MergeOutput = {
      afterFingerprint,
      fingerprint: merged.whole,
      outline: stripIds(merged),
      clock,
      afterSectionIndex: afterIndex === -1 ? null : afterIndex,
      versionFingerprint: versionFp,
    };
    if (input.afterGroups !== undefined) out.afterFingerprints = fingerprintsOfGroups(fragment, input.afterGroups);
    return out;
  }, opts);
}

/** 活文件已不是 worker 當基底的那一份（別人在這中間改了）：從頭重來。 */
export class StaleBase extends Error {
  override name = "StaleBase";
}
/** 套用（`edit_note`／`/edits`／建立、撤回、批次寫回）遇到 {@link StaleBase} 最多重來幾次；用完 → `ParserBusyError`（503 `server_busy`＋`Retry-After`）。 */
export const DOC_MERGE_ATTEMPTS = 3;

/** worker 算好的合併後的值 → 舊 `mergeDiff` 的回傳形。 */
export function mergeOutputOf(post: DocPost): MergeOutput {
  const out: MergeOutput = {
    afterFingerprint: post.afterFingerprint, fingerprint: post.fingerprint, outline: post.outline, clock: post.clock,
    afterSectionIndex: post.afterSectionIndex, versionFingerprint: post.versionFingerprint,
  };
  if (post.afterFingerprints !== undefined) out.afterFingerprints = post.afterFingerprints;
  return out;
}

/**
 * 把 worker 算好的 diff 合併進活文件。合併的條件：
 * - 取狀態時文件在記憶體裡（有 `watch`，`live-watch.ts`）：活文件之後的改動沒碰到這次寫入在意的 block（`post.guard`）就合併——別段有人在打字
 *   照樣合併，Yjs 的合併本身是 CRDT 安全的；碰到了 → {@link StaleBase}（呼叫端從頭重來，worker 在新狀態上重比 if_match）。判斷只看守衛裡的
 *   幾個 id，不與筆記大小成正比。
 * - 沒有 `watch`（取狀態時文件不在記憶體，用的是 `note_states` 的位元組），或文件在這期間被卸載又載回（不是同一個物件）：比快照
 *   （state vector＋刪除集），相等才合併——這條路徑本來就要把整篇從 DB 載進來。
 * 文件在記憶體裡就先在開直連之前判一次（不行就不開——開了再關會把沒改的文件落盤一次）；transact 內再判一次（之間有 goneNow 與開直連的 await）。
 * 合併後回的指紋與大綱是 worker 算的（不含別人在這期間打的字；下一次 if_match 不符就讓呼叫端重讀）；`clock` 取合併前活文件的（links 的 CAS）。
 */
export async function mergeAtBase(
  deps: ApplyDeps,
  noteId: string,
  ctx: DirectConnectionCtx,
  post: DocPost,
  watch: LiveWatch | undefined,
  opts?: { beforeDisconnect?: (out: MergeOutput) => Promise<void> }
): Promise<MergeOutput> {
  // 筆記大小上限：worker 算好「基底＋這次寫入」的前後狀態大小與還在的內容量（`capBlocks`，依結果判斷：長過上限、比原本大，而且還在的內容
  // 變多或狀態一次長超過 SLACK 才擋）。
  // 合併時別人在這期間（瀏覽器協作）造成的成長沒算進來：協作更新不在 server 檢查，網頁編輯器在貼上、拖放、站內 AI 套用之前自己擋。
  if (deps.noteMaxBytes !== undefined && capBlocks(post.size, deps.noteMaxBytes)) throw new NoteTooLargeError(deps.noteMaxBytes, post.size.stateAfter);
  // 撤回刪段（守衛帶 `absent`）：被刪的那幾顆在這期間又回到頂層（例如瀏覽器按了 Ctrl+Z，id 相同）→ 不合併，免得頂層出現兩顆同 id 的
  // block（成本與頂層 block 數成正比，只有這一種撤回會走）。
  const absent = post.guard.kind === "blocks" ? (post.guard.absent ?? []) : [];
  const stillAbsent = (doc: Y.Doc): boolean => {
    if (absent.length === 0) return true;
    const top = new Set(topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT)).map(c => c.getAttribute("id")));
    return !absent.some(id => top.has(id));
  };
  const mergeable = (doc: Y.Doc): boolean => stillAbsent(doc) && (watch !== undefined && watch.doc === doc ? !watch.conflicts(post.guard) : stateEquals(doc, post.baseSnapshot));
  const live = deps.collab.hocuspocus.documents.get(noteId);
  if (live && !mergeable(live)) throw new StaleBase();
  const afterOpen = deps.testHooks?.afterOpenDirect;
  return withDirectConnection(directTarget(deps.collab, deps.db), noteId, ctx, doc => {
    if (!mergeable(doc)) throw new StaleBase();
    const clock = docClock(doc);
    Y.applyUpdate(doc, post.diff);
    ctx.applied = true;
    return { ...mergeOutputOf(post), clock };
  }, { ...opts, ...(afterOpen ? { afterOpen } : {}) });
}

/**
 * `note_ai_edits_fingerprint_chk` 的防護：`(cardinality(after_block_ids) = 0) = (after_fingerprint is null)`。
 * `mergeDiff` 是在 `applyUpdate` 之後、**同一個 transact 內**算 `after_fingerprint` 的，此時剛插入的
 * block 必定全在頂層且順序正確，所以「`afterIds` 非空卻算出 null」理論上
 * 到不了——**沒有測試會因為刪掉這個函式而變紅**，這裡誠實記下。
 * 但萬一到得了（例如 BlockNote 把插入的 block 放進了別的容器、或 `fingerprintForIds` 的語意日後被改），
 * 直接拿去 insert 的落點是：**內容已經落盤、insert 撞 CHECK 丟 500、該次編輯永遠無法撤回、也不留紀錄**。
 * 所以退化成「記一列但標記為不可撤回」（`after_block_ids: []`＋`after_fingerprint: null`，`revertable`
 * 因此為 false），並 `log.error`——有紀錄、可查、可稽核，優於 500 加什麼都沒有。
 */
export function recordableAfter(deps: ApplyDeps, noteId: string, afterIds: string[], afterFingerprint: string | null): { afterBlockIds: string[]; afterFingerprint: string | null } {
  if (afterIds.length === 0 || afterFingerprint !== null) return { afterBlockIds: afterIds, afterFingerprint };
  deps.log.error({ noteId, afterIds }, "after_fingerprint 為 null 但 after_block_ids 非空（理論上到不了）——該列記為不可撤回");
  return { afterBlockIds: [], afterFingerprint: null };
}

export async function insertEditRecord(db: Db, row: typeof noteAiEdits.$inferInsert): Promise<string> {
  return db.transaction(async tx => {
    const [inserted] = await tx.insert(noteAiEdits).values(row).returning({ id: noteAiEdits.id });
    const keep = await tx.select({ id: noteAiEdits.id }).from(noteAiEdits).where(eq(noteAiEdits.noteId, row.noteId)).orderBy(desc(noteAiEdits.createdAt), desc(noteAiEdits.id)).limit(RETENTION);
    await tx.delete(noteAiEdits).where(and(eq(noteAiEdits.noteId, row.noteId), notInArray(noteAiEdits.id, keep.map(k => k.id))));
    return inserted!.id;
  });
}

/** 本體（含「濾自連結排在 slice 之前」「例外降級為 warn」的理由）在 `notes/links.ts` 的 `syncLinksFromDoc`（#175：複製共用）。 */
export async function updateNoteLinks(deps: ApplyDeps, p: { sourceNoteId: string; userId: string; clock: number } & ({ forkDoc: Y.Doc } | { targets: string[] })): Promise<void> {
  const from = "targets" in p ? { targets: p.targets } : { doc: p.forkDoc };
  return syncLinksFromDoc(deps, { sourceNoteId: p.sourceNoteId, userId: p.userId, clock: p.clock, ...from });
}

/** `applyEdit`／`applyVersionEdit` 共用的第一段：fork（活文件在記憶體就 fork 它，否則讀 note_states）＋整篇大綱與指紋。
 * ⚠ `whole` 必須在 prepare 之前算（prepare 會在 fork 上 mount 並 replaceBlocks）。 */
export interface ForkChecked {
  fork: Y.Doc;
  sv: Uint8Array;
  outline: OutlineEntry[];
  whole: string;
  isEmptyDoc: boolean;
}
export async function forkAndCheck(deps: ApplyDeps, noteId: string): Promise<ForkChecked> {
  const { doc: fork } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, noteId);
  const sv = Y.encodeStateVector(fork);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(fragment);
  return { fork, sv, outline, whole, isEmptyDoc: topLevelContainers(fragment).length === 0 };
}

/**
 * 要寫進去的 block（主執行緒；`delete_section` 為空）：建筆記路徑直接用解析好的；否則在 parse worker 裡解析 markdown（或用呼叫端在佇列外
 * 解析好的 `preparsed`），再依 #387 把寫入者讀到過的連結文字照舊存成沒有自訂文字。解析失敗回錯誤（呼叫端在段落與指紋檢查之後才回）。
 */
async function prepareBlocks(
  deps: ApplyDeps,
  input: ApplyInput
): Promise<{ blocks: AnyPartialBlock[]; unbound: number; written?: ShownLinks } | { error: ParseError; detail?: ParseDetail }> {
  if (input.op === "delete_section") return { blocks: [], unbound: 0 };
  // 建筆記路徑：`content` 已經解析驗證過了，這裡直接套用解析出來的 block JSON。再 parse 一次會把
  // markdown → blocks → wikilink 重綁整條做兩遍。
  // ⚠ 存活突變：把這裡改回「一律重新解析 markdown」，行為等價、測試照樣全綠——
  // **沒有測試會因為改回重新解析而變紅**，只能靠審查看程式碼，這裡誠實記下。
  if (input.blocks !== undefined) return { blocks: input.blocks, unbound: input.unbound ?? 0 };
  // #398：在 parse worker 裡解析，**開編輯器之前**（不持 lease 等 worker）；失敗＝什麼都沒開、沒寫。
  const parsed = input.preparsed ?? (await deps.editing.parser.parse({ owner: input.userId, markdown: input.markdown ?? "", candidates: input.candidates, siteOrigin: siteOriginOf(deps.editing.baseUrl) }));
  if ("error" in parsed) return { error: parsed.error, ...(parsed.detail ? { detail: parsed.detail } : {}) };
  // #387：連結文字是寫入者讀到過的「沒有自訂文字」的那段 → 照舊沒有自訂文字（目標在讀出之後改了名也一樣）。
  const [kept, cleared] = deps.shownLinks ? deps.shownLinks.keepLabelFree(parsed.blocks, input.userId, input.candidates) : [parsed.blocks, []];
  if (!deps.shownLinks) return { blocks: kept, unbound: parsed.unbound };
  // 寫下去的連結也要記在寫入者名下（agent 用回覆的指紋把自己寫的連結原樣寫回）——這裡只收集，合併成功後才記。
  // 被清掉的原文字也要記（m-b）：存下的 snapshotTitle 已換成現行標題，不記的話那段文字的期限不會因這次寫入延長。
  const written = shownLinkTextsOf(kept, new Map());
  written.free.push(...cleared);
  return { blocks: kept, unbound: parsed.unbound, written };
}

/**
 * 編輯器的生命只到「取出 diff」為止：mount → 單一編輯器呼叫 → `diffSince` → `close()`，
 * 全部關在這個函式內。**不變量：持有 lease 期間絕不再取得 lease**（`runtime.acquire()` 的
 * 等待迴圈只在 in-flight 歸零時才放行；外層抱著 lease 等內層＝死鎖，見 Global Constraints）。
 * 合併之後不需要編輯器：`mergeDiff` 只操作 live doc 的 Yjs 結構、`before_blocks`／`after_block_ids`
 * 在這裡就已經是純 JSON 快照、`updateNoteLinks` 走的是 fork 這顆 `Y.Doc` 而不是編輯器
 * （`unmount()` 只拆 ProseMirror view，y-prosemirror 的 `binding.destroy()` 僅 unobserve、
 * 不動 doc 內容，所以 close 之後 fork 仍是合併前那份）。
 */
export async function prepareEdit(
  deps: ApplyDeps,
  input: ApplyInput,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: { op: EditOp; isEmptyDoc: boolean; section: OutlineEntry | undefined } // OutlineEntry ＝ fingerprint.ts 的 SectionInfo + fingerprint（含 blockIds）
): Promise<{ diff: Uint8Array; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null; unbound: number; written?: ShownLinks } | { error: ParseError; detail?: ParseDetail }> {
  const { op, isEmptyDoc, section } = plan;
  const b = await prepareBlocks(deps, input);
  if ("error" in b) return b;
  const { blocks, unbound, written } = b;
  const r = await editOnFork(deps.editing, fork, sv, { op, isEmptyDoc, section }, blocks);
  return { ...r, unbound, ...(written ? { written } : {}) };
}

export async function applyEdit(deps: ApplyDeps, input: ApplyInput): Promise<ApplyResult> {
  // 解析在主執行緒排進 parse worker（`prepareBlocks`）；失敗的錯誤交給 worker 在段落與指紋檢查之後才回（錯誤碼的先後不變）。
  const b = await prepareBlocks(deps, input);
  const parseError = "error" in b ? { error: b.error, ...(b.detail ? { detail: b.detail } : {}) } : undefined;
  const blocks = "error" in b ? undefined : b.blocks;
  for (let attempt = 0; attempt < DOC_MERGE_ATTEMPTS; attempt++) {
    // 取狀態的同一個 tick 開始記活文件被改了哪些 block（`live-watch.ts`；文件不在記憶體就沒有 watch）。合併完（或放棄）就停。
    const { state, watch } = await loadNoteState(deps, input.noteId, { watch: true });
    let r: Exclude<Awaited<ReturnType<typeof deps.editing.runDoc<"edit">>>, typeof DOC_TOO_COMPLEX>;
    let merged: MergeOutput;
    try {
      const out = await deps.editing.runDoc(
        input.userId,
        {
          kind: "edit", state, op: input.op,
          ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
          ...(input.ifMatch !== undefined ? { ifMatch: input.ifMatch } : {}),
          ...(blocks !== undefined && input.op !== "delete_section" ? { blocks } : {}),
          ...(parseError ? { parseError } : {}),
        },
        { extraWeight: input.markdown?.length ?? input.contentLength ?? (blocks ? JSON.stringify(blocks).length : 0) }
      );
      // 套用的轉換逾時或用完記憶體：建立路徑（新筆記）是內容的問題；寫進既有筆記是筆記本身太大或太複雜。
      if (out === DOC_TOO_COMPLEX) return input.blocks !== undefined ? { ok: false, code: "unsupported_block", detail: "too_complex" } : { ok: false, code: "too_complex" };
      if (!out.ok) return out;
      r = out;
      if (deps.testHooks?.beforeMerge) await deps.testHooks.beforeMerge();
      const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, applied: false };
      try {
        merged = await mergeAtBase(deps, input.noteId, ctx, r.post, watch);
      } catch (err) {
        if (err instanceof StaleBase) continue; // 別人改到這次寫入在意的 block：對新的狀態從頭重來（指紋照樣重比）
        throw err;
      }
    } finally {
      watch?.stop();
    }
    const { beforeBlocks, afterIds, anchor } = r;
    const unbound = "error" in b ? 0 : b.unbound;
    // #387：內容已落進文件，寫下去的連結記在寫入者名下（之後照原樣寫回也不凍結）。
    if (!("error" in b) && b.written) deps.shownLinks?.record(input.userId, b.written);
    if (deps.testHooks?.beforeRecord) await deps.testHooks.beforeRecord();
    const editId = await insertEditRecord(deps.db, {
      noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, op: input.op,
      sectionId: input.sectionId ?? null, beforeBlocks, anchor,
      ...recordableAfter(deps, input.noteId, afterIds, merged.afterFingerprint),
    });
    if (deps.testHooks?.afterRecord) await deps.testHooks.afterRecord();
    await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, targets: r.post.linkTargets, clock: merged.clock });
    // ⚠ `afterBlockIds` 用 worker 回的**原始** `afterIds`，不是 `recordableAfter(...)` 那份
    // ——後者在退化情形（after_fingerprint 為 null）會把陣列清空，那是給 DB 紀錄用的語意。
    // 兩者只在那條「理論上到不了」的路徑上不同，**沒有任何測試守得到這個誤用**，誠實記在這裡。
    return { ok: true, editId, fingerprint: merged.fingerprint, outline: merged.outline, unboundWikilinks: unbound, afterBlockIds: afterIds, afterSectionIndex: merged.afterSectionIndex };
  }
  // 三次都在合併前被別人改掉（一直有人在打字）：什麼都沒寫，回 503 讓呼叫端稍後重試。
  throw new ParserBusyError();
}
