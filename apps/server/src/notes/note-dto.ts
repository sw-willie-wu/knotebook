import { and, eq, sql, type SQL } from "drizzle-orm";
import type { NoteDto, NoteTagDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { groups, notePlacements, noteStates, notes, uploads, users } from "../db/schema.js";
import { editor, lastEditedSelection } from "./list-query.js";
import type { NoteAccess } from "./service.js";

// Narrow on purpose: the list is a UNION whose branches select only these columns, so both full rows and union rows are accepted. `ownerHandle` isn't on notes (#122): fill points JOIN users (PATCH must return the owner's handle, not the editor's); `editorHandle` comes from a second users alias.
export interface NoteFields {
  id: string;
  title: string;
  ownerId: string | null;
  slug: string;
  slugIsCustom: boolean;
  prevSlug: string | null;
  ownerHandle: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastEditedAt: Date | null;
  lastEditedAgentLabel: string | null;
  editorHandle: string | null;
  groupId: string | null;
  groupName: string | null;
  /** Deliberately not named `folderId`: a spread notes row (PATCH `returning`) can't supply it, so tsc forces every call site; otherwise the owner's folder would reach a sharee. */
  viewerFolderId: string | null;
  sizeBytes?: number;
  tags?: NoteTagDto[];
}

/** `access` is passed in so tsc forces every call site to decide (never hard-code `"owner"`); correctness is pinned by each path's tests. */
export function toNoteDto(note: NoteFields, access: Pick<NoteAccess, "role" | "permissions">): NoteDto {
  return {
    id: note.id,
    title: note.title,
    ownerId: note.ownerId,
    role: access.role,
    slug: note.slug,
    slugIsCustom: note.slugIsCustom,
    prevSlug: note.prevSlug,
    ownerHandle: note.ownerHandle,
    groupId: note.groupId,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    lastEdited: note.lastEditedAt
      ? { at: note.lastEditedAt.toISOString(), byHandle: note.editorHandle ?? "", agentLabel: note.lastEditedAgentLabel }
      : null,
    group: note.groupId !== null && note.groupName !== null ? { id: note.groupId, name: note.groupName } : null,
    permissions: access.permissions,
    folderId: note.viewerFolderId,
    ...(note.sizeBytes !== undefined ? { sizeBytes: note.sizeBytes } : {}),
    ...(note.tags !== undefined ? { tags: note.tags } : {}),
  };
}

function viewerFolderIdSql(viewerId: string) {
  return sql<string | null>`case when ${notes.groupId} is not null or ${notes.ownerId} = ${viewerId} then ${notes.folderId} else ${notePlacements.folderId} end`;
}

export function placementJoinOn(viewerId: string): SQL {
  return and(eq(notePlacements.noteId, notes.id), eq(notePlacements.userId, viewerId))!;
}

/** Group note or caller is owner → `note.folderId`; otherwise the caller's placement. Queries `db`: routes call it only outside the transaction. */
export async function viewerFolderIdFor(
  db: DbOrTx,
  note: { id: string; ownerId: string | null; groupId: string | null; folderId: string | null },
  viewerId: string,
): Promise<string | null> {
  if (note.groupId !== null || note.ownerId === viewerId) return note.folderId;
  const [row] = await db
    .select({ folderId: notePlacements.folderId })
    .from(notePlacements)
    .where(and(eq(notePlacements.noteId, note.id), eq(notePlacements.userId, viewerId)))
    .limit(1);
  return row?.folderId ?? null;
}

/** `sizeBytes` = Yjs state bytes + attachment total. Outer columns are table-qualified: a bare `${notes.id}` renders `"id"` in a single-table select, which inside the `uploads u` subquery resolves to `u.id` and silently miscounts. */
export function noteSizeBytesSql(): SQL.Aliased<number> {
  const outerId = sql.raw('"notes"."id"');
  return sql<number>`(coalesce((select octet_length(s.ydoc) from ${noteStates} s where s.note_id = ${outerId}), 0) + coalesce((select sum(u.size) from ${uploads} u where u.note_id = ${outerId}), 0))`
    .mapWith(Number)
    .as("size_bytes");
}

export function noteFieldsSelection(viewerId: string) {
  return {
    id: notes.id,
    title: notes.title,
    ownerId: notes.ownerId,
    slug: notes.slug,
    slugIsCustom: notes.slugIsCustom,
    prevSlug: notes.prevSlug,
    ownerHandle: users.handle,
    createdAt: notes.createdAt,
    updatedAt: notes.updatedAt,
    ...lastEditedSelection,
    groupId: notes.groupId,
    groupName: groups.name,
    viewerFolderId: viewerFolderIdSql(viewerId),
  };
}

/** No `deleted_at` condition (callers are past the gate); returns undefined if the note was deleted in the race window, and callers answer 404. LEFT JOIN users: group notes have no owner. */
export async function loadNoteFields(db: DbOrTx, noteId: string, viewerId: string): Promise<NoteFields | undefined> {
  const [row] = await db
    .select(noteFieldsSelection(viewerId))
    .from(notes)
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(notePlacements, placementJoinOn(viewerId))
    .where(eq(notes.id, noteId))
    .limit(1);
  return row;
}
