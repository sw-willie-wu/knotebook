/**
 * `version` is read from package.json at runtime (hardcoding adds a fourth sync point). Use
 * `fileURLToPath`, not `new URL().pathname` (`%7E`, #130). Never throw on failure: fall back to
 * "0.0.0" (callers check `versionReadFailed`); a display string must not take the endpoint down.
 * `instructions` enters model context on every `initialize`: length-capped and must not contain
 * any "fingerprint means you have read it" sentence (unit-tested).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Clients namespace tools by this name; it must match the config key `docs/mcp.md` tells users to set. */
export const MCP_SERVER_NAME = "knotebook";

function readPackageVersion(): { version: string; failed: boolean } {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      return { version: parsed.version, failed: false };
    }
  } catch {
  }
  return { version: "0.0.0", failed: true };
}

const pkg = readPackageVersion();

export const MCP_SERVER_VERSION = pkg.version;
export const versionReadFailed = pkg.failed;

/**
 * Describes only what this credential can use. English, since it goes into model context (not the UI, no i18n). Four shapes (read-write/read-only, with or
 * without `open_notes_as_files`), each must stay ≤ 1000 characters: when over, shorten the
 * wording, don't raise the cap (it protects model context); re-measure all four after any edit; each must also pass the banned-phrase regex.
 * The read-only form must not name write tools; `insufficient_scope` is dead over HTTP, so
 * its remedy text is the only place that hint reaches the model. "Tools read notes in
 * sections" because `open_notes_as_files` can return whole files.
 */
const BASE_INSTRUCTIONS = `Knotebook notes over MCP. Tools read notes in sections: none returns a whole
note. Call read_note_outline first for a note's sections, then
read_note_section for one section, 4000 characters per call — page with \`offset\`
until \`truncated\` is false.
Headings and titles are cut at 200 characters as written in JSON. Notes you can see include ones shared with you and your groups' notes: each
result carries \`owner\` and \`role\` so you can tell whose content you are reading.
Only list_trash lists notes in the trash.
Notes can sit in folders; list_folders shows their paths.`;

/** One line per form; the read-only one names only read tools. "poll": nothing is pushed to an agent, it has to call again. */
const COMMENTS_WRITE = "Comments: read_comments, post_comment; poll list_notifications for mentions.";
const COMMENTS_READ_ONLY = "Comments: read_comments; poll list_notifications for mentions.";

/**
 * Qualifiers in the last sentence: "changes a note's content" excludes `create_note` without
 * content (no `note_ai_edits` row, nothing to undo) but includes `delete_section`;
 * "successful" because the merge and the record row are different transactions; "usually"
 * because undo can fail (blocks changed, `RETENTION` (`AI_EDITS_RETENTION`: the newest 100 rows per note) in `apply.ts`); the full
 * conditions are in the `editId` `.describe()` in `edit-note.ts`. Copy writes into a new note
 * without a record, which `COPY_NOTE_DESCRIPTION` states.
 */
const WRITE_INSTRUCTIONS =
  "Writing needs the notes:write scope. edit_note changes one note (six ops; all but append " +
  "need `if_match`, the fingerprint of what you replace) and create_note makes a new one. " +
  "A successful write that changes a note's content is recorded, and can usually be undone.";

/** Read-write form goes after WRITE; the read-only form goes before READ_ONLY and must not mention write-back. */
const FILES_HINT_WRITE = "If you have a shell, use open_notes_as_files to change much of a note, or many notes.";
const FILES_HINT_READ_ONLY = "If you have a shell, use open_notes_as_files to read many or whole notes.";

/** Names no write tool. Reconnect is needed: `tools.listChanged` is false. `notes:write` and `Settings` are asserted by tests; the quoted text is the token-row toggle label. Doesn't mention notes:move (a read-only credential has no move tools). */
const READ_ONLY_INSTRUCTIONS =
  "This credential is read-only, so there are no tools here that change anything. To let it " +
  'write, ask the user to turn on "Create and edit notes" (notes:write) for this credential via the pencil on its row in Settings → Authorization, then reconnect so the writing tools appear.';

export function mcpInstructions(canWrite: boolean, openNotesAsFiles: boolean): string {
  const tail = canWrite
    ? openNotesAsFiles ? `${WRITE_INSTRUCTIONS} ${FILES_HINT_WRITE}` : WRITE_INSTRUCTIONS
    : openNotesAsFiles ? `${FILES_HINT_READ_ONLY} ${READ_ONLY_INSTRUCTIONS}` : READ_ONLY_INSTRUCTIONS;
  return `${BASE_INSTRUCTIONS} ${canWrite ? COMMENTS_WRITE : COMMENTS_READ_ONLY} ${tail}`;
}
