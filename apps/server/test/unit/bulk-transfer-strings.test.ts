import { describe, expect, it } from "vitest";
import { BULK_TRANSFER_TTL_MINUTES, MAX_ACTIVE_BULK_TOKENS } from "../../src/auth/transfer-token.js";
import {
  BULK_FOLDER_ID_DESCRIBE,
  BULK_GROUP_ID_DESCRIBE,
  BULK_NEXT_RO,
  BULK_RANGE_AMBIGUOUS_MESSAGE,
  BULK_SPACE_DESCRIBE,
  CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO,
  TOO_MANY_BULK_TOKENS_MESSAGE,
  bulkCurls,
} from "../../src/mcp/tools/create-bulk-transfer-token.js";

/** bulk transfer spec §14.2、§14.3；plan T8 S1–S3、§0.1-13。模型面字串逐字照 spec，改一個字要回 spec（全域 model-facing-string-claims）。 */

/** spec docs/superpowers/specs/2026-11-02-mcp-bulk-transfer-design.md §14.2 原文（由 scratchpad 的 wb1-t8-gen.py 從 spec 抽出貼上）。 */
/** 第 551 行 */
const SPEC_DESC_RO = "Get a short-lived token that lets shell commands download many notes as files. One download gives you, as a .tar.gz of markdown files in the same folders as the sidebar, every note you can see outside the trash, or only your own notes, notes shared with you, one group's or one folder's; another command fetches the latest copy of one of them. This credential can't send notes back. The token works until `expiresAt`, at most 30 minutes; the result has ready `curl` commands: send the token only to those addresses, in the `Authorization` header.";
/** 第 554 行 */
const SPEC_SPACE = "`personal` for only your own notes, or `shared` for only notes others shared with you. Leave out `space`, `group_id` and `folder_id` for every note you can see; pass at most one of them.";
/** 第 555 行 */
const SPEC_GROUP = "Only one group's notes: the `id` in the `owner` of its notes in list_notes or search_notes, or the `groupId` in a folder's `space`.";
/** 第 556 行 */
const SPEC_FOLDER = "Only one folder and the folders inside it, from list_folders.";
/** 第 564 行 */
const SPEC_NEXT_RO = "Run `export.curl`; it unpacks the notes into a `knotebook` folder. Each note is a markdown file whose front matter, between the `---` lines at the top, holds its `id`, `role` and `base`. Moving, renaming or deleting a file doesn't move, rename or delete the note. `.knotebook/manifest.json` lists each folder's `id` and each note's file. On Windows, run these commands in Git Bash or WSL: they are POSIX shell commands, and the Windows `tar.exe` skips files whose names it can't represent; compare with the manifest to check none is missing. If the download stops partway, run `export.curl` again. Fetch the latest copy of one note with `note.curl`. If a command fails, curl exits with an error, and the server's JSON reply is in the output file or printed. A 401 means the token can't be used: ask for a new one. A 403 means this token, or your role in that note, doesn't allow it. A 404 means the note is gone or you can't see it. A 413 `too_many_notes` means the download is too big: ask for a token with `space`, `group_id` or `folder_id`. A 429 means too many requests: wait the seconds in `Retry-After`, then send the same request again. When you are done, run `revoke.curl`.";
/** 第 571 行 */
const SPEC_CURL_EXPORT = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" -o knotebook.tar.gz \"<origin>/api/transfer/export\" && mkdir -p knotebook && tar -xzf knotebook.tar.gz -C knotebook";
/** 第 572 行 */
const SPEC_CURL_NOTE = "curl -sS --fail-with-body -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/notes/<note_id>\" > \"<output-file>\"";
/** 第 574 行 */
const SPEC_CURL_REVOKE = "curl -sS --fail-with-body -X DELETE -H \"Authorization: Bearer <t>\" \"<origin>/api/transfer/token\"";

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
});
