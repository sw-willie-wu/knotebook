/**
 * `POST /api/notes/:id/links` 的交易寫入核心（spec §12.3，Task 5）。routes/notes.ts 只負責
 * body 驗證、權限矩陣與 `linkSyncGate` 呼叫；本檔專責「正規化目標集合」與「單一交易內
 * CAS clock + 批次授權 + 整組取代 note_links」。
 */
import { and, desc, eq, inArray, lte, notInArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { MAX_BACKLINKS, MAX_LINK_TARGETS, type BacklinkDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { noteLinks, noteShares, notes, users } from "../db/schema.js";
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

/**
 * `GET /api/notes/:id/backlinks` 的查詢核心（spec §12.3）：routes/notes.ts 只負責先用
 * `resolveRole` 判斷呼叫者對「被查詢的筆記本身」有沒有讀取權（none → 404）；本函式回答
 * 另一個問題——連到該筆記的**來源**筆記裡，哪些是呼叫者看得到的（owner 或有分享）。
 *
 * 單一 SQL、讀者授權述詞 inline：`note_links` JOIN `notes`（來源筆記）鎖定
 * `target_note_id = :targetNoteId`，分成 `ownedSelect`（來源筆記 owner_id = 呼叫者）與
 * `sharedSelect`（來源筆記在 `note_shares` 有呼叫者的一列）兩支，`union()`（非
 * `unionAll`——形狀比照 `attemptOnce` 的批次授權查詢：owner 與 shared 理論上互斥，但用
 * 真正的 SQL UNION 讓「同一來源筆記兩邊都命中」這種邊界情況天然被去重，不必額外加
 * `ne(ownerId, userId)` 排除）。**不對每篇來源筆記各自呼叫 `resolveRole`**——那樣是
 * N+1 查詢，且審查會抓到「來源筆記存在性/標題被無權限地個別洩漏」的風險。
 *
 * `ORDER BY notes.updated_at DESC, notes.id DESC LIMIT MAX_BACKLINKS`（spec 逐字）：次要
 * 排序鍵 `id DESC` 必須有——`updated_at` 是 `defaultNow()`，同一交易內批次 insert 的
 * fixture（測試造時序）時間戳會完全相同，缺了次要鍵會讓 LIMIT 邊界不確定、排序斷言
 * flake（`routes/notes.ts` 的 `GET /api/notes` 列表查詢已踩過同一雷，見該處註解）。
 * 過濾（讀者授權 WHERE 述詞）必須先於 LIMIT——此處自然滿足（`union()` 兩支各自的
 * `where` 在 `union` 結果之上才 `orderBy`/`limit`，SQL 語意上濾動作發生在截斷之前）。
 * `notes.updated_at` 只用來排序、不進 `BacklinkDto`（回應形狀是 `{id, title, slug,
 * ownerHandle}`——#122 起兩支各 JOIN `users` 帶出來源筆記 owner 的 username，
 * BacklinksSection 組 `/n/` 連結用）。
 */
export async function fetchBacklinks(db: Db, targetNoteId: string, userId: string): Promise<BacklinkDto[]> {
  const ownedSelect = db
    .select({ id: notes.id, title: notes.title, slug: notes.slug, ownerHandle: users.handle, updatedAt: notes.updatedAt })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .where(and(eq(noteLinks.targetNoteId, targetNoteId), eq(notes.ownerId, userId)));

  const sharedSelect = db
    .select({ id: notes.id, title: notes.title, slug: notes.slug, ownerHandle: users.handle, updatedAt: notes.updatedAt })
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .innerJoin(users, eq(users.id, notes.ownerId))
    .where(eq(noteLinks.targetNoteId, targetNoteId));

  const rows = await union(ownedSelect, sharedSelect)
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(MAX_BACKLINKS);

  return rows.map(row => ({ id: row.id, title: row.title, slug: row.slug, ownerHandle: row.ownerHandle }));
}
