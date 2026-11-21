/**
 * The check order is a contract: wiring → at most one scope (in the handler: a refine on the
 * input would silently empty `inputSchema.properties`) → `group_id` readable → `folder_id`
 * visible (an invisible folder is always `not_found` over MCP) → `access` from the parent
 * credential's current scope → plaintext and hash computed outside the transaction →
 * transaction → cleanup outside it. No limiter is charged (the endpoint already charged
 * `tokenRead`); no presence. Description and output follow the parent credential: with
 * `notes:write` the RW forms (extra `write`), otherwise RO (a PUT with an access=read token
 * gets 403). Model-facing strings: change docs and `test/unit/bulk-transfer-strings.test.ts`
 * together. Secrets never reach the log: the plaintext is only in this response body, and SQL
 * parameters carry only the hash.
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hashToken } from "../../auth/api-token.js";
import { deleteExpiredTransferTokens } from "../../auth/transfer-cleanup.js";
import {
  BULK_TRANSFER_TTL_MINUTES,
  MAX_ACTIVE_BULK_TOKENS,
  TRANSFER_TOKENS_EXPIRY_CHK,
  generateTransferToken,
  type BulkRange,
} from "../../auth/transfer-token.js";
import { issueBulkTransferTokenInTx, type IssueBulkTransferTokenInput, type IssueBulkTransferTokenResult } from "../../auth/tx/issue-bulk-transfer-token.js";
import { checkViolationConstraint, pgErrorSummary } from "../../db/pg-errors.js";
import { resolveFolderAccess } from "../../folders/queries.js";
import { redactDbError } from "../../lib/redact-db-error.js";
import { loadCreateTarget } from "../../notes/create-target.js";
import { GROUP_ID } from "../../notes/schemas.js";
import { FOLDER_ID } from "../folder-fields.js";
import { FOLDER_GROUP_NOT_FOUND_MESSAGE, FOLDER_NOT_FOUND_MESSAGE } from "../folder-messages.js";
import { toolError, toolResult } from "../tool-result.js";
import { canWriteNotes } from "../write-scope.js";
import { REVOKED_MESSAGE } from "./create-transfer-token.js";
import type { McpToolCtx } from "../context.js";

export const OPEN_NOTES_AS_FILES_DESCRIPTION_RW =
  "Get a short-lived token that lets shell commands read and write one or many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them; each file you change goes back in its own request. Sending back a file changes the note only in the blocks where your copy differs from what you downloaded. If the note has changed since your download, a changed file is refused and nothing is written: fetch that note again and redo your changes in the new copy. A file with no `id` in its front matter creates a new note. Leaving a file out, or deleting it, deletes nothing. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";

export const OPEN_NOTES_AS_FILES_DESCRIPTION_RO =
  "Get a short-lived token that lets shell commands download one or many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them. This credential can't send notes back. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";

export const BULK_SPACE_DESCRIBE =
  "`personal` for only your own notes, or `shared` for only notes others shared with you. Leave out `space`, `group_id` and `folder_id` for every note you can see; pass at most one of them.";
export const BULK_GROUP_ID_DESCRIBE =
  "Only one group's notes: the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.";
export const BULK_FOLDER_ID_DESCRIBE =
  "Only one folder and the folders inside it, from list_folders.";

export const BULK_NEXT_RO =
  "Run `export.curl`; it unpacks the notes into a `knotebook` folder. To work on one note, you can skip the download: fetch it with `note.curl` and the note's id. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role`, `tags` and `base`. Moving, renaming or deleting a file doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; compare with the manifest to check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed, and a file under a note's old name stays. Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note is gone or you can't see it. A 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives. A 429 whose message says another export is already running: try again after the seconds it gives. Any other 429 means too many requests: wait a minute, then send the same request again. When you are done, run `revoke.curl`.";

/** The 503 subject is "the server": creating a note that hits a retryable transaction error also returns 503, before any "the note" exists. Windows curl sometimes exits 56 on a 413 after the connection reset, hence "usually". A new file's `title`/`folder_id` count only in front matter with a `knotebook:` line (`transfer/frontmatter.ts`). */
export const BULK_NEXT_RW =
  "Run `export.curl`; it unpacks the notes into a `knotebook` folder. To work on one note, you can skip the download: fetch it with `note.curl` and the note's id. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`: leave those as they are. Change `title` there to rename the note. Its `tags` line lists the note's tags as a JSON array: change it to set the note's tags (a name the note's space doesn't have yet is created), or take the line out to leave them as they are. Tags are set only there: a #name in the note's text stays text. Moving or renaming a file, or deleting it, doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; `.knotebook/manifest.json` lists every file, so you can check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed and haven't sent back, and a file under a note's old name stays. Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again. Edit the markdown in the form read_note_section returns — a <!-- knotebook:knowledge … --> comment after a heading holds that heading's knowledge info, written as edit_note's markdown describes, and taking it out removes that info; other HTML comments are dropped, and text after one, on its line and on the lines right below it, becomes plain text that can run on into the text after a later comment; leave a blank line after each comment, with nothing after it on its line, to keep the lines below it as markdown — then send each file you changed with `write.curl`, one file per request. If a command fails, curl exits with an error, and the server's JSON reply is usually in the output file or printed; `note.curl` writes over its output file even when it fails, so never point it at a copy you still need. If the note has changed since your download, a changed file is refused with a 409 `base_unavailable` whose `reason` is `note_changed`, and nothing is written: fetch that note again with `note.curl`, redo your changes in the new copy, and send that. Once a file's changes have been written, that copy can't carry more changes: to change the note again, fetch it with `note.curl` and edit the new copy. Sending the same file again returns `unchanged` once everything in it has been applied. A file with no `id` creates a new note; its `title` and `folder_id` count only in front matter at the top that has a `knotebook:` line, as downloaded files do — otherwise that front matter becomes note text. To change it again, fetch it with `note.curl` and the reply's `id`. If you're not sure a new note was created, send the same file again: while this token works, an identical file returns the note it created. A new note goes into the folder given as `folder_id` in its front matter, or else to the top of this token's folder or group, or of your own notes; a token for only notes shared with you can't create notes. A 400 means nothing was written; its `code` says why. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it; changing the tags needs edit rights in the note's own space, not through a share. A 404 means the note, or the `folder_id` folder, is gone or you can't see it. A 409 `base_unavailable` means this copy can't be written back, and the reply's `reason` says why (`note_changed`, `already_sent`, `other_note`, `expired` or `reverted`): keep your changes, fetch the note again with `note.curl` and redo them in the new copy. A 409 `not_mergeable` means this note can't be written back as a file: change it with edit_note. A note marked `tooLargeToSend` in the manifest downloads as a file too big to send back: change it with edit_note. A 413 `content_too_large` means the file is too big to send: change that note with edit_note; a 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives. A 429 whose message says another export is already running: try again after the seconds it gives. Any other 429 means too many requests: wait a minute, then send the same request again. A 503 means the server was busy: try again shortly. When you are done, run `revoke.curl`.";

export const BULK_RANGE_AMBIGUOUS_MESSAGE = "Pass at most one of `space`, `group_id` and `folder_id`, so no token was created.";
/** "3" and "30" are literals kept in step with `MAX_ACTIVE_BULK_TOKENS` and `BULK_TRANSFER_TTL_MINUTES` by tests. */
export const TOO_MANY_BULK_TOKENS_MESSAGE =
  "This credential already has 3 bulk transfer tokens that haven't expired. Wait for one to expire (within 30 minutes), or run the `revoke.curl` of one you no longer need, before asking for another.";

export const openNotesAsFilesInput = {
  space: z.enum(["personal", "shared"]).optional().describe(BULK_SPACE_DESCRIBE),
  group_id: GROUP_ID.optional().describe(BULK_GROUP_ID_DESCRIBE),
  folder_id: FOLDER_ID.optional().describe(BULK_FOLDER_ID_DESCRIBE),
};

const urlCurl = z.object({ url: z.string(), curl: z.string() });
export const openNotesAsFilesOutputRo = {
  token: z.string(),
  expiresAt: z.string().describe("When the token stops working (ISO 8601)."),
  access: z.enum(["read", "write"]),
  export: urlCurl,
  note: urlCurl,
  revoke: urlCurl,
  next: z.string().describe("How to use the commands, and what their status codes mean."),
};
export const openNotesAsFilesOutputRw = {
  token: openNotesAsFilesOutputRo.token,
  expiresAt: openNotesAsFilesOutputRo.expiresAt,
  access: openNotesAsFilesOutputRo.access,
  export: urlCurl,
  note: urlCurl,
  write: urlCurl,
  revoke: urlCurl,
  next: openNotesAsFilesOutputRo.next,
};

export interface OpenNotesAsFilesArgs {
  space?: "personal" | "shared";
  group_id?: string;
  folder_id?: string;
}

export function bulkCurls(origin: string, token: string) {
  const auth = `-H "Authorization: Bearer ${token}"`;
  const exportUrl = `${origin}/api/transfer/export`;
  const noteUrl = `${origin}/api/transfer/notes/<note_id>`;
  const writeUrl = `${origin}/api/transfer/notes`;
  const revokeUrl = `${origin}/api/transfer/token`;
  return {
    export: { url: exportUrl, curl: `curl -sS --fail-with-body ${auth} -o knotebook.tar.gz "${exportUrl}" && mkdir -p knotebook && tar -xzf knotebook.tar.gz -C knotebook` },
    note: { url: noteUrl, curl: `curl -sS --fail-with-body ${auth} "${noteUrl}" > "<output-file>"` },
    // The shell opens the file (`@- < "<file>"`): Git Bash's curl can't read `"@<file>"` for names outside the code page.
    write: { url: writeUrl, curl: `curl -sS --fail-with-body -X PUT ${auth} -H "Content-Type: text/markdown; charset=utf-8" --data-binary @- "${writeUrl}" < "<file>"` },
    revoke: { url: revokeUrl, curl: `curl -sS --fail-with-body -X DELETE ${auth} "${revokeUrl}"` },
  };
}

export async function openNotesAsFiles(args: OpenNotesAsFilesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const parentTokenId = ctx.tokenId;
  if (ctx.authKind !== "token" || parentTokenId === null) throw new Error("open_notes_as_files 只在 token 路徑註冊");

  const given = [args.space, args.group_id, args.folder_id].filter(v => v !== undefined).length;
  if (given > 1) return toolError("invalid_body", BULK_RANGE_AMBIGUOUS_MESSAGE);

  let range: BulkRange = { kind: "all" };
  if (args.space !== undefined) range = { kind: args.space };
  // The group must be `can_read`; GROUP_ID doesn't lowercase (as in list_folders).
  if (args.group_id !== undefined) {
    const groupId = args.group_id.toLowerCase();
    const target = await loadCreateTarget(ctx.db, ctx.userId, groupId);
    if (target === undefined || !target.canRead) return toolError("group_not_found", FOLDER_GROUP_NOT_FOUND_MESSAGE);
    range = { kind: "group", groupId };
  }
  if (args.folder_id !== undefined) {
    const access = await resolveFolderAccess(ctx.db, ctx.userId, args.folder_id);
    if (access === null) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    range = { kind: "folder", folderId: args.folder_id.toLowerCase() };
  }

  const access = canWriteNotes(ctx) ? "write" : "read";

  const token = generateTransferToken();
  const input: IssueBulkTransferTokenInput = {
    tokenHash: hashToken(token),
    parentTokenId,
    access,
    range,
    maxActive: MAX_ACTIVE_BULK_TOKENS,
    ttlMinutes: BULK_TRANSFER_TTL_MINUTES,
  };
  let result: IssueBulkTransferTokenResult;
  try {
    result = await ctx.db.transaction(tx => issueBulkTransferTokenInTx(tx, input, ctx.hooks?.issueBulkTransferToken));
  } catch (err) {
    if (checkViolationConstraint(err) === TRANSFER_TOKENS_EXPIRY_CHK) return toolError("unauthorized", REVOKED_MESSAGE);
    throw redactDbError(ctx.log, err, "簽發 bulk transfer token");
  }
  if (result.kind === "revoked") return toolError("unauthorized", REVOKED_MESSAGE);
  if (result.kind === "too_many_active") return toolError("too_many_requests", TOO_MANY_BULK_TOKENS_MESSAGE);

  // Fire-and-forget; logs only `pgErrorSummary` (code/constraint), since the raw error can carry query parameters.
  void deleteExpiredTransferTokens(ctx.db).catch((err: unknown) => {
    ctx.log.warn({ ...pgErrorSummary(err) }, "清理過期 transfer token 失敗");
  });

  const { export: exportCmd, note, write, revoke } = bulkCurls(ctx.publicOrigin, token);
  const expiresAt = result.expiresAt.toISOString();
  return access === "write"
    ? toolResult({ token, expiresAt, access, export: exportCmd, note, write, revoke, next: BULK_NEXT_RW })
    : toolResult({ token, expiresAt, access, export: exportCmd, note, revoke, next: BULK_NEXT_RO });
}
