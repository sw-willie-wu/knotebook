/**
 * #175 S14（T15）：`POST /api/notes/:id/links` 的交易本體。**本檔不 import `Db`、不接 `deps`**——只收 `tx`、
 * 純資料與型別明示的測試縫，所以寫不出「交易內向 pool 借連線」（spec §4.4 S14、§6 T15）。
 * 重試／錯誤分類外殼（FK race 重試一次、40001/40P01 → busy）留在 `notes/links.ts` 的 `writeNoteLinks`。
 *
 * 單次交易嘗試（READ COMMITTED，drizzle `db.transaction` 預設隔離級別）：
 * 1. 第一個寫入語句：`UPDATE notes SET links_clock = $clock WHERE id = $id AND links_clock <= $clock`——0 列命中＝
 *    提交的 clock 落後於已經生效的索引進度（LWW 落敗），no-op、完全不動 `note_links`。`<=`（非 `<`）刻意允許
 *    「同 clock 重送」也生效，讓同一次編輯的重試／併發送達皆可正確覆蓋。
 * 2. 命中才做批次授權查詢：`owned ∪ shared ∪ grouped(can_read)`（`union`，非 `unionAll`——同一 note 若同時符合
 *    多邊條件不重複計入）交集提交的 target 集合，單一查詢決定整組可連結的目標，不逐一 `resolveRole`。
 * 3. `beforeLinkWrite`（測試縫：授權查詢之後、寫入 `note_links` 之前——整合測試在此用另一條連線刪 target 讓
 *    insert 撞 FK，確定性地驅動外殼的重試）。production 不傳＝no-op。
 * 4. 整組取代：新集合非空 → insert 新增（`onConflictDoNothing` 容忍與既有列重疊）＋ delete 不在新集合內的既有列；
 *    新集合為空 → 直接刪光這個 source 的所有既有列。
 */
import { and, eq, inArray, isNull, lte, notInArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import type { Tx } from "../../db/tx.js";
import { groupMembers, groupRoles, noteLinks, noteShares, notes } from "../../db/schema.js";

export interface WriteLinksInput {
  sourceNoteId: string;
  userId: string;
  /** 已經過 `normalizeLinkTargets` 的目標集合（去重、濾自連結）。可為空陣列（清空所有連結）。 */
  targetIds: string[];
  /** `CollabHooks.linkSyncGate` 回傳的 `clock`——CAS 進 `notes.links_clock` 的候選值。 */
  clock: number;
}

export async function writeLinksInTx(
  tx: Tx,
  input: WriteLinksInput,
  beforeLinkWrite?: () => Promise<void>,
): Promise<"applied" | "noop"> {
  const [updated] = await tx
    .update(notes)
    .set({ linksClock: input.clock })
    .where(and(eq(notes.id, input.sourceNoteId), lte(notes.linksClock, input.clock)))
    .returning({ id: notes.id });
  if (!updated) return "noop";

  let targets: string[] = [];
  if (input.targetIds.length > 0) {
    const ownedSelect = tx
      .select({ id: notes.id })
      .from(notes)
      .where(and(eq(notes.ownerId, input.userId), inArray(notes.id, input.targetIds)));
    // 規格落差 2／gate r1 A-M6：JOIN notes 才看得到 group_id——群組筆記上的殘留分享列不給連結權。
    const sharedSelect = tx
      .select({ id: notes.id })
      .from(notes)
      .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, input.userId)))
      .where(and(inArray(notes.id, input.targetIds), isNull(notes.groupId)));
    // #175 §5.3：成員在自己筆記裡寫 `[[群組筆記]]`——角色要有閱讀旗標才寫得進去。
    const groupedSelect = tx
      .select({ id: notes.id })
      .from(notes)
      .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, input.userId)))
      .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
      .where(inArray(notes.id, input.targetIds));
    const rows = await union(ownedSelect, sharedSelect, groupedSelect);
    targets = rows.map(row => row.id);
  }

  await beforeLinkWrite?.();

  if (targets.length > 0) {
    await tx
      .insert(noteLinks)
      .values(targets.map(targetNoteId => ({ sourceNoteId: input.sourceNoteId, targetNoteId })))
      .onConflictDoNothing();
    await tx.delete(noteLinks).where(and(eq(noteLinks.sourceNoteId, input.sourceNoteId), notInArray(noteLinks.targetNoteId, targets)));
  } else {
    await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, input.sourceNoteId));
  }
  return "applied";
}
