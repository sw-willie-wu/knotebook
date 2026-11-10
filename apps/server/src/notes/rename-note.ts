/**
 * #180 spec §3.1：PATCH 格 2（title-only）的本體，REST `PATCH /api/notes/:id` 與 MCP `edit_note` 的 `rename` 共用。
 * 從 `routes/notes.ts` 格 2 **原樣搬家**：pre-read 本列 `title, slug_is_custom` → `needsAuto` → 迴圈（重試耗盡退
 * `fallbackAutoSlug`、要 auto 時 `deriveUniqueAutoSlug`、否則 `autoSlugFromTitle` 佔位）→ `await hook?.(auto)` →
 * **單句** UPDATE（`updated_at`＝`UPDATED_AT_NOW`、`slug = case when slug_is_custom then slug else $auto end`、scope 述詞＝授權當下歸屬）。
 * **不開交易**（格 2 今天就沒有）→ 不進 S14 的 `ROUTE_FILES`。不寫 `prev_slug`、不寫也不刪 `note_redirects`。
 * 授權**不在**本函式：呼叫端各自判（PATCH 要先做「帶 slug 要 changeSlug」整包判定；MCP 只要 `permissions.edit`）——
 * 前置條件：`input.access.role !== "none"` 且 `input.access.permissions.edit` 已驗。
 * 0 列時補一句 `select id, title`：列不在 → `gone`；列在 → `ownership_changed`（授權後歸屬變了——即今天 `ownershipChanged` 的查詢）
 * ——#381 起，傳了 `expectTitleFingerprint` 或 `expectTitle` 且標題已不是 pre-read 那一個時改回 `title_changed`。
 * `expectTitle`（只有 bulk transfer 的檔案寫回傳）：現行標題必須**等於**它才改——pre-read 不等 → `title_changed`；
 * 之後與 `expectTitleFingerprint` 走同一道條件式 UPDATE（WHERE `title = pre.title`，此時 pre.title 就是 expectTitle）與同一句 0 列補查。
 * 兩者都不傳（REST PATCH）＝ UPDATE 語句與 #381 之前同形。
 * 語句形狀守衛＝`test/notes-slug.test.ts` 的「語句形狀守衛」案（格 2 恰一次 pre-read、恰一條 UPDATE、0 條刪轉址）。
 *
 * #381：`expectTitleFingerprint`（MCP rename 的 `if_match`）——**只有 MCP 傳**，REST PATCH 不傳：對 REST 而言 UPDATE 語句不變、仍是 last-write-wins；唯一差別是 0 列後的補查多讀一欄
 * `title`（REST 不用它，`ownership_changed`／`gone` 的判定與回應不變）。
 * 傳了就是兩道、各守一段時間窗：
 * (1) pre-read 之後 `fingerprintOf(pre.title) !== expect` → `title_changed`（呼叫者讀完之後、本請求開始之前被改）；
 * (2) UPDATE 的 WHERE 多一條 `title = pre.title`（**條件式 UPDATE**：比對與寫入同一句，pg 的列鎖＋EvalPlanQual 讓
 *     「pre-read 之後、UPDATE 之前」被提交的改名一定讓這句 0 列）；0 列時補查到的列標題已不是 pre.title → `title_changed`。
 * 兩道缺一不可：拿掉 (1)，pre-read 讀到的是**別人的新標題**，(2) 的 WHERE 照樣成立；拿掉 (2)，(1) 與 UPDATE 之間就是 TOCTOU 窗。
 * 守衛＝`test/mcp-rename.test.ts` 的 R14（(1)）與 R15（(2)，經 `hook` 在兩者之間插入別人的改名）。
 * 指紋算的是**標題全文**（`fingerprintOf`，與內文指紋同格式），不是 MCP 回應裡截斷後的顯示字串。ABA（被改走又改回同一字串）視為未變，可接受。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { UPDATED_AT_NOW } from "./clock.js";
import { fingerprintOf } from "./editing/fingerprint.js";
import type { NoteAccess } from "./service.js";
import { deriveUniqueAutoSlug, fallbackAutoSlug, isSlugUniqueViolation, MAX_AUTO_SLUG_RETRIES, type SlugScope } from "./slug.js";

export type RenameOutcome =
  | { kind: "renamed"; row: typeof notes.$inferSelect }
  /** pre-read 無列，或 UPDATE 0 列且列已不在（#181：在垃圾桶裡也算不在）。 */
  | { kind: "gone" }
  /** UPDATE 0 列而列仍在（授權後歸屬變了）。 */
  | { kind: "ownership_changed" }
  /** #381：只在傳了 `expectTitleFingerprint` 或 `expectTitle` 時出現——標題已不是呼叫者看到的那一個，什麼都沒寫。 */
  | { kind: "title_changed" };

export async function renameNoteTitle(
  db: Db,
  input: { noteId: string; access: NoteAccess; title: string; expectTitleFingerprint?: string; expectTitle?: string },
  hook?: (candidate: string) => void | Promise<void>,
): Promise<RenameOutcome> {
  const { noteId: id, access, title, expectTitleFingerprint: expect, expectTitle } = input;
  const guarded = expect !== undefined || expectTitle !== undefined;
  const slugScope: SlugScope = access.groupId !== null ? { groupId: access.groupId } : { ownerId: access.ownerId! };
  // #181 §6.2-11：三句都排除垃圾桶筆記——在垃圾桶裡＝列不在 → `gone`。
  const [pre] = await db.select({ title: notes.title, slugIsCustom: notes.slugIsCustom }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!pre) return { kind: "gone" };
  // #381 (1)
  if (expect !== undefined && fingerprintOf(pre.title) !== expect) return { kind: "title_changed" };
  if (expectTitle !== undefined && pre.title !== expectTitle) return { kind: "title_changed" };
  const needsAuto = !pre.slugIsCustom;

  let updated: typeof notes.$inferSelect | undefined;
  for (let attempt = 1; ; attempt++) {
    // 候選來源三分支（原註解照搬）：重試耗盡 → uuid8 退位；要走 auto（或重試中）→ 在歸屬範圍內探測（RF5）；
    // custom=true → CASE 會保留現行 slug、$auto 只是佔位，傳未探測候選即可
    // ——若 pre-read 後被併發翻回 auto（罕見競態），只有恰好撞索引才落到重試路徑
    // 重新探測；沒撞就直接寫入未探測候選（仍唯一，可接受）。
    let auto: string;
    if (attempt > MAX_AUTO_SLUG_RETRIES) auto = fallbackAutoSlug();
    else if (needsAuto || attempt > 1) auto = await deriveUniqueAutoSlug(db, slugScope, id, title);
    else auto = autoSlugFromTitle(title);
    await hook?.(auto);
    try {
      [updated] = await db
        .update(notes)
        .set({ updatedAt: UPDATED_AT_NOW, title, slug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${auto} end` })
        .where(
          and(
            eq(notes.id, id),
            access.groupId !== null ? eq(notes.groupId, access.groupId) : and(eq(notes.ownerId, access.ownerId!), isNull(notes.groupId)),
            isNull(notes.deletedAt),
            // #381 (2)：條件式 UPDATE。兩個 expect 都不傳（REST PATCH）時 `and()` 略過 undefined，語句與 #381 之前同形。
            guarded ? eq(notes.title, pre.title) : undefined,
          ),
        )
        .returning();
      break;
    } catch (err) {
      if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
  if (updated) return { kind: "renamed", row: updated };
  const [still] = await db.select({ id: notes.id, title: notes.title }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!still) return { kind: "gone" };
  // #381：0 列的成因要分辨——標題變了優先回 `title_changed`（歸屬與標題同時變時，重讀能同時看到兩者）。
  if (guarded && still.title !== pre.title) return { kind: "title_changed" };
  return { kind: "ownership_changed" };
}
