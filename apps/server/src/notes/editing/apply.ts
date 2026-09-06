import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Block, PartialBlock } from "@blocknote/core";
import * as Y from "yjs";
import { MAX_LINK_TARGETS, YDOC_FRAGMENT, extractLinkTargets, topLevelContainers, type EditOp, type NoteOutlineEntry, type WikilinkTarget } from "@knotebook/shared";
import type { CollabServer } from "../../collab/server.js";
import { docClock } from "../../collab/store.js";
import type { Db } from "../../db/index.js";
import { noteAiEdits } from "../../db/schema.js";
import { normalizeLinkTargets, writeNoteLinks } from "../links.js";
import { fingerprintForIds, outlineOf, type OutlineEntry } from "./fingerprint.js";
import { parseMarkdownForNote, type ParseError } from "./markdown.js";
import { loadNoteDoc } from "./read.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession, withDirectConnection, type DirectCtx } from "./session.js";

// 順序（spec §6.1）：讀路徑 fork → 指紋比對 → parse/驗證 → 單一編輯器呼叫 → diff → **關掉編輯器**
// → mergeDiff＝withDirectConnection 內一個同步 transact（live doc 重算目標段指紋／anchor → docClock（applyUpdate
// 前，links CAS 用）→ applyUpdate → ctx.applied → 同 transact 算 after_fingerprint／回覆指紋大綱）→ finally disconnect（落盤）
// → note_ai_edits 交易（含裁切 100）→ note_links（writeNoteLinks 自己的交易，CAS 對更晚的瀏覽器寫入 no-op）。
// 沒有任何 DB 交易橫跨合併；先合併落盤、後記錄（記錄失敗＝內容在、紀錄沒有）；before_blocks 無上限。
// ⚠ 「fork→merge 窗口理論為零」只對**目標段非空**成立：零 block 的段（heading 開頭筆記的 `_top`、
// 真空文件）指紋恆為 `EMPTY_SECTION_FINGERPRINT`（常數），重算必等於 `if_match`；`append` 不帶
// `if_match` 時本就跳過核對。那些情形併發插入的 block **不會遺失**（Yjs 兩邊都留），只是 AI 內容
// 的相對位置由 CRDT 決定。⚠ 編輯器（＝runtime lease）只活到取出 diff 為止（`prepareEdit`）：
// **持有 lease 期間絕不再取得 lease**，否則跨過重建門檻時內外層互等，是無訊息的死鎖
// （見 `runtime.ts` 的 acquire 不可重入）。
export interface EditingTestHooks { beforeMerge?: () => Promise<void>; beforeRecord?: () => Promise<void>; beforeRevertRecord?: () => Promise<void> }
// ⚠ `log` 兩個方法都要：`updateNoteLinks` 用 `warn`、`recordableAfter` 用 `error`。少宣告 `error`
// 就是 typecheck 紅。
export interface ApplyDeps { db: Db; collab: CollabServer; editing: EditingRuntime; log: { warn(o: object, m: string): void; error(o: object, m: string): void }; testHooks?: EditingTestHooks }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組，走 repo 慣例（同 session.ts）
type AnyPartialBlock = PartialBlock<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
type AnyBlock = Block<any, any, any>;
type Anchor = { block_id: string; position: "before" | "after" };

// `blocks`／`unbound` 只有建筆記路徑會傳（spec §5 的管線：空 scratch doc 解析驗證 → 建列 → 把
// **解析出的 block JSON** 套到真 fork）；`/edits` 一律不傳，行為完全不變。
export interface ApplyInput {
  noteId: string; userId: string; tokenId: string | null; agentLabel: string | null; op: EditOp;
  sectionId?: string; markdown?: string; ifMatch?: string; candidates: WikilinkTarget[];
  blocks?: AnyPartialBlock[]; unbound?: number;
}
export type ApplyResult =
  | { ok: true; editId: string; fingerprint: string; outline: NoteOutlineEntry[]; unboundWikilinks: number }
  | { ok: false; code: "section_not_found" | "fingerprint_mismatch" | ParseError | "empty_section" };

export const RETENTION = 100;
export class FingerprintMismatch extends Error {}

export interface MergeInput { targetIds: string[] | null; expectFingerprint: string | null; anchorId: string | null; diff: Uint8Array; afterIds: string[] }
export interface MergeOutput { afterFingerprint: string | null; fingerprint: string; outline: NoteOutlineEntry[]; clock: number }

const stripIds = (o: { outline: Array<NoteOutlineEntry & { blockIds: string[] }> }): NoteOutlineEntry[] =>
  o.outline.map(({ blockIds: _b, ...e }) => e);

/** 本棒唯一的 withDirectConnection 呼叫點；撤回（revert.ts）也走這裡。 */
export async function mergeDiff(deps: ApplyDeps, noteId: string, ctx: DirectCtx, input: MergeInput): Promise<MergeOutput> {
  return withDirectConnection(deps.collab.hocuspocus, noteId, ctx, doc => {
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    if (input.expectFingerprint !== null) {
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
    const merged = outlineOf(fragment);
    const afterFingerprint = input.afterIds.length === 0 ? null : fingerprintForIds(fragment, input.afterIds);
    return { afterFingerprint, fingerprint: merged.whole, outline: stripIds(merged), clock };
  });
}

/**
 * `note_ai_edits_fingerprint_chk` 的防護：`(cardinality(after_block_ids) = 0) = (after_fingerprint is null)`。
 * `mergeDiff` 是在 `applyUpdate` 之後、**同一個 transact 內**算 `after_fingerprint` 的，此時剛插入的
 * block 必定全在頂層且順序正確（spec §6.1「此時必全在」），所以「`afterIds` 非空卻算出 null」理論上
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

export async function updateNoteLinks(deps: ApplyDeps, p: { sourceNoteId: string; userId: string; forkDoc: Y.Doc; clock: number }): Promise<void> {
  // spec §6.1 步驟 5 說「先自行去重、濾自連結、slice」——去重那半 `extractLinkTargets` 已經做完了
  // （shared `note-markdown.ts` 結尾就是 `[...new Set(found)].sort()`），這裡再包一層 Set 是死碼。
  // 濾自連結必須排在 slice **之前**：反過來的話，一個排在前面的 self-link 會佔掉一個名額，把真正
  // 的第 1000 個目標擠掉。
  const deduped = extractLinkTargets(p.forkDoc).filter(t => t !== p.sourceNoteId);
  const trimmed = deduped.slice(0, MAX_LINK_TARGETS);
  if (trimmed.length < deduped.length) deps.log.warn({ noteId: p.sourceNoteId, kept: trimmed.length, dropped: deduped.length - trimmed.length }, "wikilink 目標超過 MAX_LINK_TARGETS，已截斷");
  const norm = normalizeLinkTargets(p.sourceNoteId, trimmed);
  if (!norm.ok) return;
  // ⚠ 這個函式跑在**內容已落盤、note_ai_edits 也已寫**之後，是整條鏈的最後一步。`writeNoteLinks`
  // 對「忙碌」是回值（"busy"）不是拋出，所以它真的 throw 就代表 DB 故障——讓例外逃出去會把一次
  // 完全成功的寫入回成 500，而外部 AI 對 500 幾乎一定重試 → 同一筆編輯被套用兩次、紀錄多一列。
  // 這條鏈上其他每個失敗形都有明確語意，唯獨這個沒有，所以在這裡降級成警告：代價只是 wikilink
  // 索引落後（已記在 known-limitations），下一次該筆記的連結集合再變就會補上。
  try {
    const outcome = await writeNoteLinks(deps.db, { sourceNoteId: p.sourceNoteId, userId: p.userId, targetIds: norm.targets, clock: p.clock });
    if (outcome !== "applied") deps.log.warn({ noteId: p.sourceNoteId, outcome }, "note_links 未更新（CAS 落敗或忙碌）");
  } catch (err) {
    deps.log.warn({ noteId: p.sourceNoteId, err }, "note_links 寫入失敗，索引暫時落後（內容與紀錄已成功）");
  }
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
async function prepareEdit(
  deps: ApplyDeps,
  input: ApplyInput,
  fork: Y.Doc,
  sv: Uint8Array,
  plan: { op: EditOp; isEmptyDoc: boolean; section: OutlineEntry | undefined } // OutlineEntry ＝ fingerprint.ts 的 SectionInfo + fingerprint（含 blockIds）
): Promise<{ diff: Uint8Array; beforeBlocks: AnyBlock[]; afterIds: string[]; anchor: Anchor | null; unbound: number } | { error: ParseError }> {
  const s = await EditorSession.open(deps.editing, fork);
  try {
    const { op, isEmptyDoc, section } = plan;
    const ed = s.editor;
    const top = ed.document;
    let blocks: AnyPartialBlock[] = [];
    let unbound = 0;
    if (op !== "delete_section") {
      if (input.blocks !== undefined) {
        // 建筆記路徑（spec §5）：`content` 已經在空 scratch doc 上解析驗證過了，這裡直接套用
        // 解析出來的 block JSON。再 parse 一次會把 markdown → blocks → wikilink 重綁整條做兩遍。
        // ⚠ 存活突變：把這裡改回「一律重新解析 markdown」，行為等價、測試照樣全綠——
        // **沒有測試會因為改回重新解析而變紅**，只能靠審查看程式碼，這裡誠實記下。
        blocks = input.blocks; unbound = input.unbound ?? 0;
      } else {
        const parsed = parseMarkdownForNote(ed, input.markdown ?? "", input.candidates);
        if ("error" in parsed) return { error: parsed.error }; // `finally` 仍會 close()
        blocks = parsed.blocks; unbound = parsed.unbound;
      }
    }
    const snapshot = (idList: string[]): AnyBlock[] => idList.map(id => ed.getBlock(id)).filter((b): b is AnyBlock => b !== undefined);
    let beforeBlocks: AnyBlock[] = [];
    let afterIds: string[] = [];
    let anchor: Anchor | null = null;
    switch (op) {
      case "replace_all": {
        beforeBlocks = isEmptyDoc ? [] : top;
        afterIds = ed.replaceBlocks(top.map(b => b.id), blocks).insertedBlocks.map(b => b.id);
        break;
      }
      case "replace_section": {
        const sectionIds = section!.blockIds;
        if (sectionIds.length === 0) afterIds = ed.insertBlocks(blocks, top[0]!.id, "before").map(b => b.id); // 零 block _top：插在第一個 heading 之前
        else { beforeBlocks = snapshot(sectionIds); afterIds = ed.replaceBlocks(sectionIds, blocks).insertedBlocks.map(b => b.id); }
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
        const prev = top[idx - 1]; const next = top[idx + sectionIds.length];
        if (sectionIds.length === top.length) { // 段落涵蓋整篇：永不為空 → 空 paragraph 收尾，id 不記
          const inserted = ed.replaceBlocks(sectionIds, [{ type: "paragraph" }]).insertedBlocks;
          anchor = { block_id: inserted[0]!.id, position: "before" };
        } else {
          ed.replaceBlocks(sectionIds, []);
          anchor = prev ? { block_id: prev.id, position: "after" } : { block_id: next!.id, position: "before" };
        }
        break;
      }
    }
    return { diff: s.diffSince(sv), beforeBlocks, afterIds, anchor, unbound };
  } finally {
    s.close(); // ← 編輯器到此為止。下面的 hook／直連／DB 交易都**不持有 lease**。
  }
}

export async function applyEdit(deps: ApplyDeps, input: ApplyInput): Promise<ApplyResult> {
  const { doc: fork } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, input.noteId);
  const sv = Y.encodeStateVector(fork);
  const fragment = fork.getXmlFragment(YDOC_FRAGMENT);
  const { outline, whole } = outlineOf(fragment);
  const isEmptyDoc = topLevelContainers(fragment).length === 0;
  const section = input.sectionId === undefined ? undefined : outline.find(o => o.sectionId === input.sectionId);
  if (input.sectionId !== undefined && !section) return { ok: false, code: "section_not_found" };
  const expect = input.ifMatch ?? null;
  const targetIds = input.op === "replace_all" || input.op === "append" ? null : section!.blockIds;
  if (expect !== null && (targetIds === null ? whole : section!.fingerprint) !== expect) return { ok: false, code: "fingerprint_mismatch" };
  if (input.op === "delete_section" && (isEmptyDoc || section!.blockIds.length === 0)) return { ok: false, code: "empty_section" };

  // 真空文件：三 op 等同 replace_all（正規化殘留 paragraph 被 replace 掉）
  const op: EditOp = isEmptyDoc ? "replace_all" : input.op;
  const prepared = await prepareEdit(deps, input, fork, sv, { op, isEmptyDoc, section });
  if ("error" in prepared) return { ok: false, code: prepared.error };
  const { diff, beforeBlocks, afterIds, anchor, unbound } = prepared;

  if (deps.testHooks?.beforeMerge) await deps.testHooks.beforeMerge();
  const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, applied: false };
  let merged: MergeOutput;
  try {
    merged = await mergeDiff(deps, input.noteId, ctx, { targetIds, expectFingerprint: expect, anchorId: null, diff, afterIds });
  } catch (err) {
    if (err instanceof FingerprintMismatch) return { ok: false, code: "fingerprint_mismatch" };
    throw err;
  }
  if (deps.testHooks?.beforeRecord) await deps.testHooks.beforeRecord();
  const editId = await insertEditRecord(deps.db, {
    noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel: input.agentLabel, op: input.op,
    sectionId: input.sectionId ?? null, beforeBlocks, anchor,
    ...recordableAfter(deps, input.noteId, afterIds, merged.afterFingerprint),
  });
  await updateNoteLinks(deps, { sourceNoteId: input.noteId, userId: input.userId, forkDoc: fork, clock: merged.clock });
  return { ok: true, editId, fingerprint: merged.fingerprint, outline: merged.outline, unboundWikilinks: unbound };
}
