/**
 * `POST /api/notes/:id/links` 的交易寫入核心（spec §12.3，Task 5）。routes/notes.ts 只負責
 * body 驗證、權限矩陣與 `linkSyncGate` 呼叫；本檔專責「正規化目標集合」與「單一交易內
 * CAS clock + 批次授權 + 整組取代 note_links」。
 */
import { and, eq, inArray, lte, notInArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { MAX_LINK_TARGETS } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteLinks, noteShares, notes } from "../db/schema.js";
import { isForeignKeyViolation, isTransientTransactionError } from "../db/pg-errors.js";

export type NormalizeLinkTargetsResult = { ok: true; targets: string[] } | { ok: false };

/**
 * 純函式（供 `test/unit/links-normalize.test.ts` 直接測，不碰 DB）：去重（`Set`）、濾掉
 * 指向自己的 self-link（`target === sourceNoteId`），**在此之後**才判定正規化後的集合是否
 * 超過 `MAX_LINK_TARGETS` → `{ ok: false }`（routes 端映射成 400 `invalid_body`）。
 *
 * zod 層的 `.max(MAX_LINK_TARGETS * 2)` 只是提交前的粗閘（效能考量，見 routes/notes.ts
 * body schema 旁註解），語意上限一律在這裡（正規化之後）判定——去重與濾除 self-link 都可能
 * 讓一個超過粗閘但正規化後合法的集合通過，反之亦然（重複元素多但正規化後仍在上限內）。
 */
export function normalizeLinkTargets(sourceNoteId: string, rawTargetIds: string[]): NormalizeLinkTargetsResult {
  const deduped = [...new Set(rawTargetIds)].filter(targetId => targetId !== sourceNoteId);
  if (deduped.length > MAX_LINK_TARGETS) return { ok: false };
  return { ok: true, targets: deduped };
}

export interface WriteNoteLinksParams {
  sourceNoteId: string;
  userId: string;
  /** 已經過 `normalizeLinkTargets` 的目標集合（去重、濾自連結）。可為空陣列（清空所有連結）。 */
  targetIds: string[];
  /** `CollabHooks.linkSyncGate` 回傳的 `clock`——CAS 進 `notes.links_clock` 的候選值。 */
  clock: number;
}

export interface WriteNoteLinksHooks {
  /**
   * 測試注入縫：命中批次授權查詢「之後」、實際寫入 `note_links`（insert/delete）「之前」
   * 呼叫。整合測試在此視窗內用另一條連線刪除某個 target 筆記並 commit，確定性地讓後續的
   * insert 撞上 foreign_key_violation（而非依賴純併發時序，那樣會 flaky）。production 未
   * 傳入時等同 no-op。
   */
  beforeLinkWrite?: () => Promise<void>;
}

export type WriteNoteLinksOutcome = "applied" | "noop" | "busy";

/**
 * 單次交易嘗試（READ COMMITTED，drizzle `db.transaction` 預設隔離級別）：
 * 1. 第一個寫入語句：`UPDATE notes SET links_clock = $clock WHERE id = $id AND links_clock
 *    <= $clock`——0 列命中＝提交的 clock 落後於已經生效的索引進度（LWW 落敗），no-op、
 *    完全不動 `note_links`。`<=`（非 `<`）刻意允許「同 clock 重送」也生效，讓同一次編輯
 *    的重試/併發送達皆可正確覆蓋。
 * 2. 命中才做批次授權查詢：`owned ∪ shared`（`union`，非 `unionAll`——同一 note 若同時符合
 *    兩邊條件不重複計入）交集提交的 target 集合，單一查詢決定整組可連結的目標，不逐一
 *    `resolveRole`。
 * 3. `hooks.beforeLinkWrite`（測試注入點，見上）。
 * 4. 整組取代：新集合非空 → insert 新增（`onConflictDoNothing` 容忍與既有列重疊）+ delete
 *    不在新集合內的既有列；新集合為空 → 直接刪光這個 source 的所有既有列。
 */
async function attemptOnce(db: Db, params: WriteNoteLinksParams, hooks: WriteNoteLinksHooks): Promise<"applied" | "noop"> {
  return db.transaction(async tx => {
    const [updated] = await tx
      .update(notes)
      .set({ linksClock: params.clock })
      .where(and(eq(notes.id, params.sourceNoteId), lte(notes.linksClock, params.clock)))
      .returning({ id: notes.id });
    if (!updated) return "noop" as const;

    let targets: string[] = [];
    if (params.targetIds.length > 0) {
      const ownedSelect = tx
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.ownerId, params.userId), inArray(notes.id, params.targetIds)));
      const sharedSelect = tx
        .select({ id: noteShares.noteId })
        .from(noteShares)
        .where(and(eq(noteShares.userId, params.userId), inArray(noteShares.noteId, params.targetIds)));
      const rows = await union(ownedSelect, sharedSelect);
      targets = rows.map(row => row.id);
    }

    await hooks.beforeLinkWrite?.();

    if (targets.length > 0) {
      await tx
        .insert(noteLinks)
        .values(targets.map(targetNoteId => ({ sourceNoteId: params.sourceNoteId, targetNoteId })))
        .onConflictDoNothing();
      await tx.delete(noteLinks).where(and(eq(noteLinks.sourceNoteId, params.sourceNoteId), notInArray(noteLinks.targetNoteId, targets)));
    } else {
      await tx.delete(noteLinks).where(eq(noteLinks.sourceNoteId, params.sourceNoteId));
    }
    return "applied" as const;
  });
}

/**
 * `writeNoteLinks`：`attemptOnce` 的重試/錯誤分類外殼。
 * - `isForeignKeyViolation`（授權查詢之後、insert 之前，某個 target 筆記被併發刪除）→
 *   剔除消失的 target 重試一次——不需要另外解析錯誤內容找出是哪個 target：重新呼叫
 *   `attemptOnce` 會在交易內重跑批次授權查詢，該筆記此時已不存在，自然被排除在外。
 * - `isTransientTransactionError`（40001 序列化衝突／40P01 死鎖，DB 層級交易衝突，不是
 *   「某個 target 消失」這種可挽救的邏輯錯誤）→ `"busy"`，routes 端映射 409 `server_busy`，
 *   不在 server 端做第二次重試（交給 client 重試，避免無界重試放大衝突）。
 * - 其餘錯誤：原樣拋出，routes 端 log 後回 500。
 */
export async function writeNoteLinks(db: Db, params: WriteNoteLinksParams, hooks: WriteNoteLinksHooks = {}): Promise<WriteNoteLinksOutcome> {
  try {
    return await attemptOnce(db, params, hooks);
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      try {
        return await attemptOnce(db, params, hooks);
      } catch (err2) {
        if (isTransientTransactionError(err2)) return "busy";
        throw err2;
      }
    }
    if (isTransientTransactionError(err)) return "busy";
    throw err;
  }
}
