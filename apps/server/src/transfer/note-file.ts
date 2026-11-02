/**
 * bulk transfer spec 2026-11-02 §6.4、§7、§8：一篇的檔（frontmatter＋整篇匯出）與它的基底列。T9 單篇與 T10 整包共用。
 *
 * 順序（plan §1-1、-4）：`loadNoteDoc`（live 就 fork、否則解 `note_states`；**不開直連**、不 touch presence）→ mount 前
 * `linkTitlesFor`（DB）→ `exportNoteForTransfer`（持 lease 期間零 DB）→ 算加鹽 HMAC 行雜湊（純計算）。這支不寫 DB：基底由
 * 呼叫端以 `insertBases` 寫。
 */
import { canonicalNotePath } from "@knotebook/shared";
import type { CollabServer } from "../collab/server.js";
import type { Db } from "../db/index.js";
import { linkTitlesFor, loadNoteDoc } from "../notes/editing/read.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { baseHashes, newBaseKey, newSalt } from "./base-hash.js";
import type { TransferBaseInsert } from "./bases.js";
import { exportNoteForTransfer, type ExportNoteOptions } from "./export-note.js";
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
  opts: Pick<ExportNoteOptions, "forceUnmergeable" | "yieldFn"> = {},
): Promise<NoteFile> {
  const { doc } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, row.id);
  const titles = await linkTitlesFor(deps.db, viewerId, doc);
  const ex = await exportNoteForTransfer(deps.editing, doc, titles, opts);
  const salt = newSalt();
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
