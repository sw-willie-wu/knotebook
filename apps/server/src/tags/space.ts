import { eq, type SQL } from "drizzle-orm";
import { tags } from "../db/schema.js";

/** A tag belongs to exactly one space: a user's personal space or a group. */
export type TagSpace = { kind: "personal"; ownerId: string } | { kind: "group"; groupId: string };

/** A note's `owner_id` and `group_id` are mutually exclusive, so the group wins when set. */
export function tagSpaceOf(row: { ownerId: string | null; groupId: string | null }): TagSpace {
  if (row.groupId !== null) return { kind: "group", groupId: row.groupId };
  if (row.ownerId === null) throw new Error("a note without owner or group has no tag space");
  return { kind: "personal", ownerId: row.ownerId };
}

export function tagSpaceWhere(space: TagSpace): SQL {
  return space.kind === "personal" ? eq(tags.ownerId, space.ownerId) : eq(tags.groupId, space.groupId);
}
