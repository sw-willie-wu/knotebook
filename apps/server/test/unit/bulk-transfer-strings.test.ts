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
import { TAGS_PER_NOTE_MAX } from "@knotebook/shared";
import { FILE_TAG_LIMIT_MESSAGE } from "../../src/tags/messages.js";
import { EXPORT_BUSY_MESSAGE, exportRateLimitedMessage } from "../../src/routes/transfer.js";
import { EXPORT_BUSY_RETRY_AFTER_S } from "../../src/transfer/export-stream.js";

/** Model-facing strings of bulk transfer, pinned verbatim: when one changes, update the matching tool description too. */

const SPEC_DESC_RO = "Get a short-lived token that lets shell commands download one or many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them. This credential can't send notes back. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
const SPEC_SPACE = "`personal` for only your own notes, or `shared` for only notes others shared with you. Leave out `space`, `group_id` and `folder_id` for every note you can see; pass at most one of them.";
const SPEC_GROUP = "Only one group's notes: the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.";
const SPEC_FOLDER = "Only one folder and the folders inside it, from list_folders.";
const SPEC_NEXT_RO = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. To work on one note, you can skip the download: fetch it with `note.curl` and the note's id. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role`, `tags` and `base`. Moving, renaming or deleting a file doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; compare with the manifest to check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed, and a file under a note's old name stays. Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note is gone or you can't see it. A 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives. A 429 whose message says another export is already running: try again after the seconds it gives. Any other 429 means too many requests: wait a minute, then send the same request again. When you are done, run `revoke.curl`.";
const SPEC_CURL_EXPORT = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" -o knotebook.tar.gz \"<origin>/api/transfer/export\" && mkdir -p knotebook && tar -xzf knotebook.tar.gz -C knotebook";
const SPEC_CURL_NOTE = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/notes/<note_id>\" > \"<output-file>\"";
const SPEC_CURL_REVOKE = "curl -sS --fail-with-body -X DELETE -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/token\"";
const SPEC_DESC_RW = "Get a short-lived token that lets shell commands read and write one or many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them; each file you change goes back in its own request. Sending back a file changes the note only in the blocks where your copy differs from what you downloaded. If the note has changed since your download, a changed file is refused and nothing is written: fetch that note again and redo your changes in the new copy. A file with no `id` in its front matter creates a new note. Leaving a file out, or deleting it, deletes nothing. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
const SPEC_NEXT_RW = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. To work on one note, you can skip the download: fetch it with `note.curl` and the note's id. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`: leave those as they are. Change `title` there to rename the note. Its `tags` line lists the note's tags as a JSON array: change it to set the note's tags (a name the note's space doesn't have yet is created), or take the line out to leave them as they are. Tags are set only there: a #name in the note's text stays text. Moving or renaming a file, or deleting it, doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; `.knotebook/manifest.json` lists every file, so you can check none is missing. If the download stops partway, run `export.curl` again — but first move or rename the `knotebook` folder: the download writes over its files, including ones you changed and haven't sent back, and a file under a note's old name stays. Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again. Edit the markdown in the form read_note_section returns — a <!-- knotebook:knowledge … --> comment after a heading holds that heading's knowledge info, written as edit_note's markdown describes, and taking it out removes that info; other HTML comments are dropped, and text after one, on its line and on the lines right below it, becomes plain text that can run on into the text after a later comment; leave a blank line after each comment, with nothing after it on its line, to keep the lines below it as markdown — then send each file you changed with `write.curl`, one file per request. If a command fails, curl exits with an error, and the server's JSON reply is usually in the output file or printed; `note.curl` writes over its output file even when it fails, so never point it at a copy you still need. If the note's text or title has changed since your download, a file that changes its text or title is refused with a 409 `base_unavailable` whose `reason` is `note_changed`, and nothing is written; a file that changes the `tags` line is refused the same way only if the note's tags have changed since your download. In either case fetch that note again with `note.curl`, redo your changes in the new copy, and send that. If the reply has `tagsFailed`, the text or title was written but the tags were not: fetch the note again and set the tags in the new copy. Once a file's changes have been written, that copy can't carry more changes: to change the note again, fetch it with `note.curl` and edit the new copy. Sending the same file again returns `unchanged` once everything in it has been applied. A file with no `id` creates a new note; its `title` and `folder_id` count only in front matter at the top that has a `knotebook:` line, as downloaded files do — otherwise that front matter becomes note text. To change it again, fetch it with `note.curl` and the reply's `id`. If you're not sure a new note was created, send the same file again: while this token works, an identical file returns the note it created. A new note goes into the folder given as `folder_id` in its front matter, or else to the top of this token's folder or group, or of your own notes; a token for only notes shared with you can't create notes. A 400 means nothing was written; its `code` says why. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it; changing the tags needs edit rights in the note's own space, not through a share. A 404 means the note, or the `folder_id` folder, is gone or you can't see it. A 409 `base_unavailable` means this copy can't be written back, and the reply's `reason` says why (`note_changed`, `already_sent`, `other_note`, `expired` or `reverted`): keep your changes, fetch the note again with `note.curl` and redo them in the new copy. A 409 `tag_limit_reached` means the file's `tags` line lists more tags than a note, or its space, can have; a 409 `conflict` means the note moved to another space while the file was being sent; nothing is written in either case. A 409 `not_mergeable` means this note can't be written back as a file: change it with edit_note. A note marked `tooLargeToSend` in the manifest downloads as a file too big to send back: change it with edit_note. A 413 `content_too_large` means the file is too big to send: change that note with edit_note; a 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives. A 429 whose message says another export is already running: try again after the seconds it gives. Any other 429 means too many requests: wait a minute, then send the same request again. A 503 means the server was busy: try again shortly. When you are done, run `revoke.curl`.";
const SPEC_CURL_WRITE = "curl -sS --fail-with-body -X PUT -H \"Authorization: Bearer <t>\" -H \"Content-Type: text/markdown; charset=utf-8\" --data-binary @- \"<origin>/api/transfer/notes\" < \"<file>\"";

describe("open_notes_as_files model-facing strings", () => {
  it("four strings (RO description, three describes, RO next) verbatim", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RO).toBe(SPEC_DESC_RO);
    expect(BULK_SPACE_DESCRIBE).toBe(SPEC_SPACE);
    expect(BULK_GROUP_ID_DESCRIBE).toBe(SPEC_GROUP);
    expect(BULK_FOLDER_ID_DESCRIBE).toBe(SPEC_FOLDER);
    expect(BULK_NEXT_RO).toBe(SPEC_NEXT_RO);
  });

  it("read-only description does not mention writing back: no write-back wording other than the can't-send-notes-back sentence", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RO).toContain("This credential can't send notes back.");
    for (const s of [OPEN_NOTES_AS_FILES_DESCRIPTION_RO, BULK_NEXT_RO]) {
      for (const bad of ["creates a new note", "PUT", "write.curl", "goes back in its own request", "base_unavailable", "not_mergeable", "Change `title`"]) {
        expect(s, bad).not.toContain(bad);
      }
    }
  });

  it("literal numbers match the constants: 3 tokens, 30 minutes", () => {
    expect(MAX_ACTIVE_BULK_TOKENS).toBe(3);
    expect(BULK_TRANSFER_TTL_MINUTES).toBe(30);
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toContain(`already has ${MAX_ACTIVE_BULK_TOKENS} bulk transfer tokens`);
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toContain(`(within ${BULK_TRANSFER_TTL_MINUTES} minutes)`);
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toContain("`revoke.curl`");
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RO).toContain(`at most ${BULK_TRANSFER_TTL_MINUTES} minutes`);
    expect(BULK_RANGE_AMBIGUOUS_MESSAGE).toBe("Pass at most one of `space`, `group_id` and `folder_id`, so no token was created.");
    // Pin the whole text too: the toContain checks above cover only the numbers and revoke.curl.
    expect(TOO_MANY_BULK_TOKENS_MESSAGE).toBe(
      "This credential already has 3 bulk transfer tokens that haven't expired. Wait for one to expire (within 30 minutes), or run the `revoke.curl` of one you no longer need, before asking for another."
    );
  });

  it("the tag limit message for a file names the same limit as TAGS_PER_NOTE_MAX", () => {
    expect(FILE_TAG_LIMIT_MESSAGE).toBe(`The file lists more than ${TAGS_PER_NOTE_MAX} different tags; a note can have at most ${TAGS_PER_NOTE_MAX}.`);
  });

  it("curl templates verbatim (origin and token substituted)", () => {
    const origin = "https://kb.example";
    const tok = "knbt_TOKEN";
    const sub = (s: string) => s.replaceAll("<t>", tok).replaceAll("<origin>", origin);
    const c = bulkCurls(origin, tok);
    expect(c.export).toEqual({ url: `${origin}/api/transfer/export`, curl: sub(SPEC_CURL_EXPORT) });
    expect(c.note).toEqual({ url: `${origin}/api/transfer/notes/<note_id>`, curl: sub(SPEC_CURL_NOTE) });
    expect(c.revoke).toEqual({ url: `${origin}/api/transfer/token`, curl: sub(SPEC_CURL_REVOKE) });
  });

  it("RW description and RW next verbatim", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RW).toBe(SPEC_DESC_RW);
    expect(BULK_NEXT_RW).toBe(SPEC_NEXT_RW);
  });

  // #417: a file fetched singly with `note.curl` has no manifest, hence no `tooLargeToSend` marker, so the 413 sentence has to give
  // the way out itself; the old "too big to send;" ending had none, and this pins that it is gone. Both versions of next contain the skip-the-download sentence (`note.curl` is offered in both, and the fetched file carries its own base).
  it("#417: 413 content_too_large gives a way out (edit_note); both versions of next say a single note can skip the download", () => {
    expect(BULK_NEXT_RW).toContain("A 413 `content_too_large` means the file is too big to send: change that note with edit_note;");
    expect(BULK_NEXT_RW).not.toContain("too big to send;");
    for (const s of [BULK_NEXT_RW, BULK_NEXT_RO]) {
      expect(s).toContain("To work on one note, you can skip the download: fetch it with `note.curl` and the note's id.");
    }
  });

  // The curl commands use no `-i`/`-D`, so the model can't see `Retry-After`: neither version of next may tell it to look at a header.
  // The 429 has three message variants; the whole-download quota one points to `note.curl`. Quoted message fragments must really appear in the server's messages (fails when a message changes).
  it("429 gives a way out based on messages curl can print, and never tells the model to look at Retry-After; later changes are fetched with note.curl", () => {
    for (const s of [BULK_NEXT_RW, BULK_NEXT_RO]) {
      expect(s).not.toContain("Retry-After");
      expect(s).toContain("A 429 whose message says you've reached your hourly limit for full downloads: fetch the notes you need with `note.curl` (their ids are in an earlier download's front matter or manifest, or in list_notes or search_notes), or download again after the minutes it gives.");
      expect(s).toContain("A 429 whose message says another export is already running: try again after the seconds it gives.");
      expect(s).toContain("Any other 429 means too many requests: wait a minute, then send the same request again.");
      expect(s).toContain("Downloads are limited per hour: to get later changes, fetch those notes with `note.curl` instead of running `export.curl` again.");
      expect(s).not.toContain("already running: try again shortly");
    }
    // Fragments quoted by `next` appear verbatim in the server messages, and the messages really give the minutes and seconds that next mentions.
    expect(exportRateLimitedMessage(60_000)).toContain("You've reached your hourly limit for full downloads;");
    expect(exportRateLimitedMessage(60_000)).toMatch(/ in \d+ minutes?, /);
    expect(EXPORT_BUSY_MESSAGE).toContain("Another export is already running.");
    expect(EXPORT_BUSY_MESSAGE).toContain(`Try again in ${EXPORT_BUSY_RETRY_AFTER_S} seconds.`);
    for (const c of Object.values(bulkCurls("https://kb.example", "knbt_TOKEN"))) expect(c.curl).not.toMatch(/ -(i|D)\b|--include|--dump-header/);
  });

  it("RW next describes the tags line and the knowledge comment; RO next lists tags in the front matter and says nothing of knowledge", () => {
    expect(BULK_NEXT_RW).toContain("Its `tags` line lists the note's tags as a JSON array: change it to set the note's tags (a name the note's space doesn't have yet is created), or take the line out to leave them as they are. Tags are set only there: a #name in the note's text stays text.");
    expect(BULK_NEXT_RW).toContain("a <!-- knotebook:knowledge … --> comment after a heading holds that heading's knowledge info, written as edit_note's markdown describes, and taking it out removes that info; other HTML comments are dropped");
    expect(BULK_NEXT_RW).toContain("changing the tags needs edit rights in the note's own space, not through a share.");
    expect(BULK_NEXT_RO).toContain("holds its `id`, `role`, `tags` and `base`.");
    expect(BULK_NEXT_RO).not.toContain("knowledge");
  });

  it("RW literal numbers match the constants: at most 30 minutes", () => {
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RW).toContain(`at most ${BULK_TRANSFER_TTL_MINUTES} minutes`);
    // RW has no other hard-coded numbers (quota and limits stay out of model-facing strings; the wait in minutes for the whole-download quota comes from the 429 message)
    expect(BULK_NEXT_RW.match(/\b\d+\b/g)?.filter(n => !["400", "401", "403", "404", "409", "413", "429", "503"].includes(n)) ?? []).toEqual([]);
  });

  it("RW string says a changed file is refused and to re-download and redo, and no longer mentions merging, conflicts, versions or the old causes", () => {
    for (const s of [OPEN_NOTES_AS_FILES_DESCRIPTION_RW, BULK_NEXT_RW]) {
      // `not_mergeable` is an error code (unchanged), so match "merge" on word boundaries.
      expect(s).not.toMatch(/\bmerg(?:e|ed|es|ing)\b/);
      for (const bad of ["merge conflict", "saved as a version", "your text is used", "your text was used", "anchors_gone", "blocks others added"]) expect(s, bad).not.toContain(bad);
    }
    expect(OPEN_NOTES_AS_FILES_DESCRIPTION_RW).toContain("If the note has changed since your download, a changed file is refused");
    expect(BULK_NEXT_RW).toContain("If the note's text or title has changed since your download, a file that changes its text or title is refused with a 409 `base_unavailable` whose `reason` is `note_changed`, and nothing is written; a file that changes the `tags` line is refused the same way only if the note's tags have changed since your download. In either case fetch that note again with `note.curl`, redo your changes in the new copy, and send that.");
    expect(BULK_NEXT_RW).toContain("If the reply has `tagsFailed`, the text or title was written but the tags were not: fetch the note again and set the tags in the new copy.");
    expect(BULK_NEXT_RW).toContain("(`note_changed`, `already_sent`, `other_note`, `expired` or `reverted`)");
  });

  it("write.curl verbatim (origin and token substituted; the shell opens the file with @- < <file>)", () => {
    const origin = "https://kb.example";
    const tok = "knbt_TOKEN";
    const c = bulkCurls(origin, tok);
    expect(c.write).toEqual({ url: `${origin}/api/transfer/notes`, curl: SPEC_CURL_WRITE.replaceAll("<t>", tok).replaceAll("<origin>", origin) });
  });
});
