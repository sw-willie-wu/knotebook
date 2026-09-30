import { and, eq, isNull, ne } from "drizzle-orm";
import type { WikilinkTarget } from "@knotebook/shared";
import type { Db } from "../../db/index.js";
import { groupMembers, groupRoles, noteShares, notes } from "../../db/schema.js";

/**
 * wikilink 重綁的候選：該使用者看得到的筆記標題（自有 ∪ 被分享 ∪ 所屬群組裡角色可讀的筆記；同 GET /api/notes 的三支）。
 * #175 §5.3：grouped 支 JOIN `group_roles` 並要求 `can_read`——無閱讀旗標的成員看不到群組筆記。群組筆記的 `owner_id`
 * 是 NULL，owned 支（`owner_id = $u`）結構上不會撈到它們；三支已結構性互斥（§5.3：owned 要 `owner_id = $u`、
 * shared 要 `group_id IS NULL`、grouped 要 `group_id` 非 NULL——S5 破裂也造不出重複），依 id 去重只是純防禦。
 * shared 支明寫 `group_id IS NULL`（§5.3、規格落差 2）：群組筆記上的殘留分享列不算——`owner_id <> $u` 對 NULL 求值
 * 為 NULL 也會擋住，但不靠 NULL 語意（gate r1 A-M6）。不改吃 `visibleNoteBranches`（欄位集不同，它在 wikilink 重綁路徑上）。
 */
export async function visibleNoteTitles(db: Db, userId: string): Promise<WikilinkTarget[]> {
  const owned = await db.select({ id: notes.id, title: notes.title }).from(notes).where(eq(notes.ownerId, userId));
  const shared = await db.select({ id: notes.id, title: notes.title }).from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .where(and(ne(notes.ownerId, userId), isNull(notes.groupId)));
  const grouped = await db.select({ id: notes.id, title: notes.title }).from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)));
  const byId = new Map<string, WikilinkTarget>();
  for (const t of [...owned, ...shared, ...grouped]) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()];
}
