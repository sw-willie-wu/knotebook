/**
 * #200 spec §6 `create_transfer_token`：簽一支短命、單篇、單用途的 transfer token，讓模型用 shell `curl` 上傳一張圖
 * 到筆記（`upload`）或下載筆記的圖（`download`）——MCP 憑證不能從 shell 送，圖片位元組也塞不進工具引數（spec §1.1）。
 *
 * **流程順序是契約**（spec §6.3）：① upload → `requireWriteScope`（扣 `tokenWrite`）② `resolveNoteAccess`（none →
 * not_found 同字串；upload＋viewer → forbidden）③ download → 扣 `contentRead`（不 touch presence：簽 token 不是讀內容）
 * ③a upload → 儲存配額「已滿」預檢（已滿 → storage_quota_exceeded、不簽）④ 交易（`issueTransferTokenInTx`，S14：交易內只有那三句）⑤ 交易外清理（fire-and-forget）→ 結果。
 *
 * **只在 token 路徑註冊**（`register.ts`）：session 沒有母憑證可綁，而經 session 打 `/api/mcp` 的只會是同源瀏覽器，
 * 它本來就能直接用 cookie 上傳與看圖。
 *
 * **密文不進 log**：明文只在這個回應本文裡；SQL 參數只有雜湊；`runTool` 只在例外時 log `{err, tool}`。
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hashToken } from "../../auth/api-token.js";
import { deleteExpiredTransferTokens } from "../../auth/transfer-cleanup.js";
import {
  MAX_PENDING_UPLOAD_TOKENS,
  TRANSFER_TOKENS_EXPIRY_CHK,
  TRANSFER_TOKENS_NOTE_FK,
  generateTransferToken,
} from "../../auth/transfer-token.js";
import {
  issueTransferTokenInTx,
  type IssueTransferTokenInput,
  type IssueTransferTokenResult,
} from "../../auth/tx/issue-transfer-token.js";
import { checkViolationConstraint, isForeignKeyViolation, pgErrorSummary } from "../../db/pg-errors.js";
import { users } from "../../db/schema.js";
import { redactDbError } from "../../lib/redact-db-error.js";
import { NOTE_ID } from "../../notes/schemas.js";
import { resolveNoteAccess } from "../../notes/service.js";
import { formatBytes } from "../../storage/format-bytes.js";
import { spaceOfNote } from "../../storage/space.js";
import { canViewSpaceUsage, isSpaceFull, readSpaceUsage } from "../../storage/usage.js";
import { NOTE_NOT_FOUND_MESSAGE, READ_RATE_LIMITED_MESSAGE } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** spec §6.5 定稿（讀寫版）。逐句依據寫在 spec §6.5；改一個字要回 spec 重驗。 */
export const CREATE_TRANSFER_TOKEN_DESCRIPTION_RW =
  "Get a short-lived token that lets a shell command upload an image to a note or download its images — your MCP " +
  "credential can't be sent that way, and image bytes don't fit in tool arguments. `upload` needs edit access and is " +
  "good for one file; `download` fetches any image uploaded to that note. Tokens expire within 10 minutes (see " +
  "`expiresAt`). The result has a ready `curl` command: send the token only to that address, in the `Authorization` header.";

/** spec §6.5 定稿（唯讀版）：不描述唯讀憑證沒有的 upload。 */
export const CREATE_TRANSFER_TOKEN_DESCRIPTION_RO =
  "Get a short-lived token that lets a shell command download a note's images — your MCP credential can't be sent that " +
  "way, and image bytes don't fit in tool arguments. It fetches any image uploaded to that note. Tokens expire within " +
  "10 minutes (see `expiresAt`). The result has a ready `curl` command: send the token only to that address, in the " +
  "`Authorization` header.";

const NOTE_ID_DESCRIBE = "The note's id, as returned by list_notes or search_notes.";

/** spec §6.1：purpose 的 enum 依憑證二選一。唯讀憑證送 upload → SDK 的輸入驗證錯誤，handler 不跑、不扣 tokenWrite。 */
export const createTransferTokenInputRw = {
  note_id: NOTE_ID.describe(NOTE_ID_DESCRIBE),
  purpose: z.enum(["upload", "download"]).describe("`upload` stores one image for the note (then reference it with edit_note); `download` fetches its images."),
};
export const createTransferTokenInputRo = {
  note_id: NOTE_ID.describe(NOTE_ID_DESCRIBE),
  purpose: z.enum(["download"]).describe("`download` fetches its images."),
};

/** spec §6.4（欄名 camelCase 同既有輸出）；只有 `expiresAt`、`next` 帶 describe（tools/list 的字數預算）。 */
export const createTransferTokenOutput = {
  purpose: z.enum(["upload", "download"]),
  noteId: z.string(),
  token: z.string(),
  expiresAt: z.string().describe("When the token stops working (ISO 8601)."),
  url: z.string(),
  method: z.enum(["POST", "GET"]),
  curl: z.string(),
  next: z.string().describe("What to do with the reply, and what its status codes mean."),
};

/**
 * spec §6.4 upload `next`（定稿全文，含儲存配額那棒加入的兩句 409）。逐句綁定（409 兩句在 `transfer-tokens.test.ts` 的
 * 「× 儲存配額」describe：`storage_quota_exceeded` 由「空間已滿 → 409、token 未消費、騰出後同一支 201」與「放不下 → 交易內
 * 409、token 已燒」兩案綁；`server_busy` 由 55P03 縫那案綁——token 已燒、同一支之後 401、新 token 201）；其餘：
 * 401（T3、T4、T8）；403／429 不燒（T5、T7、T9、T17；per-IP `bearerMiss` 的 429 只取代本來的 401，該次請求同樣沒有
 * 消費——T19b。所以措辭是「這次被拒不會用掉 token」而不是「token 仍未使用」：bearerMiss 那形的 token 可能早已用過）；404 的兩個來源——消費前的角色重驗 none（T9「移除分享 → 404」）
 * 與消費後筆記在上傳途中被刪（T24，真 socket）；413／415 燒（T11、T12；400 亦燒，RF5）。全在 `test/transfer-tokens.test.ts`。
 * （簽發後、上傳前就刪筆記的那一形答 401——token 列已被 cascade 刪，RF1——由「A 401 means the token can't be used」涵蓋。）
 */
export const UPLOAD_NEXT =
  "The reply is JSON `{id, url}`. Put the image in the note with edit_note using markdown `![description](url)`, with " +
  "`url` exactly as returned (`/api/uploads/<id>`, relative). The token is good for one upload until `expiresAt`. A 401 " +
  "means the token can't be used (expired, already used, or revoked) — ask for a new one. A 403 or 429 doesn't use the " +
  "token up (after a 429, wait a moment and retry); a 404 means the note is gone or you can no longer see it. " +
  "A 409 `storage_quota_exceeded` means the note's storage space has no room for this file: don't retry until space has been freed, and then ask for a new token. " +
  "A 409 `server_busy` means the server was busy and the token is used up: ask for a new token and retry. Once the server has started reading the file, a " +
  "rejection (for example 413: too large, 415: not a PNG, JPEG, GIF or WebP image) still uses the token up.";

/**
 * spec §6.4 download `next`。403 的兩個來源（T6 錯筆記、T9 不再可讀）；404（非 UUID、查無此上傳——T21、T21b；DB 有列
 * 但檔案不在磁碟的那形同碼，`uploads.test.ts`）；429 之後等一下、用同一支 token 重試會成功（T21b）。
 */
export const DOWNLOAD_NEXT =
  "Replace `<upload_id>` with the id from `/api/uploads/<id>` in the note's markdown. Any image uploaded to this note " +
  "can be fetched with this token until `expiresAt`. A 401 means the token can't be used — ask for a new one. A 403 " +
  "means this token can't fetch that image: it belongs to another note, or you can no longer read this one. A 404 " +
  "means there is no image with that id. A 429 means too many requests: wait a moment and retry with the same token.";

export const VIEWER_UPLOAD_MESSAGE = "You can read this note but not edit it, so you can't upload images to it.";
export const REVOKED_MESSAGE = "This credential was revoked or expired while the request was being handled.";
/**
 * spec §4.3a 逐字。字串裡的「5」是寫死的字面值：與 `MAX_PENDING_UPLOAD_TOKENS` 的對齊由兩條斷言守——
 * `mcp-transfer.test.ts` M2a 基本形的 `expect(TOO_MANY_PENDING_MESSAGE).toContain(` ${MAX_PENDING_UPLOAD_TOKENS} unused upload tokens`)`
 * 與同案「第 6 支被拒」（常數本身＝5 由 `test/unit/transfer-token.test.ts` 釘）。
 */
export const TOO_MANY_PENDING_MESSAGE =
  "This credential already has 5 unused upload tokens. Use them, or wait for them to expire (within 10 minutes), before asking for another.";

/**
 * 儲存配額 spec §8.3-3 逐字（可見形：呼叫者能檢視該空間用量——個人空間本人、群組 manageGroup、站台 admin）。
 * 數字以 `formatBytes` 印；`extra` 另帶兩個原始數字。綁定：`mcp-transfer.test.ts` 的配額預檢案。
 */
export function storageFullVisibleMessage(usedBytes: number, quotaBytes: number): string {
  return (
    `This note's storage space is full (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used), so no image can be uploaded to it. ` +
    "A site admin can assign a larger storage plan; deleting notes that have images also frees space."
  );
}

/** 儲存配額 spec §8.3-3 逐字（不可見形：不帶數字、不帶 `extra`）。 */
export const STORAGE_FULL_HIDDEN_MESSAGE =
  "This note's storage space is full, so no image can be uploaded to it. Ask the note's owner or a site admin for more space.";

export interface CreateTransferTokenArgs {
  note_id: string;
  purpose: "upload" | "download";
}

export async function createTransferToken(args: CreateTransferTokenArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const parentTokenId = ctx.tokenId;
  // `register.ts` 只在 token 路徑註冊這支；到得了這裡卻沒有母憑證＝接線錯了，交給 runTool 的 internal。
  if (ctx.authKind !== "token" || parentTokenId === null) throw new Error("create_transfer_token 只在 token 路徑註冊");

  // ① spec §6.3 第 1 步：upload 才扣 tokenWrite（scope、session 跳過、扣點三件事的單一入口）。
  if (args.purpose === "upload") {
    const denied = requireWriteScope(ctx);
    if (denied !== null) return denied;
  }

  // ② 第 2 步：none 與「不存在」回逐位元組相同的 not_found（docs/mcp.md 的宣稱）。
  const access = await resolveNoteAccess(ctx.db, ctx.userId, args.note_id);
  if (access.role === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (args.purpose === "upload" && access.role === "viewer") return toolError("forbidden", VIEWER_UPLOAD_MESSAGE);

  // ③ 第 3 步：download 扣 contentRead（key userId，同 `authorizeNoteRead`）；不 touch presence。
  if (args.purpose === "download" && !ctx.limiters.contentRead.consume(ctx.userId)) {
    return toolError("too_many_requests", READ_RATE_LIMITED_MESSAGE);
  }

  // ③a 配額預檢（spec §6.3-3a；儲存配額 spec §8.3-3）：upload 時空間已滿 → storage_quota_exceeded，不簽 token
  //    （與上傳 preHandler 第 4a 步同一判準 `isSpaceFull`）。空間取 ② 的 `access`，不另查；兩句讀都在交易外（S14）。
  if (args.purpose === "upload") {
    const space = spaceOfNote(access);
    const usage = await readSpaceUsage(ctx.db, space);
    if (isSpaceFull(usage)) {
      // `McpToolCtx` 沒有 isAdmin：只在已滿時讀一次（平常路徑不多一句）。
      const [me] = await ctx.db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, ctx.userId));
      return (await canViewSpaceUsage(ctx.db, { id: ctx.userId, isAdmin: me?.isAdmin === true }, space))
        ? toolError("storage_quota_exceeded", storageFullVisibleMessage(usage.usedBytes, usage.quotaBytes), {
            usedBytes: usage.usedBytes,
            quotaBytes: usage.quotaBytes,
          })
        : toolError("storage_quota_exceeded", STORAGE_FULL_HIDDEN_MESSAGE);
    }
  }

  // ④ 交易外算好純資料（S14）：明文與雜湊都在這裡，交易內只有三句。
  const token = generateTransferToken();
  const input: IssueTransferTokenInput = {
    tokenHash: hashToken(token),
    parentTokenId,
    noteId: args.note_id,
    purpose: args.purpose,
    maxPendingUploads: MAX_PENDING_UPLOAD_TOKENS,
  };
  let result: IssueTransferTokenResult;
  try {
    result = await ctx.db.transaction(tx => issueTransferTokenInTx(tx, input, ctx.hooks?.issueTransferToken));
  } catch (err) {
    // 交易外映射（spec §4.2）：筆記在 ② 之後被刪 → not_found；母憑證恰在 now() 到期 → 視同 revoked；其餘遮蔽後丟出。
    if (isForeignKeyViolation(err) && pgErrorSummary(err).constraint === TRANSFER_TOKENS_NOTE_FK) {
      return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    }
    if (checkViolationConstraint(err) === TRANSFER_TOKENS_EXPIRY_CHK) return toolError("unauthorized", REVOKED_MESSAGE);
    throw redactDbError(ctx.log, err, "簽發 transfer token");
  }
  if (result.kind === "revoked") return toolError("unauthorized", REVOKED_MESSAGE);
  if (result.kind === "too_many_pending") return toolError("too_many_requests", TOO_MANY_PENDING_MESSAGE);

  // ⑤ 交易外、fire-and-forget（失敗只 warn；log 只記 code／constraint，比照 redactDbError 的遮蔽）。
  void deleteExpiredTransferTokens(ctx.db).catch((err: unknown) => {
    ctx.log.warn({ ...pgErrorSummary(err) }, "清理過期 transfer token 失敗");
  });

  const upload = args.purpose === "upload";
  // M1：URL 用 DB 回的小寫正規形。
  const url = upload ? `${ctx.publicOrigin}/api/notes/${result.noteId}/uploads` : `${ctx.publicOrigin}/api/uploads/<upload_id>`;
  const curl = upload
    ? `curl -sS -X POST -H "Authorization: Bearer ${token}" -F "file=@<path-to-image>" "${url}"`
    : `curl -sS -H "Authorization: Bearer ${token}" -o <output-file> "${url}"`;
  return toolResult({
    purpose: args.purpose,
    noteId: result.noteId,
    token,
    expiresAt: result.expiresAt.toISOString(),
    url,
    method: upload ? "POST" : "GET",
    curl,
    next: upload ? UPLOAD_NEXT : DOWNLOAD_NEXT,
  });
}
