import { and, eq, inArray } from "drizzle-orm";
import { TAGS_PER_NOTE_MAX } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { groupMembers, tags } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";

export const INVALID_SEARCH_TAGS_MESSAGE = `tags must list 1 to ${TAGS_PER_NOTE_MAX} tags of one of your spaces.`;

/**
 * Lower-cased, deduplicated tag ids when every one of them exists and they all belong to one space the caller is in (their personal
 * space, or a group they are a member of); otherwise null. Callers answer every null the same way, so a missing tag and one the caller
 * can't use look identical.
 */
export async function resolveSearchTagFilter(db: DbOrTx, userId: string, raw: string): Promise<string[] | null> {
  const parts = raw.split(",");
  if (parts.length > TAGS_PER_NOTE_MAX || !parts.every(p => UUID_RE.test(p))) return null;
  const ids = [...new Set(parts.map(p => p.toLowerCase()))];
  const rows = await db.select({ ownerId: tags.ownerId, groupId: tags.groupId }).from(tags).where(inArray(tags.id, ids));
  if (rows.length !== ids.length) return null;
  const first = rows[0]!;
  if (!rows.every(r => r.ownerId === first.ownerId && r.groupId === first.groupId)) return null;
  if (first.groupId === null) return first.ownerId === userId ? ids : null;
  const [member] = await db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, first.groupId), eq(groupMembers.userId, userId)));
  return member === undefined ? null : ids;
}
