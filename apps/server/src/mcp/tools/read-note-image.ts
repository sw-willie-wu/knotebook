/** Outside the collab gate and registered for every credential (reads only DB and disk); the description depends on `authKind` because a session has no `create_transfer_token`. "No such upload", "not a readable image", "can't read its note" and "file missing" share one sentence within MCP so existence and file type aren't leaked (REST's 403/404 split is a pre-existing tradeoff). */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { uploads } from "../../db/schema.js";
import { NOTE_ID, noNul } from "../../notes/schemas.js";
import { resolveRole } from "../../notes/service.js";
import { uploadFilePath } from "../../uploads/service.js";
import { MCP_IMAGE_MAX_BYTES } from "../limits.js";
import { authorizeNoteRead } from "../note-read.js";
import { toolError, toolResultWithImage } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

const UPLOAD_ID_RE = /^(?:\/api\/uploads\/)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const UPLOAD_ID = z
  .string()
  .regex(UPLOAD_ID_RE)
  // Redundant with the regex today; a second layer, like `NOTE_ID`.
  .refine(noNul)
  .transform(s => UPLOAD_ID_RE.exec(s)![1]!.toLowerCase());

export const READ_NOTE_IMAGE_DESCRIPTION_TOKEN =
  "Look at an image in a note. Pass the id from `/api/uploads/<id>` in read_note_section's markdown. Images up to " +
  `${MCP_IMAGE_MAX_BYTES} bytes come back as an image; larger ones are refused — download those with create_transfer_token instead.`;
export const READ_NOTE_IMAGE_DESCRIPTION_SESSION =
  "Look at an image in a note. Pass the id from `/api/uploads/<id>` in read_note_section's markdown. Images up to " +
  `${MCP_IMAGE_MAX_BYTES} bytes come back as an image; larger ones are refused.`;

export const readNoteImageInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  upload_id: UPLOAD_ID.describe("The id in `/api/uploads/<id>`."),
};
export const readNoteImageOutput = {
  noteId: z.string(),
  uploadId: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  bytes: z.number(),
};

const NOT_READABLE_MESSAGE = "No readable image with that id. It may not exist, may not be a PNG, JPEG, GIF or WebP image, or may belong to a note you can't read.";

/** `noteId` is the note the upload belongs to, not the requested one: a download transfer token is bound to it. */
function tooLarge(ctx: McpToolCtx, bytes: number, noteId: string): CallToolResult {
  const head = `This image is ${bytes} bytes; read_note_image returns images up to ${MCP_IMAGE_MAX_BYTES} bytes.`;
  const tail = ctx.authKind === "token"
    ? ` Download it with create_transfer_token (purpose "download") for note ${noteId}.`
    : " Open it in the browser instead.";
  return toolError("file_too_large", head + tail, { noteId, bytes });
}

export async function readNoteImage(args: { note_id: string; upload_id: string }, ctx: McpToolCtx): Promise<CallToolResult> {
  const access = await authorizeNoteRead(ctx, args.note_id, undefined);
  if (!access.ok) return access.error;
  const noteId = args.note_id.toLowerCase();
  const [row] = await ctx.db
    .select({ id: uploads.id, noteId: uploads.noteId, mime: uploads.mime, size: uploads.size })
    .from(uploads)
    .where(eq(uploads.id, args.upload_id));
  if (!row) return toolError("not_found", NOT_READABLE_MESSAGE);
  // An upload of another note also needs read access to that note (what `GET /api/uploads/:id` relies on).
  if (row.noteId !== noteId && (await resolveRole(ctx.db, ctx.userId, row.noteId)) === "none") {
    return toolError("not_found", NOT_READABLE_MESSAGE);
  }
  // Same answer as a missing upload, so the reply doesn't tell what kind of file an id is; the output schema lists only these four.
  if (!(readNoteImageOutput.mimeType.options as readonly string[]).includes(row.mime)) return toolError("not_found", NOT_READABLE_MESSAGE);
  if (row.size > MCP_IMAGE_MAX_BYTES) return tooLarge(ctx, row.size, row.noteId);
  let buf: Buffer;
  try {
    buf = await readFile(uploadFilePath(ctx.uploadsDir, row.id));
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    ctx.log.error({ uploadId: row.id }, "read_note_image：上傳列在、檔案不在磁碟");
    return toolError("not_found", NOT_READABLE_MESSAGE);
  }
  if (buf.length > MCP_IMAGE_MAX_BYTES) return tooLarge(ctx, buf.length, row.noteId); // DB size and the real file disagree
  const meta = { noteId: row.noteId, uploadId: row.id, mimeType: row.mime as z.infer<typeof readNoteImageOutput.mimeType>, bytes: buf.length };
  return toolResultWithImage(meta, { data: buf.toString("base64"), mimeType: row.mime });
}
