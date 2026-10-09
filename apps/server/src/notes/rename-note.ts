/**
 * #180 spec §3.1：PATCH 格 2（title-only）的本體，REST `PATCH /api/notes/:id` 與 MCP `edit_note` 的 `rename` 共用。
 * 從 `routes/notes.ts` 格 2 **原樣搬家**：pre-read 本列 `title, slug_is_custom` → `needsAuto` → 迴圈（重試耗盡退
 * `fallbackAutoSlug`、要 auto 時 `deriveUniqueAutoSlug`、否則 `autoSlugFromTitle` 佔位）→ `await hook?.(auto)` →
 * **單句** UPDATE（`updated_at`＝`UPDATED_AT_NOW`、`slug = case when slug_is_custom then slug else $auto end`、scope 述詞＝授權當下歸屬）。
 * **不開交易**（格 2 今天就沒有）→ 不進 S14 的 `ROUTE_FILES`。不寫 `prev_slug`、不寫也不刪 `note_redirects`。
 * 授權**不在**本函式：呼叫端各自判（PATCH 要先做「帶 slug 要 changeSlug」整包判定；MCP 只要 `permissions.edit`）——
 * 前置條件：`input.access.role !== "none"` 且 `input.access.permissions.edit` 已驗。
 * 0 列時補一句 `select id`：列不在 → `gone`；列在 → `ownership_changed`（授權後歸屬變了——即今天 `ownershipChanged` 的查詢）。
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
  /** pre-read 無列，或 UPDATE 0 列且列已不在。 */
  | { kind: "gone" }
  /** UPDATE 0 列而列仍在（授權後歸屬變了）。 */
  | { kind: "ownership_changed" };

export async function renameNoteTitle(
  db: Db,
  input: { noteId: string; access: NoteAccess; title: string },
  hook?: (candidate: string) => void | Promise<void>,
): Promise<RenameOutcome> {
  const { noteId: id, access, title } = input;
  const slugScope: SlugScope = access.groupId !== null ? { groupId: access.groupId } : { ownerId: access.ownerId! };
  const [pre] = await db.select({ title: notes.title, slugIsCustom: notes.slugIsCustom }).from(notes).where(eq(notes.id, id)).limit(1);
  if (!pre) return { kind: "gone" };
  const needsAuto = !pre.slugIsCustom;

  let updated: typeof notes.$inferSelect | undefined;
  for (let attempt = 1; ; attempt++) {
    // 候選來源三分支（原註解照搬）：重試耗盡 → uuid8 退位；要走 auto（或重試中）→ 在歸屬範圍內探測（RF5）；
    // custom=true → CASE 會保留現行 slug、$auto 只是佔位，傳未探測候選即可。
    let auto: string;
    if (attempt > MAX_AUTO_SLUG_RETRIES) auto = fallbackAutoSlug();
    else if (needsAuto || attempt > 1) auto = await deriveUniqueAutoSlug(db, slugScope, id, title);
    else auto = autoSlugFromTitle(title);
    await hook?.(auto);
    try {
      [updated] = await db
        .update(notes)
        .set({ updatedAt: UPDATED_AT_NOW, title, slug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${auto} end` })
        .where(and(eq(notes.id, id), access.groupId !== null ? eq(notes.groupId, access.groupId) : and(eq(notes.ownerId, access.ownerId!), isNull(notes.groupId))))
        .returning();
      break;
    } catch (err) {
      if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
      throw err;
    }
  }
  if (updated) return { kind: "renamed", row: updated };
  const [still] = await db.select({ id: notes.id }).from(notes).where(eq(notes.id, id)).limit(1);
  return still ? { kind: "ownership_changed" } : { kind: "gone" };
}
