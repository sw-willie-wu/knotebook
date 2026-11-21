// Lock order for every write in a group's tag space: the group's row KEY SHARE first. Group delete and transfer take the group FOR UPDATE and
// then its notes; the cascade of deleting the group reaches the tag rows last, so a tag write that locked a tag or a note before the group
// would cycle with them (40P01). A personal space has no group to lock.
// A merge then takes the two tag rows FOR UPDATE (by name_key, as every path that locks several tag rows does) and the notes carrying the source tag FOR KEY SHARE (by id). A delete does the same for its tag, so it queues behind a purge or move that holds the notes before it removes any `note_tags` row. A note move holds its
// row FOR UPDATE, so a note that leaves the space while we wait drops out of the lock set and out of the copy.
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { normalizeTagName, type SpaceTagDto, type TagColor } from "@knotebook/shared";
import { uniqueViolationConstraint } from "../../db/pg-errors.js";
import type { Tx } from "../../db/tx.js";
import { groups, noteTags, notes, tags } from "../../db/schema.js";
import { listSpaceTags } from "../queries.js";
import { tagSpaceWhere, type TagSpace } from "../space.js";

async function lockSpaceGroup(tx: Tx, space: TagSpace): Promise<boolean> {
  if (space.kind === "personal") return true;
  const [group] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, space.groupId)).for("key share");
  return group !== undefined;
}

function noteSpaceWhere(space: TagSpace) {
  return space.kind === "personal" ? eq(notes.ownerId, space.ownerId) : eq(notes.groupId, space.groupId);
}

/** KEY SHARE conflicts with the FOR UPDATE a note purge or move holds, so the cascade over `note_tags` never runs against a writer that deletes the same rows in another order. */
async function lockNotesCarryingTag(tx: Tx, tagId: string, space: TagSpace): Promise<void> {
  await tx
    .select({ id: notes.id })
    .from(notes)
    .innerJoin(noteTags, eq(noteTags.noteId, notes.id))
    .where(and(eq(noteTags.tagId, tagId), noteSpaceWhere(space)))
    .orderBy(asc(notes.id))
    .for("key share", { of: notes });
}

const NAME_INDEXES = new Set(["tags_owner_name_idx", "tags_group_name_idx"]);

/** The unique index on (space, lower(name)) refuses a duplicate name; the error aborts the transaction, so the caller catches it outside. */
export function isTagNameTaken(err: unknown): boolean {
  const constraint = uniqueViolationConstraint(err);
  return constraint !== null && NAME_INDEXES.has(constraint);
}

export type UpdateTagResult = { kind: "ok"; tag: SpaceTagDto } | { kind: "not_found" } | { kind: "invalid_tag_name" };

/** Throws the unique violation (see `isTagNameTaken`) when another tag in the space has the name. */
export async function updateTagInTx(tx: Tx, input: { tagId: string; space: TagSpace; name?: string; color?: TagColor }): Promise<UpdateTagResult> {
  const set: { name?: string; color?: TagColor } = {};
  if (input.name !== undefined) {
    const name = normalizeTagName(input.name);
    if (name === null) return { kind: "invalid_tag_name" };
    set.name = name;
  }
  if (input.color !== undefined) set.color = input.color;
  if (!(await lockSpaceGroup(tx, input.space))) return { kind: "not_found" };

  // drizzle throws on `.set({})` before it reaches the database.
  if (Object.keys(set).length > 0) {
    const rows = await tx
      .update(tags)
      .set(set)
      .where(and(eq(tags.id, input.tagId), tagSpaceWhere(input.space)))
      .returning({ id: tags.id });
    if (rows.length === 0) return { kind: "not_found" };
  }
  const [tag] = await listSpaceTags(tx, input.space, input.tagId);
  return tag === undefined ? { kind: "not_found" } : { kind: "ok", tag };
}

/** Rows in `note_tags` go with the tag through the foreign key. */
export async function deleteTagInTx(tx: Tx, input: { tagId: string; space: TagSpace }): Promise<boolean> {
  if (!(await lockSpaceGroup(tx, input.space))) return false;
  const [tag] = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.id, input.tagId), tagSpaceWhere(input.space))).for("update");
  if (tag === undefined) return false;
  await lockNotesCarryingTag(tx, input.tagId, input.space);
  const rows = await tx
    .delete(tags)
    .where(and(eq(tags.id, input.tagId), tagSpaceWhere(input.space)))
    .returning({ id: tags.id });
  return rows.length > 0;
}

/**
 * Moves every note of the space from `sourceId` to `targetId`, then deletes the source. The target keeps its own name and color;
 * a copied row keeps the source row's `created_at`, so on a note that had only the source the tag keeps its place, and on a note that had
 * both the target keeps the place it had. Trashed notes take part: their tags return on restore. Returns the target as it is after the merge.
 */
export async function mergeTagsInTx(
  tx: Tx,
  input: { sourceId: string; targetId: string; space: TagSpace },
): Promise<{ kind: "ok"; tag: SpaceTagDto } | { kind: "not_found" }> {
  const { sourceId, targetId, space } = input;
  if (!(await lockSpaceGroup(tx, space))) return { kind: "not_found" };
  const locked = await tx
    .select({ id: tags.id })
    .from(tags)
    .where(and(inArray(tags.id, [sourceId, targetId]), tagSpaceWhere(space)))
    .orderBy(sql`${tags.nameKey} collate "C"`)
    .for("update");
  if (locked.length !== 2) return { kind: "not_found" };

  await lockNotesCarryingTag(tx, sourceId, space);

  // Another statement, another snapshot: a note moved out while we waited above no longer matches the space condition.
  await tx.execute(sql`
    insert into ${noteTags} (note_id, tag_id, created_at)
    select nt.note_id, ${targetId}::uuid, nt.created_at
    from ${noteTags} nt join ${notes} on "notes"."id" = nt.note_id
    where nt.tag_id = ${sourceId}::uuid and ${space.kind === "personal" ? sql`"notes"."owner_id" = ${space.ownerId}` : sql`"notes"."group_id" = ${space.groupId}`}
    on conflict do nothing`);
  await tx.delete(tags).where(and(eq(tags.id, sourceId), tagSpaceWhere(space)));
  const [tag] = await listSpaceTags(tx, space, targetId);
  return tag === undefined ? { kind: "not_found" } : { kind: "ok", tag };
}
