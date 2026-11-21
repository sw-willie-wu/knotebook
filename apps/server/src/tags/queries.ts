import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { NoteTagDto, SpaceTagDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { noteTags, notes, tags } from "../db/schema.js";
import { groupAccess } from "../groups/queries.js";
import { tagSpaceWhere, type TagSpace } from "./space.js";

/**
 * `visibleNoteBranches` extra column. Outer columns are written as literals: a single-table select renders `${notes.id}` as a bare
 * "id", which inside this subquery would resolve to a `note_tags`/`tags` column. The space comparison drops rows an older move left
 * behind in the wrong space; the `=`/`or` form (a tag has exactly one of owner and group set) plans about twice as fast as `is not distinct from` on a long list.
 */
export function noteTagsJsonSql(): SQL.Aliased<NoteTagDto[]> {
  const outerId = sql.raw('"notes"."id"');
  const outerOwner = sql.raw('"notes"."owner_id"');
  const outerGroup = sql.raw('"notes"."group_id"');
  return sql<NoteTagDto[]>`coalesce((select json_agg(json_build_object('id', t.id, 'name', t.name, 'color', t.color) order by nt.created_at, t.id) from ${noteTags} nt join ${tags} t on t.id = nt.tag_id where nt.note_id = ${outerId} and (t.owner_id = ${outerOwner} or t.group_id = ${outerGroup})), '[]'::json)`.as("tags");
}

/** `visibleNoteBranches` extraWhere: notes carrying every given tag. Ids are lowercased and deduplicated first, so the count compares with the distinct number. */
export function notesHavingAllTagsSql(tagIds: readonly string[]): SQL | undefined {
  const unique = [...new Set(tagIds.map(id => id.toLowerCase()))];
  if (unique.length === 0) return undefined;
  const outerId = sql.raw('"notes"."id"');
  const outerOwner = sql.raw('"notes"."owner_id"');
  const outerGroup = sql.raw('"notes"."group_id"');
  const idList = sql.join(unique.map(id => sql`${id}`), sql`, `);
  return sql`(select count(*)::int from ${noteTags} nt join ${tags} t on t.id = nt.tag_id where nt.note_id = ${outerId} and nt.tag_id in (${idList}) and t.owner_id is not distinct from ${outerOwner} and t.group_id is not distinct from ${outerGroup}) = ${unique.length}`;
}

/** Sorted by `name_key` (lower-cased), then id. `noteCount` skips trashed notes and notes whose space differs from the tag's. */
export async function listSpaceTags(db: DbOrTx, space: TagSpace, onlyTagId?: string): Promise<SpaceTagDto[]> {
  // Outer columns are literals: in a single-table select `${tags.id}` renders as a bare "id", which the subquery would resolve to its own table.
  const [outerId, outerOwner, outerGroup] = [sql.raw('"tags"."id"'), sql.raw('"tags"."owner_id"'), sql.raw('"tags"."group_id"')];
  const noteCount = sql<number>`(select count(*)::int from ${noteTags} nt join ${notes} n on n.id = nt.note_id where nt.tag_id = ${outerId} and n.deleted_at is null and n.owner_id is not distinct from ${outerOwner} and n.group_id is not distinct from ${outerGroup})`;
  const rows = await db
    .select({ id: tags.id, name: tags.name, color: tags.color, noteCount })
    .from(tags)
    .where(onlyTagId === undefined ? tagSpaceWhere(space) : and(tagSpaceWhere(space), eq(tags.id, onlyTagId)))
    .orderBy(asc(tags.nameKey), asc(tags.id));
  return rows;
}

/** In the order the tags were added. Rows from another space than the note's are left out. */
export async function loadNoteTags(db: DbOrTx, noteId: string): Promise<NoteTagDto[]> {
  const sameNoteAndSpace = and(eq(notes.id, noteTags.noteId), sql`${tags.ownerId} is not distinct from ${notes.ownerId}`, sql`${tags.groupId} is not distinct from ${notes.groupId}`);
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(noteTags)
    .innerJoin(tags, eq(tags.id, noteTags.tagId))
    .innerJoin(notes, sameNoteAndSpace)
    .where(eq(noteTags.noteId, noteId))
    .orderBy(asc(noteTags.createdAt), asc(tags.id));
}

export async function loadNoteTagNames(db: DbOrTx, noteId: string): Promise<string[]> {
  return (await loadNoteTags(db, noteId)).map(t => t.name);
}


/**
 * Who may rename, recolor, merge or delete a tag. A tag the caller can't see answers `not_found` like one that doesn't exist: a personal tag
 * is its owner's alone (a site admin included), a group's tag needs a group the caller belongs to or administers site-wide.
 */
export async function resolveTagManageAccess(
  db: DbOrTx,
  tagId: string,
  user: { id: string; isAdmin: boolean },
): Promise<{ kind: "ok"; space: TagSpace } | { kind: "not_found" } | { kind: "forbidden" }> {
  const [row] = await db.select({ ownerId: tags.ownerId, groupId: tags.groupId }).from(tags).where(eq(tags.id, tagId));
  if (!row) return { kind: "not_found" };
  if (row.groupId === null) {
    return row.ownerId === user.id ? { kind: "ok", space: { kind: "personal", ownerId: user.id } } : { kind: "not_found" };
  }
  const access = await groupAccess(db, row.groupId, user);
  if (!access) return { kind: "not_found" };
  return access.manageGroup ? { kind: "ok", space: { kind: "group", groupId: row.groupId } } : { kind: "forbidden" };
}
