// Authorization happens outside the transaction; the note's space is confirmed again here with FOR KEY SHARE. Every path that changes
// a note's space first takes FOR UPDATE on the note row (note move, group delete), which conflicts with KEY SHARE, so the space can't
// change between this check and the writes below. A content save updates non-key columns under FOR NO KEY UPDATE, which is compatible
// with KEY SHARE, so tagging never waits for a save.
// Lock order: the group's row KEY SHARE, then the note row KEY SHARE (a personal note has no first lock). Creating a group tag inserts a row
// whose foreign key takes KEY SHARE on the group; if the note were locked first, that would cycle (40P01) with group delete and transfer,
// which take the group FOR UPDATE and then its notes. Same shape as notes/tx/copy.ts.
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import {
  normalizeTagName,
  pickTagColor,
  TAGS_PER_NOTE_MAX,
  TAGS_PER_SPACE_MAX,
  type NoteTagDto,
  type TagColor,
} from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { groups, noteTags, notes, tags } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { loadNoteTags } from "../queries.js";
import { tagSpaceOf, tagSpaceWhere, type TagSpace } from "../space.js";

export type NoteTagsResult =
  | { kind: "ok"; tags: NoteTagDto[] }
  | { kind: "invalid_tag_name"; name: string }
  | { kind: "tag_limit_reached"; limit: number }
  | { kind: "not_found" }
  | { kind: "conflict" };

export interface ExpectedNoteSpace {
  ownerId: string | null;
  groupId: string | null;
}

export async function lockNoteTagSpaceInTx(tx: Tx, noteId: string, expected: ExpectedNoteSpace): Promise<TagSpace | "not_found" | "conflict"> {
  if (expected.groupId !== null) {
    const [group] = await tx.select({ id: groups.id }).from(groups).where(eq(groups.id, expected.groupId)).for("key share");
    if (!group) return "not_found";
  }
  const [row] = await tx
    .select({ ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(and(eq(notes.id, noteId), isNull(notes.deletedAt)))
    .for("key share");
  if (!row) return "not_found";
  if (row.ownerId !== expected.ownerId || row.groupId !== expected.groupId) return "conflict";
  return tagSpaceOf(row);
}

/** The key is computed by the database: JS and PostgreSQL lower-casing disagree for some characters (a word-final capital sigma). */
async function nameKeyOf(tx: Tx, name: string): Promise<string> {
  const res = await tx.execute<{ k: string }>(sql`select lower(${name}) as k`);
  return res.rows[0]!.k;
}

async function findTagByKey(tx: Tx, space: TagSpace, key: string): Promise<{ id: string; color: TagColor } | null> {
  const [row] = await tx
    .select({ id: tags.id, color: tags.color })
    .from(tags)
    .where(and(tagSpaceWhere(space), eq(tags.nameKey, key)));
  return row ?? null;
}

/** Colors of the space's tags, one entry per tag (what `pickTagColor` counts). */
async function usedColors(tx: Tx, space: TagSpace): Promise<string[]> {
  const rows = await tx
    .select({ color: tags.color, n: sql<number>`count(*)::int` })
    .from(tags)
    .where(tagSpaceWhere(space))
    .groupBy(tags.color);
  return rows.flatMap(r => Array.from({ length: r.n }, () => r.color));
}

/** Not `do nothing` + select: a concurrent delete would leave nothing to read. `do update` locks the row and always returns its id; the existing spelling is kept. */
export async function upsertTag(tx: Tx, space: TagSpace, name: string, color: TagColor, createdBy: string): Promise<string> {
  const base = { name, color, createdBy };
  const [row] =
    space.kind === "personal"
      ? await tx
          .insert(tags)
          .values({ ...base, ownerId: space.ownerId })
          .onConflictDoUpdate({ target: [tags.ownerId, tags.nameKey], targetWhere: sql`${tags.ownerId} is not null`, set: { name: sql`${tags.name}` } })
          .returning({ id: tags.id })
      : await tx
          .insert(tags)
          .values({ ...base, groupId: space.groupId })
          .onConflictDoUpdate({ target: [tags.groupId, tags.nameKey], targetWhere: sql`${tags.groupId} is not null`, set: { name: sql`${tags.name}` } })
          .returning({ id: tags.id });
  return row!.id;
}

/** Only tags of the note's own space count; leftovers from an older move don't. */
async function attachedTagIds(tx: Tx, noteId: string, space: TagSpace): Promise<string[]> {
  const rows = await tx
    .select({ id: noteTags.tagId })
    .from(noteTags)
    .innerJoin(tags, eq(tags.id, noteTags.tagId))
    .where(and(eq(noteTags.noteId, noteId), tagSpaceWhere(space)));
  return rows.map(r => r.id);
}

async function finish(tx: Tx, noteId: string): Promise<NoteTagsResult> {
  return { kind: "ok", tags: await loadNoteTags(tx, noteId) };
}

export async function addNoteTagInTx(
  tx: Tx,
  input: { noteId: string; expected: ExpectedNoteSpace; name: string; createdBy: string },
  hook?: GroupTestHook,
): Promise<NoteTagsResult> {
  const name = normalizeTagName(input.name);
  if (name === null) return { kind: "invalid_tag_name", name: input.name };
  const space = await lockNoteTagSpaceInTx(tx, input.noteId, input.expected);
  if (typeof space === "string") return { kind: space };
  await hook?.("tag-note-locked", { noteId: input.noteId });

  const existing = await findTagByKey(tx, space, await nameKeyOf(tx, name));
  const attached = await attachedTagIds(tx, input.noteId, space);
  if (existing !== null && attached.includes(existing.id)) return finish(tx, input.noteId);
  if (attached.length >= TAGS_PER_NOTE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_NOTE_MAX };

  const used = existing === null ? await usedColors(tx, space) : [];
  if (existing === null && used.length >= TAGS_PER_SPACE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_SPACE_MAX };
  const tagId = await upsertTag(tx, space, name, existing?.color ?? pickTagColor(used), input.createdBy);
  await tx.insert(noteTags).values({ noteId: input.noteId, tagId }).onConflictDoNothing();
  return finish(tx, input.noteId);
}

export async function removeNoteTagInTx(tx: Tx, input: { noteId: string; expected: ExpectedNoteSpace; tagId: string }): Promise<NoteTagsResult> {
  const space = await lockNoteTagSpaceInTx(tx, input.noteId, input.expected);
  if (typeof space === "string") return { kind: space };
  await tx.delete(noteTags).where(and(eq(noteTags.noteId, input.noteId), eq(noteTags.tagId, input.tagId)));
  return finish(tx, input.noteId);
}

/**
 * Replaces the note's tags with the named ones. Nothing is written unless every check passes, but it never throws: a non-ok result
 * still lets the transaction commit, so a caller that wants the whole operation rolled back has to throw itself.
 * Names are handled one by one (a single multi-row upsert fails when two names share a `name_key`).
 */
export async function setNoteTagsByNamesInTx(
  tx: Tx,
  input: { noteId: string; expected: ExpectedNoteSpace; names: readonly string[]; createdBy: string },
): Promise<NoteTagsResult> {
  const normalized: string[] = [];
  for (const raw of input.names) {
    const name = normalizeTagName(raw);
    if (name === null) return { kind: "invalid_tag_name", name: raw };
    normalized.push(name);
  }
  const space = await lockNoteTagSpaceInTx(tx, input.noteId, input.expected);
  if (typeof space === "string") return { kind: space };

  const wanted: Array<{ name: string; existing: { id: string; color: TagColor } | null }> = [];
  const seen = new Set<string>();
  for (const name of normalized) {
    const key = await nameKeyOf(tx, name);
    if (seen.has(key)) continue;
    seen.add(key);
    wanted.push({ name, existing: await findTagByKey(tx, space, key) });
  }
  if (wanted.length > TAGS_PER_NOTE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_NOTE_MAX };
  const used = await usedColors(tx, space);
  if (used.length + wanted.filter(w => w.existing === null).length > TAGS_PER_SPACE_MAX) {
    return { kind: "tag_limit_reached", limit: TAGS_PER_SPACE_MAX };
  }

  const tagIds: string[] = [];
  for (const w of wanted) {
    let color = w.existing?.color;
    if (color === undefined) {
      color = pickTagColor(used);
      used.push(color);
    }
    tagIds.push(await upsertTag(tx, space, w.name, color, input.createdBy));
  }

  const current = new Set(await attachedTagIds(tx, input.noteId, space));
  if (tagIds.length === 0) {
    await tx.delete(noteTags).where(eq(noteTags.noteId, input.noteId));
  } else {
    await tx.delete(noteTags).where(and(eq(noteTags.noteId, input.noteId), notInArray(noteTags.tagId, tagIds)));
  }
  const added = tagIds.filter(id => !current.has(id));
  if (added.length > 0) {
    // One transaction shares one now(); a millisecond step per new tag keeps the order the names were given in.
    await tx
      .insert(noteTags)
      .values(
        added.map((tagId, i) => ({
          noteId: input.noteId,
          tagId,
          createdAt: sql`date_trunc('milliseconds', now()) + ${i}::int * interval '1 millisecond'`,
        })),
      )
      .onConflictDoNothing();
  }
  return finish(tx, input.noteId);
}
