/**
 * Takes only `tx` and plain data; the caller's `.transaction(` callback is one call to this. Lock order is the one every tags writer uses
 * (the group's row, then the note row, then the tag rows in `name_key` order), and the hooks run inside the transaction only as test seams.
 */
import type { Tx } from "../../db/tx.js";
import { loadNoteTagNames } from "../../tags/queries.js";
import { lockNoteTagSpaceInTx, setNoteTagsByNamesInTx, type ExpectedNoteSpace } from "../../tags/tx/note-tags.js";
import { tagsKeyOf } from "../note-tags-format.js";

export type SyncTagsOutcome = { kind: "ok" } | { kind: "not_found" | "conflict" | "invalid_tag_name" | "changed_meanwhile" } | { kind: "tag_limit_reached"; limit: number };

export interface SyncTagsInput {
  noteId: string;
  expected: ExpectedNoteSpace;
  names: readonly string[];
  createdBy: string;
  /** `tagsKeyOf` of the note's tags when the checks before the write were made. */
  currentKey: string;
}

/** The re-read after the locks narrows the window in which someone else's change is overwritten, but doesn't close it: two tag changes of one note don't wait for each other. */
export async function writeSyncTagsInTx(tx: Tx, input: SyncTagsInput, afterLock?: () => Promise<void>, afterWrite?: () => Promise<void>): Promise<SyncTagsOutcome> {
  const space = await lockNoteTagSpaceInTx(tx, input.noteId, input.expected);
  if (typeof space === "string") return { kind: space };
  await afterLock?.();
  if (tagsKeyOf(await loadNoteTagNames(tx, input.noteId)) !== input.currentKey) return { kind: "changed_meanwhile" };
  const out = await setNoteTagsByNamesInTx(tx, { noteId: input.noteId, expected: input.expected, names: input.names, createdBy: input.createdBy });
  if (out.kind === "tag_limit_reached") return { kind: out.kind, limit: out.limit };
  if (out.kind !== "ok") return { kind: out.kind };
  await afterWrite?.();
  return { kind: "ok" };
}
