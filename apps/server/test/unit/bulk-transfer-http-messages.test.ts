import { describe, expect, it } from "vitest";
import {
  BULK_TRANSFER_INVALID_MESSAGE,
  BULK_TRANSFER_PAT_MESSAGE,
  BULK_TRANSFER_REQUIRED_MESSAGE,
  TRANSFER_INVALID_MESSAGE,
  TRANSFER_PAT_MESSAGE,
  TRANSFER_PURPOSE_MESSAGE,
} from "../../src/auth/transfer-auth.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../../src/folders/messages.js";
import {
  BASE_UNAVAILABLE_MESSAGES,
  EXPORT_BUSY_MESSAGE,
  INVALID_UTF8_MESSAGE,
  NOT_IN_RANGE_MESSAGE,
  NOT_MERGEABLE_MESSAGE,
  RANGE_GONE_MESSAGE,
  TOO_MANY_NOTES_MESSAGE,
  TRANSFER_NOTE_NOT_FOUND_MESSAGE,
  TRANSFER_RATE_LIMITED_MESSAGE,
  transferParseMessage,
} from "../../src/routes/transfer.js";
import {
  CREATE_IN_SHARED_FORBIDDEN_MESSAGE,
  DEST_NOT_IN_RANGE_MESSAGE,
  GROUP_CREATE_FORBIDDEN_MESSAGE,
  SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE,
} from "../../src/transfer/create-file.js";
import { UNCLOSED_FENCE_MESSAGE, unclosedFenceMessage } from "../../src/transfer/regions.js";

/**
 * bulk transfer spec §12.2（HTTP 層訊息、英文碼；#372 起訊息也是英文）；PR-3 plan T3、§0.1-5 守衛第一層：以**字面字串**釘住 bulk 端點的 HTTP 層與 auth 層
 * 訊息常數（agent 經 curl 讀到的就是 JSON 的 `message`）。「哪條路由用哪個常數」由整合測試匯入常數比對（第二層，各案名帶常數名）。
 * 行內字面（不是常數）的句子——「You don't have edit access to this note.」「This token's scope doesn't allow this action.」
 * 「The server is busy. Try again in a moment.」「Too many requests. Wait a moment and try again.」「Not signed in.」（bulk 端點收到非 Bearer
 * 的 Authorization）「This request needs Content-Type text/markdown.」「Origin check failed: …」——在整合測試以字面斷言
 * （`transfer-write.test.ts` W9／W11、`transfer-bulk-auth.test.ts` A2／A12、
 * `transfer-write-auth.test.ts` W-A6／W-A7）；frontmatter 的八句在 `transfer-frontmatter-read.test.ts` 以字面斷言。
 * 413 `content_too_large` 走全域 errorHandler 的 `BODY_TOO_LARGE_MESSAGE`（`http/errors.ts`，#372），不在這裡。
 */
describe("bulk transfer 的 HTTP 層訊息（字面）", () => {
  it("H1 auth 層：bulk 專用句與 #200 句分開", () => {
    expect(BULK_TRANSFER_INVALID_MESSAGE).toBe("The transfer token is invalid, expired or revoked. Get a new one from the MCP tool create_bulk_transfer_token.");
    expect(BULK_TRANSFER_INVALID_MESSAGE).not.toContain("used");
    expect(BULK_TRANSFER_REQUIRED_MESSAGE).toBe("A transfer token is required.");
    expect(BULK_TRANSFER_PAT_MESSAGE).toBe("This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool create_bulk_transfer_token.");
    expect(TRANSFER_PURPOSE_MESSAGE).toBe("This transfer token can't be used for this action.");
    // #200 的兩句：本 PR 不動（W11）；#372 改英文
    expect(TRANSFER_INVALID_MESSAGE).toBe("The transfer token is invalid, expired or already used.");
    expect(TRANSFER_PAT_MESSAGE).toBe("This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool create_transfer_token.");
  });

  it("H2 路由層（routes/transfer.ts）", () => {
    expect(RANGE_GONE_MESSAGE).toBe("The group or folder this transfer token covers is no longer visible to you.");
    expect(NOT_IN_RANGE_MESSAGE).toBe("This note isn't in this transfer token's range.");
    expect(TRANSFER_NOTE_NOT_FOUND_MESSAGE).toBe("No note with that id.");
    expect(TRANSFER_RATE_LIMITED_MESSAGE).toBe("Too many requests. Wait a moment and try again.");
    expect(EXPORT_BUSY_MESSAGE).toBe("Another export is already running. Try again in a moment.");
    expect(TOO_MANY_NOTES_MESSAGE).toBe("The range has more than 3000 notes. Ask for a token with a smaller range.");
    expect(INVALID_UTF8_MESSAGE).toBe("The file isn't valid UTF-8.");
    expect(BASE_UNAVAILABLE_MESSAGES).toEqual({
      already_sent: "Can't write back with this copy: it has already been sent back with different content. Download the note again and make your changes there.",
      other_note: "Can't write back with this copy: its base belongs to another note or another user. Download the note again and make your changes there.",
      expired: "Can't write back with this copy: the server no longer has its base (it is too old or no longer valid). Download the note again and make your changes there.",
      note_changed: "Can't write back with this copy: the note has changed (its title or text) since you downloaded it. Download this note again (the note command), redo your changes in the new copy and send that.",
      reverted: "Can't write back with this copy: the changes it wrote back have been reverted. Download the note again and make your changes there.",
    });
    // 第三輪不再合併：任何一句都不得再說「合併」（#372 起英文：merge），也不得留下舊成因 anchors_gone。
    for (const m of Object.values(BASE_UNAVAILABLE_MESSAGES)) expect(m).not.toMatch(/merg/i);
    expect(Object.keys(BASE_UNAVAILABLE_MESSAGES)).not.toContain("anchors_gone");
    expect(NOT_MERGEABLE_MESSAGE).toBe("This note can't be written back from a file. Change it with edit_note instead.");
  });

  it("H3 新增筆記的落點（transfer/create-file.ts＋借用的 folders/messages.ts）", () => {
    expect(CREATE_IN_SHARED_FORBIDDEN_MESSAGE).toBe("A transfer token for only notes shared with you can't create notes.");
    expect(DEST_NOT_IN_RANGE_MESSAGE).toBe("The new note's location isn't in this transfer token's range.");
    expect(SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE).toBe("New notes can't go in your folders for notes shared with you.");
    expect(GROUP_CREATE_FORBIDDEN_MESSAGE).toBe("Your role in this group can't create notes.");
    expect(FOLDER_NOT_FOUND_MESSAGE).toBe("No folder with that id.");
    expect(NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE).toBe("Your role in this group can't put notes in folders.");
  });

  it("H4 未閉合 code fence（transfer/regions.ts）", () => {
    expect(UNCLOSED_FENCE_MESSAGE).toBe(
      "A line you added or changed opens a code block with ``` that is never closed, so everything from that line to the end of the file counts as code. Add a closing ``` (or use inline `code`) and send the file again."
    );
  });
});

describe("H3 檔案寫回的 400 訊息依成因（8000 探索測試 E）", () => {
  it("unsupported_block 三種成因、empty_content 兩種、too_many_blocks 帶上限、未閉合 fence 照實際記號", () => {
    expect(transferParseMessage("unsupported_block", "event_attr")).toBe("The file has HTML with an event attribute (such as onerror or onclick), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "editor_internal")).toBe("The file has HTML the editor uses internally (such as an element with data-content-type), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "dropped_element")).toBe("The file has an element the editor drops along with its content (such as <script>, <style> or <iframe>), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "unknown_block")).toBe("The file has an element the editor doesn't support, which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("empty_content", "unclosed_comment")).toBe("A `<!--` has no closing `-->`, so everything after it counts as a comment and there is nothing to store. Add the `-->` and send the file again. Nothing was written.");
    expect(transferParseMessage("empty_content")).toBe("A part of the file has no content once parsed (for example, only HTML comments or blank space), so nothing was written.");
    expect(transferParseMessage("too_many_blocks")).toBe("The content is over a note's limit of 2000 blocks (nested blocks count too), so nothing was written.");
    expect(transferParseMessage("invalid_body", undefined, "~~~")).toBe(unclosedFenceMessage("~~~"));
    expect(unclosedFenceMessage("~~~")).toBe("A line you added or changed opens a code block with ~~~ that is never closed, so everything from that line to the end of the file counts as code. Add a closing ~~~ (or use inline `code`) and send the file again.");
    expect(unclosedFenceMessage("~~~")).not.toContain("```");
  });
});
