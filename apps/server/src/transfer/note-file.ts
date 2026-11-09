/**
 * bulk transfer spec 2026-11-02 §6.4、§7、§8：一篇的檔（frontmatter＋整篇匯出）與它的基底列。T9 單篇與 T10 整包共用。
 *
 * 順序（plan §1-1、-4）：`loadNoteState`（live 就編碼、否則 `note_states` 的位元組；**不開直連**、不 touch presence）→
 * 匯出的轉換在 parse worker 裡（很小的筆記在主執行緒；`doc-jobs.ts` 的 `exportFile`：連結的現行標題經 `ask` 問主執行緒查 DB、
 * `exportNoteForTransfer`、鹽先產生，匯出時順便算段表 `links` 的連結文字雜湊，F1）→ 算加鹽 HMAC 行雜湊（純計算）。
 * worker 全忙排太久 → `ParserBusyError`；逾時或用完記憶體 → `NoteReadTooComplexError`。這支不寫 DB：基底由呼叫端以 `insertBases` 寫。
 */
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
  /** `deriveTransferKey(APP_SECRET)`；每個 `transferRoutes` 實例算一次。 */
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
  const h = baseHashes(deps.key, salt, { body: normalizeBody(ex.body), title: row.title, lines: ex.lines, kinds: ex.lineKinds });
  const file = Buffer.from(
    writeNoteFile({ id: row.id, title: row.title, role: row.role, base: baseKey, url: canonicalNotePath(row) }, ex.body),
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
      lineHashes: h.lineHashes,
      lineKinds: h.lineKinds,
      segments: ex.segments,
    },
  };
}
