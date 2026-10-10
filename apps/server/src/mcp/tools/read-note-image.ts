/**
 * #200 §7：`read_note_image(note_id, upload_id)`。collab 閘門**外**、讀寫／唯讀／session 都註冊（只讀 DB 與磁碟）；
 * 描述依 `authKind` 二選一（session 沒有 `create_transfer_token`）。
 * 流程（§7.3，Q3 放寬規則＝對齊 `GET /api/uploads/:id`）：`authorizeNoteRead`（none → not_found、扣 contentRead、token 路徑 touch presence）
 * → 查上傳列 → 上傳屬別篇時再 `resolveRole(上傳所屬筆記)`，none → 同一個 not_found → 上限 → 讀檔（ENOENT → 同一個 not_found）。
 * 「查無／讀不到所屬筆記／檔案不在」三者**在 MCP 內**同一句，不洩漏存在性（REST 的 403／404 區分是既有取捨，不在此宣稱）。
 */
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
/** #200 §7.2（M11）：裸 UUID 或恰為 `/api/uploads/<uuid>`；NUL 守衛（今天被 regex 蓋住，同 NOTE_ID 的第二道）；transform 去前綴並小寫。 */
export const UPLOAD_ID = z
  .string()
  .regex(UPLOAD_ID_RE)
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

const NOT_READABLE_MESSAGE = "No readable image with that id. It may not exist, or it may belong to a note you can't read.";

function tooLarge(ctx: McpToolCtx, bytes: number, noteId: string): CallToolResult {
  const head = `This image is ${bytes} bytes; read_note_image returns images up to ${MCP_IMAGE_MAX_BYTES} bytes.`;
  const tail = ctx.authKind === "token"
    ? ` Download it with create_transfer_token (purpose "download") for note ${noteId}.`
    : " Open it in the browser instead.";
  // 回上傳**真正所屬**的 noteId：download transfer token 綁在那一篇（§7.3-4）。
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
  // Q3 放寬：上傳屬別篇時，呼叫者也要讀得到那一篇（＝瀏覽器 GET /api/uploads/:id 的授權依據）。
  if (row.noteId !== noteId && (await resolveRole(ctx.db, ctx.userId, row.noteId)) === "none") {
    return toolError("not_found", NOT_READABLE_MESSAGE);
  }
  if (row.size > MCP_IMAGE_MAX_BYTES) return tooLarge(ctx, row.size, row.noteId);
  let buf: Buffer;
  try {
    buf = await readFile(uploadFilePath(ctx.uploadsDir, row.id));
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw err;
    ctx.log.error({ uploadId: row.id }, "read_note_image：上傳列在、檔案不在磁碟");
    return toolError("not_found", NOT_READABLE_MESSAGE);
  }
  if (buf.length > MCP_IMAGE_MAX_BYTES) return tooLarge(ctx, buf.length, row.noteId); // DB size 與實檔不符
  const meta = { noteId: row.noteId, uploadId: row.id, mimeType: row.mime as z.infer<typeof readNoteImageOutput.mimeType>, bytes: buf.length };
  return toolResultWithImage(meta, { data: buf.toString("base64"), mimeType: row.mime });
}
