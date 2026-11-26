/** The note is locked `FOR KEY SHARE` explicitly (the same lock the INSERT's FK takes anyway, just earlier) before the space lock, and the space is the one read inside the transaction (the precheck may predate a move). The route unlinks both the temp and the final file if this throws. */
import { rename } from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { notes, uploads } from "../../db/schema.js";
import type { GroupTestHook } from "../../groups/test-hook.js";
import { TxAbort } from "../../http/tx-abort.js";
import { accessQuery, noteAccessFromRow } from "../../notes/service.js";
import { spaceOfNote } from "../../storage/space.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";

export interface InsertUploadInput {
  id: string;
  /** Already through `UUID_RE` and lowercased. */
  noteId: string;
  uploaderId: string;
  mime: string;
  size: number;
  /** Already through `sanitizeUploadFileName`. */
  fileName: string | null;
  tempPath: string;
  finalPath: string;
  lockTimeoutMs: number;
}

export async function insertUploadInTx(tx: Tx, input: InsertUploadInput, hook?: GroupTestHook): Promise<void> {
  const [note] = await tx
    .select({ ownerId: notes.ownerId, groupId: notes.groupId })
    .from(notes)
    .where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt)))
    .for("key share");
  // Trashing takes `FOR UPDATE` first, which conflicts with this KEY SHARE; if it commits first the re-evaluated `deleted_at IS NULL` fails and this is a 404.
  if (!note) throw new TxAbort(404, "not_found", "No note with that id.");
  // A long upload gives a share or group role plenty of time to change after the preHandler's check.
  const access = noteAccessFromRow((await accessQuery(tx, input.uploaderId, input.noteId))[0], input.uploaderId);
  if (access.role === "none") throw new TxAbort(404, "not_found", "No note with that id.");
  if (access.role === "viewer") throw new TxAbort(403, "forbidden", "You don't have edit access to this note.");
  await assertSpaceRoomInTx(tx, spaceOfNote(note), input.size, { lockTimeoutMs: input.lockTimeoutMs, hook, hookCtx: { noteId: input.noteId } });
  // charged_to_id = uploader, also for personal notes (the personal space ignores it; `notes/tx/move.ts` overwrites it on a move into a group).
  await tx.insert(uploads).values({
    id: input.id, noteId: input.noteId, uploaderId: input.uploaderId, chargedToId: input.uploaderId, mime: input.mime, size: input.size, fileName: input.fileName,
  });
  // Before commit, so a failed rename rolls the row back and a committed row always has its file.
  await rename(input.tempPath, input.finalPath);
}
