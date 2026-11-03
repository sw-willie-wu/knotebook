import { describe, expect, it } from "vitest";
import { BULK_TRANSFER_TTL_MINUTES, MAX_ACTIVE_BULK_TOKENS } from "../../src/auth/transfer-token.js";
import {
  BULK_FOLDER_ID_DESCRIBE,
  BULK_GROUP_ID_DESCRIBE,
  BULK_NEXT_RO,
  BULK_NEXT_RW,
  BULK_RANGE_AMBIGUOUS_MESSAGE,
  BULK_SPACE_DESCRIBE,
  CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO,
  CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RW,
  TOO_MANY_BULK_TOKENS_MESSAGE,
  bulkCurls,
} from "../../src/mcp/tools/create-bulk-transfer-token.js";

/** bulk transfer spec §14.2、§14.3；plan T8 S1–S3、§0.1-13。模型面字串逐字照 spec，改一個字要回 spec（全域 model-facing-string-claims）。 */

/** spec docs/superpowers/specs/2026-11-02-mcp-bulk-transfer-design.md §14.2、§14.3 原文（PR-3 T3 定稿；引用一律寫章節與段名，不寫行號）。 */
/** §14.2「RO description」 */
const SPEC_DESC_RO = "Get a short-lived token that lets shell commands download many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them. This credential can't send notes back. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
/** §14.2「輸入 `.describe()`」space */
const SPEC_SPACE = "`personal` for only your own notes, or `shared` for only notes others shared with you. Leave out `space`, `group_id` and `folder_id` for every note you can see; pass at most one of them.";
/** §14.2「輸入 `.describe()`」group_id */
const SPEC_GROUP = "Only one group's notes: the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.";
/** §14.2「輸入 `.describe()`」folder_id */
const SPEC_FOLDER = "Only one folder and the folders inside it, from list_folders.";
/** §14.2「RO `next`」 */
const SPEC_NEXT_RO = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`. Moving, renaming or deleting a file doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; compare with the manifest to check none is missing. If the download stops partway, run `export.curl` again. Fetch the latest copy of one note with `note.curl`. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note is gone or you can't see it. A 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 means too many requests: wait the seconds in `Retry-After`, then send the same request again. When you are done, run `revoke.curl`.";
/** §14.3 export */
const SPEC_CURL_EXPORT = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" -o knotebook.tar.gz \"<origin>/api/transfer/export\" && mkdir -p knotebook && tar -xzf knotebook.tar.gz -C knotebook";
/** §14.3 note */
const SPEC_CURL_NOTE = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/notes/<note_id>\" > \"<output-file>\"";
/** §14.3 revoke */
const SPEC_CURL_REVOKE = "curl -sS --fail-with-body -X DELETE -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/token\"";
/** §14.2「RW description」 */
const SPEC_DESC_RW = "Get a short-lived token that lets shell commands read and write many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; each file you change goes back in its own request. Sending back a file changes the note only in the blocks where your copy differs from what you downloaded; blocks others added meanwhile stay, except ones nested inside a block you changed. Where a block you changed had also been changed or removed in the note since your download, your text is used, and the note is first saved as a version. A file with no `id` in its front matter creates a new note. Leaving a file out, or deleting it, deletes nothing. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
/** §14.2「RW `next`」（rev 9 起 HTML 註解那句依 PR-2 T13 X3b 反例改寫，R22；PR-3 T3 503 句改成 the server，待回寫 spec §14.2） */
const SPEC_NEXT_RW = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`: leave those as they are. Change `title` there to rename the note. Moving or renaming a file, or deleting it, doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; `.knotebook/manifest.json` lists every file, so you can check none is missing. If the download stops partway, run `export.curl` again. Edit the markdown in the form read_note_section returns — HTML comments are dropped, and text after one, on its line and on the lines right below it, becomes plain text that can run on into the text after a later comment; leave a blank line after each comment, with nothing after it on its line, to keep the lines below it as markdown — then send each file you changed with `write.curl`, one file per request. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed; `note.curl` writes over its output file even when it fails, so never point it at a copy you still need. The reply's `conflicts` counts the places where the note had also changed or removed what you changed; your text was used there, after the note was saved as a version. Once a file's changes have been written, that copy can't carry more changes: to change the note again, fetch it with `note.curl` and edit the new copy. Sending the same file again returns `unchanged` once everything in it has been applied. A file with no `id` creates a new note; to change it again, fetch it with `note.curl` and the reply's `id`. If you're not sure a new note was created, send the same file again: while this token works, an identical file returns the note it created. A new note goes into the folder given as `folder_id` in its front matter, or else to the top of this token's folder or group, or of your own notes; a token for only notes shared with you can't create notes. A 400 means nothing was written; its `code` says why. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note, or the `folder_id` folder, is gone or you can't see it. A 409 `base_unavailable` means the server can't merge your copy — it was already sent back with other changes, belongs to another note, or is too old: keep your changes, fetch the note again and redo them there. A 409 `not_mergeable` means this note can't be written back as a file: change it with edit_note. A 413 `content_too_large` means the file is too big to send; a 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 means too many requests: wait the seconds in `Retry-After`, then send the same request again. A 503 means the server was busy: try again shortly. When you are done, run `revoke.curl`.";
/** §14.3 write */
const SPEC_CURL_WRITE = "curl -sS --fail-with-body -X PUT -H \"Authorization: Bearer <t>\" -H \"Content-Type: text/markdown; charset=utf-8\" --data-binary @- \"<origin>/api/transfer/notes\" < \"<file>\"";

describe("create_bulk_transfer_token 的模型面字串", () => {
  it("S1 四段字串（RO description、三個 describe、RO next）逐字等於 spec 原文", () => {
    expect(CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO).toBe(SPEC_DESC_RO);
    expect(BULK_SPACE_DESCRIBE).toBe(SPEC_SPACE);
    expect(BULK_GROUP_ID_DESCRIBE).toBe(SPEC_GROUP);
    expect(BULK_FOLDER_ID_DESCRIBE).toBe(SPEC_FOLDER);
    expect(BULK_NEXT_RO).toBe(SPEC_NEXT_RO);
  });

  it("S2 唯讀描述不提寫回：除了 can't send notes back 之外沒有寫回的字", () => {
    expect(CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO).toContain("This credential can't send notes back.");
    for (const s of [CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO, BULK_NEXT_RO]) {
      for (const bad of ["creates a new note", "PUT", "write.curl", "goes back in its own request", "base_unavailable", "not_mergeable", "Change `title`"]) {
        expect(s, bad).not.toContain(bad);
      }
    }
  });

  it("S3 字面數字與常數對齊：3 支、30 分鐘", () => {
    expect(MAX_ACTIVE_BULK_TOKENS).toBe(3);
    expect(BULK_TRANSFER_TTL_MINUTES).toBe(30);
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toContain(`already has ${MAX_ACTIVE_BULK_TOKENS} bulk transfer tokens`);
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toContain(`(within ${BULK_TRANSFER_TTL_MINUTES} minutes)`);
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toContain("`revoke.curl`");
    expect(CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO).toContain(`at most ${BULK_TRANSFER_TTL_MINUTES} minutes`);
    expect(BULK_RANGE_AMBIGUOUS_MESSAGE).toBe("Pass at most one of `space`, `group_id` and `folder_id`, so no token was created.");
    // PR-3 T3：全文也釘（上面三條 toContain 只守數字與 revoke.curl，改其他字殺不掉）。
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toBe(
      "This credential already has 3 bulk transfer tokens that haven't expired. Wait for one to expire (within 30 minutes), or run the `revoke.curl` of one you no longer need, before asking for another."
    );
  });

  it("S4 curl 範本逐字照 spec §14.3（代入 origin 與權杖）", () => {
    const origin = "https://kb.example";
    const tok = "knbt_TOKEN";
    const sub = (s: string) => s.replaceAll("<t>", tok).replaceAll("<origin>", origin);
    const c = bulkCurls(origin, tok);
    expect(c.export).toEqual({ url: `${origin}/api/transfer/export`, curl: sub(SPEC_CURL_EXPORT) });
    expect(c.note).toEqual({ url: `${origin}/api/transfer/notes/<note_id>`, curl: sub(SPEC_CURL_NOTE) });
    expect(c.revoke).toEqual({ url: `${origin}/api/transfer/token`, curl: sub(SPEC_CURL_REVOKE) });
  });

  it("S5 RW description、RW next 逐字等於 spec 原文", () => {
    expect(CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RW).toBe(SPEC_DESC_RW);
    expect(BULK_NEXT_RW).toBe(SPEC_NEXT_RW);
  });

  it("S6 RW 的字面數字與常數對齊：至多 30 分鐘", () => {
    expect(CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RW).toContain(`at most ${BULK_TRANSFER_TTL_MINUTES} minutes`);
    // RW 沒有其他寫死的數字（額度、上限都不進模型面字串；429 只叫它看 Retry-After）
    expect(BULK_NEXT_RW.match(/\b\d+\b/g)?.filter(n => !["400", "401", "403", "404", "409", "413", "429", "503"].includes(n)) ?? []).toEqual([]);
  });

  it("S7 write.curl 逐字照 spec §14.3（代入 origin 與權杖；檔案由 shell 開 `@- < \"<file>\"`）", () => {
    const origin = "https://kb.example";
    const tok = "knbt_TOKEN";
    const c = bulkCurls(origin, tok);
    expect(c.write).toEqual({ url: `${origin}/api/transfer/notes`, curl: SPEC_CURL_WRITE.replaceAll("<t>", tok).replaceAll("<origin>", origin) });
  });
});
