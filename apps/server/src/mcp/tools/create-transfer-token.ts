/**
 * A short-lived, single-note, single-purpose token so a shell `curl` can upload or download an
 * file: an MCP credential can't be sent from a shell and file bytes don't fit in tool
 * arguments. The order is a contract: upload → `requireWriteScope` (charges `tokenWrite`) →
 * `resolveNoteAccess` (none → the same not_found string; upload + viewer → forbidden) →
 * download → charge `contentRead` (no presence: signing isn't reading) → upload → storage-full
 * pre-check (full → storage_quota_exceeded, nothing signed) → transaction (only those three
 * statements) → cleanup outside it. Token path only: a session is a same-origin browser that
 * can already upload and view with its cookie. The plaintext appears only in the response
 * body; SQL parameters carry only the hash; `runTool` logs only `{err, tool}` on exceptions.
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { formatBytes } from "@knotebook/shared";
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
import { spaceOfNote } from "../../storage/space.js";
import { canViewSpaceUsage, isSpaceFull, readSpaceUsage } from "../../storage/usage.js";
import { NOTE_NOT_FOUND_MESSAGE, READ_RATE_LIMITED_MESSAGE } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

export const CREATE_TRANSFER_TOKEN_DESCRIPTION_RW =
  "Get a short-lived token that lets a shell command upload a file to a note or download its files — your MCP " +
  "credential can't be sent that way, and file bytes don't fit in tool arguments. An upload can be an image (PNG, JPEG, GIF or WebP), audio, video, " +
  "a PDF, an Office or OpenDocument file, or a text file. `upload` needs edit access and is good for one file; `download` " +
  "fetches any file uploaded to that note. Tokens expire within 10 minutes (see `expiresAt`). The result has a ready `curl` " +
  "command: send the token only to that address, in the `Authorization` header.";

export const CREATE_TRANSFER_TOKEN_DESCRIPTION_RO =
  "Get a short-lived token that lets a shell command download a note's files — your MCP credential can't be sent that " +
  "way, and file bytes don't fit in tool arguments. It fetches any file uploaded to that note. Tokens expire within " +
  "10 minutes (see `expiresAt`). The result has a ready `curl` command: send the token only to that address, in the " +
  "`Authorization` header.";

const NOTE_ID_DESCRIBE = "The note's id, as returned by list_notes or search_notes.";

/** A read-only credential sending `upload` gets the SDK's input error; the handler doesn't run. */
export const createTransferTokenInputRw = {
  note_id: NOTE_ID.describe(NOTE_ID_DESCRIBE),
  purpose: z.enum(["upload", "download"]).describe("`upload` stores one file for the note (then reference it with edit_note); `download` fetches its files."),
};
export const createTransferTokenInputRo = {
  note_id: NOTE_ID.describe(NOTE_ID_DESCRIBE),
  purpose: z.enum(["download"]).describe("`download` fetches its files."),
};

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

/** Wording is pinned by `test/transfer-tokens.test.ts`. 403/429 don't burn the token, except a 403 for a role lost mid-upload (the per-IP
 * `bearerMiss` 429 only replaces a 401), so the text says "this rejection doesn't use up the
 * token", not "the token is still unused": in the bearerMiss case it may already be used.
 * 413/415/400 burn it. A 404 is either the pre-consumption role re-check or the note deleted
 * mid-upload. A note deleted after issue but before upload gives 401 (token row cascaded), covered
 * by "A 401 means the token can't be used". storage_quota_exceeded: space already full → token not
 * consumed (the same token works once space is freed); the declared length is over the room →
 * answered before reading, not consumed; doesn't fit once the file is streaming, or in the transaction → 409, token
 * burned. server_busy burns the token. */
export const UPLOAD_NEXT =
  "The reply is JSON `{id, url, mime, kind}`, where `kind` is `image`, `audio`, `video` or `file`. Put an image (PNG, JPEG, GIF, WebP or SVG) in the note with " +
  "edit_note using markdown `![description](url)` and any other kind as a link `[name](url)`, with `url` exactly as returned " +
  "(`/api/uploads/<id>`, relative). The token is good for one upload until `expiresAt`. A 401 " +
  "means the token can't be used (expired, already used, or revoked) — ask for a new one. A 403 or 429 doesn't use the " +
  "token up (after a 429, wait a moment and retry), unless the 403 is for a role lost while the file was uploading; a 404 means the note is gone or you can no longer see it, and one that comes while the file is uploading comes after the token was used up. " +
  "A 409 `storage_quota_exceeded` means the note's storage space has no room for this file: don't retry until space has been freed, and then ask for a new token. " +
  "A 409 `server_busy` means the server was busy and the token is used up: ask for a new token and retry. Once the server has started reading the file, a " +
  "rejection (for example 413: over the size limit, 415: not a supported type — an image (PNG, JPEG, GIF, WebP or SVG), audio, video, a PDF, an Office or OpenDocument file, or a text file) still uses the token up. If curl reports a connection error (a reset or a failed send) instead of a status, the server most likely refused the file — too large, not a supported type, or no room in the space — and the token is used up: check the file's size, type and the space's room before asking for a new token.";

export const DOWNLOAD_NEXT =
  "Replace `<upload_id>` with the id from `/api/uploads/<id>` in the note's markdown. Any file uploaded to this note " +
  "can be fetched with this token until `expiresAt`. A 401 means the token can't be used — ask for a new one. A 403 " +
  "means this token can't fetch that file: it belongs to another note, or you can no longer read this one. A 404 " +
  "means there is no file with that id. A 429 means too many requests: wait a moment and retry with the same token.";

export const VIEWER_UPLOAD_MESSAGE = "You can read this note but not edit it, so you can't upload files to it.";
export const REVOKED_MESSAGE = "This credential was revoked or expired while the request was being handled.";
/** The "5" is a literal kept in step with `MAX_PENDING_UPLOAD_TOKENS` by assertions in `mcp-transfer.test.ts`. */
export const TOO_MANY_PENDING_MESSAGE =
  "This credential already has 5 unused upload tokens. Use them, or wait for them to expire (within 10 minutes), before asking for another.";

/** Visible only to those who may view the space's usage (owner, manageGroup, site admin). */
export function storageFullVisibleMessage(usedBytes: number, quotaBytes: number): string {
  return (
    `This note's storage space is full (${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used), so no file can be uploaded to it. ` +
    "A site admin can assign a larger storage plan; deleting notes that have files also frees space."
  );
}

export const STORAGE_FULL_HIDDEN_MESSAGE =
  "This note's storage space is full, so no file can be uploaded to it. Ask the note's owner or a site admin for more space.";

export interface CreateTransferTokenArgs {
  note_id: string;
  purpose: "upload" | "download";
}

export async function createTransferToken(args: CreateTransferTokenArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const parentTokenId = ctx.tokenId;
  if (ctx.authKind !== "token" || parentTokenId === null) throw new Error("create_transfer_token 只在 token 路徑註冊");

  if (args.purpose === "upload") {
    const denied = requireWriteScope(ctx);
    if (denied !== null) return denied;
  }

  const access = await resolveNoteAccess(ctx.db, ctx.userId, args.note_id);
  if (access.role === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (args.purpose === "upload" && access.role === "viewer") return toolError("forbidden", VIEWER_UPLOAD_MESSAGE);

  if (args.purpose === "download" && !ctx.limiters.contentRead.consume(ctx.userId)) {
    return toolError("too_many_requests", READ_RATE_LIMITED_MESSAGE);
  }

  if (args.purpose === "upload") {
    const space = spaceOfNote(access);
    const usage = await readSpaceUsage(ctx.db, space);
    if (isSpaceFull(usage)) {
      const [me] = await ctx.db.select({ isAdmin: users.isAdmin }).from(users).where(eq(users.id, ctx.userId));
      return (await canViewSpaceUsage(ctx.db, { id: ctx.userId, isAdmin: me?.isAdmin === true }, space))
        ? toolError("storage_quota_exceeded", storageFullVisibleMessage(usage.usedBytes, usage.quotaBytes), {
            usedBytes: usage.usedBytes,
            quotaBytes: usage.quotaBytes,
          })
        : toolError("storage_quota_exceeded", STORAGE_FULL_HIDDEN_MESSAGE);
    }
  }

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
    if (isForeignKeyViolation(err) && pgErrorSummary(err).constraint === TRANSFER_TOKENS_NOTE_FK) {
      return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
    }
    if (checkViolationConstraint(err) === TRANSFER_TOKENS_EXPIRY_CHK) return toolError("unauthorized", REVOKED_MESSAGE);
    throw redactDbError(ctx.log, err, "簽發 transfer token");
  }
  if (result.kind === "revoked") return toolError("unauthorized", REVOKED_MESSAGE);
  if (result.kind === "too_many_pending") return toolError("too_many_requests", TOO_MANY_PENDING_MESSAGE);

  // Fire-and-forget; logs only `pgErrorSummary` (code/constraint), since the raw error can carry query parameters.
  void deleteExpiredTransferTokens(ctx.db).catch((err: unknown) => {
    ctx.log.warn({ ...pgErrorSummary(err) }, "清理過期 transfer token 失敗");
  });

  const upload = args.purpose === "upload";
  const url = upload ? `${ctx.publicOrigin}/api/notes/${result.noteId}/uploads` : `${ctx.publicOrigin}/api/uploads/<upload_id>`;
  const curl = upload
    ? `curl -sS -X POST -H "Authorization: Bearer ${token}" -F "file=@<path-to-file>" "${url}"`
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
