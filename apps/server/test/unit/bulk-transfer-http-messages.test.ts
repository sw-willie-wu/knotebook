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
  NEW_NOTE_TAGS_FORBIDDEN_MESSAGE,
  NOT_IN_RANGE_MESSAGE,
  NOT_MERGEABLE_MESSAGE,
  RANGE_GONE_MESSAGE,
  TAGS_CHANGE_FORBIDDEN_MESSAGE,
  TAGS_CONFLICT_MESSAGE,
  TOO_MANY_NOTES_MESSAGE,
  TRANSFER_NOTE_NOT_FOUND_MESSAGE,
  TRANSFER_RATE_LIMITED_MESSAGE,
  exportRateLimitedMessage,
  transferParseMessage,
} from "../../src/routes/transfer.js";
import {
  CREATE_IN_SHARED_FORBIDDEN_MESSAGE,
  DEST_NOT_IN_RANGE_MESSAGE,
  GROUP_CREATE_FORBIDDEN_MESSAGE,
  SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE,
} from "../../src/transfer/create-file.js";
import { UNCLOSED_FENCE_MESSAGE, unclosedFenceMessage } from "../../src/transfer/regions.js";
import { EXPORT_BUSY_RETRY_AFTER_S } from "../../src/transfer/export-stream.js";

/**
 * HTTP-layer messages of bulk transfer (English since #372). First guard layer: pins the bulk endpoints' HTTP-layer and auth-layer message
 * constants as literal strings (an agent reading over curl sees the JSON `message`). Which route uses which constant is checked by integration
 * tests that import the constants (second layer; their case names carry the constant name).
 * Inline literal sentences (not constants), such as the no-edit-access, token-scope, server-busy, rate-limit, not-signed-in (non-Bearer
 * Authorization on a bulk endpoint), Content-Type and Origin-check sentences, are asserted literally in integration tests
 * (`transfer-write.test.ts`, `transfer-bulk-auth.test.ts`, `transfer-write-auth.test.ts`); the eight frontmatter sentences in
 * `test/unit/transfer-frontmatter-read.test.ts`.
 * 413 `content_too_large` goes through the global errorHandler's `BODY_TOO_LARGE_MESSAGE` (`http/errors.ts`, #372), so it is not covered here.
 */
describe("bulk transfer HTTP-layer messages (literal)", () => {
  it("auth layer: the bulk-specific sentence is separate from the #200 sentence", () => {
    expect(BULK_TRANSFER_INVALID_MESSAGE).toBe("The transfer token is invalid, expired or revoked. Get a new one from the MCP tool open_notes_as_files.");
    expect(BULK_TRANSFER_INVALID_MESSAGE).not.toContain("used");
    expect(BULK_TRANSFER_REQUIRED_MESSAGE).toBe("A transfer token is required.");
    expect(BULK_TRANSFER_PAT_MESSAGE).toBe("This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool open_notes_as_files.");
    expect(TRANSFER_PURPOSE_MESSAGE).toBe("This transfer token can't be used for this action.");
    // The two #200 sentences.
    expect(TRANSFER_INVALID_MESSAGE).toBe("The transfer token is invalid, expired or already used.");
    expect(TRANSFER_PAT_MESSAGE).toBe("This endpoint doesn't accept API tokens. Get a transfer token from the MCP tool create_transfer_token.");
  });

  it("route layer (routes/transfer.ts)", () => {
    expect(RANGE_GONE_MESSAGE).toBe("The group or folder this transfer token covers is no longer visible to you.");
    expect(NOT_IN_RANGE_MESSAGE).toBe("This note isn't in this transfer token's range.");
    expect(TRANSFER_NOTE_NOT_FOUND_MESSAGE).toBe("No note with that id.");
    expect(TRANSFER_RATE_LIMITED_MESSAGE).toBe("Too many requests. Wait a moment and try again.");
    // Busy: the seconds are written into the message (curl doesn't print Retry-After), using the same constant as the header.
    expect(EXPORT_BUSY_MESSAGE).toBe("Another export is already running. Try again in 30 seconds.");
    expect(EXPORT_BUSY_MESSAGE).toContain(`in ${EXPORT_BUSY_RETRY_AFTER_S} seconds`);
    // Hourly whole-download quota used up: the wait in minutes is in the message, rounded up and at least 1; it says the quota is per person (a new token does not reset it) and that the token may have expired by then; the code is still too_many_requests.
    expect(exportRateLimitedMessage(37 * 60_000)).toBe(
      "You've reached your hourly limit for full downloads; it counts per person, so a new token won't reset it. Download again in 37 minutes, with a new token if this one has expired by then; until then, fetch the notes you need one by one with the note command, which doesn't count toward this limit."
    );
    expect(exportRateLimitedMessage(1_000)).toContain(" in 1 minute, ");
    expect(exportRateLimitedMessage(0)).toContain(" in 1 minute, ");
    expect(exportRateLimitedMessage(60_000)).toContain(" in 1 minute, ");
    expect(exportRateLimitedMessage(60_001)).toContain(" in 2 minutes, ");
    expect(exportRateLimitedMessage(59 * 60_000 + 1_000)).toContain(" in 60 minutes, ");
    expect(exportRateLimitedMessage(3_600_000)).toContain(" in 60 minutes, ");
    expect(exportRateLimitedMessage(37 * 60_000)).not.toBe(TRANSFER_RATE_LIMITED_MESSAGE);
    expect(TOO_MANY_NOTES_MESSAGE).toBe("The range has more than 3000 notes. Ask for a token with a smaller range.");
    expect(INVALID_UTF8_MESSAGE).toBe("The file isn't valid UTF-8.");
    expect(BASE_UNAVAILABLE_MESSAGES).toEqual({
      already_sent: "Can't write back with this copy: it has already been sent back with different content. Download the note again and make your changes there.",
      other_note: "Can't write back with this copy: its base belongs to another note or another user. Download the note again and make your changes there.",
      expired: "Can't write back with this copy: the server no longer has its base (it is too old or no longer valid). Download the note again and make your changes there.",
      note_changed: "Can't write back with this copy: the note has changed (its title or text) since you downloaded it. Download this note again (the note command), redo your changes in the new copy and send that.",
      reverted: "Can't write back with this copy: the changes it wrote back have been reverted. Download the note again and make your changes there.",
    });
    // No more merging: no sentence may say "merge" (English since #372), and the old cause anchors_gone must not remain.
    for (const m of Object.values(BASE_UNAVAILABLE_MESSAGES)) expect(m).not.toMatch(/merg/i);
    expect(Object.keys(BASE_UNAVAILABLE_MESSAGES)).not.toContain("anchors_gone");
    expect(NOT_MERGEABLE_MESSAGE).toBe("This note can't be written back from a file. Change it with edit_note instead.");
  });

  it("tags (routes/transfer.ts)", () => {
    expect(TAGS_CHANGE_FORBIDDEN_MESSAGE).toBe(
      "You can't change this note's tags: that needs edit rights in the note's own space, not through a share. Leave the tags line as it was downloaded, or take it out.",
    );
    expect(TAGS_CONFLICT_MESSAGE).toBe("The note moved to another space while the file was being sent, so its tags were not changed. Fetch the note again.");
    expect(NEW_NOTE_TAGS_FORBIDDEN_MESSAGE).toBe(
      "Your role in this group can't set a new note's tags: that needs edit rights in the group. Take the tags line out of the file, or leave it empty.",
    );
  });

  it("where a new note lands (transfer/create-file.ts plus the borrowed folders/messages.ts)", () => {
    expect(CREATE_IN_SHARED_FORBIDDEN_MESSAGE).toBe("A transfer token for only notes shared with you can't create notes.");
    expect(DEST_NOT_IN_RANGE_MESSAGE).toBe("The new note's location isn't in this transfer token's range.");
    expect(SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE).toBe("New notes can't go in your folders for notes shared with you.");
    expect(GROUP_CREATE_FORBIDDEN_MESSAGE).toBe("Your role in this group can't create notes.");
    expect(FOLDER_NOT_FOUND_MESSAGE).toBe("No folder with that id.");
    expect(NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE).toBe("Your role in this group can't put notes in folders.");
  });

  it("unclosed code fence (transfer/regions.ts)", () => {
    expect(UNCLOSED_FENCE_MESSAGE).toBe(
      "A line you added or changed opens a code block with ``` that is never closed, so everything from that line to the end of the file counts as code. Add a closing ``` (or use inline `code`) and send the file again."
    );
  });
});

describe("file write-back 400 messages by cause", () => {
  it("unsupported_block has three causes, empty_content two, too_many_blocks carries the limit, an unclosed fence uses the actual marker", () => {
    expect(transferParseMessage("unsupported_block", "event_attr")).toBe("The file has HTML with an event attribute (such as onerror or onclick), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "editor_internal")).toBe("The file has HTML the editor uses internally (such as an element with data-content-type), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "dropped_element")).toBe("The file has an element the editor drops along with its content (such as <script>, <style> or <iframe>), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "nested_paragraph")).toBe("The file has a paragraph inside another paragraph (HTML such as a <p> inside a <button>, <marquee>, <svg> or <math> that is itself in a <p>), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "too_deep")).toBe("The file is nested more than 128 HTML elements deep, counting the paragraph inside (quotes nested 128 levels deep or lists nested 64 levels deep), which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("unsupported_block", "unknown_block")).toBe("The file has an element the editor doesn't support, which can't be stored in a note, so nothing was written.");
    expect(transferParseMessage("empty_content", "unclosed_comment")).toBe("A `<!--` has no closing `-->`, so everything after it counts as a comment and there is nothing to store. Add the `-->` and send the file again. Nothing was written.");
    expect(transferParseMessage("empty_content")).toBe("A part of the file has no content once parsed (for example, only HTML comments or blank space), so nothing was written.");
    expect(transferParseMessage("too_many_blocks")).toBe("The content is over a note's limit of 2000 blocks (nested blocks count too), so nothing was written.");
    expect(transferParseMessage("invalid_body", undefined, "~~~")).toBe(unclosedFenceMessage("~~~"));
    expect(unclosedFenceMessage("~~~")).toBe("A line you added or changed opens a code block with ~~~ that is never closed, so everything from that line to the end of the file counts as code. Add a closing ~~~ (or use inline `code`) and send the file again.");
    expect(unclosedFenceMessage("~~~")).not.toContain("```");
  });
});
