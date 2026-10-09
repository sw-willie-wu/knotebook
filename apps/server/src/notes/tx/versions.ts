/**
 * 筆記版本歷史的交易本體（spec 2026-10-09-note-versions-design.md §5.3 第 3–4 步、§9）。S14：只收 `tx`、純資料；
 * `capture` 是呼叫端在交易前備好的**同步**函式（只做 Yjs 序列化與指紋計算，不碰 pool）。
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteVersions, notes, type VersionEditorJson } from "../../db/schema.js";

export type { VersionEditorJson };
export type NoteVersionRow = typeof noteVersions.$inferSelect;

export const spaceKeyOf = (r: { ownerId: string | null; groupId: string | null }): string =>
  r.ownerId !== null ? `u:${r.ownerId}` : `g:${r.groupId}`;

/**
 * 「這列不是該篇現在的基底」述詞（A6）：在**同一條** DELETE 裡現讀 `notes.version_base_seq`，讀與刪之間基底被改也不會刪到新基底。
 * 用於 `note_versions` 的單表 DELETE——外層欄位寫帶表名字面（drizzle 雷：`${table.col}` 在單表語句會渲染成裸欄名）。
 */
export const notBaseVersionSql = (noteId: string): SQL =>
  sql`note_versions.seq is distinct from (select notes.version_base_seq from notes where notes.id = ${noteId})`;

export interface CutVersionInput {
  noteId: string;
  kind: "auto" | "manual";
  /** 已正規化（`normalizeVersionName`）；null＝沒填。 */
  name: string | null;
  editors: VersionEditorJson[];
  /** 第 2 步用的基底指紋（記憶體鏡像）；交易內讀到的不同 → stale（r4 M-5）。 */
  expectBaseFingerprint: string | null;
  /** 狀態的空間鍵；交易內讀到的不同 → stale（搬移交錯，r5 I-2）。 */
  expectSpaceKey: string;
  /** 沒有基底時 auto 重評 dirty 的比較對象（§5.3-2）。 */
  loadFingerprint: string | null;
  vacuumFingerprint: string;
  /** 鎖回來後的第一個同步區段呼叫一次：重算版本指紋並取 `encodeStateAsUpdate`（r7 M-2）。丟例外＝指紋算不出來。 */
  capture: () => { fp: string; ydoc: Uint8Array };
}

export type CutAbortReason =
  | { kind: "note-deleted" }
  | { kind: "clean" }
  | { kind: "stale"; baseFingerprint: string | null; spaceKey: string }
  | { kind: "fingerprint-failed"; cause: unknown };

/** 交易內的拒絕一律 throw（drizzle 只在 throw 時 ROLLBACK）；呼叫端 `instanceof` 判。 */
export class VersionCutAbort extends Error {
  constructor(readonly reason: CutAbortReason) {
    super(`version cut aborted: ${reason.kind}`);
    this.name = "VersionCutAbort";
  }
}

/**
 * §5.3 第 3–4 步。鎖 `notes` 列 → 同步重算 → 比基底／空間（不符 → stale）→ 有基底且相同：auto → clean、manual → 基底轉手動 →
 * 沒有基底的 auto 依第 2 步規則重評 dirty → 配號、INSERT、基底指向新版。
 */
export async function cutVersionInTx(tx: Tx, input: CutVersionInput): Promise<{ row: NoteVersionRow; upgraded: boolean; fp: string }> {
  const [note] = await tx
    .select({ baseSeq: notes.versionBaseSeq, baseFingerprint: notes.versionBaseFingerprint, ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(eq(notes.id, input.noteId))
    .for("update");
  // ⚠ 從這裡到下一個 await 是「鎖回來後的第一個同步區段」（§5.3-3）：fp 與 ydoc 必須在這裡取，之後一律用這份。
  let snap: { fp: string; ydoc: Uint8Array } | null = null;
  let captureError: unknown;
  if (note) {
    try {
      snap = input.capture();
    } catch (err) {
      captureError = err;
    }
  }
  if (!note) throw new VersionCutAbort({ kind: "note-deleted" });
  if (snap === null) throw new VersionCutAbort({ kind: "fingerprint-failed", cause: captureError });
  const spaceKey = spaceKeyOf(note);
  if (note.baseFingerprint !== input.expectBaseFingerprint || spaceKey !== input.expectSpaceKey) {
    throw new VersionCutAbort({ kind: "stale", baseFingerprint: note.baseFingerprint, spaceKey });
  }
  const { fp, ydoc } = snap;
  if (note.baseFingerprint !== null && note.baseSeq !== null && fp === note.baseFingerprint) {
    if (input.kind === "auto") throw new VersionCutAbort({ kind: "clean" });
    const [upgraded] = await tx
      .update(noteVersions)
      .set(input.name !== null ? { kind: "manual", name: input.name } : { kind: "manual" })
      .where(and(eq(noteVersions.noteId, input.noteId), eq(noteVersions.seq, note.baseSeq)))
      .returning();
    if (upgraded) return { row: upgraded, upgraded: true, fp };
    // 基底那列不見（§13 READ COMMITTED 競態、或 SQL 直刪）：UPDATE 0 列 → 退回「無基底」規則建新版、基底改指新版，
    // 新列的 base_seq 不指向已刪的那列（下方存在檢查；起草裁定 18；Task 14b，`versions-legacy-attrs.test.ts` 的手動儲存案）。
  }
  if (input.kind === "auto" && note.baseFingerprint === null) {
    const dirty = (input.loadFingerprint === null || fp !== input.loadFingerprint) && fp !== input.vacuumFingerprint;
    if (!dirty) throw new VersionCutAbort({ kind: "clean" });
  }
  const [maxRow] = await tx
    .select({ maxSeq: sql<number | null>`max(${noteVersions.seq})` })
    .from(noteVersions)
    .where(eq(noteVersions.noteId, input.noteId));
  const [counted] = await tx
    .update(notes)
    .set({ versionCounter: sql`${notes.versionCounter} + 1` })
    .where(eq(notes.id, input.noteId))
    .returning({ seq: notes.versionCounter });
  const seq = counted!.seq;
  const maxSeq = maxRow?.maxSeq ?? null;
  let baseSeq = note.baseSeq !== null && note.baseSeq !== maxSeq ? note.baseSeq : null;
  if (baseSeq !== null) {
    // 基底列已被刪（內容乾淨走上面 UPDATE 0 列、或內容有改）：「continued from」不得指向不存在的版本 → null（Task 14b）。
    const [baseRow] = await tx
      .select({ seq: noteVersions.seq })
      .from(noteVersions)
      .where(and(eq(noteVersions.noteId, input.noteId), eq(noteVersions.seq, baseSeq)))
      .limit(1);
    if (!baseRow) baseSeq = null;
  }
  const [row] = await tx
    .insert(noteVersions)
    .values({ noteId: input.noteId, seq, ydoc: Buffer.from(ydoc), kind: input.kind, name: input.name, editors: input.editors, baseSeq })
    .returning();
  await tx.update(notes).set({ versionBaseSeq: seq, versionBaseFingerprint: fp }).where(eq(notes.id, input.noteId));
  return { row: row!, upgraded: false, fp };
}

/**
 * §9：搬到群組（`{ noteId }`）與刪群組轉移（`{ groupId }`——**在改 `group_id` 之前**呼叫，以群組述詞一次處理）在交易內清空版本、
 * 配號歸零、基底清空。不建任何版本（D9）。呼叫端已持該（些）筆記列的 `FOR UPDATE`。
 */
export async function resetNoteVersionsInTx(tx: Tx, target: { noteId: string } | { groupId: string }): Promise<void> {
  const noteWhere = "noteId" in target ? eq(notes.id, target.noteId) : eq(notes.groupId, target.groupId);
  const versionWhere =
    "noteId" in target
      ? eq(noteVersions.noteId, target.noteId)
      : sql`note_versions.note_id in (select notes.id from notes where notes.group_id = ${target.groupId})`;
  await tx.delete(noteVersions).where(versionWhere);
  await tx.update(notes).set({ versionCounter: 0, versionBaseSeq: null, versionBaseFingerprint: null }).where(noteWhere);
}
