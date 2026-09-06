import { and, eq, ne } from "drizzle-orm";
import type { WikilinkTarget } from "@knotebook/shared";
import type { Db } from "../../db/index.js";
import { noteShares, notes } from "../../db/schema.js";

/** wikilink 重綁的候選：該使用者看得到的筆記標題（自有 ∪ 被分享；同 GET /api/notes 的兩支）。 */
export async function visibleNoteTitles(db: Db, userId: string): Promise<WikilinkTarget[]> {
  const owned = await db.select({ id: notes.id, title: notes.title }).from(notes).where(eq(notes.ownerId, userId));
  const shared = await db.select({ id: notes.id, title: notes.title }).from(notes)
    .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId))).where(ne(notes.ownerId, userId));
  return [...owned, ...shared];
}
