/**
 * #108: the three declared strings of `McpServer`.
 *
 * The `MCP_SERVER_VERSION` check does **not** cover the dist or `/out` layout: it only proves that `apps/server/package.json` resolves under `src`.
 * The copy at the deploy root was verified once by hand and has no continuous guard (changing the deploy shape of `docker/Dockerfile`, or moving `mcp/`
 * one level deeper, would not be noticed here).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpInstructions, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../../src/mcp/server-info.js";
import { listNotesInput } from "../../src/mcp/tools/list-notes.js";
import { searchNotesInput } from "../../src/mcp/tools/search-notes.js";

/** The test reads the repo path itself, independent of the implementation's path computation: that is what gives it something to compare against. */
const pkgVersion = (
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
  ) as { version: string }
).version;

/** #417: read-write and read-only each split again by whether `open_notes_as_files` is on the list: four forms in total; an assertion that holds for all forms runs four times. */
const ALL_FORMS = [
  ["read-write + files", true, true],
  ["read-write", true, false],
  ["read-only + files", false, true],
  ["read-only", false, false],
] as const;
const READ_ONLY_FORMS = [false, true].map(files => mcpInstructions(false, files));

const FILES_HINT_WRITE = "If you have a shell, use open_notes_as_files to change much of a note, or many notes.";
const FILES_HINT_READ_ONLY = "If you have a shell, use open_notes_as_files to read many or whole notes.";

describe("#108 MCP server-info", () => {
  it("name is literally knotebook (the same as the config key name docs/mcp.md tells users to fill in)", () => {
    expect(MCP_SERVER_NAME).toBe("knotebook");
  });

  it("version equals the version in apps/server/package.json verbatim (not hard-coded, and not the retired 0.0.0)", () => {
    expect(MCP_SERVER_VERSION).toBe(pkgVersion);
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // #108: read-write and read-only are either/or, not additive; since #417 each further splits on the files sentence, so all four forms are measured separately and each is checked for forbidden words.
  // How much headroom is left is documented only in the comment inside `server-info.ts`: the number is deliberately not copied here again (#146: a copied
  // version said about 20 when the real value was 40, long stale). When hitting the limit, shorten the text first, don't raise this cap.
  it.each(ALL_FORMS)("instructions (%s) <= 1000 UTF-16 code units (every initialize puts them into the model's context)", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it.each(ALL_FORMS)("instructions (%s) contain no forbidden words (must not imply that the fingerprint is a 'have you read it' check)", (_label, canWrite, files) => {
    // This regex must have the same source as the grep that scans `apps/server/src/mcp/`.
    expect(mcpInstructions(canWrite, files)).not.toMatch(
      /without reading|has not read|cannot .*overwrite|must .*read|requires .*read|only after reading/i
    );
  });

  // The either/or itself: the two share one BASE and differ in the tail. If one constant were returned on both sides, this case catches it.
  it.each([true, false])("the two instructions share the same opening and differ in the tail (files sentence %s)", files => {
    const rw = mcpInstructions(true, files);
    const ro = mcpInstructions(false, files);
    expect(rw).not.toBe(ro);
    expect(rw.startsWith("Knotebook notes over MCP.")).toBe(true);
    expect(ro.startsWith("Knotebook notes over MCP.")).toBe(true);
    expect(rw).toContain("edit_note");
    expect(ro).not.toContain("edit_note");
    expect(ro).not.toContain("create_note");
  });

  it.each(ALL_FORMS)("#175: instructions (%s) visibility sentence covers groups, and the field name is owner", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Notes you can see include ones shared with you and your groups' notes:");
    expect(text).toContain("result carries `owner` and `role` so you can tell whose content you are reading.");
    expect(text).not.toContain("ones other people shared with you");
    // #175: the field was renamed to `owner`; keeping the old name in instructions would send the model to read a key that doesn't exist.
    expect(text).not.toContain("ownerHandle");
  });

  // #177: truncation now counts the length after JSON escaping (`truncateText` in `limits.ts`). The old sentence "cut at 200 characters." is false for
  // titles containing `"`, `\` or C0 (101 `"` get cut to 100), so both are pinned: the new sentence is present and the old one is absent.
  it.each(ALL_FORMS)("#177: instructions (%s) say 200 after escaping, not 200 of the raw length", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Headings and titles are cut at 200 characters as written in JSON.");
    expect(text).not.toContain("cut at 200 characters.");
  });

  it("#247 read-only instructions: the remedy is to turn on 'Create and edit notes' via the pencil on the token row in Settings -> Authorization, and reconnect; <= 1000", () => {
    for (const ro of READ_ONLY_FORMS) {
      expect(ro).toContain('turn on "Create and edit notes" (notes:write) for this credential via the pencil on its row in Settings → Authorization');
      expect(ro).toContain("then reconnect so the writing tools appear");
      expect(ro).not.toContain("Settings → Account");
      expect(ro).not.toContain("create a token");
      expect(ro.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("#180: the read-write instructions say six ops", () => {
  // #381: rename needs `if_match` too: the sentence is now "all but append need", and the old "append and rename" is pinned absent.
  it.each([true, false])("contains 'six ops; all but append need `if_match`', not 'five ops' or 'all but append and rename'; the read-only form is unchanged (files sentence %s)", files => {
    const rw = mcpInstructions(true, files);
    expect(rw).toContain("six ops; all but append need `if_match`, the fingerprint of what you replace");
    expect(rw).not.toContain("all but append and rename");
    expect(rw).not.toContain("five ops");
    expect(mcpInstructions(false, files)).not.toContain("rename");
  });
});

// #181: the trash sentence goes into the BASE shared by both forms (list_trash exists for read-only credentials too); the two old phrasings dropped to make room in the budget are pinned absent.
// It doesn't vary by notes:delete: the two tools may not exist, so neither form may mention their names.
describe("#181: the trash sentence in instructions", () => {
  it.each(ALL_FORMS)("%s form contains the list_trash sentence, not the shortened old wording, and doesn't mention delete_note/restore_note", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Only list_trash lists notes in the trash.");
    expect(text).not.toContain("there is no tool that returns a whole");
    expect(text).not.toContain("(id, heading, length)");
    expect(text).not.toContain("delete_note");
    expect(text).not.toContain("restore_note");
  });
});

describe("bulk transfer: the first sentence of instructions only talks about tools", () => {
  it.each(ALL_FORMS)("%s form starts with 'Tools read notes in sections: none returns a whole note.' and doesn't contain the old sentence 'Reading is always sectioned'", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files).replace(/\s+/g, " ");
    expect(text.startsWith("Knotebook notes over MCP. Tools read notes in sections: none returns a whole note. ")).toBe(true);
    expect(text).not.toContain("Reading is always sectioned");
  });
});

// Folders: the folder sentence goes into the BASE shared by both forms (list_folders is registered for any credential); the outline-limit sentence dropped to make room in the budget is pinned absent
// (the limit stays in the description of read_note_outline). Folder write tools may not exist (read-only, no notes:delete), so neither form may mention their names.
describe("folders: the folder sentence in instructions", () => {
  it.each(ALL_FORMS)("%s form contains the folder sentence, not the outline-limit sentence, and doesn't mention folder write tools", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Notes can sit in folders; list_folders shows their paths.");
    expect(text).not.toContain("an outline at most 100 sections");
    expect(text).not.toContain("create_folder");
    expect(text).not.toContain("delete_folder");
    expect(text).not.toContain("move_note_to_folder");
  });
});

// #417: the per-call limit sentences of list_notes/search_notes were swapped out to make room for the files sentence; both limits remain in the `.describe()` of each `limit`,
// and both sides are pinned: absent from instructions, present in `.describe()` (the numbers are copied literally, so a changed constant turns this red).
describe("#417: the limits of list_notes/search_notes appear only in each limit's description", () => {
  it.each(ALL_FORMS)("%s form doesn't contain the limit sentence; the .describe() of limit says 1 to 100 / 1 to 50", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files).replace(/\s+/g, " ");
    expect(text).not.toContain("list_notes returns at most 100 notes per call");
    expect(text).not.toContain("search_notes at most 50");
    expect(listNotesInput.limit.description).toContain("1 to 100.");
    expect(searchNotesInput.limit.description).toContain("1 to 50.");
  });
});

// #417: the `open_notes_as_files` sentence is appended only when it is on the list (token + collab + editing), one for read-write and one for read-only, not mixed;
// the two forms where it is not on the list don't mention it at all (the list and instructions use one criterion; the wire comparison is in `test/mcp-open-notes-as-files.test.ts`).
describe("#417: the files sentence in instructions", () => {
  it("read-write + files: appended after the read-write tail; doesn't contain the read-only sentence", () => {
    const text = mcpInstructions(true, true);
    expect(text.endsWith(` ${FILES_HINT_WRITE}`)).toBe(true);
    expect(text).not.toContain(FILES_HINT_READ_ONLY);
  });

  it("read-only + files: only talks about reading, appended before the read-only tail; doesn't contain the editing sentence", () => {
    const text = mcpInstructions(false, true);
    expect(text).toContain(`${FILES_HINT_READ_ONLY} This credential is read-only`);
    expect(text).not.toContain(FILES_HINT_WRITE);
    expect(text).not.toContain("change much of");
  });

  it.each([true, false])("without this tool (canWrite %s): open_notes_as_files isn't mentioned", canWrite => {
    expect(mcpInstructions(canWrite, false)).not.toContain("open_notes_as_files");
  });

  it.each(ALL_FORMS)("%s form doesn't mention the old tool name", (_label, canWrite, files) => {
    expect(mcpInstructions(canWrite, files)).not.toContain("bulk_transfer");
  });
});

describe("comments: one line in each form", () => {
  it.each(ALL_FORMS)("%s form names read_comments and list_notifications and says to poll", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("read_comments");
    expect(text).toContain("poll list_notifications");
  });

  it.each([true, false])("only the read-write form names post_comment (files sentence %s)", files => {
    expect(mcpInstructions(true, files)).toContain("Comments: read_comments, post_comment; poll list_notifications for mentions.");
    expect(mcpInstructions(false, files)).toContain("Comments: read_comments; poll list_notifications for mentions.");
    expect(mcpInstructions(false, files)).not.toContain("post_comment");
  });
});
