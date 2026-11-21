/** What a file's `tags` line asks for, decided with reads only, before anything is written. */
import { sql } from "drizzle-orm";
import { canEditNoteTags, normalizeTagName, TAGS_PER_NOTE_MAX, TAGS_PER_SPACE_MAX } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { tags } from "../db/schema.js";
import type { NoteAccess } from "../notes/service.js";
import { loadNoteTagNames } from "../tags/queries.js";
import { tagSpaceOf, tagSpaceWhere, type TagSpace } from "../tags/space.js";
import { hmacOf } from "./base-hash.js";
import { tagsKeyOf } from "./note-tags-format.js";

export type TagsPlan =
  | { kind: "unchanged" }
  | { kind: "change"; names: string[]; currentKey: string; fileSha: Buffer }
  | { kind: "note_changed" }
  | { kind: "invalid_tag_name" }
  | { kind: "tag_limit_reached"; limit: number }
  | { kind: "tags_forbidden" };

/** Valid names in the order the file gave them, or null when one is invalid. */
export function normalizedTagNames(raw: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const r of raw) {
    const n = normalizeTagName(r);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

/** Existing tags of the space plus the names that don't exist there yet; a name counts by its database lower-casing. */
async function spaceCounts(db: Db, space: TagSpace, names: readonly string[]): Promise<{ total: number; fresh: number }> {
  const list = sql.join(names.map(n => sql`${n}`), sql`, `);
  const res = await db.execute<{ total: number; fresh: number }>(
    sql`select (select count(*)::int from ${tags} where ${tagSpaceWhere(space)}) as total, (select count(distinct lower(n))::int from unnest(array[${list}]::text[]) as n where lower(n) not in (select name_key from ${tags} where ${tagSpaceWhere(space)})) as fresh`,
  );
  return res.rows[0]!;
}

/**
 * `copySha`: the hash of the tags in the copy the file was downloaded as (the last write of this copy, else the download); null for a base made before tags were
 * stored. A file whose tags equal the copy's changes nothing, whatever the note's tags are now: someone changing them in the meantime is not undone.
 */
export async function planTagsWrite(
  db: Db,
  input: { noteId: string; fileTags: string[] | undefined; access: NoteAccess; copySha: Buffer | null; key: Buffer; salt: Buffer },
): Promise<TagsPlan> {
  if (input.fileTags === undefined) return { kind: "unchanged" };
  const names = normalizedTagNames(input.fileTags);
  const fileKey = names === null ? null : tagsKeyOf(names);
  const fileSha = fileKey === null ? null : hmacOf(input.key, input.salt, fileKey);
  if (input.copySha !== null && fileSha !== null && fileSha.equals(input.copySha)) return { kind: "unchanged" };
  const currentKey = tagsKeyOf(await loadNoteTagNames(db, input.noteId));
  if (input.copySha === null && fileKey === currentKey) return { kind: "unchanged" };
  if (input.copySha !== null && !hmacOf(input.key, input.salt, currentKey).equals(input.copySha)) return { kind: "note_changed" };
  if (names === null || fileSha === null) return { kind: "invalid_tag_name" };
  if (new Set(names.map(n => n.toLowerCase())).size > TAGS_PER_NOTE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_NOTE_MAX };
  if (!canEditNoteTags(input.access)) return { kind: "tags_forbidden" };
  if (names.length > 0) {
    const c = await spaceCounts(db, tagSpaceOf(input.access), names);
    if (c.total + c.fresh > TAGS_PER_SPACE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_SPACE_MAX };
  }
  return { kind: "change", names, currentKey, fileSha };
}

/** For a new note: the same checks a write-back makes, minus the ones that need an existing note. */
export async function planNewNoteTags(
  db: Db,
  input: { fileTags: readonly string[]; space: TagSpace },
): Promise<{ kind: "ok"; names: string[] } | { kind: "invalid_tag_name" } | { kind: "tag_limit_reached"; limit: number }> {
  const names = normalizedTagNames(input.fileTags);
  if (names === null) return { kind: "invalid_tag_name" };
  if (new Set(names.map(n => n.toLowerCase())).size > TAGS_PER_NOTE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_NOTE_MAX };
  if (names.length > 0) {
    const c = await spaceCounts(db, input.space, names);
    if (c.total + c.fresh > TAGS_PER_SPACE_MAX) return { kind: "tag_limit_reached", limit: TAGS_PER_SPACE_MAX };
  }
  return { kind: "ok", names };
}
