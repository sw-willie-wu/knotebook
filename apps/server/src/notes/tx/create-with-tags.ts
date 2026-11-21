/**
 * Takes only `tx` and plain data; the caller's `.transaction(` callback is one call to this. The note row and its tags commit together:
 * a tags problem throws, which rolls the insert back, so a refused file leaves no note behind. The insert takes the group's row KEY SHARE
 * through its foreign key before the tag locks, the same order every tags writer uses.
 */
import type { Tx } from "../../db/tx.js";
import type { notes } from "../../db/schema.js";
import { setNoteTagsByNamesInTx } from "../../tags/tx/note-tags.js";
import { insertNoteWithAutoSlug } from "../create.js";
import type { SlugScope } from "../slug.js";

export class CreateTagsError extends Error {
  override name = "CreateTagsError";
  constructor(readonly kind: "invalid_tag_name" | "tag_limit_reached" | "not_found" | "conflict", readonly limit = 0) {
    super(`creating the note with its tags failed: ${kind}`);
  }
}

export interface CreateWithTagsInput {
  scope: SlugScope;
  folderId: string | null;
  title: string | undefined;
  names: readonly string[];
  createdBy: string;
}

export async function createNoteWithTagsInTx(tx: Tx, input: CreateWithTagsInput): Promise<typeof notes.$inferSelect> {
  const note = await insertNoteWithAutoSlug(tx, { scope: input.scope, folderId: input.folderId }, input.title, undefined, { inTx: true });
  const out = await setNoteTagsByNamesInTx(tx, { noteId: note.id, expected: { ownerId: note.ownerId, groupId: note.groupId }, names: input.names, createdBy: input.createdBy });
  if (out.kind === "tag_limit_reached") throw new CreateTagsError(out.kind, out.limit);
  if (out.kind !== "ok") throw new CreateTagsError(out.kind);
  return note;
}
