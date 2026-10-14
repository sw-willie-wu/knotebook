import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import { UUID_RE, type SiteLinkCandidate, type WikilinkTarget } from "@knotebook/shared";
import type { Db } from "../../db/index.js";
import { groupMembers, groupRoles, noteShares, notes, users } from "../../db/schema.js";

/** #269：寫入者／讀者可見筆記的站內連結候選（`resolveFromList` 吃這個形）。 */
export type VisibleNoteTarget = SiteLinkCandidate;

/**
 * 使用者看得到的筆記（自有 ∪ 被分享 ∪ 所屬群組裡角色可讀的筆記；同 GET /api/notes 的三支），帶站內網址比對要的欄位。
 * #175 §5.3：grouped 支 JOIN `group_roles` 並要求 `can_read`——無閱讀旗標的成員看不到群組筆記。群組筆記的 `owner_id`
 * 是 NULL，owned 支（`owner_id = $u`）結構上不會撈到它們；三支已結構性互斥（§5.3：owned 要 `owner_id = $u`、
 * shared 要 `group_id IS NULL`、grouped 要 `group_id` 非 NULL——S5 破裂也造不出重複），依 id 去重只是純防禦。
 * shared 支明寫 `group_id IS NULL`（§5.3、規格落差 2）：群組筆記上的殘留分享列不算——`owner_id <> $u` 對 NULL 求值
 * 為 NULL 也會擋住，但不靠 NULL 語意（gate r1 A-M6）。不改吃 `visibleNoteBranches`（欄位集不同，它在 wikilink 重綁路徑上）。
 * `ownerHandle`：LEFT JOIN owner——群組筆記為 NULL。
 * #269 §6.6／§9.1：`ids` 有給時三支各加 `inArray(notes.id, ids)`（只查這些）；給了空集合（或全是非 uuid）⇒ 不發任何查詢。
 */
export async function visibleNoteTargets(db: Db, userId: string, ids?: readonly string[]): Promise<VisibleNoteTarget[]> {
  const only = ids === undefined ? undefined : ids.filter(id => UUID_RE.test(id)).map(id => id.toLowerCase());
  if (only !== undefined && only.length === 0) return [];
  const idCond = only === undefined ? undefined : inArray(notes.id, only);
  const cols = { id: notes.id, title: notes.title, slug: notes.slug, groupId: notes.groupId, ownerHandle: users.handle };
  const owned = await db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId)).where(and(eq(notes.ownerId, userId), idCond));
  const shared = await db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId))
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
    .where(and(ne(notes.ownerId, userId), isNull(notes.groupId), idCond));
  const grouped = await db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId))
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)))
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .where(idCond);
  const byId = new Map<string, VisibleNoteTarget>();
  for (const t of [...owned, ...shared, ...grouped]) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()];
}

/** wikilink 重綁的候選（`{ id, title }`）——同 `visibleNoteTargets` 的可見性。 */
export async function visibleNoteTitles(db: Db, userId: string): Promise<WikilinkTarget[]> {
  return (await visibleNoteTargets(db, userId)).map(({ id, title }) => ({ id, title }));
}

/** #269 §9.1：MCP／REST 讀出的現行標題——只查 `ids`（`extractLinkTargets` 的結果）中讀者看得到的；空集合不查。 */
export async function visibleTitlesByIds(db: Db, userId: string, ids: readonly string[]): Promise<WikilinkTarget[]> {
  return (await visibleNoteTargets(db, userId, ids)).map(({ id, title }) => ({ id, title }));
}
