import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation } from "../db/pg-errors.js";
import { notifications, uploads } from "../db/schema.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";

export type UploadFinishedOutcome = "created" | "exists" | "not_found" | "not_uploader" | "no_access";

/**
 * Read access is enough: the row only points the uploader back at a note, and the list hides it once the note can't be read. The block's
 * contents aren't checked (that needs the live document); a false report only notifies the caller.
 */
export async function recordUploadFinished(db: Db, input: { userId: string; uploadId: string; blockId: string }): Promise<UploadFinishedOutcome> {
  if (!UUID_RE.test(input.uploadId)) return "not_found";
  const [row] = await db
    .select({ noteId: uploads.noteId, uploaderId: uploads.uploaderId })
    .from(uploads)
    .where(eq(uploads.id, input.uploadId.toLowerCase()))
    .limit(1);
  if (!row) return "not_found";
  if (row.uploaderId !== input.userId) return "not_uploader";
  if (!(await resolveNoteAccess(db, input.userId, row.noteId)).permissions.read) return "no_access";
  try {
    const inserted = await db
      .insert(notifications)
      .values({
        userId: input.userId,
        kind: "upload_finished",
        noteId: row.noteId,
        uploadId: input.uploadId.toLowerCase(),
        blockId: input.blockId,
        actorId: input.userId,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return inserted.length > 0 ? "created" : "exists";
  } catch (err) {
    // The note or the upload was deleted after the checks above.
    if (isForeignKeyViolation(err)) return "not_found";
    throw err;
  }
}
