// Tags are matched across spaces by `name_key`: the target's tag wins when it exists (name and color), otherwise one is created with the source's color.
// Automatic mapping isn't a user action, so it skips TAGS_PER_SPACE_MAX and the tag-edit permission; each function is one statement.
// Lock order: these run after the caller has locked the note rows (and the target group), so they add no edge to the groups -> notes order.
// They lock tags rows of the target space (and, for a copy, the source tags with KEY SHARE); a tag merge, delete or rename may hold such a row,
// so they can wait for it, but once it is released they need nothing the other side holds.
// The upsert takes the target tags in `name_key` order, so concurrent moves, copies and group hand-overs into one space can't wait on each other in opposite orders.
import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import type { TagSpace } from "../space.js";

const spaceColumn = (space: TagSpace): SQL => sql.raw(space.kind === "personal" ? "owner_id" : "group_id");
const spaceId = (space: TagSpace): string => (space.kind === "personal" ? space.ownerId : space.groupId);

/** `t` is the alias of the tags row. Null columns compare as false so the negation is safe. */
const inSpace = (space: TagSpace): SQL => sql`coalesce(t.${spaceColumn(space)} = ${spaceId(space)}::uuid, false)`;

/** `src` must expose name, color and name_key of the tags to carry; the result has the target tag's id and name_key. */
function upsertIntoTarget(target: TagSpace, createdBy: string, from: SQL): SQL {
  const col = spaceColumn(target);
  return sql`insert into tags (${col}, name, color, created_by)
    select ${spaceId(target)}::uuid, s.name, s.color, ${createdBy}::uuid from ${from} s order by s.name_key
    on conflict (${col}, name_key) where ${col} is not null do update set name = tags.name
    returning id, name_key`;
}

/**
 * Same-space copies share the tag rows; other spaces get the mapped ones. Only tags of the source note's own space are carried.
 * The source tags are locked KEY SHARE before the insert: a merge or delete in flight makes this wait, and a tag it removed is left off the copy
 * instead of failing the insert's foreign key check.
 */
export async function copyNoteTagsInTx(
  tx: Tx,
  input: { sourceNoteId: string; targetNoteId: string; target: TagSpace; createdBy: string },
): Promise<void> {
  await tx.execute(sql`
    with src as (
      select t.id as tag_id, t.name, t.color, t.name_key, nt.created_at, ${inSpace(input.target)} as in_target
      from note_tags nt
      join tags t on t.id = nt.tag_id
      join notes n on n.id = nt.note_id
      where nt.note_id = ${input.sourceNoteId}::uuid and n.deleted_at is null
        and t.owner_id is not distinct from n.owner_id and t.group_id is not distinct from n.group_id
      for key share of t
    ), shared as (
      insert into note_tags (note_id, tag_id, created_at)
      select ${input.targetNoteId}::uuid, tag_id, created_at from src where in_target
    ), mapped as (
      ${upsertIntoTarget(input.target, input.createdBy, sql`(select * from src where not in_target)`)}
    )
    insert into note_tags (note_id, tag_id, created_at)
    select ${input.targetNoteId}::uuid, mapped.id, src.created_at from mapped join src on src.name_key = mapped.name_key and not src.in_target
    on conflict do nothing`);
}

/**
 * Called after the note row already carries the target space, hence the explicit `source`. `created_at` is copied because every row written in one
 * transaction would otherwise share now() and lose the order. Rows pointing at any tag outside the target are dropped, strays included; the old
 * space's tags themselves stay.
 */
export async function moveNoteTagsInTx(
  tx: Tx,
  input: { noteId: string; source: TagSpace; target: TagSpace; createdBy: string },
): Promise<void> {
  if (input.source.kind === input.target.kind && spaceId(input.source) === spaceId(input.target)) return;
  await tx.execute(sql`
    with src as (
      select t.id as tag_id, t.name, t.color, t.name_key, nt.created_at
      from note_tags nt
      join tags t on t.id = nt.tag_id
      where nt.note_id = ${input.noteId}::uuid and ${inSpace(input.source)}
    ), mapped as (
      ${upsertIntoTarget(input.target, input.createdBy, sql`src`)}
    ), dropped as (
      delete from note_tags nt using tags t
      where nt.note_id = ${input.noteId}::uuid and t.id = nt.tag_id and not ${inSpace(input.target)}
    )
    insert into note_tags (note_id, tag_id, created_at)
    select ${input.noteId}::uuid, mapped.id, src.created_at from mapped join src on src.name_key = mapped.name_key
    on conflict do nothing`);
}

/**
 * Must run while the notes still carry the group id: the join on the group's notes is what picks the rows, trashed notes included.
 * The group's own tag rows (and their note_tags) go away with the group.
 */
export async function moveGroupTagsToPersonalInTx(tx: Tx, input: { groupId: string; ownerId: string; createdBy: string }): Promise<void> {
  await tx.execute(sql`
    with mapped as (
      ${upsertIntoTarget({ kind: "personal", ownerId: input.ownerId }, input.createdBy, sql`(select name, color, name_key from tags where group_id = ${input.groupId}::uuid)`)}
    )
    insert into note_tags (note_id, tag_id, created_at)
    select nt.note_id, mapped.id, nt.created_at
    from note_tags nt
    join tags g on g.id = nt.tag_id and g.group_id = ${input.groupId}::uuid
    join notes n on n.id = nt.note_id and n.group_id = ${input.groupId}::uuid
    join mapped on mapped.name_key = g.name_key
    on conflict do nothing`);
}
