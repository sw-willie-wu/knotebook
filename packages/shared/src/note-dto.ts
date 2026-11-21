import type { NoteGroupDto } from "./groups.js";
import type { AvatarRef } from "./avatar.js";
import type { NoteTagDto } from "./tags.js";

export type Role = "owner" | "editor" | "viewer" | "none";

export interface NoteDto {
  id: string;
  title: string;
  /** Exactly one of `owner_id`/`group_id` is non-null (DB `notes_owner_xor_group_chk`). */
  ownerId: string | null;
  /** Always `"editor"` or `"viewer"` for group notes, never `"owner"`. */
  role: Role;
  createdAt: string;
  updatedAt: string;
  slug: string;
  /** Always the owner's, even in an editor's PATCH response. */
  ownerHandle: string | null;
  /** Duplicates `group?.id` so `canonicalNotePath(note)` can build both URL forms. */
  groupId: string | null;
  /** false: slug follows title changes; true: title changes leave it. */
  slugIsCustom: boolean;
  /** Redirect source for by-path misses; one level only, recorded only for custom slug changes. */
  prevSlug: string | null;
  lastEdited: LastEditedDto | null;
  group: NoteGroupDto | null;
  /** Web must use this, not `role === "owner"`. */
  permissions: NotePermissions;
  /** For notes shared with the caller, the caller's own placement; the owner's folder is never exposed. null = root. */
  folderId: string | null;
  /** Yjs state plus attachments, bytes; sort key only, sent only by GET /api/notes. */
  sizeBytes?: number;
  /** Sent only by GET /api/notes, in the order they were added. */
  tags?: NoteTagDto[];
}

export interface NotePermissions {
  read: boolean;
  edit: boolean;
  delete: boolean;
  manageShares: boolean;
  managePublicLink: boolean;
  changeSlug: boolean;
  moveToGroup: boolean;
}

// Fingerprints are an optimistic-concurrency check, not a security boundary, and only the server computes them.
// blockIds are server-internal and deliberately not on these DTOs.
export interface NoteOutlineEntry {
  /** TOP_SECTION_ID ("_top") for the first section, else the heading block's id. */
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  fingerprint: string;
}
/** `byHandle` is the editor's handle, not the owner's; a non-null `agentLabel` means it was written through a token. */
export interface LastEditedDto {
  at: string;
  byHandle: string;
  agentLabel: string | null;
}
export interface NoteContentDto {
  markdown: string;
  fingerprint: string;
  outline: NoteOutlineEntry[];
  lastEdited: LastEditedDto | null;
}
export interface NoteSectionDto {
  section: Omit<NoteOutlineEntry, "sectionId"> & { id: string; markdown: string };
  lastEdited: LastEditedDto | null;
}

/** No `revert`: that op is only produced by `POST …/edits/:editId/revert`. */
export type EditOp = "replace_all" | "replace_section" | "insert_after" | "append" | "delete_section";
/** `fingerprint`/`outline` describe the merged note, so they can serve as the next `if_match` without a re-read. */
export interface NoteEditResultDto {
  editId: string;
  fingerprint: string;
  outline: NoteOutlineEntry[];
  /** [[…]] links in this write that matched no unique note and stayed plain text. */
  unboundWikilinks: number;
  /** Only present when the write kept, created, removed or renewed knowledge info, or ignored a knowledge comment. */
  knowledge?: NoteKnowledgeReportDto;
}
export interface NoteKnowledgeRefDto {
  id: string;
  heading: string;
}
export interface NoteKnowledgeReportDto {
  /** Headings sent without a comment that kept the knowledge info of the heading they replaced. */
  kept: NoteKnowledgeRefDto[];
  created: NoteKnowledgeRefDto[];
  /** Knowledge info that was in the replaced or deleted range and is no longer anywhere in the note. */
  removed: NoteKnowledgeRefDto[];
  /** Knowledge whose id another heading already had, so it got a new one; `from` is the id it had. */
  renewed: Array<NoteKnowledgeRefDto & { from: string }>;
  /** Knowledge comments that were not right after a top-level heading. */
  ignoredComments: number;
}

/** The server keeps at most this many AI edit rows per note; web help text quotes it. */
export const AI_EDITS_RETENTION = 100;

// `revertable` is false for revert rows (never revertable), already-reverted rows, a target whose fingerprint no longer
// matches, a `delete_section` whose anchor block is gone, and once a deleted section has been restored (its
// `before_blocks` are back at top level): revert takes no `if_match`, so that last case is its idempotency guard.
export interface NoteEditDto {
  id: string;
  /** file_sync = one row per changed region of a file write-back; web shows op literals untranslated. */
  op: EditOp | "revert" | "file_sync";
  sectionId: string | null;
  /** "" if the section is gone (deleted or renamed). */
  heading: string;
  byHandle: string;
  /** null for cookie writes. */
  agentLabel: string | null;
  /** The writer's current avatar (token rows too); null if none, or the display image isn't generated yet. */
  avatar: AvatarRef | null;
  createdAt: string;
  revertedAt: string | null;
  revertOf: string | null;
  revertable: boolean;
}

// Kept separate from Role: note_shares_role_chk allows only editor/viewer ('none' is only resolveRole's sentinel).
export type ShareRole = "editor" | "viewer";

export interface ShareDto {
  userId: string;
  email: string;
  displayName: string;
  role: ShareRole;
  avatar: AvatarRef | null;
}
