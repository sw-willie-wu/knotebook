/**
 * `POST /api/notes/:id/links` 的交易寫入核心（spec §12.3，Task 5）。routes/notes.ts 只負責
 * body 驗證、權限矩陣與 `linkSyncGate` 呼叫；本檔專責「正規化目標集合」與「單一交易內
 * CAS clock + 批次授權 + 整組取代 note_links」的重試外殼（交易本體在 `tx/write-links.ts`，#175 S14）。
 */
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import type * as Y from "yjs";
import { MAX_BACKLINKS, MAX_LINK_TARGETS, extractLinkTargets, type BacklinkDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, noteLinks, noteShares, notes, users } from "../db/schema.js";
import { isForeignKeyViolation, isTransientTransactionError } from "../db/pg-errors.js";
import { writeLinksInTx, type WriteLinksInput } from "./tx/write-links.js";

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

/** #175：型別搬到 `tx/write-links.ts`（交易本體的輸入）；這個名字留給既有呼叫端。 */
export type WriteNoteLinksParams = WriteLinksInput;

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
 * 單次交易嘗試：本體在 `tx/write-links.ts` 的 `writeLinksInTx`（#175 S14，§6 T15——只收 `tx`，碰不到 pool）。
 * 語意（CAS clock → 批次授權 owned ∪ shared ∪ grouped(can_read) → 測試縫 → 整組取代）寫在那支的檔頭。
 */
async function attemptOnce(db: Db, params: WriteNoteLinksParams, hooks: WriteNoteLinksHooks): Promise<"applied" | "noop"> {
  return db.transaction(tx => writeLinksInTx(tx, params, hooks.beforeLinkWrite));
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
 * 從一份 Y.Doc 抽出 wikilink 目標、以 `userId` 的身分寫進 `sourceNoteId` 的出向 `note_links`（`writeNoteLinks`）。
 * 原本是 `notes/editing/apply.ts` 的 `updateNoteLinks` 本體（#106 的 AI 寫入／撤回路徑），#175 PR2 搬來與複製
 * （`POST /api/notes/:id/copy` commit 後寫副本的出向連結，spec §6.5）共用；`updateNoteLinks` 改成委派到這裡。
 * deps 收窄成只要 `db` 與 `log.warn`。
 */
export async function syncLinksFromDoc(
  deps: { db: Db; log: { warn(o: object, m: string): void } },
  p: { sourceNoteId: string; userId: string; doc: Y.Doc; clock: number },
): Promise<void> {
  // spec §6.1 步驟 5 說「先自行去重、濾自連結、slice」——去重那半 `extractLinkTargets` 已經做完了
  // （shared `note-markdown.ts` 結尾就是 `[...new Set(found)].sort()`），這裡再包一層 Set 是死碼。
  // 濾自連結必須排在 slice **之前**：反過來的話，一個排在前面的 self-link 會佔掉一個名額，把真正
  // 的第 1000 個目標擠掉。
  const deduped = extractLinkTargets(p.doc).filter(t => t !== p.sourceNoteId);
  const trimmed = deduped.slice(0, MAX_LINK_TARGETS);
  if (trimmed.length < deduped.length) deps.log.warn({ noteId: p.sourceNoteId, kept: trimmed.length, dropped: deduped.length - trimmed.length }, "wikilink 目標超過 MAX_LINK_TARGETS，已截斷");
  const norm = normalizeLinkTargets(p.sourceNoteId, trimmed);
  if (!norm.ok) return;
  // ⚠ 這個函式跑在**內容已落盤、note_ai_edits 也已寫**之後，是整條鏈的最後一步。`writeNoteLinks`
  // 對「忙碌」是回值（"busy"）不是拋出，所以它真的 throw 就代表 DB 故障——讓例外逃出去會把一次
  // 完全成功的寫入回成 500，而外部 AI 對 500 幾乎一定重試 → 同一筆編輯被套用兩次、紀錄多一列。
  // 這條鏈上其他每個失敗形都有明確語意，唯獨這個沒有，所以在這裡降級成警告：代價只是 wikilink
  // 索引落後（已記在 known-limitations），下一次該筆記的連結集合再變就會補上。
  // （複製同理：副本已 commit，500 只會讓呼叫端重試出第二份副本。）
  try {
    const outcome = await writeNoteLinks(deps.db, { sourceNoteId: p.sourceNoteId, userId: p.userId, targetIds: norm.targets, clock: p.clock });
    if (outcome !== "applied") deps.log.warn({ noteId: p.sourceNoteId, outcome }, "note_links 未更新（CAS 落敗或忙碌）");
  } catch (err) {
    deps.log.warn({ noteId: p.sourceNoteId, err }, "note_links 寫入失敗，索引暫時落後（內容與紀錄已成功）");
  }
}

/**
 * `GET /api/notes/:id/backlinks` 的查詢核心（spec §12.3）：routes/notes.ts 只負責先用
 * `resolveRole` 判斷呼叫者對「被查詢的筆記本身」有沒有讀取權（none → 404）；本函式回答
 * 另一個問題——連到該筆記的**來源**筆記裡，哪些是呼叫者看得到的（owner、有分享，或所屬群組裡角色可讀）。
 *
 * 單一 SQL、讀者授權述詞 inline：`note_links` JOIN `notes`（來源筆記）鎖定
 * `target_note_id = :targetNoteId`，分成三支：`ownedSelect`（來源筆記 owner_id = 呼叫者）、
 * `sharedSelect`（來源筆記是個人筆記〔`group_id IS NULL`〕且在 `note_shares` 有呼叫者的一列——群組筆記上的
 * 殘留分享列不算，規格落差 2）、`groupedSelect`（#175 §5.3：來源筆記所屬群組有呼叫者這位成員，且其角色
 * `can_read`），`union()`（非 `unionAll`——形狀比照 `writeLinksInTx` 的批次授權查詢：用真正的 SQL UNION 讓
 * 「同一來源筆記兩邊都命中」這種邊界情況天然被去重，不必額外加 `ne(ownerId, userId)` 排除）。
 * **不對每篇來源筆記各自呼叫 `resolveRole`**——那樣是 N+1 查詢，且審查會抓到「來源筆記存在性/標題被無權限地
 * 個別洩漏」的風險。
 *
 * `ORDER BY notes.updated_at DESC, notes.id DESC LIMIT MAX_BACKLINKS`（spec 逐字）：次要
 * 排序鍵 `id DESC` 必須有——`updated_at` 是 `defaultNow()`，同一交易內批次 insert 的
 * fixture（測試造時序）時間戳會完全相同，缺了次要鍵會讓 LIMIT 邊界不確定、排序斷言
 * flake（`routes/notes.ts` 的 `GET /api/notes` 列表查詢已踩過同一雷，見該處註解）。
 * 過濾（讀者授權 WHERE 述詞）必須先於 LIMIT——此處自然滿足（`union()` 各支各自的
 * `where` 在 `union` 結果之上才 `orderBy`/`limit`，SQL 語意上濾動作發生在截斷之前）。
 * `notes.updated_at` 只用來排序、不進 `BacklinkDto`（回應形狀是 `{id, title, slug,
 * ownerHandle, groupId}`——三支都 LEFT JOIN `users` 帶出來源筆記 owner 的 username〔群組筆記沒有 owner，
 * 為 null〕，並帶來源筆記的 `groupId`；BacklinksSection 以兩者組 `/n/` 或 `/g/` 連結）。
 */
export async function fetchBacklinks(db: Db, targetNoteId: string, userId: string): Promise<BacklinkDto[]> {
  // `ownerHandle` 包 `sql<string | null>` 只為與 `list-query.ts` 的 `baseColumns` 同形——這裡三支都 LEFT JOIN
  // users，drizzle 本來就推得 `string | null`，換回裸 `users.handle` tsc 也不新增錯誤（實測；不像清單的 owned 支是
  // INNER JOIN、包起來才是承重的）。每支現造一份欄位物件（builder 單次使用，不共用模組常數）。
  const columns = () => ({
    id: notes.id,
    title: notes.title,
    slug: notes.slug,
    ownerHandle: sql<string | null>`${users.handle}`.as("owner_handle"),
    groupId: notes.groupId,
    updatedAt: notes.updatedAt,
  });
  const ownedSelect = db
    .select(columns())
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .where(and(eq(noteLinks.targetNoteId, targetNoteId), eq(notes.ownerId, userId)));

  const sharedSelect = db
    .select(columns())
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .leftJoin(users, eq(users.id, notes.ownerId))
    // 規格落差 2／gate r1 A-M6：群組筆記上的殘留分享列（S5 破裂）不算——同 §5.3 清單的 shared 支。
    .where(and(eq(noteLinks.targetNoteId, targetNoteId), isNull(notes.groupId)));

  const groupedSelect = db
    .select(columns())
    .from(noteLinks)
    .innerJoin(notes, eq(notes.id, noteLinks.sourceNoteId))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .leftJoin(users, eq(users.id, notes.ownerId))
    .where(eq(noteLinks.targetNoteId, targetNoteId));

  const rows = await union(ownedSelect, sharedSelect, groupedSelect)
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .limit(MAX_BACKLINKS);

  return rows.map(row => ({ id: row.id, title: row.title, slug: row.slug, ownerHandle: row.ownerHandle, groupId: row.groupId }));
}
