/** Shared by single-note download and whole-export. Workers all busy for too long → `ParserBusyError`; timeout or out of memory → `NoteReadTooComplexError`. `loadNoteState` opens no direct connection and touches no presence. Writes no DB: the caller writes the base with `insertBases`. */
import { canonicalNotePath } from "@knotebook/shared";
import type { CollabServer } from "../collab/server.js";
import type { Db } from "../db/index.js";
import { DOC_TOO_COMPLEX } from "../notes/editing/doc-jobs.js";
import { NoteReadTooComplexError, loadNoteState, titlesAsk } from "../notes/editing/read.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { baseHashes, newBaseKey, newSalt } from "./base-hash.js";
import type { TransferBaseInsert } from "./bases.js";
import type { ExportNoteOptions } from "./export-note.js";
import { writeNoteFile } from "./frontmatter.js";
import { normalizeBody } from "./normalize.js";
import type { RangeNoteRow } from "./range.js";

export interface NoteFileDeps {
  db: Db;
  collab: CollabServer;
  editing: EditingRuntime;
  key: Buffer;
  keyId: string;
}

export interface NoteFile {
  file: Buffer;
  base: TransferBaseInsert;
  mergeable: boolean;
}

export async function buildNoteFile(
  deps: NoteFileDeps,
  viewerId: string,
  row: RangeNoteRow,
  opts: Pick<ExportNoteOptions, "forceUnmergeable"> = {},
): Promise<NoteFile> {
  const { state } = await loadNoteState({ db: deps.db, collab: deps.collab }, row.id);
  const salt = newSalt();
  const ex = await deps.editing.runDoc(
    viewerId,
    { kind: "exportFile", state, key: new Uint8Array(deps.key), salt: new Uint8Array(salt), ...(opts.forceUnmergeable ? { forceUnmergeable: true } : {}) },
    { ask: titlesAsk(deps.db, viewerId) },
  );
  if (ex === DOC_TOO_COMPLEX) throw new NoteReadTooComplexError();
  const baseKey = newBaseKey();
  const h = baseHashes(deps.key, salt, { body: normalizeBody(ex.body), title: row.title, tags: row.tagNames, lines: ex.lines, kinds: ex.lineKinds });
  const file = Buffer.from(
    writeNoteFile({ id: row.id, title: row.title, role: row.role, base: baseKey, url: canonicalNotePath(row), tags: row.tagNames }, ex.body),
    "utf8",
  );
  return {
    file,
    mergeable: ex.segments !== null,
    base: {
      key: baseKey,
      userId: viewerId,
      noteId: row.id,
      salt,
      keyId: deps.keyId,
      bodySha: h.bodySha,
      titleSha: h.titleSha,
      tagsSha: h.tagsSha,
      lineHashes: h.lineHashes,
      lineKinds: h.lineKinds,
      segments: ex.segments,
    },
  };
}
