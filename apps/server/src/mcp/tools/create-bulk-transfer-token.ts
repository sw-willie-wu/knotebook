/**
 * bulk transfer：`create_bulk_transfer_token`——簽一支 30 分鐘的 bulk 權杖，讓模型用 shell `curl`
 * 一次下載看得到的筆記成 `.tar.gz`、單篇重抓、或自行撤銷。
 *
 * **流程順序是契約**：① 接線檢查 ② 至多給一個範圍（在 handler 判，input 不准 refine：`inputSchema.properties`
 * 會靜默變空）③ `group_id` 可讀（`loadCreateTarget`，同 list_folders）④ `folder_id` 看得到（`resolveFolderAccess`；看不到在
 * MCP 一律 `not_found`）⑤ `access` 依母憑證當下 scope ⑥ 交易外算明文與雜湊 ⑦ 交易（S14）⑧ 交易外清理。
 * 不扣任何桶（MCP 端點已扣 `tokenRead`）；不 touch presence。
 *
 * 描述與輸出依母憑證二選一：有 `notes:write`（`canWriteNotes`）→ RW description、RW 輸出（多 `write`）、RW `next`；
 * 否則 RO（「This credential can't send notes back.」——access=read 的權杖 PUT 會 403，`transfer-write-auth` W-A3c 守）。
 * 模型面字串改一個字要同時改 docs 與 `test/unit/bulk-transfer-strings.test.ts` 的全文 `toBe`。
 * **密文不進 log**：明文只在這個回應本文裡；SQL 參數只有雜湊。
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

/** RW description：母憑證有 `notes:write`（`canWriteNotes`）時註冊這份。 */
export const CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RW =
  "Get a short-lived token that lets shell commands read and write many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; each file you change goes back in its own request. Sending back a file changes the note only in the blocks where your copy differs from what you downloaded. If the note has changed since your download, a changed file is refused and nothing is written: fetch that note again and redo your changes in the new copy. A file with no `id` in its front matter creates a new note. Leaving a file out, or deleting it, deletes nothing. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";

/** RO description。 */
export const CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO =
  "Get a short-lived token that lets shell commands download many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them. This credential can't send notes back. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";

/** 輸入的三句 `.describe()`。 */
export const BULK_SPACE_DESCRIBE =
  "`personal` for only your own notes, or `shared` for only notes others shared with you. Leave out `space`, `group_id` and `folder_id` for every note you can see; pass at most one of them.";
export const BULK_GROUP_ID_DESCRIBE =
  "Only one group's notes: the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.";
export const BULK_FOLDER_ID_DESCRIBE =
  "Only one folder and the folders inside it, from list_folders.";

/** RO 的 `next`。 */
export const BULK_NEXT_RO =
  "Run `export.curl`; it unpacks the notes into a `knotebook` folder. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`. Moving, renaming or deleting a file doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; compare with the manifest to check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed, and a file under a note's old name stays. Fetch the latest copy of one note with `note.curl`. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note is gone or you can't see it. A 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 means too many requests: wait the seconds in `Retry-After`, then send the same request again. When you are done, run `revoke.curl`.";

/** RW 的 `next`（503 句的主詞是 the server——新增筆記撞可重試交易錯誤也回 503，那時還沒有 the note；
 * 實機回補：新增檔的 front matter 要有 `knotebook:` 行 `title`／`folder_id` 才算〔`transfer/frontmatter.ts` 的辨識，
 * `transfer-write-create.test.ts`〕；JSON 回覆是「usually」印出——Windows 的 curl 對 413 偶爾 exit 56、連線先被重設〔實機 14-413-tally〕）。 */
export const BULK_NEXT_RW =
  "Run `export.curl`; it unpacks the notes into a `knotebook` folder. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`: leave those as they are. Change `title` there to rename the note. Moving or renaming a file, or deleting it, doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; `.knotebook/manifest.json` lists every file, so you can check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed and haven't sent back, and a file under a note's old name stays. Edit the markdown in the form read_note_section returns — HTML comments are dropped, and text after one, on its line and on the lines right below it, becomes plain text that can run on into the text after a later comment; leave a blank line after each comment, with nothing after it on its line, to keep the lines below it as markdown — then send each file you changed with `write.curl`, one file per request. If a command fails, curl exits with an error, and the server's JSON reply is usually in the output file or printed; `note.curl` writes over its output file even when it fails, so never point it at a copy you still need. If the note has changed since your download, a changed file is refused with a 409 `base_unavailable` whose `reason` is `note_changed`, and nothing is written: fetch that note again with `note.curl`, redo your changes in the new copy, and send that. Once a file's changes have been written, that copy can't carry more changes: to change the note again, fetch it with `note.curl` and edit the new copy. Sending the same file again returns `unchanged` once everything in it has been applied. A file with no `id` creates a new note; its `title` and `folder_id` count only in front matter at the top that has a `knotebook:` line, as downloaded files do — otherwise that front matter becomes note text. To change it again, fetch it with `note.curl` and the reply's `id`. If you're not sure a new note was created, send the same file again: while this token works, an identical file returns the note it created. A new note goes into the folder given as `folder_id` in its front matter, or else to the top of this token's folder or group, or of your own notes; a token for only notes shared with you can't create notes. A 400 means nothing was written; its `code` says why. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note, or the `folder_id` folder, is gone or you can't see it. A 409 `base_unavailable` means this copy can't be written back, and the reply's `reason` says why (`note_changed`, `already_sent`, `other_note`, `expired` or `reverted`): keep your changes, fetch the note again with `note.curl` and redo them in the new copy. A 409 `not_mergeable` means this note can't be written back as a file: change it with edit_note. A note marked `tooLargeToSend` in the manifest downloads as a file too big to send back: change it with edit_note. A 413 `content_too_large` means the file is too big to send; a 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 means too many requests: wait the seconds in `Retry-After`, then send the same request again. A 503 means the server was busy: try again shortly. When you are done, run `revoke.curl`.";

/** 字面見 `bulk-transfer-strings.test.ts` S3。比照 `folder-messages.ts` 的「so nothing was …」句式。 */
export const BULK_RANGE_AMBIGUOUS_MESSAGE = "Pass at most one of `space`, `group_id` and `folder_id`, so no token was created.";
/**
 * 全文見 `bulk-transfer-strings.test.ts` S3。「3」「30」是寫死的字面值：與 `MAX_ACTIVE_BULK_TOKENS`／`BULK_TRANSFER_TTL_MINUTES` 的對齊由
 * `bulk-transfer-strings.test.ts` S3 與 `mcp-bulk-transfer-token.test.ts` B5（第 4 支被拒）守。
 */
export const TOO_MANY_BULK_TOKENS_MESSAGE =
  "This credential already has 3 bulk transfer tokens that haven't expired. Wait for one to expire (within 30 minutes), or run the `revoke.curl` of one you no longer need, before asking for another.";

/** 註冊為 `z.object(createBulkTransferTokenInput).strict()`；「至多一個」在 handler 判（不准 refine）。 */
export const createBulkTransferTokenInput = {
  space: z.enum(["personal", "shared"]).optional().describe(BULK_SPACE_DESCRIBE),
  group_id: GROUP_ID.optional().describe(BULK_GROUP_ID_DESCRIBE),
  folder_id: FOLDER_ID.optional().describe(BULK_FOLDER_ID_DESCRIBE),
};

const urlCurl = z.object({ url: z.string(), curl: z.string() });
/** 輸出（RO：沒有 `write`）。 */
export const createBulkTransferTokenOutputRo = {
  token: z.string(),
  expiresAt: z.string().describe("When the token stops working (ISO 8601)."),
  access: z.enum(["read", "write"]),
  export: urlCurl,
  note: urlCurl,
  revoke: urlCurl,
  next: z.string().describe("How to use the commands, and what their status codes mean."),
};
/** 輸出（RW：RO 再加 `write`；鍵序固定）。 */
export const createBulkTransferTokenOutputRw = {
  token: createBulkTransferTokenOutputRo.token,
  expiresAt: createBulkTransferTokenOutputRo.expiresAt,
  access: createBulkTransferTokenOutputRo.access,
  export: urlCurl,
  note: urlCurl,
  write: urlCurl,
  revoke: urlCurl,
  next: createBulkTransferTokenOutputRo.next,
};

export interface CreateBulkTransferTokenArgs {
  space?: "personal" | "shared";
  group_id?: string;
  folder_id?: string;
}

/** 四組 curl（`<t>`＝權杖、`<origin>`＝`publicOrigin`）；`write` 只給 RW 輸出。 */
export function bulkCurls(origin: string, token: string) {
  const auth = `-H "Authorization: Bearer ${token}"`;
  const exportUrl = `${origin}/api/transfer/export`;
  const noteUrl = `${origin}/api/transfer/notes/<note_id>`;
  const writeUrl = `${origin}/api/transfer/notes`;
  const revokeUrl = `${origin}/api/transfer/token`;
  return {
    export: { url: exportUrl, curl: `curl -sS --fail-with-body ${auth} -o knotebook.tar.gz "${exportUrl}" && mkdir -p knotebook && tar -xzf knotebook.tar.gz -C knotebook` },
    note: { url: noteUrl, curl: `curl -sS --fail-with-body ${auth} "${noteUrl}" > "<output-file>"` },
    // 檔案由 shell 開（`@- < "<file>"`，因為 Git Bash 的 curl 遇碼頁外檔名時 `"@<file>"` 讀不到）。
    write: { url: writeUrl, curl: `curl -sS --fail-with-body -X PUT ${auth} -H "Content-Type: text/markdown; charset=utf-8" --data-binary @- "${writeUrl}" < "<file>"` },
    revoke: { url: revokeUrl, curl: `curl -sS --fail-with-body -X DELETE ${auth} "${revokeUrl}"` },
  };
}

export async function createBulkTransferToken(args: CreateBulkTransferTokenArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const parentTokenId = ctx.tokenId;
  // ① `register.ts` 只在 token 路徑註冊；到得了這裡卻沒有母憑證＝接線錯了，交給 runTool 的 internal。
  if (ctx.authKind !== "token" || parentTokenId === null) throw new Error("create_bulk_transfer_token 只在 token 路徑註冊");

  // ② 至多一個範圍。
  const given = [args.space, args.group_id, args.folder_id].filter(v => v !== undefined).length;
  if (given > 1) return toolError("invalid_body", BULK_RANGE_AMBIGUOUS_MESSAGE);

  let range: BulkRange = { kind: "all" };
  if (args.space !== undefined) range = { kind: args.space };
  // ③ 群組要 can_read（GROUP_ID 不轉小寫，照 list_folders）。
  if (args.group_id !== undefined) {
    const groupId = args.group_id.toLowerCase();
    const target = await loadCreateTarget(ctx.db, ctx.userId, groupId);
    if (target === undefined || !target.canRead) return toolError("group_not_found", FOLDER_GROUP_NOT_FOUND_MESSAGE);
    range = { kind: "group", groupId };
  }
  // ④ 資料夾要看得到；MCP 一律 not_found。FOLDER_ID 已轉小寫。
  if (args.folder_id !== undefined) {
    const access = await resolveFolderAccess(ctx.db, ctx.userId, args.folder_id);
    if (access === null) return toolError("not_found", FOLDER_NOT_FOUND_MESSAGE);
    range = { kind: "folder", folderId: args.folder_id.toLowerCase() };
  }

  // ⑤ 母憑證當下有 notes:write → write。與註冊時選 RW／RO 描述是同一支 `canWriteNotes`（`register.ts`）。
  const access = canWriteNotes(ctx) ? "write" : "read";

  // ⑥ 交易外算好純資料（S14）。
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

  // ⑧ 交易外、fire-and-forget（失敗只 warn；log 只記 code／constraint）。
  void deleteExpiredTransferTokens(ctx.db).catch((err: unknown) => {
    ctx.log.warn({ ...pgErrorSummary(err) }, "清理過期 transfer token 失敗");
  });

  const { export: exportCmd, note, write, revoke } = bulkCurls(ctx.publicOrigin, token);
  const expiresAt = result.expiresAt.toISOString();
  return access === "write"
    ? toolResult({ token, expiresAt, access, export: exportCmd, note, write, revoke, next: BULK_NEXT_RW })
    : toolResult({ token, expiresAt, access, export: exportCmd, note, revoke, next: BULK_NEXT_RO });
}
