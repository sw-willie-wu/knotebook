/**
 * Order is a contract: role → `contentRead` limiter → presence. The limiter comes after the
 * role so a `none` not-found doesn't consume it; presence comes last so a 429 leaves no
 * trace. `touch` doesn't look at the role, so touching earlier would let any PAT holder who
 * guesses a note id show a name tag on real collaborators' screens. `none` must read as
 * plain "not found". Presence targets/names come from `presenceTargetForRead`/`presenceIdentity`; never build `PresenceTarget` literals.
 */
import { YDOC_FRAGMENT, topLevelIdsOf, type Role } from "@knotebook/shared";
import { currentAgentLabel } from "../auth/agent-label.js";
import { outlineOf, type OutlineEntry } from "../notes/editing/fingerprint.js";
import { ParserBusyError } from "../notes/editing/parse-core.js";
import { presenceIdentity, presenceTargetForRead } from "../notes/editing/presence.js";
import { NoteReadTooComplexError, loadNoteDoc, readNoteOutline } from "../notes/editing/read.js";
import { resolveRole } from "../notes/service.js";
import { toolError, type ToolErrorResult } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";

/** Also used on the `read_note_outline` race path (deleted after the role check): any other string would make the two not-founds distinguishable. */
export const NOTE_NOT_FOUND_MESSAGE = "No note with that id. It may not exist, it may not be shared with you, or it may belong to a group you aren't in.";

/**
 * Don't say "section ids change when the note is edited": the id is the section's first
 * top-level block id, which `append`/`insert_after` leave untouched. Only `replace_all`,
 * `replace_section` and `delete_section` can change ids.
 */
export const SECTION_NOT_FOUND_MESSAGE =
  "This note has no section with that id. Call read_note_outline again — an edit can change a section's id.";

export const READ_RATE_LIMITED_MESSAGE = "Too many note reads right now. Wait a moment before reading more.";
export const READ_BUSY_MESSAGE = "The server is busy processing other requests. Try reading again in a moment.";
export const READ_TOO_COMPLEX_MESSAGE = "This note is too large or too complex to read within the server's time and memory limits.";

export function docReadToolError(err: unknown): ToolErrorResult | null {
  if (err instanceof ParserBusyError) return toolError("server_busy", READ_BUSY_MESSAGE);
  if (err instanceof NoteReadTooComplexError) return toolError("too_complex", READ_TOO_COMPLEX_MESSAGE);
  return null;
}

type OutlineRead = { outline: OutlineEntry[]; located?: Array<[string, string]> };

/** Without an editing runtime (test app without collab) falls back to the main thread. `locate`: see `OutlineDocOp`. */
export async function readOutlineForTool(ctx: McpToolCtx, noteId: string, locate?: string[]): Promise<OutlineRead | { error: ToolErrorResult }> {
  if (ctx.editing === undefined) {
    const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, noteId);
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT);
    return { outline: outlineOf(fragment).outline, ...(locate === undefined ? {} : { located: [...topLevelIdsOf(fragment, new Set(locate))] }) };
  }
  try {
    const r = await readNoteOutline({ db: ctx.db, collab: ctx.collab }, ctx.editing, noteId, ctx.userId, locate);
    return { outline: r.outline, ...(r.located === undefined ? {} : { located: r.located }) };
  } catch (err) {
    const error = docReadToolError(err);
    if (error) return { error };
    throw err;
  }
}

/**
 * The current section of each block, a nested one by its top-level block (`SectionInfo.blockIds` lists only top-level ones); a block
 * no longer in the note is absent. Null when the note can't be read now (`server_busy`, `too_complex`): the caller shows no sections
 * rather than failing.
 */
export async function sectionsOfBlocks(ctx: McpToolCtx, noteId: string, blockIds: readonly string[]): Promise<Map<string, string> | null> {
  const out = new Map<string, string>();
  if (blockIds.length === 0) return out;
  const read = await readOutlineForTool(ctx, noteId, [...new Set(blockIds)]);
  if ("error" in read) return null;
  const sectionOfTop = new Map<string, string>();
  for (const s of read.outline) for (const id of s.blockIds) sectionOfTop.set(id, s.sectionId);
  for (const [id, top] of read.located ?? []) {
    const section = sectionOfTop.get(top);
    if (section !== undefined) out.set(id, section);
  }
  return out;
}

export type NoteReadAccess = { ok: true; role: Role } | { ok: false; error: ToolErrorResult };

/** A `{ ok: false }` result's error must be returned as-is, with nothing else done. `section` undefined = the whole note (presence at the document start); otherwise presence lands on that section's first block. */
export async function authorizeNoteRead(
  ctx: McpToolCtx,
  noteId: string,
  section: string | undefined
): Promise<NoteReadAccess> {
  const role = await resolveRole(ctx.db, ctx.userId, noteId);
  if (role === "none") return { ok: false, error: toolError("not_found", NOTE_NOT_FOUND_MESSAGE) };
  if (!ctx.limiters.contentRead.consume(ctx.userId)) {
    return { ok: false, error: toolError("too_many_requests", READ_RATE_LIMITED_MESSAGE) };
  }
  // A cookie session is a browser user: no presence. `touch` acts only on a loaded doc (a no-op when nobody is online), so reads stay side-effect free apart from the in-process `shownLinks` record.
  if (ctx.tokenId !== null) {
    const label = await currentAgentLabel(ctx.db, ctx.tokenId);
    if (label !== null) {
      ctx.presence?.touch(noteId, ctx.tokenId, presenceIdentity(ctx.userHandle, label), presenceTargetForRead(section));
    }
  }
  return { ok: true, role };
}
