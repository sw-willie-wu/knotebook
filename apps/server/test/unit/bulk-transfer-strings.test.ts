import { describe, expect, it } from "vitest";
import { BULK_TRANSFER_TTL_MINUTES, MAX_ACTIVE_BULK_TOKENS } from "../../src/auth/transfer-token.js";
import {
  BULK_FOLDER_ID_DESCRIBE,
  BULK_GROUP_ID_DESCRIBE,
  BULK_NEXT_RO,
  BULK_NEXT_RW,
  BULK_RANGE_AMBIGUOUS_MESSAGE,
  BULK_SPACE_DESCRIBE,
  OPEN_NOTES_AS_FILES_DESCRIPTION_RO,
  OPEN_NOTES_AS_FILES_DESCRIPTION_RW,
  TOO_MANY_BULK_TOKENS_MESSAGE,
  bulkCurls,
} from "../../src/mcp/tools/open-notes-as-files.js";
import { EXPORT_BUSY_MESSAGE, exportRateLimitedMessage } from "../../src/routes/transfer.js";
import { EXPORT_BUSY_RETRY_AFTER_S } from "../../src/transfer/export-stream.js";

/** bulk transfer 的模型面字串（S1–S3）：逐字釘住，改一個字就要同步改對應的工具說明。 */

/** 原文。 */
/** RO description */
const SPEC_DESC_RO = "Get a short-lived token that lets shell commands download one or many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them. This credential can't send notes back. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
/** 輸入 `.describe()`：space */
const SPEC_SPACE = "`personal` for only your own notes, or `shared` for only notes others shared with you. Leave out `space`, `group_id` and `folder_id` for every note you can see; pass at most one of them.";
/** 輸入 `.describe()`：group_id */
const SPEC_GROUP = "Only one group's notes: the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.";
/** 輸入 `.describe()`：folder_id */
const SPEC_FOLDER = "Only one folder and the folders inside it, from list_folders.";
/** RO `next` */
const SPEC_NEXT_RO = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. To work on one note, you can skip the download: fetch it with `note.curl` and the note's id. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`. Moving, renaming or deleting a file doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; compare with the manifest to check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed, and a file under a note's old name stays. Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note is gone or you can't see it. A 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives. A 429 whose message says another export is already running: try again after the seconds it gives. Any other 429 means too many requests: wait a minute, then send the same request again. When you are done, run `revoke.curl`.";
/** export */
const SPEC_CURL_EXPORT = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" -o knotebook.tar.gz \"<origin>/api/transfer/export\" && mkdir -p knotebook && tar -xzf knotebook.tar.gz -C knotebook";
/** note */
const SPEC_CURL_NOTE = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/notes/<note_id>\" > \"<output-file>\"";
/** revoke */
const SPEC_CURL_REVOKE = "curl -sS --fail-with-body -X DELETE -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/token\"";
/** RW description */
const SPEC_DESC_RW = "Get a short-lived token that lets shell commands read and write one or many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them; each file you change goes back in its own request. Sending back a file changes the note only in the blocks where your copy differs from what you downloaded. If the note has changed since your download, a changed file is refused and nothing is written: fetch that note again and redo your changes in the new copy. A file with no `id` in its front matter creates a new note. Leaving a file out, or deleting it, deletes nothing. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
/** RW `next`（HTML 註解那句依反例改寫；503 句用 the server；含新增檔 front matter 一句與「usually」） */
const SPEC_NEXT_RW = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. To work on one note, you can skip the download: fetch it with `note.curl` and the note's id. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`: leave those as they are. Change `title` there to rename the note. Moving or renaming a file, or deleting it, doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; `.knotebook/manifest.json` lists every file, so you can check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed and haven't sent back, and a file under a note's old name stays. Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again. Edit the markdown in the form read_note_section returns — HTML comments are dropped, and text after one, on its line and on the lines right below it, becomes plain text that can run on into the text after a later comment; leave a blank line after each comment, with nothing after it on its line, to keep the lines below it as markdown — then send each file you changed with `write.curl`, one file per request. If a command fails, curl exits with an error, and the server's JSON reply is usually in the output file or printed; `note.curl` writes over its output file even when it fails, so never point it at a copy you still need. If the note has changed since your download, a changed file is refused with a 409 `base_unavailable` whose `reason` is `note_changed`, and nothing is written: fetch that note again with `note.curl`, redo your changes in the new copy, and send that. Once a file's changes have been written, that copy can't carry more changes: to change the note again, fetch it with `note.curl` and edit the new copy. Sending the same file again returns `unchanged` once everything in it has been applied. A file with no `id` creates a new note; its `title` and `folder_id` count only in front matter at the top that has a `knotebook:` line, as downloaded files do — otherwise that front matter becomes note text. To change it again, fetch it with `note.curl` and the reply's `id`. If you're not sure a new note was created, send the same file again: while this token works, an identical file returns the note it created. A new note goes into the folder given as `folder_id` in its front matter, or else to the top of this token's folder or group, or of your own notes; a token for only notes shared with you can't create notes. A 400 means nothing was written; its `code` says why. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note, or the `folder_id` folder, is gone or you can't see it. A 409 `base_unavailable` means this copy can't be written back, and the reply's `reason` says why (`note_changed`, `already_sent`, `other_note`, `expired` or `reverted`): keep your changes, fetch the note again with `note.curl` and redo them in the new copy. A 409 `not_mergeable` means this note can't be written back as a file: change it with edit_note. A note marked `tooLargeToSend` in the manifest downloads as a file too big to send back: change it with edit_note. A 413 `content_too_large` means the file is too big to send: change that note with edit_note; a 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives. A 429 whose message says another export is already running: try again after the seconds it gives. Any other 429 means too many requests: wait a minute, then send the same request again. A 503 means the server was busy: try again shortly. When you are done, run `revoke.curl`.";
/** write */
const SPEC_CURL_WRITE = "curl -sS --fail-with-body -X PUT -H \"Authorization: Bearer <t>\" -H \"Content-Type: text/markdown; charset=utf-8\" --data-binary @- \"<origin>/api/transfer/notes\" < \"<file>\"";

describe("open_notes_as_files 的模型面字串", () => {
  it("S1 四段字串（RO description、三個 describe、RO next）逐字", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RO).toBe(SPEC_DESC_RO);
    expect(BULK_SPACE_DESCRIBE).toBe(SPEC_SPACE);
    expect(BULK_GROUP_ID_DESCRIBE).toBe(SPEC_GROUP);
    expect(BULK_FOLDER_ID_DESCRIBE).toBe(SPEC_FOLDER);
    expect(BULK_NEXT_RO).toBe(SPEC_NEXT_RO);
  });

  it("S2 唯讀描述不提寫回：除了 can't send notes back 之外沒有寫回的字", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RO).toContain("This credential can't send notes back.");
    for (const s of [OPEN_NOTES_AS_FILES_DESCRIPTION_RO, BULK_NEXT_RO]) {
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
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RO).toContain(`at most ${BULK_TRANSFER_TTL_MINUTES} minutes`);
    expect(BULK_RANGE_AMBIGUOUS_MESSAGE).toBe("Pass at most one of `space`, `group_id` and `folder_id`, so no token was created.");
    // 全文也釘（上面三條 toContain 只守數字與 revoke.curl，改其他字殺不掉）。
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toBe(
      "This credential already has 3 bulk transfer tokens that haven't expired. Wait for one to expire (within 30 minutes), or run the `revoke.curl` of one you no longer need, before asking for another."
    );
  });

  it("S4 curl 範本逐字（代入 origin 與權杖）", () => {
    const origin = "https://kb.example";
    const tok = "knbt_TOKEN";
    const sub = (s: string) => s.replaceAll("<t>", tok).replaceAll("<origin>", origin);
    const c = bulkCurls(origin, tok);
    expect(c.export).toEqual({ url: `${origin}/api/transfer/export`, curl: sub(SPEC_CURL_EXPORT) });
    expect(c.note).toEqual({ url: `${origin}/api/transfer/notes/<note_id>`, curl: sub(SPEC_CURL_NOTE) });
    expect(c.revoke).toEqual({ url: `${origin}/api/transfer/token`, curl: sub(SPEC_CURL_REVOKE) });
  });

  it("S5 RW description、RW next 逐字", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RW).toBe(SPEC_DESC_RW);
    expect(BULK_NEXT_RW).toBe(SPEC_NEXT_RW);
  });

  // #417：單篇用 `note.curl` 抓的檔沒有 manifest，也就沒有 `tooLargeToSend` 標記——413 句要自己給出路，
  // 舊的「too big to send;」句尾沒有出路，釘它不在。跳過下載那句兩版都有（`note.curl` 兩版都給，抓到的檔自帶 base）。
  it("#417：413 content_too_large 給出路（edit_note）；兩版 next 都說單篇可以不下載", () => {
    expect(BULK_NEXT_RW).toContain("A 413 `content_too_large` means the file is too big to send: change that note with edit_note;");
    expect(BULK_NEXT_RW).not.toContain("too big to send;");
    for (const s of [BULK_NEXT_RW, BULK_NEXT_RO]) {
      expect(s).toContain("To work on one note, you can skip the download: fetch it with `note.curl` and the note's id.");
    }
  });

  // curl 指令沒有 `-i`／`-D`，模型看不到 `Retry-After`：兩版 next 都不得叫它看 header；429 依訊息分三種，
  // 整包額度用完指向 `note.curl`；引用的訊息片段要真的出現在伺服器的訊息裡（改訊息時這裡會紅）。
  it("429 依 curl 印得出來的訊息給出路，不叫模型看 Retry-After；之後的變更用 note.curl 拿", () => {
    for (const s of [BULK_NEXT_RW, BULK_NEXT_RO]) {
      expect(s).not.toContain("Retry-After");
      expect(s).toContain("A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives.");
      expect(s).toContain("A 429 whose message says another export is already running: try again after the seconds it gives.");
      expect(s).toContain("Any other 429 means too many requests: wait a minute, then send the same request again.");
      expect(s).toContain("Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again.");
      expect(s).not.toContain("already running: try again shortly");
    }
    // `next` 引用的片段逐字出現在伺服器訊息裡；訊息真的給了 next 說的分鐘數、秒數。
    expect(exportRateLimitedMessage(60_000)).toContain("You've reached your hourly limit for full downloads;");
    expect(exportRateLimitedMessage(60_000)).toMatch(/ in \d+ minutes?, /);
    expect(EXPORT_BUSY_MESSAGE).toContain("Another export is already running.");
    expect(EXPORT_BUSY_MESSAGE).toContain(`Try again in ${EXPORT_BUSY_RETRY_AFTER_S} seconds.`);
    for (const c of Object.values(bulkCurls("https://kb.example", "knbt_TOKEN"))) expect(c.curl).not.toMatch(/ -(i|D)\b|--include|--dump-header/);
  });

  it("S6 RW 的字面數字與常數對齊：至多 30 分鐘", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RW).toContain(`at most ${BULK_TRANSFER_TTL_MINUTES} minutes`);
    // RW 沒有其他寫死的數字（額度、上限都不進模型面字串；整包額度的等待分鐘數由 429 的訊息給）
    expect(BULK_NEXT_RW.match(/\b\d+\b/g)?.filter(n => !["400", "401", "403", "404", "409", "413", "429", "503"].includes(n)) ?? []).toEqual([]);
  });

  it("S8（不再合併）RW 字串講「動過就拒、重新下載重做」，不再提合併、衝突、存版或舊成因", () => {
    for (const s of [OPEN_NOTES_AS_FILES_DESCRIPTION_RW, BULK_NEXT_RW]) {
      // `not_mergeable` 是錯誤碼（照舊），所以「merge」用字邊界比。
      expect(s).not.toMatch(/\bmerg(?:e|ed|es|ing)\b/);
      for (const bad of ["conflict", "saved as a version", "your text is used", "your text was used", "anchors_gone", "blocks others added"]) expect(s, bad).not.toContain(bad);
      expect(s).toContain("If the note has changed since your download, a changed file is refused");
    }
    expect(BULK_NEXT_RW).toContain("whose `reason` is `note_changed`, and nothing is written: fetch that note again with `note.curl`, redo your changes in the new copy, and send that.");
    expect(BULK_NEXT_RW).toContain("(`note_changed`, `already_sent`, `other_note`, `expired` or `reverted`)");
  });

  it("S7 write.curl 逐字（代入 origin 與權杖；檔案由 shell 開 `@- < \"<file>\"`）", () => {
    const origin = "https://kb.example";
    const tok = "knbt_TOKEN";
    const c = bulkCurls(origin, tok);
    expect(c.write).toEqual({ url: `${origin}/api/transfer/notes`, curl: SPEC_CURL_WRITE.replaceAll("<t>", tok).replaceAll("<origin>", origin) });
  });
});
