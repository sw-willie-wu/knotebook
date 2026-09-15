/**
 * #145：**唯一的建列點**。三條建立路徑（`POST /api/notes` 裸建列與帶 `content` 那條走的
 * `NoteWriteService.createWithContent`、MCP 的 `create_note`）全部呼叫這裡。
 *
 * ① 為什麼派生不能留在原本那個形——「同步組一個 values 物件、呼叫端各自 insert」（本棒把那支
 *    純函式與它的型別整組刪了）：owner 範圍去重是 `await` 的 DB 探測。把那支改成 async 只會讓
 *    呼叫端各自 `await` 完再自己 insert——`insert(notes)` 仍散在三處，「只改其中一處」的漂移
 *    原樣保留。唯一能收成一處的切法是**連 insert 一起收**。
 * ② 「`src/` 內只有本檔可以 `.insert(notes)`」有源碼結構守衛：`test/notes-slug.test.ts` 的
 *    「源碼守衛：src/ 內 `.insert(notes)` 只允許出現在 notes/create.ts」那一案（它自己濾掉
 *    註解行，所以散文裡提到這個字面不算違反；盲點清單寫在該案的註解裡）。
 * ③ 不帶 `title` 時**一次探測都不發**，且 `slug` 鍵不進 values——DB default
 *   （`untitled-<uuid8>`）是唯一真相（`db/schema.ts`），應用層不重寫第二份。
 */
import { notes } from "../db/schema.js";
import { uniqueViolationConstraint } from "../db/pg-errors.js";
import type { Db } from "../db/index.js";
import { MAX_AUTO_SLUG_RETRIES, deriveUniqueAutoSlug, fallbackAutoSlug } from "./slug.js";

export interface NoteCreateHooks {
  /** 探測完、INSERT 發出前呼叫（帶本輪候選）——測試在這裡搶插同 owner 同 slug 的佔位列。 */
  beforeInsert?: (candidate: string) => void | Promise<void>;
}

/**
 * 建一列筆記，`title` 有值時把 auto slug 一起派生好（#145）。
 *
 * 碰撞契約與 PATCH 的 auto 路徑**逐字相同**（`routes/notes.ts` 的四格矩陣）：探測（述詞不
 * 排除任何列——這一列還不存在）→ INSERT；撞 `notes_owner_slug_idx` ＝真競態 → 重探測重發，
 * `MAX_AUTO_SLUG_RETRIES` 次後改用 `fallbackAutoSlug()` 不探測直接發；再撞（~2^-32）就讓
 * 錯誤冒出去（REST → 500 `internal`、MCP → 工具錯誤 `internal`）。**建立路徑永不回 409
 * `slug_taken`**：那個碼專屬「使用者顯式指定的自訂 slug 撞名」。
 *
 * constraint 名分流不得放寬成「看到 23505 就重試」（PR1 的 M4-2 契約）——其他唯一鍵違反
 * 一律 rethrow。⚠ 誠實：`notes` 表上今天沒有第二把建立路徑撞得到的唯一鍵，所以放寬它不會
 * 有任何測試變紅（附錄二第 1 條）。
 *
 * `slugIsCustom`／`prevSlug`／`legacySlug` **一律不設**：吃各自的 default（`false`／null／
 * null），之後的 title PATCH 因此仍會重算 slug，而 `legacy_slug` 是 0007 的凍結快照
 * （另有 trigger 與源碼守衛）。
 */
export async function insertNoteWithAutoSlug(
  db: Db,
  ownerId: string,
  title: string | undefined,
  hooks?: NoteCreateHooks
): Promise<typeof notes.$inferSelect> {
  // `title` 未帶：`title`／`slug` 兩把鍵都不放，讓 DB 的 default `"Untitled"` 與
  // `untitled-<uuid8>` 同時生效（#145 D6：不派生成 `untitled`，也不發任何探測查詢）。
  if (title === undefined) {
    const [created] = await db.insert(notes).values({ ownerId }).returning();
    return created!;
  }

  for (let attempt = 1; ; attempt++) {
    const slug =
      attempt > MAX_AUTO_SLUG_RETRIES ? fallbackAutoSlug() : await deriveUniqueAutoSlug(db, ownerId, null, title);
    await hooks?.beforeInsert?.(slug);
    try {
      // `.returning()` 落空在 INSERT 上結構性不可能（成功的 INSERT 必回一列）——`!` 是
      // 原本那三處的寫法，沿用。**不要**替它加一條回 404 的分支：PATCH 的 `if (!updated)`
      // 是 UPDATE 命中 0 列（筆記已被刪），與這裡不同情形。
      const [created] = await db.insert(notes).values({ ownerId, title, slug }).returning();
      return created!;
    } catch (err) {
      if (uniqueViolationConstraint(err) === "notes_owner_slug_idx" && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
}
