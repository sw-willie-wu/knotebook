/**
 * #180 spec §3.1：PATCH 格 2（title-only）的本體，REST `PATCH /api/notes/:id` 與 MCP `edit_note` 的 `rename` 共用。
 * 從 `routes/notes.ts` 格 2 **原樣搬家**：pre-read 本列 `title, slug_is_custom` → `needsAuto` → 迴圈（重試耗盡退
 * `fallbackAutoSlug`、要 auto 時 `deriveUniqueAutoSlug`、否則 `autoSlugFromTitle` 佔位）→ `await hook?.(auto)` →
 * **單句** UPDATE（`updated_at`＝`UPDATED_AT_NOW`、`slug = case when slug_is_custom then slug else $auto end`、scope 述詞＝授權當下歸屬）。
 * **不開交易**（格 2 今天就沒有）→ 不進 S14 的 `ROUTE_FILES`。不寫 `prev_slug`、不寫也不刪 `note_redirects`。
 * 授權**不在**本函式：呼叫端各自判（PATCH 要先做「帶 slug 要 changeSlug」整包判定；MCP 只要 `permissions.edit`）——
 * 前置條件：`input.access.role !== "none"` 且 `input.access.permissions.edit` 已驗。
 * 0 列時補一句 `select id`：列不在 → `gone`；列在 → `ownership_changed`（授權後歸屬變了——即今天 `ownershipChanged` 的查詢）。
 * `expectTitle`（只有 bulk transfer 的檔案寫回傳，Willie 2026-11-04 第三輪）：現行標題必須等於它才改——pre-read 不等 → `title_changed`；
 * UPDATE 多一個 `title = expectTitle` 述詞（檢查與寫入同一句），0 列且列還在、標題已不是它 → `title_changed`。不傳＝行為逐位元組不變。
 * 語句形狀守衛＝`test/notes-slug.test.ts` 的「語句形狀守衛」案（格 2 恰一次 pre-read、恰一條 UPDATE、0 條刪轉址）。
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { autoSlugFromTitle } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { UPDATED_AT_NOW } from "./clock.js";
import type { NoteAccess } from "./service.js";
import { deriveUniqueAutoSlug, fallbackAutoSlug, isSlugUniqueViolation, MAX_AUTO_SLUG_RETRIES, type SlugScope } from "./slug.js";

export type RenameOutcome =
  | { kind: "renamed"; row: typeof notes.$inferSelect }
  /** pre-read 無列，或 UPDATE 0 列且列已不在（#181：在垃圾桶裡也算不在）。 */
  | { kind: "gone" }
  /** UPDATE 0 列而列仍在（授權後歸屬變了）。 */
  | { kind: "ownership_changed" };
/** 帶 `expectTitle` 時多一形：現行標題已不是期望的那個。 */
export type ConditionalRenameOutcome = RenameOutcome | { kind: "title_changed" };

export async function renameNoteTitle(
  db: Db,
  input: { noteId: string; access: NoteAccess; title: string },
  hook?: (candidate: string) => void | Promise<void>,
): Promise<RenameOutcome>;
export async function renameNoteTitle(
  db: Db,
  input: { noteId: string; access: NoteAccess; title: string; expectTitle: string },
  hook?: (candidate: string) => void | Promise<void>,
): Promise<ConditionalRenameOutcome>;
export async function renameNoteTitle(
  db: Db,
  input: { noteId: string; access: NoteAccess; title: string; expectTitle?: string },
  hook?: (candidate: string) => void | Promise<void>,
): Promise<ConditionalRenameOutcome> {
  const { noteId: id, access, title, expectTitle } = input;
  const slugScope: SlugScope = access.groupId !== null ? { groupId: access.groupId } : { ownerId: access.ownerId! };
  // #181 §6.2-11：三句都排除垃圾桶筆記——在垃圾桶裡＝列不在 → `gone`。
  const [pre] = await db.select({ title: notes.title, slugIsCustom: notes.slugIsCustom }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  if (!pre) return { kind: "gone" };
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
            expectTitle !== undefined ? eq(notes.title, expectTitle) : undefined,
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
  if (expectTitle !== undefined) {
    const [row] = await db.select({ title: notes.title }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
    if (!row) return { kind: "gone" };
    return row.title !== expectTitle ? { kind: "title_changed" } : { kind: "ownership_changed" };
  }
  const [still] = await db.select({ id: notes.id }).from(notes).where(and(eq(notes.id, id), isNull(notes.deletedAt))).limit(1);
  return still ? { kind: "ownership_changed" } : { kind: "gone" };
}
