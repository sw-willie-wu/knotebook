/**
 * bulk transfer spec 2026-11-02 §5.6、§6：整包匯出的串流本體（`GET /api/transfer/export` 在 hijack 之後呼叫）。
 *
 * 契約（plan T10 流程 6–11）：
 * - 先寫所有目錄、再逐篇寫筆記（完整路徑 code unit 序）、manifest 最後；每 50 篇一批。
 * - 每批開頭：檢查點（權杖列還在＋使用者閘門；不看到期，§5.6）→ 以同一套可見性與範圍重查這批（看不到或移出範圍 → `skipped: gone`）
 *   → 逐篇組檔、寫 tar 項目（內含背壓）、讓出 → 整批寫完一次 INSERT 基底。檢查點失敗、基底寫入失敗 → **中止**。
 * - **中止**＝`writer.abort()`＋`reply.raw.destroy()`：不送 tar／gzip／chunked 的結尾，curl 以 exit 18 結束（§5.6）。
 * - 用戶端斷線：`reply.raw` 的 close（不是 `request.raw`，見 `routes/ai.ts` 的實測）→ `writer.abort()` 解開正在等的寫入。
 * - **outcome 在做決定的那一刻定案**：中止路徑在 destroy 之前定 `aborted`；正常完成在 `finish()` resolve 時定 `done`；close handler
 *   只在 outcome 未定且 `!writableFinished` 時定 `client_closed`，否則只 abort（冪等）、不改。
 * - finally：放 slot → `onExportEnd(outcome)` → 只在 done 時清理基底 → info log 一行（只有計數與 id，不記標題、路徑、權杖、內容）。
 */
import { setImmediate as setImmediateP } from "node:timers/promises";
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger, FastifyReply } from "fastify";
import type { UserGate } from "../auth/session.js";
import type { BulkRange } from "../auth/transfer-token.js";
import type { Db } from "../db/index.js";
import { transferTokens } from "../db/schema.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { ParserBusyError } from "../notes/editing/parse-core.js";
import { insertBases, pruneBases, type TransferBaseInsert } from "./bases.js";
import { buildNoteFile, type NoteFile, type NoteFileDeps } from "./note-file.js";
import type { Layout, LayoutFolder, LayoutGroup } from "./paths.js";
import { inRangeIds, visibleNotes, type RangeNoteRow } from "./range.js";
import { TarAbortError, TarGzWriter } from "./tar.js";

/** §21 D8：整包的篇數上限（只算範圍內，`layout.files.size`）。 */
export const TRANSFER_EXPORT_MAX_NOTES = 3000;
/** §6.6-3：批次大小（重查、檢查點、基底 INSERT 的節拍）。 */
export const EXPORT_BATCH = 50;
/** §6.6-1：已有匯出在跑時的 `Retry-After`（秒）。 */
export const EXPORT_BUSY_RETRY_AFTER_S = 30;

export type ExportOutcome = "done" | "aborted" | "client_closed";

/** 測試縫（`AppDeps.transferTestHooks`，生產不注入）。 */
export interface ExportTestHooks {
  beforeBatch?(index: number): Promise<void>;
  afterNote?(noteId: string): Promise<void>;
  onExportEnd?(outcome: ExportOutcome): void;
  forceUnmergeable?(noteId: string): boolean;
  /** 回一個字串＝讓這篇組檔時丟錯，錯誤訊息是「標題＋這個字串」（刻意帶內容：failed 分支若 log 原始 err 就一定洩漏，E21 殺得到）。 */
  forceFailNote?(noteId: string): string | undefined;
  /** close handler 第一行呼叫（測試據此確認 server 端已觀察到斷線）。 */
  onClientClose?(): void;
  /** 串流本體進入時、`writeHead` 之前呼叫；測試讓它丟錯，驗「這之前丟錯 slot 也會放」（T7–T11 審查 m2）。 */
  beforeStream?(): void;
}

export interface StreamExportParams {
  db: Db;
  gate: UserGate;
  log: FastifyBaseLogger;
  fileDeps: NoteFileDeps;
  reply: FastifyReply;
  userId: string;
  tokenId: string;
  parentTokenId: string;
  range: BulkRange;
  tree: { folders: LayoutFolder[]; groups: LayoutGroup[] };
  layout: Layout;
  site: string;
  exportedAt: Date;
  release: () => void;
  hooks?: ExportTestHooks;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
/** `knotebook-yyyyMMdd-HHmmss.tar.gz`（UTC）。 */
export function exportFileName(at: Date): string {
  const d = `${at.getUTCFullYear()}${pad2(at.getUTCMonth() + 1)}${pad2(at.getUTCDate())}`;
  const t = `${pad2(at.getUTCHours())}${pad2(at.getUTCMinutes())}${pad2(at.getUTCSeconds())}`;
  return `knotebook-${d}-${t}.tar.gz`;
}

export async function streamExport(p: StreamExportParams): Promise<void> {
  const started = Date.now();
  const raw = p.reply.raw;
  let outcome = null as ExportOutcome | null;
  p.hooks?.beforeStream?.();
  raw.writeHead(200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="${exportFileName(p.exportedAt)}"`,
    // hijack 繞過 onSend：全站的 nosniff 要自己帶（app.ts 的 onSend hook）。
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  const writer = new TarGzWriter(raw, { mtime: p.exportedAt });
  const onClose = () => {
    p.hooks?.onClientClose?.();
    if (outcome === null && !raw.writableFinished) outcome = "client_closed";
    writer.abort(new Error("client closed"));
  };
  raw.on("close", onClose);
  raw.on("error", () => {});
  if (raw.destroyed) onClose();
  const abortStream = () => {
    if (outcome === null) outcome = "aborted";
    writer.abort(new Error("export aborted"));
    raw.destroy();
  };

  const order = [...p.layout.files.entries()].sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const manifestNotes: Array<{ path: string; id: string; role: string; mergeable?: false; tooLargeToSend?: true }> = [];
  const skipped: Array<{ id: string; reason: "gone" | "failed" | "busy" }> = [];
  let notMergeable = 0;
  let written = 0;
  try {
    for (const d of p.layout.dirs) await writer.addDir(d.path);
    for (let b = 0; b * EXPORT_BATCH < order.length; b++) {
      if (outcome !== null) break;
      await p.hooks?.beforeBatch?.(b);
      if (outcome !== null) break;
      // 檢查點（§5.6）：權杖列還在（撤銷／母憑證撤銷 cascade）＋使用者閘門；刻意不看到期——串流開始後到期不中止。
      const [tok] = await p.db.select({ id: transferTokens.id }).from(transferTokens).where(eq(transferTokens.id, p.tokenId)).limit(1);
      const g = tok === undefined ? null : await p.gate.checkUser(p.userId);
      if (g === null || g.status !== "ok" || g.user.mustChangePassword) {
        abortStream();
        break;
      }
      const batch = order.slice(b * EXPORT_BATCH, (b + 1) * EXPORT_BATCH);
      const rows = await visibleNotes(p.db, p.userId, { ids: batch.map(([id]) => id) });
      const still = inRangeIds(rows, p.tree, p.range);
      const byId = new Map<string, RangeNoteRow>(rows.map(r => [r.id, r]));
      const bases: TransferBaseInsert[] = [];
      for (const [id, path] of batch) {
        if (outcome !== null) break;
        const row = byId.get(id);
        if (row === undefined || !still.has(id)) {
          skipped.push({ id, reason: "gone" });
          continue;
        }
        let nf: NoteFile;
        try {
          const failWith = p.hooks?.forceFailNote?.(id);
          if (failWith !== undefined) throw new Error(`${row.title} ${failWith}`);
          nf = await buildNoteFile(p.fileDeps, p.userId, row, { forceUnmergeable: p.hooks?.forceUnmergeable?.(id) === true });
        } catch (err) {
          // 只記計數（info 行的 skipped），不記錯誤原文：訊息可能帶標題或內容（plan §1-8）。worker 全忙（排隊逾時）記成 `busy`
          // （審查 r4 M4：與真的讀不出來分開，呼叫端知道稍後單篇重抓就好）。
          skipped.push({ id, reason: err instanceof ParserBusyError ? "busy" : "failed" });
          continue;
        }
        await writer.addFile(path, nf.file);
        written++;
        bases.push(nf.base);
        if (!nf.mergeable) notMergeable++;
        // 8000 探索測試 H：檔案比寫回上限（`TRANSFER_WRITE_BODY_LIMIT`，256 KiB）還大 → `tooLargeToSend: true`（照 `mergeable: false` 只在例外時帶鍵）。
        manifestNotes.push({
          path, id, role: row.role,
          ...(nf.mergeable ? {} : { mergeable: false as const }),
          ...(nf.file.length > TRANSFER_WRITE_BODY_LIMIT ? { tooLargeToSend: true as const } : {}),
        });
        await p.hooks?.afterNote?.(id);
        await setImmediateP();
      }
      if (outcome !== null) break;
      try {
        await insertBases(p.db, p.log, bases);
      } catch {
        abortStream();
        break;
      }
    }
    if (outcome === null) {
      const manifest = {
        knotebook: 1,
        exportedAt: p.exportedAt.toISOString(),
        site: p.site,
        range: p.range,
        folders: p.layout.dirs,
        notes: manifestNotes,
        skipped,
      };
      await writer.addFile(".knotebook/manifest.json", Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8"));
      await writer.finish();
      outcome = "done";
    }
  } catch (err) {
    if (!(err instanceof TarAbortError)) {
      p.log.warn({ ...pgErrorSummary(err) }, "整包匯出中止");
      abortStream();
    }
  } finally {
    const final: ExportOutcome = outcome ?? "aborted";
    if (outcome === null) abortStream();
    p.release();
    p.hooks?.onExportEnd?.(final);
    if (final === "done") pruneBases(p.db, p.log, p.userId, manifestNotes.map(n => n.id));
    p.log.info(
      { userId: p.userId, tokenId: p.parentTokenId, range: p.range, notes: written, skipped: skipped.length, notMergeable, bytes: writer.bytesOut, ms: Date.now() - started, outcome: final },
      "bulk transfer export",
    );
  }
}
