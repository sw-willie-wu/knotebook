/**
 * #175 T1（spec §4.3、§6.2 row 12、§6 T1；gate r3 M-1、r4 I-1／M-2、r5 M-1／M-2／N-5）：PATCH 寫 `prev_slug` 的短交易本體。
 *
 *   WITH o AS (SELECT id, slug_is_custom FROM notes WHERE id = $id AND <授權時的 scope> FOR UPDATE)
 *   UPDATE notes SET …, prev_slug = CASE WHEN slug_is_custom THEN slug ELSE prev_slug END FROM o WHERE notes.id = o.id
 *   RETURNING notes.*, o.slug_is_custom AS old_custom
 *
 * - 先鎖列再讀，`old_custom` 是**這次 UPDATE 實際覆寫的那一版**——並發形下也成立（`RETURNING` 帶子查詢的形在 EPQ
 *   下讀到語句開始時的快照，gate r4 A-11 R3 實證會錯）。
 * - scope 條件＝授權當下的歸屬（個人：`owner_id = $me AND group_id IS NULL`；群組：`group_id = $authGroupId`）。
 *   0 列＝授權之後歸屬變了（PR2 的移動）或列被刪 → 回 null，呼叫端再讀一次分流 404／409 `conflict`（gate r5 M-2）。
 * - `old_custom` 為真（舊自訂 slug 真的被寫進 prev）且個人 scope → 同交易刪 `/n/<handle>/<新 prev>` 的轉址（B4：
 *   轉址與 prev 以寫入先後裁決）。群組 scope 不發：`/g/` 轉址只由轉移寫入、而轉移同交易刪掉群組（gate r3 N-2）。
 * - `redirectHandle` 由呼叫端傳入（`request.user.handle`，記憶體中）。**本檔不得查 users**——S14：gate r4 A-10 以
 *   「交易內補查 owner handle」的形在 N=10 並發下永久卡死；本檔也沒有連線池可用（只收 `tx`、不接路由的依賴物件）。
 * - 撞 slug 唯一索引（23505）照常拋出——呼叫端在交易外分流。
 */
import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { noteRedirects, notes } from "../../db/schema.js";
import { UPDATED_AT_NOW } from "../clock.js";
import { userNotePath } from "../redirects.js";

export type SlugWriteScope = { kind: "personal"; ownerId: string } | { kind: "group"; groupId: string };

/** 測試縫：`authorized`＝路由在授權之後、交易之前呼叫；`slug-written`＝本函式在 CTE UPDATE 之後、COMMIT 之前呼叫。 */
export type SlugPatchTestHook = (point: "authorized" | "slug-written", ctx: { noteId: string }) => Promise<void>;

export interface PatchSlugInput {
  noteId: string;
  scope: SlugWriteScope;
  set: { title?: string; slug: string; slugIsCustom: boolean };
  /** 個人 scope：呼叫者的 handle（授權時已證明他就是 owner，§4.3）；群組 scope：null。 */
  redirectHandle: string | null;
}

export async function patchSlugInTx(
  tx: Tx,
  input: PatchSlugInput,
  hook?: SlugPatchTestHook,
): Promise<typeof notes.$inferSelect | null> {
  const scope =
    input.scope.kind === "personal"
      ? and(eq(notes.ownerId, input.scope.ownerId), isNull(notes.groupId))
      : eq(notes.groupId, input.scope.groupId);
  const o = tx.$with("o").as(
    tx
      .select({ id: notes.id, oldCustom: sql<boolean>`${notes.slugIsCustom}`.as("old_custom") })
      .from(notes)
      .where(and(eq(notes.id, input.noteId), scope))
      .for("update"),
  );
  const [row] = await tx
    .with(o)
    .update(notes)
    .set({
      updatedAt: UPDATED_AT_NOW,
      ...(input.set.title !== undefined ? { title: input.set.title } : {}),
      slug: input.set.slug,
      slugIsCustom: input.set.slugIsCustom,
      // 「只記自訂變更」（#122 spec M4-3）：PG 對 SET 運算式一律讀 OLD 列值，CASE 讀到的是更新前的 slug_is_custom/slug。
      prevSlug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${notes.prevSlug} end`,
    })
    .from(o)
    .where(eq(notes.id, o.id))
    .returning({ ...getTableColumns(notes), oldCustom: o.oldCustom });
  if (!row) return null;
  await hook?.("slug-written", { noteId: input.noteId });
  const { oldCustom, ...updated } = row;
  if (oldCustom && input.scope.kind === "personal" && input.redirectHandle !== null && updated.prevSlug !== null) {
    await tx.delete(noteRedirects).where(eq(noteRedirects.oldPath, userNotePath(input.redirectHandle, updated.prevSlug)));
  }
  return updated;
}
