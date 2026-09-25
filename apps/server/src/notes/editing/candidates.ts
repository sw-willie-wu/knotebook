import { and, eq, ne } from "drizzle-orm";
import type { WikilinkTarget } from "@knotebook/shared";
import type { Db } from "../../db/index.js";
import { groupMembers, noteShares, notes } from "../../db/schema.js";

/**
 * wikilink 重綁的候選：該使用者看得到的筆記標題（自有 ∪ 被分享 ∪ 所屬群組的筆記；同 GET /api/notes 的三支）。
 * #103 §5.3：grouped 這支刻意不排除自己的筆記，改在 TS 端依 id 去重——owner 兼成員時同一篇會從兩支
 * 各來一次。不改吃 `visibleNoteBranches`（欄位集不同，它在 wikilink 重綁路徑上）。
 */
export async function visibleNoteTitles(db: Db, userId: string): Promise<WikilinkTarget[]> {
  const owned = await db.select({ id: notes.id, title: notes.title }).from(notes).where(eq(notes.ownerId, userId));
  const shared = await db.select({ id: notes.id, title: notes.title }).from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId))).where(ne(notes.ownerId, userId));
  const grouped = await db.select({ id: notes.id, title: notes.title }).from(notes)
    .innerJoin(groupMembers, and(eq(groupMembers.groupId, notes.groupId), eq(groupMembers.userId, userId)));
  const byId = new Map<string, WikilinkTarget>();
  for (const t of [...owned, ...shared, ...grouped]) if (!byId.has(t.id)) byId.set(t.id, t);
  return [...byId.values()];
}
