/**
 * #108：**同一篇筆記的所有寫入路徑**——REST 的 `/edits`、
 * `/revert`、`POST /api/notes` 帶 `content`，以及 MCP 的 `edit_note`／`create_note`
 * ——必須經過**同一個** `NoteWriteQueue` 實例（`buildApp` 建一次、兩個路由共用）。不同實例
 * ＝沒有串行可言，而 #137 修過的資料損毀級 bug 與撤回的冪等守衛都建立在串行之上
 * （理由鏈逐字寫在 `queue.ts` 那段長註解裡）。
 *
 * 收進來的是**外圍順序**（候選集合 → agentLabel → 佇列 → `applyEdit`／`revertEdit` →
 * presence touch），**不收授權與限流**：那兩者在 REST 與 MCP 上的答案形不同（HTTP 狀態碼
 * vs 工具錯誤），收進來就得在這裡分支「我是誰的呼叫端」，比重複更糟。
 *
 * ⚠ **`EditOp` 寫入路徑的 presence 目標只能取自 `presenceTargetForWrite(op, afterBlockIds)`**——#106 三棒各在
 * 這裡錯過一次（請求帶的 `section_id` 是 heading 的 block id，寫完就已經不存在了）。`syncFile`（`file_sync`）在本檔內以
 * 各區編輯後的 `afterIds` 組，理由同：不吃請求帶的 id。
 * ⚠ **帶 content 建立筆記的佇列逾時答案是 `500 internal` 不是 `503`**（`docs/ai-editing.md`
 * 逐字），所以 `createWithContent` 的 catch **刻意不分辨例外型別**，`QueueBusyError` 一併吃掉。
 * 這條逾時在真實路徑上不可達；catch 不分辨型別是為了讓 REST 與 MCP
 * `create_note` 共用同一個答案，不是因為真的會逾時——建立筆記用的是剛 insert 出來的新 id，
 * per-note 佇列上結構性不可能有併發者，既有的那條 500 測試走的是 `beforeRecord` throw，不是
 * 真逾時。
 *
 * 誠實缺口另補三條：
 * (1) `applyDeps()` 的 throw 今天三個呼叫點都到不了、沒有測試守著——留著是因為 `create_note`
 *     不進部署形態閘門，忘了先問 `available` 時它是唯一會出聲的東西。
 * (2) `test/write-body-limit.test.ts` 的四發邊界驗收是從 `WRITE_BODY_LIMIT` 這個常數算出來
 *     的，所以對「上限值本身被改」零鑑別力（實測把常數改成 280000 → 42 案全綠）；還在守上限值
 *     的只有 `note-edits.test.ts`／`mcp-endpoint.test.ts` 兩條寫死 300000 的舊測試，而它們只
 *     擋得住「放大到 > 300000」。
 * (3) `presenceIdentity(...)` 組字收成一份之後（`presence.ts`），「它組得對不對」仍然只有
 *     `note-presence.test.ts` 與 `mcp-content.test.ts` 兩條逐字斷言在守——本檔 `touch()` 與
 *     `mcp/note-read.ts` 都只是呼叫端，沒有各自的第二道守衛。
 */
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import type { EditOp } from "@knotebook/shared";
import { currentAgentLabel } from "../../auth/agent-label.js";
import type { CollabServer } from "../../collab/server.js";
import type { VersionService } from "../../collab/versions.js";
import type { Db } from "../../db/index.js";
import { noteAiEdits, notes, transferBases, transferCreates } from "../../db/schema.js";
import { isForeignKeyViolation, isNoteFolderSpaceViolation, isRetryableTxError, pgErrorSummary } from "../../db/pg-errors.js";
import type { FixedWindowLimiter } from "../../http/rate-limit.js";
import { redactDbError } from "../../lib/redact-db-error.js";
import { hmacOf } from "../../transfer/base-hash.js";
import { diffLines, hashAgentLines } from "../../transfer/line-diff.js";
import { bodyLines } from "../../transfer/normalize.js";
import { fileSyncRows } from "../../transfer/sync-apply.js";
import type { PlanSyncError } from "../../transfer/sync-plan.js";
import { recordFileSyncInTx } from "../../transfer/tx/record-file-sync.js";
import { insertNoteWithAutoSlug } from "../create.js";
import { NoteTooLargeError } from "../note-size.js";
import { renameNoteTitle, type RenameOutcome } from "../rename-note.js";
import { resolveNoteAccess, type NoteAccess } from "../service.js";
import type { SlugScope } from "../slug.js";
import type { NoteVersionRow } from "../tx/versions.js";
import { applyEdit, mergeAtBase, recordableAfter, StaleBase, updateNoteLinks, type ApplyDeps, type ApplyResult, type EditingTestHooks, type MergeOutput } from "./apply.js";
import { DOC_TOO_COMPLEX, type AskFn, type SyncApplyDocResult } from "./doc-jobs.js";
import { applyVersionEdit, type ApplyVersionFailureCode, type ApplyVersionInput } from "./apply-version.js";
import { visibleNoteTargets, type VisibleNoteTarget } from "./candidates.js";
import { loadNoteState, titlesAsk } from "./read.js";
import { siteOriginOf, type ParseDetail, type ParsedMarkdown, type ParseError } from "./markdown.js";
import { ParserBusyError, type ParseOutcome } from "./parse-core.js";
import { presenceIdentity, presenceTargetForWrite, type PresenceRegistry, type PresenceTarget } from "./presence.js";
import { NoteWriteQueue, QueueBusyError } from "./queue.js";
import { revertEdit, type RevertResult } from "./revert.js";
import type { EditingRuntime } from "./runtime.js";
import { NoteGoneError, type DirectCtx } from "./session.js";
import { ShownLinkTexts, shownLinkTextsOf } from "./shown-link-texts.js";

export type ApplyOk = Extract<ApplyResult, { ok: true }>;
export type ApplyFailureCode = Extract<ApplyResult, { ok: false }>["code"];
export type RevertOk = Extract<RevertResult, { ok: true }>;
export type RevertFailureCode = Extract<RevertResult, { ok: false }>["code"];

/**
 * 寫入的四種結局。**兩個型別參數**：`T`＝成功結果，`C`＝該路徑的失敗碼聯集——`applyEdit`
 * 與 `revertEdit` 的碼**不同**，共用一個 `ApplyFailureCode` 會讓 revert 的 `stale`／
 * `already_reverted`／`not_found` 在呼叫端收窄不到（實跑得到 TS2322）。
 * `agentLabel` 一起回，是因為呼叫端組回應／記錄時還用得到，而它是在 service 裡查的。
 */
export type WriteOutcome<T, C> =
  | { ok: true; result: T; agentLabel: string | null }
  | { ok: false; kind: "busy" } // QueueBusyError：等了 `queueWaitMs` 還沒輪到
  | { ok: false; kind: "gone" } // #181 NoteGoneError：授權之後被移入垃圾桶（或正被移入）；呼叫端映成各自既有的 not_found
  | { ok: false; kind: "apply"; code: C; detail?: ParseDetail };
/** #398：解析的 worker 全忙、排隊超過上限（`ParserBusyError`）——呼叫端映成 503 `server_busy`。只有會解析 markdown 的路徑會回。 */
export type ParserBusy = { ok: false; kind: "parser_busy" };
/** 這次修改會讓筆記長過大小上限（`NoteTooLargeError`，`notes/note-size.ts`）——呼叫端映成 413 `note_too_large`；什麼都沒寫。 */
export type TooLarge = { ok: false; kind: "too_large"; limitBytes: number };

/**
 * 帶 content 建立的結局。成功時**連 insert 的 `returning()` 那一列一起回**：兩個呼叫端
 * （REST 回 `NoteDto`、MCP 回 `NoteSummaryForModel`）要的 DTO 不同，重讀不可能有共用形，
 * 但「重讀落空時退回這一列」的退路可以共用一份資料。
 */
/** `prepareContent` 的成功形：解析結果＋預取的候選集合與 agentLabel（`createWithContent` 的第三個參數）。 */
export type PreparedContent = { ok: true; candidates: readonly VisibleNoteTarget[]; agentLabel: string | null; prepared: ParsedMarkdown };

export type CreateWithContentResult =
  | { ok: true; noteId: string; inserted: typeof notes.$inferSelect; unbound: number }
  | { ok: false; kind: "parse"; code: ParseError; detail?: ParseDetail }
  | ParserBusy
  | TooLarge
  | { ok: false; kind: "internal" };

export type SaveVersionOutcome = { ok: true; row: NoteVersionRow; upgraded: boolean } | { ok: false; kind: "busy" | "note-deleted" };

/** 合併指紋不符時從頭重來（重新 fork、重新判「筆記動過沒」），最多 3 次。 */
export const SYNC_MERGE_ATTEMPTS = 3;

export interface SyncFileInput {
  noteId: string;
  userId: string;
  userHandle: string;
  /** 母憑證 id（presence、紀錄列的 token_id）。 */
  tokenId: string | null;
  access: NoteAccess;
  baseKey: string;
  /** frontmatter 的 `title`；沒有 `title` 行＝undefined（不改名）。 */
  title: string | undefined;
  /** 已 `normalizeBody` 的本文。 */
  body: string;
  key: Buffer;
  keyId: string;
  limiters: { transferWrite: FixedWindowLimiter; tokenRead: FixedWindowLimiter };
}
export interface SyncFileOk {
  ok: true;
  result: "unchanged" | "applied" | "renamed";
  applied: number;
  same: number;
  editIds: string[];
  unboundWikilinks: number;
  renamed: boolean;
  /** `title_changed`：內容已寫入，但改名前標題剛被別人改掉（改名與「標題沒變」的檢查是同一句 UPDATE）。 */
  renameFailed?: "gone" | "ownership_changed" | "title_changed";
  diffOverflow: boolean;
  anchored: number;
  degradedLines: number;
}
/** 去重視窗（＝權杖 TTL）。 */
export const CREATE_DEDUPE_MINUTES = 30;
export interface CreateFromFileInput {
  userId: string;
  userHandle: string;
  tokenId: string | null;
  fileSha: Buffer;
  keyId: string;
  title: string | undefined;
  body: string;
  dest: { scope: SlugScope; folderId: string | null };
  limiters: { transferWrite: FixedWindowLimiter; tokenRead: FixedWindowLimiter };
}
export type CreateFromFileOutcome =
  | { ok: true; created: boolean; noteId: string; unboundWikilinks: number }
  | { ok: false; kind: "parse"; code: ParseError; detail?: ParseDetail }
  | ParserBusy
  | TooLarge
  | { ok: false; kind: "rate_limited"; retryAfterMs: number }
  | { ok: false; kind: "folder_gone" | "busy" | "internal" };

/**
 * 409 `base_unavailable` 的成因（回應的 `error.reason`）：`already_sent`＝這份副本已用其他內容
 * 送回過；`other_note`＝`base` 屬於別篇或別人；`expired`＝伺服器已沒有這份基底（裁掉、過期）或金鑰換過；`note_changed`＝這篇筆記在下載
 * 之後被改過（標題或內文，不再三方合併）；`reverted`＝這份檔寫回的紀錄已被撤回（`applied_edit_ids`）。
 */
export type BaseUnavailableReason = "already_sent" | "other_note" | "expired" | "note_changed" | "reverted";

export type SyncFileOutcome =
  | SyncFileOk
  | { ok: false; kind: "base_unavailable"; reason: BaseUnavailableReason }
  | { ok: false; kind: "not_mergeable" | "busy" | "gone" }
  | { ok: false; kind: "rate_limited"; retryAfterMs: number }
  | { ok: false; kind: "parse"; code: PlanSyncError; detail?: ParseDetail; fence?: string }
  | ParserBusy
  | TooLarge
  /** 套用進筆記的轉換逾時或用完記憶體（筆記本身太大或太複雜）：500 `too_complex`。 */
  | { ok: false; kind: "note_too_complex" };

export interface NoteWriteServiceDeps {
  db: Db;
  /** 兩者同生同滅——沒有 collab 的部署寫不動內容，`available` 為 false。 */
  collab?: CollabServer;
  editing?: EditingRuntime;
  /** #138 presence 註冊表（選配；沒有 collab 時是全 no-op 空殼）。 */
  presence?: PresenceRegistry;
  /** `NoteWriteQueue.run` 的等待上限（毫秒）；未傳＝佇列自己的預設 10 s。整合測試壓到 50 ms 才驗得出 503。 */
  queueWaitMs?: number;
  /** 寫入路徑的測試注入縫（生產不注入＝零成本）。 */
  testHooks?: EditingTestHooks;
  /** 版本歷史：套用、手動儲存（`app.ts` 傳 collab 那份或未綁定的那份）。選配（既有測試直接 new 本 service；沒有它時套用與手動儲存會丟錯）。#272 起 AI／直寫不再切版。 */
  versions?: VersionService;
  /** bulk transfer：檔案寫回改名的 slug 候選縫（原樣傳給 `renameNoteTitle` 的第三個參數；`buildApp` 由 `slugUpdateTestHook` 透傳）。 */
  renameHook?: (candidate: string) => void | Promise<void>;
  /** #387：讀者讀到過、寫入者寫過的連結文字（測試注入用；未傳＝本 service 自建一份）。 */
  shownLinks?: ShownLinkTexts;
  /** 筆記大小上限（現讀 `siteLimits` 的生效值；未傳＝不擋，只給直接 new 本 service 的測試）。 */
  noteMaxBytes?: () => number;
}

export class NoteWriteService {
  /**
   * ⚠ **全樹唯一的 `new NoteWriteQueue()`**。`buildApp` 只建一個 service，
   * `notesRoutes` 與 `mcpRoutes` 拿到的是同一個物件。process-local。
   */
  private readonly queue = new NoteWriteQueue();

  /**
   * #387：讀者讀到過的「沒有自訂文字」的連結文字（process-local，同佇列）。讀路徑（MCP `read_note_section`、REST `/content`、`/edits` 與撤回
   * 409 的 `current`）把它傳給 `readNoteContent` 記下；`applyEdit`（`edit_note`、REST `/edits`）與帶 content 建立
   * （`create_note`、REST `POST /api/notes`）寫入時查它，寫入成功後也把寫下去的連結記進去。檔案寫回／檔案新增不查也不記
   * （#385 有自己的基底）。
   */
  readonly shownLinks: ShownLinkTexts;

  constructor(private readonly deps: NoteWriteServiceDeps) {
    this.shownLinks = deps.shownLinks ?? new ShownLinkTexts();
  }

  /** 筆記大小上限（`siteLimits` 的生效值）：MCP 的複製也用同一個值。 */
  get noteMaxBytes(): number | undefined {
    return this.deps.noteMaxBytes?.();
  }

  /** collab ＋ editing 都在＝這個部署寫得動內容（同 `routes/notes.ts` 的既有註冊閘門判準）。 */
  get available(): boolean {
    return this.deps.collab !== undefined && this.deps.editing !== undefined;
  }

  /**
   * 三條路徑共用的 `ApplyDeps`。**呼叫端必須先確認 `available`**——今天三個 REST 呼叫點
   * 分別在註冊閘門內／自己的 400 之後，這個 throw 到不了；留著是為了不讓「沒檢查就呼叫」
   * 靜默退化成 `undefined` 解參考。
   */
  private applyDeps(log: FastifyBaseLogger): ApplyDeps {
    const { collab, editing } = this.deps;
    if (!collab || !editing) throw new Error("NoteWriteService：此部署沒有 collab／editing，呼叫端必須先檢查 available");
    // 一次寫入（含 `mergeAtBase` 重來）用開始時讀到的上限：這個物件在寫入開始時建一次。
    const noteMaxBytes = this.deps.noteMaxBytes?.();
    return { db: this.deps.db, collab, editing, log, testHooks: this.deps.testHooks, versions: this.deps.versions, shownLinks: this.shownLinks, ...(noteMaxBytes !== undefined ? { noteMaxBytes } : {}) };
  }

  /**
   * #269：轉換工作專用——在本 service 的（全樹唯一的）佇列上跑一段，給它 `ApplyDeps`。與 MCP 寫入、套用版本、手動存版
   * 串行（互動寫入最多等一篇）。等待上限由呼叫端給（轉換工作用 1 s）；逾時丟 `QueueBusyError`。
   * ⚠ `fn` 內**不得**再呼叫本 service 會進同一篇 `queue.run` 的方法（例如 `saveVersion`）——會等到自己逾時。
   */
  async runExclusive<T>(log: ApplyDeps["log"], noteId: string, waitMs: number, fn: (deps: ApplyDeps) => Promise<T>): Promise<T> {
    const { collab, editing } = this.deps;
    if (!collab || !editing) throw new Error("NoteWriteService：此部署沒有 collab／editing，呼叫端必須先檢查 available");
    const deps: ApplyDeps = { db: this.deps.db, collab, editing, log, testHooks: this.deps.testHooks, versions: this.deps.versions };
    return this.queue.run(noteId, () => fn(deps), waitMs);
  }

  /**
   * ⚠ 條件逐字照抄 REST 的 `if (tokenId && agentLabel)`：**拿掉它不會有任何測試變紅**
   * （cookie ⇒ tokenId 為 null ⇒ agentLabel 也是 null，第二個條件恰好也擋住；就算兩個都
   * 拿掉，touch 用的 tokenId 不同、clientId 就不同，clock 斷言看不到）。真正擋住它的是
   * `tsc`——`touch` 收 `string`，`tokenId` 是 `string | null`。**不要改成 `?.`、不要補 `!`。**
   * 規則的**結果面**（cookie 寫入不會多冒出一個 presence）由 `note-presence.test.ts` 第 2 案
   * 的 awareness 用戶端識別集合斷言守著。
   */
  private touch(noteId: string, tokenId: string | null, userHandle: string, agentLabel: string | null, target: PresenceTarget): void {
    if (tokenId && agentLabel) {
      this.deps.presence?.touch(noteId, tokenId, presenceIdentity(userHandle, agentLabel), target);
    }
  }

  /** 候選集合 → agentLabel → 佇列 → `applyEdit` → presence touch。 */
  async applyToNote(
    log: FastifyBaseLogger,
    input: {
      noteId: string;
      userId: string;
      userHandle: string;
      tokenId: string | null;
      op: EditOp;
      sectionId?: string;
      markdown?: string;
      ifMatch?: string;
    }
  ): Promise<WriteOutcome<ApplyOk, ApplyFailureCode> | ParserBusy | TooLarge> {
    // #269：lease **之前**預取寫入者可見清單（含 slug／群組／handle）；之後的解析在記憶體內完成、lease 期間零 DB。
    const candidates = await visibleNoteTargets(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    // #398：解析在進這篇筆記的佇列之前做（解析可能花上數秒，不該擋住同一篇的其他寫入）；結果交給 `applyEdit`，
    // 它在段落與指紋檢查之後才用（錯誤碼的先後不變；合併時的指紋比對照舊兜住解析期間別人的修改）。
    let preparsed: ParseOutcome | undefined;
    if (input.op !== "delete_section" && input.markdown !== undefined) {
      try {
        preparsed = await applyDeps.editing.parser.parse({ owner: input.userId, markdown: input.markdown, candidates, siteOrigin: siteOriginOf(applyDeps.editing.baseUrl) });
      } catch (err) {
        if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
        throw err;
      }
    }
    let result: ApplyResult;
    try {
      result = await this.queue.run(
        input.noteId,
        () =>
          applyEdit(applyDeps, {
            noteId: input.noteId,
            userId: input.userId,
            tokenId: input.tokenId,
            agentLabel,
            op: input.op,
            sectionId: input.sectionId,
            markdown: input.markdown,
            ifMatch: input.ifMatch,
            candidates,
            ...(preparsed !== undefined ? { preparsed } : {}),
          }),
        this.deps.queueWaitMs
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code, ...(result.detail ? { detail: result.detail } : {}) };
    // #138 presence：此時 `applyEdit` 已經 `disconnect()`，內容都在 live doc 上了。
    // ⚠ 目標取自**編輯後**的 `result.afterBlockIds`，不是請求帶進來的 `sectionId`：後者是
    //   heading 的 block id，`replace_section`／`delete_section` 已經把它換掉了。
    this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, presenceTargetForWrite(input.op, result.afterBlockIds));
    return { ok: true, result, agentLabel };
  }

  /** agentLabel → 佇列（與 `applyToNote` **同一顆**）→ `revertEdit` → presence touch。 */
  async revert(
    log: FastifyBaseLogger,
    input: { noteId: string; editId: string; userId: string; userHandle: string; tokenId: string | null }
  ): Promise<WriteOutcome<RevertOk, RevertFailureCode> | ParserBusy | TooLarge> {
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    let result: RevertResult;
    try {
      result = await this.queue.run(
        input.noteId,
        () => revertEdit(applyDeps, { noteId: input.noteId, editId: input.editId, userId: input.userId, tokenId: input.tokenId, agentLabel }),
        this.deps.queueWaitMs
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      // 撤回的轉換在 parse worker 裡：worker 全忙排太久、筆記太大，或三次都在合併前被別人改掉 → 503（什麼都沒寫）。
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code };
    // #138：`RevertResult` 不帶 sectionId（#137 的既定形），而且被撤回的那一段可能已經不存在
    // ——落在文件開頭，不為了這件事改 #137 的回傳型別。
    this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, { kind: "doc-start" });
    return { ok: true, result, agentLabel };
  }

  /** 版本歷史：佇列（與 `/edits`、撤回、MCP **同一顆**）→ `applyVersionEdit`。`kind: "busy"`＝佇列逾時（路由映 503）。 */
  async applyVersion(log: FastifyBaseLogger, input: ApplyVersionInput): Promise<WriteOutcome<{ applied: true }, ApplyVersionFailureCode> | TooLarge> {
    const versions = this.deps.versions;
    if (!versions) throw new Error("NoteWriteService：沒有版本服務（app.ts 一定會注入；直接 new 本 service 的測試要自己帶）");
    const deps = { ...this.applyDeps(log), versions };
    let result: Awaited<ReturnType<typeof applyVersionEdit>>;
    try {
      result = await this.queue.run(input.noteId, () => applyVersionEdit(deps, input), this.deps.queueWaitMs);
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code };
    return { ok: true, result: { applied: true }, agentLabel: null };
  }

  /**
   * 版本歷史：手動儲存走同一顆佇列（與套用序列化）。不需要 collab／editing：文件沒載入時讀 note_states 當暫時狀態。
   * `null`（交易內基底或空間對不上、已回寫記憶體）→ 重試一次，再 null → busy。uninitialized／fingerprint-failed → busy（503）。
   */
  async saveVersion(log: FastifyBaseLogger, input: { noteId: string; userId: string; name: string | null }): Promise<SaveVersionOutcome> {
    const versions = this.deps.versions;
    if (!versions) throw new Error("NoteWriteService：沒有版本服務");
    try {
      return await this.queue.run(
        input.noteId,
        async (): Promise<SaveVersionOutcome> => {
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const { doc, transient } = await versions.docFor(input.noteId);
            const r = await versions.cutIfDirty(input.noteId, doc, { kind: "manual", name: input.name, extraEditors: [{ userId: input.userId, agentLabel: null }], transient });
            if (r === null) continue;
            if ("skipped" in r) return r.skipped === "note-deleted" ? { ok: false, kind: "note-deleted" } : { ok: false, kind: "busy" };
            return { ok: true, row: r.row, upgraded: r.upgraded };
          }
          log.warn({ noteId: input.noteId }, "手動儲存版本：兩次都撞到基底或空間變動");
          return { ok: false, kind: "busy" };
        },
        this.deps.queueWaitMs,
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      throw err;
    }
  }

  /**
   * bulk transfer：檔案寫回一篇既有筆記。**筆記自下載後只要
   * 被動過（標題或內文），一律 409 `note_changed`，不再三方合併**。全在一次 `queue.run(noteId)` 內（與 edit_note、撤回、套用版本
   * 串行）；進佇列前只預取候選集合與 agentLabel（同 `applyToNote`）。順序：
   * ① 查基底（key＋user＋note）→ 查無 → `other_note`／`expired`；`key_id` 不符 → `expired`
   * ② 這份副本寫回過本文（`applied_body_sha`）：檔案本文與寫回的那份不同 → `already_sent`；相同 → 那次的紀錄有撤回過 → `reverted`；
   *    標題又有改 → `already_sent`（寫回過的副本不再收任何修改，連只改標題也不收——寫回之後別人改了什麼，這份副本判不出來）；
   *    否則當沒改（這幾個成因先於 `note_changed`：筆記是被這份副本自己改的）
   * ③ 檔案與這份副本相同（本文：下載時的 `body_sha`，或②寫回的那份；標題：`applied_title_sha ?? title_sha`）→ `unchanged`、扣
   *    `tokenRead`——不管筆記有沒有被別人動過 ④ 本文有改、筆記不可寫回（段表 null）→ `not_mergeable`
   * ⑤ 寫回額度 `transferWrite`（不足 → 429）：沒改的檔不碰；本文有改 → ⑦ 解析之前扣（解析失敗也算），
   *    零區退回（淨值不扣）；只改標題 → ⑨ 改名之前扣
   * ⑥ 筆記動過沒（內容比對，不看 `updated_at`）：現行標題的 HMAC ≠ 這份副本的標題 → `note_changed`；再 fork（live 文件就 fork 它）比內文：
   *    段表非 null → 頂層 id 與單顆指紋（整個 block 子樹的文字與屬性）要與基底段表逐顆相等（`matchesBase`；不整篇匯出比，
   *    連到的筆記改名或變不可見不算動過）——例外：基底 0 顆、現況恰一顆空段落（瀏覽器打開會正規化出來）當沒動過，套用時把它換掉；
   *    段表 null（只會是只改標題）→ 整篇匯出（`exportNoteBody`，與下載同一條組字）→ `normalizeBody` → HMAC ≠ `body_sha` → `note_changed`
   * ⑦ 本文有改 → 行雜湊 → diff → 扣 `transferWrite`（至多一次）→ `planSync`（parse 失敗 → 400，已扣的不退；基底段表的 `links` 給它判「連結文字仍是下載時匯出的那個」）；
   *    零區（全是 `same`）→ 當 `unchanged`、什麼都不寫、退回 `transferWrite`；否則 `applySync` → `beforeMerge` → `mergeDiff`
   *    （期望＝fork 頂層每一顆的指紋＋整篇指紋，與 `applyUpdate` 同一個 transact：⑥ 之後瀏覽器或任何寫入改了筆記就不合併）；不符 → 從 ⑥
   *    重來（重新 fork、重新判），最多 3 次 ⑧ 紀錄交易（`recordFileSyncInTx`，交易外 `redactDbError`）→ `updateNoteLinks`
   * ⑨ 改名：`renameNoteTitle` 帶 `expectTitle`＝⑥ 讀到的現行標題（檢查與改名同一句 UPDATE）⑩ presence。
   * 帶內容參數的 DB 呼叫（紀錄、改名）錯誤一律經 `redactDbError`。
   * 已知縫（不修）：① 只改標題時，⑥ 的內文判斷與 ⑨ 的改名不在同一個交易（內文在 Yjs、標題在 DB），中間瀏覽器
   * 打的字不擋改名 ② 寫回本文期間（⑥ 讀完標題之後、合併之前）別人改了標題，而檔案沒改標題：本文照寫，偵測不到這次改名。
   */
  async syncFile(log: FastifyBaseLogger, input: SyncFileInput): Promise<SyncFileOutcome> {
    const candidates = await visibleNoteTargets(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    try {
      return await this.queue.run(input.noteId, () => this.syncFileInQueue(log, applyDeps, input, candidates, agentLabel), this.deps.queueWaitMs);
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      if (err instanceof NoteGoneError) return { ok: false, kind: "gone" };
      if (err instanceof NoteTooLargeError) return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      // #398：解析排隊超過上限（已扣的寫回額度不退，同 `busy`）。
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
  }

  private async syncFileInQueue(
    log: FastifyBaseLogger,
    applyDeps: ApplyDeps,
    input: SyncFileInput,
    candidates: readonly VisibleNoteTarget[],
    agentLabel: string | null,
  ): Promise<SyncFileOutcome> {
    const db = this.deps.db;
    const hooks = this.deps.testHooks;
    const [base] = await db
      .select()
      .from(transferBases)
      .where(and(eq(transferBases.key, input.baseKey), eq(transferBases.userId, input.userId), eq(transferBases.noteId, input.noteId)))
      .limit(1);
    if (!base) {
      // 只為了回 reason 再查一次（只比 key；不回列的內容）：列在、但不是這篇或這個人 → other_note；不在 → expired（裁掉／過期）。
      const [other] = await db.select({ key: transferBases.key }).from(transferBases).where(eq(transferBases.key, input.baseKey)).limit(1);
      return { ok: false, kind: "base_unavailable", reason: other ? "other_note" : "expired" };
    }
    if (base.keyId !== input.keyId) return { ok: false, kind: "base_unavailable", reason: "expired" };
    const salt = Buffer.from(base.salt);
    const bodySha = hmacOf(input.key, salt, input.body);
    const applied = base.appliedBodySha === null ? null : Buffer.from(base.appliedBodySha);
    // 「這份副本目前的標題」＝applied_title_sha ?? title_sha（改名寫回過就是寫回的那個）。
    const copyTitle = Buffer.from(base.appliedTitleSha ?? base.titleSha);
    const fileTitleSha = input.title === undefined ? null : hmacOf(input.key, salt, input.title);
    const titleChanged = fileTitleSha !== null && !fileTitleSha.equals(copyTitle);
    let bodyChanged: boolean;
    if (applied === null) bodyChanged = !bodySha.equals(Buffer.from(base.bodySha));
    else if (bodySha.equals(applied)) {
      // 同檔重送：這份檔寫回的紀錄若有任一列已撤回，內容已不是「都套用了」→ 409 reverted。
      const ids = base.appliedEditIds ?? [];
      if (ids.length > 0) {
        const [rev] = await db.select({ id: noteAiEdits.id }).from(noteAiEdits).where(and(inArray(noteAiEdits.id, ids), isNotNull(noteAiEdits.revertedAt))).limit(1);
        if (rev) return { ok: false, kind: "base_unavailable", reason: "reverted" };
      }
      // 寫回過本文的副本又帶標題修改 → already_sent、不改名（寫回之後別人的修改，這份副本的基底已判不出來）。
      if (titleChanged) return { ok: false, kind: "base_unavailable", reason: "already_sent" };
      bodyChanged = false;
    } else return { ok: false, kind: "base_unavailable", reason: "already_sent" };

    const out: SyncFileOk = {
      ok: true, result: "unchanged", applied: 0, same: 0, editIds: [], unboundWikilinks: 0, renamed: false, diffOverflow: false, anchored: 0, degradedLines: 0,
    };
    const tokenReadKey = `token:${input.userId}`;
    if (!bodyChanged && !titleChanged) {
      if (!input.limiters.tokenRead.consume(tokenReadKey)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.tokenRead.retryAfterMs(tokenReadKey) };
      return out;
    }
    if (bodyChanged && base.segments === null) return { ok: false, kind: "not_mergeable" };
    // 寫回額度（`transferWrite`）：本文有改 → 解析前扣（解析失敗也算）、零區退回；只改標題 → 改名前扣。
    // 沒改的檔不碰這顆，零區的檔淨值不扣——但額度用完時本文有改的檔一律 429，連零區也是（判零區要先解析）。
    // 走到這裡一定是 `applied === null`：寫回過本文的副本（applied 非 null）只有「同檔重送且標題沒改」會往下，而那時兩者都沒改、上面已回。

    const noteChanged: SyncFileOutcome = { ok: false, kind: "base_unavailable", reason: "note_changed" };
    const [row] = await db.select({ title: notes.title }).from(notes).where(and(eq(notes.id, input.noteId), isNull(notes.deletedAt))).limit(1);
    if (!row) return { ok: false, kind: "gone" };
    if (!hmacOf(input.key, salt, row.title).equals(copyTitle)) return noteChanged;
    const currentTitle = row.title;

    let charged = false;
    /** 解析前扣的那一次落在的視窗（零區退回用，`refund` 的憑據）。 */
    let chargeTicket: number | null = null;
    let firstWritten: string | null = null;
    let contentWritten = false;

    const editing = applyDeps.editing;
    const baseBodySha = Buffer.from(base.bodySha);
    let diffIn: { agentLines: string[]; diff: Awaited<ReturnType<typeof diffLines>> } | null = null;
    if (bodyChanged) {
      const agentLines = bodyLines(input.body);
      const agent = await hashAgentLines(input.key, salt, agentLines);
      const diff = await diffLines({ hashes: Buffer.from(base.lineHashes), kinds: Buffer.from(base.lineKinds) }, agent);
      out.diffOverflow = diff.overflow;
      out.anchored = diff.anchored;
      out.degradedLines = diff.degradedLines;
      diffIn = { agentLines, diff };
    }
    let merged: MergeOutput | null = null;
    let syncApplied: SyncApplyDocResult | null = null;
    // #398：這個檔的解析預算，合併前被別人改掉重來（最多 SYNC_MERGE_ATTEMPTS 次）也共用這一份。
    const fileBudget = applyDeps.editing.parser.fileBudget();
    let zeroRegion = false;
    let bodyChecked = false;
    // 比對基底、解析、套用都在 parse worker 裡、對文件狀態做（`doc-jobs.ts` 的 `sync`；很小的筆記在主執行緒）。worker 要問的兩件事在這裡
    // 回答：連結的現行標題（段表 null 時整篇匯出比對用）、寫回額度（解析**之前**扣——解析失敗（400）也算一次，同 edit_note
    // 先扣 `edit` 再解析；重試不再扣，`charged`）。合併只在活文件仍是那份狀態時（`mergeAtBase`），否則從頭重來。
    const titles = titlesAsk(db, input.userId);
    let rateLimited = false;
    const ask: AskFn = async q => {
      if (q.kind === "titles") return titles(q);
      if (charged) return true;
      chargeTicket = input.limiters.transferWrite.consumeTicket(input.userId);
      if (chargeTicket === null) {
        rateLimited = true;
        return false;
      }
      charged = true;
      return true;
    };
    for (let attempt = 0; attempt < SYNC_MERGE_ATTEMPTS && merged === null && !zeroRegion && !bodyChecked; attempt++) {
      // 套用的合併只在活文件沒被改過時（批次寫回的守衛是 any）；有 watch 就不必整篇比快照（`live-watch.ts`）。
      const { state, watch } = await loadNoteState(applyDeps, input.noteId, { watch: true });
      try {
        const budgetMs = fileBudget.remainingMs;
        const r = await editing.runDoc(
          input.userId,
          {
            kind: "syncPlan", state: new Uint8Array(state), owner: input.userId, segments: base.segments, baseLineCount: base.lineKinds.length,
            body: diffIn === null ? null : { agentLines: diffIn.agentLines, diff: diffIn.diff },
            candidates, siteOrigin: siteOriginOf(editing.baseUrl), key: new Uint8Array(input.key), salt: new Uint8Array(salt), baseBodySha: new Uint8Array(baseBodySha), budgetMs,
          },
          // 時限＝剩下的解析預算＋一次單次時限（段表 null 時整篇匯出比對的份）；逾時＝太複雜（同預算用完）。
          { ask, extraWeight: input.body.length, timeoutMs: Math.max(0, budgetMs) + editing.parser.timeoutMs() },
        );
        if (r === DOC_TOO_COMPLEX) {
          fileBudget.remainingMs = 0;
          return { ok: false, kind: "parse", code: "unsupported_block", detail: "too_complex" };
        }
        fileBudget.remainingMs = r.budgetLeft;
        if (r.kind === "note_changed") return noteChanged;
        if (r.kind === "rate_limited" || rateLimited) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
        if (r.kind === "body_checked") {
          bodyChecked = true;
          break;
        }
        if (r.kind === "parse") return { ok: false, kind: "parse", code: r.code, ...(r.detail ? { detail: r.detail } : {}), ...(r.fence ? { fence: r.fence } : {}) };
        if (r.kind === "zero_region") {
          // 零區（含全是 same，例如只加空行）→ 當 `unchanged`：退回上面扣的寫回額度（之後照「都沒寫」扣 tokenRead）、
          // 不寫 `applied_body_sha`（這份副本之後只改標題仍照一般改名處理，不會被當成「已寫回過」而回 already_sent）。
          if (chargeTicket !== null) input.limiters.transferWrite.refund(input.userId, chargeTicket);
          charged = false;
          out.same = r.same;
          zeroRegion = true;
          break;
        }
        // 套用是另一件工作、同一份文件狀態（`doc-jobs.ts` 的 `SyncPlanDocOp` 註解）；時限＝一次 PARSE_TIMEOUT_MS 的 DOC_TIMEOUT_FACTOR 倍（同其他轉換）。
        const a = await editing.runDoc(input.userId, { kind: "syncApply", state, plan: r.plan, normalizedId: r.normalizedId }, { extraWeight: input.body.length });
        // 套用逾時或用完記憶體：解析已經過了，是筆記本身太大或太複雜——同 edit_note 寫進既有筆記（500 `too_complex`）。
        if (a === DOC_TOO_COMPLEX) return { ok: false, kind: "note_too_complex" };
        if (hooks?.beforeMerge) await hooks.beforeMerge();
        const ctx: DirectCtx = { source: "ai-edit", userId: input.userId, tokenId: input.tokenId, agentLabel, applied: false };
        try {
          merged = await mergeAtBase(applyDeps, input.noteId, ctx, a.post, watch);
        } catch (err) {
          if (err instanceof StaleBase) continue;
          throw err;
        }
        syncApplied = a;
      } finally {
        watch?.stop();
      }
    }
    if (!bodyChecked && !zeroRegion && merged === null) return { ok: false, kind: "busy" }; // 三次都撞指紋
    if (syncApplied !== null && merged !== null) {
      if (hooks?.beforeRecord) await hooks.beforeRecord();
      const { rows } = fileSyncRows({
        noteId: input.noteId, userId: input.userId, tokenId: input.tokenId, agentLabel,
        decisions: syncApplied.decisions, perRegion: syncApplied.perRegion, afterFingerprints: merged.afterFingerprints ?? [],
        recordable: (ids, fp) => recordableAfter(applyDeps, input.noteId, ids, fp),
      });
      const recordInput = { noteId: input.noteId, baseKey: base.key, appliedBodySha: bodySha, rows };
      try {
        out.editIds = await db.transaction(tx => recordFileSyncInTx(tx, recordInput));
      } catch (err) {
        throw redactDbError(log, err, "寫入檔案同步紀錄");
      }
      if (hooks?.afterRecord) await hooks.afterRecord();
      await updateNoteLinks(applyDeps, { sourceNoteId: input.noteId, userId: input.userId, targets: syncApplied.post.linkTargets, clock: merged.clock });
      out.applied = syncApplied.decisions.filter(d => d.mark === "applied").length;
      out.same = syncApplied.decisions.filter(d => d.mark === "same").length;
      out.unboundWikilinks = syncApplied.unbound;
      out.result = "applied";
      contentWritten = true;
      const firstIdx = syncApplied.decisions.findIndex(d => d.mark !== "same" && d.kind !== "delete");
      firstWritten = firstIdx === -1 ? null : (syncApplied.perRegion[firstIdx]!.afterIds[0] ?? null);
    }

    // ⑨ 改名：只在現行標題仍是 ⑥ 讀到的那個時才改（同一句 UPDATE）。
    if (titleChanged) {
      if (!contentWritten && !charged) {
        if (!input.limiters.transferWrite.consume(input.userId)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
        charged = true;
      }
      let r: RenameOutcome;
      try {
        r = await renameNoteTitle(db, { noteId: input.noteId, access: input.access, title: input.title!, expectTitle: currentTitle }, this.deps.renameHook);
      } catch (err) {
        throw redactDbError(log, err, "檔案寫回改名");
      }
      if (r.kind === "renamed") {
        try {
          await db.update(transferBases).set({ appliedTitleSha: fileTitleSha, lastUsedAt: sql`now()` }).where(eq(transferBases.key, base.key));
        } catch (err) {
          throw redactDbError(log, err, "寫入檔案同步基底");
        }
        out.renamed = true;
        if (!contentWritten) out.result = "renamed";
      } else if (!contentWritten && r.kind === "gone") {
        return { ok: false, kind: "gone" };
      } else if (!contentWritten && r.kind === "title_changed") {
        return noteChanged;
      } else {
        out.renameFailed = r.kind;
      }
    }

    if (!contentWritten && !out.renamed) {
      // 都沒寫：扣 tokenRead（本請求已扣過 transferWrite 就不再扣）。
      if (!charged && !input.limiters.tokenRead.consume(tokenReadKey)) {
        return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.tokenRead.retryAfterMs(tokenReadKey) };
      }
      return out;
    }
    // ⑩ presence：寫入的第一顆 block；只有刪除區 → 文件開頭；只改名不 touch。
    if (contentWritten) this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, firstWritten === null ? { kind: "doc-start" } : { kind: "block", blockId: firstWritten });
    return out;
  }

  /**
   * bulk transfer：沒有 `id` 的檔＝新增筆記。串行鍵 `create:${userId}:${fileSha}`（新筆記還沒有 id）；
   * 佇列內：去重命中（同使用者、同檔、同 `key_id`、30 分內、該筆記仍看得到）→ 扣 `tokenRead`、回原 id；否則先扣
   * `transferWrite`（解析失敗也算）→ 解析（`prepareContent`；失敗 → parse，不留筆記、不寫去重列）→ `createWithContent`（帶解析結果）→ upsert `transfer_creates`（TTL 外的舊列、原筆記進垃圾桶
   * 都會撞 PK）→ fire-and-forget TTL 清理。建列失敗照 `mcp/tools/create-note.ts` 的 `mapCreateInsertFailure` 分流。
   */
  async createFromFile(log: FastifyBaseLogger, input: CreateFromFileInput): Promise<CreateFromFileOutcome> {
    const key = `create:${input.userId}:${input.fileSha.toString("hex")}`;
    try {
      return await this.queue.run(key, () => this.createFromFileInQueue(log, input), this.deps.queueWaitMs);
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      throw err;
    }
  }

  private async createFromFileInQueue(log: FastifyBaseLogger, input: CreateFromFileInput): Promise<CreateFromFileOutcome> {
    const db = this.deps.db;
    const [hit] = await db
      .select({ noteId: transferCreates.noteId })
      .from(transferCreates)
      .where(and(eq(transferCreates.userId, input.userId), eq(transferCreates.fileSha, input.fileSha), eq(transferCreates.keyId, input.keyId), sql`${transferCreates.createdAt} > now() - make_interval(mins => ${CREATE_DEDUPE_MINUTES}::int)`))
      .limit(1);
    if (hit && (await resolveNoteAccess(db, input.userId, hit.noteId)).role !== "none") {
      const k = `token:${input.userId}`;
      if (!input.limiters.tokenRead.consume(k)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.tokenRead.retryAfterMs(k) };
      return { ok: true, created: false, noteId: hit.noteId, unboundWikilinks: 0 };
    }
    // 去重沒命中＝真的要建 → 先扣寫回額度、再解析（不是「只看不扣、解析成功才扣」）：解析失敗（400）
    // 也算一次，同 edit_note 先扣 `edit` 再解析——否則解析失敗的檔不花任何額度，每發都能讓伺服器同步解析一整份大檔。解析失敗不留筆記、不寫去重列。
    if (!input.limiters.transferWrite.consume(input.userId)) return { ok: false, kind: "rate_limited", retryAfterMs: input.limiters.transferWrite.retryAfterMs(input.userId) };
    const pre = await this.prepareContent(log, { userId: input.userId, tokenId: input.tokenId, content: input.body });
    if (!pre.ok) return pre.kind === "parser_busy" ? pre : { ok: false, kind: "parse", code: pre.code, ...(pre.detail ? { detail: pre.detail } : {}) };
    if (this.deps.testHooks?.beforeCreateFromFile) await this.deps.testHooks.beforeCreateFromFile();
    let r: CreateWithContentResult;
    try {
      r = await this.createWithContent(log, { userId: input.userId, userHandle: input.userHandle, tokenId: input.tokenId, title: input.title, content: input.body, scope: input.dest.scope, folderId: input.dest.folderId }, pre);
    } catch (err) {
      // 建列（insertNoteWithAutoSlug）在 createWithContent 的 try 之外、原樣拋出：同 `mapCreateInsertFailure` 的判準。
      if (isRetryableTxError(err)) return { ok: false, kind: "busy" };
      if (input.dest.folderId !== null && (isNoteFolderSpaceViolation(err) || isForeignKeyViolation(err))) return { ok: false, kind: "folder_gone" };
      if ("groupId" in input.dest.scope && isForeignKeyViolation(err)) return { ok: false, kind: "folder_gone" };
      throw redactDbError(log, err, "檔案新增建列");
    }
    // 帶了 `pre` 就不會再解析，所以這裡不會是 parse／parser_busy；照型別仍原樣轉出。
    if (!r.ok) return r.kind === "parse" ? { ok: false, kind: "parse", code: r.code, ...(r.detail ? { detail: r.detail } : {}) } : r.kind === "parser_busy" || r.kind === "too_large" ? r : { ok: false, kind: "internal" };
    try {
      await db
        .insert(transferCreates)
        .values({ userId: input.userId, fileSha: input.fileSha, noteId: r.noteId, keyId: input.keyId })
        .onConflictDoUpdate({ target: [transferCreates.userId, transferCreates.fileSha], set: { noteId: r.noteId, keyId: input.keyId, createdAt: sql`now()` } });
    } catch (err) {
      throw redactDbError(log, err, "寫入新增去重");
    }
    // TTL 清理（fire-and-forget；失敗只 warn code／constraint）。
    void db
      .execute(sql`delete from ${transferCreates} where ${transferCreates.createdAt} < now() - make_interval(mins => ${CREATE_DEDUPE_MINUTES}::int)`)
      .catch((err: unknown) => log.warn({ ...pgErrorSummary(err) }, "清理 transfer_creates 失敗"));
    return { ok: true, created: true, noteId: r.noteId, unboundWikilinks: r.unbound };
  }

  /**
   * 帶 content 建立筆記的完整管線：**先解析驗證（#398 起在 parse worker 裡）
   * → 建列 → 把解析出的 block JSON 套到真 fork**。解析在建列**之前**是契約，所以壞
   * content 一列都不會建；套用時傳 `blocks` 而非 `markdown`，同一份內容不會被 parse 與
   * wikilink 重綁兩次。
   *
   * 失敗（**含佇列逾時**）＝這篇筆記不該存在：best-effort 刪掉剛建的列，回 `kind:"internal"`
   * （呼叫端映成 `500 internal`）。⚠ **這條 catch 刻意不分辨例外型別**——`QueueBusyError`
   * 一併吃掉，因為這條路徑的逾時答案是 500 不是 503（`docs/ai-editing.md` 逐字）。
   * 解析的 worker 全忙（`parser_busy`）是建列**之前**的事，不在這條 catch 裡：一列都沒建，呼叫端映成 503。
   *
   * 不帶 content 的建立**不走這裡**（呼叫端自己呼叫 `insertNoteWithAutoSlug`，不吃 `edit` 桶）。
   */
  /**
   * `createWithContent` 的解析段（建列之前；不碰 DB 以外的狀態、不扣任何桶）。bulk transfer 的新增（`createFromFile`）先呼叫它、
   * 成功再把結果傳給 `createWithContent` 省掉第二次解析（`transferWrite` 由呼叫端在解析之前扣）。
   */
  async prepareContent(log: FastifyBaseLogger, input: { userId: string; tokenId: string | null; content: string }): Promise<PreparedContent | { ok: false; kind: "parse"; code: ParseError; detail?: ParseDetail } | ParserBusy> {
    // #269：解析之前預取寫入者可見清單（含 slug／群組／handle）；解析本身零 DB。
    const candidates = await visibleNoteTargets(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const editing = this.applyDeps(log).editing;
    // #398：在 parse worker 裡解析（不開編輯器、不持 lease）；worker 全忙排太久 → parser_busy（503）。
    let prepared: Awaited<ReturnType<typeof editing.parser.parse>>;
    try {
      prepared = await editing.parser.parse({ owner: input.userId, markdown: input.content, candidates, siteOrigin: siteOriginOf(editing.baseUrl) });
    } catch (err) {
      if (err instanceof ParserBusyError) return { ok: false, kind: "parser_busy" };
      throw err;
    }
    if ("error" in prepared) return { ok: false, kind: "parse", code: prepared.error, ...(prepared.detail ? { detail: prepared.detail } : {}) };
    return { ok: true, candidates, agentLabel, prepared };
  }

  /** 帶 content 建立失敗：best-effort 刪掉剛建的列（刪不掉只 warn，不要用第二個錯誤蓋掉第一個）。 */
  private async dropCreated(log: FastifyBaseLogger, noteId: string): Promise<void> {
    try {
      await this.deps.db.delete(notes).where(eq(notes.id, noteId));
    } catch (cleanupErr) {
      log.warn({ err: cleanupErr, noteId }, "帶 content 建立失敗後清除筆記列失敗");
    }
  }

  async createWithContent(
    log: FastifyBaseLogger,
    input: {
      userId: string; userHandle: string; tokenId: string | null; title: string | undefined; content: string; scope: SlugScope;
      /** 資料夾：呼叫端已驗過的資料夾；缺省＝根層。 */
      folderId?: string | null;
    },
    /** 呼叫端已經 `prepareContent` 過（bulk transfer 新增）就傳進來，不再解析一次；缺省＝這裡解析。 */
    pre?: PreparedContent,
  ): Promise<CreateWithContentResult> {
    const p = pre ?? (await this.prepareContent(log, input));
    if (!p.ok) return p;
    const { candidates, agentLabel, prepared } = p;
    // #387：`create_note`／`POST /api/notes`（自己解析的這條）照 `edit_note` 的規則保住讀到過的連結文字；檔案新增（帶 `pre`）不查——批次的行為不變。
    const [blocks, cleared] = pre ? [prepared.blocks, [] as Array<[string, string]>] : this.shownLinks.keepLabelFree(prepared.blocks, input.userId, candidates);
    const applyDeps = this.applyDeps(log);
    // #145：建列（含帶 title 時的 auto slug 派生）收在 `notes/create.ts`。⚠ **它仍必須排在
    // 解析之後**（「解析在建列之前」是契約）；#398 起解析不持 jsdom lease（在 parse worker 裡）。
    const note = await insertNoteWithAutoSlug(this.deps.db, { scope: input.scope, folderId: input.folderId ?? null }, input.title);
    try {
      const result = await this.queue.run(
        note.id,
        () =>
          applyEdit(applyDeps, {
            noteId: note.id,
            userId: input.userId,
            tokenId: input.tokenId,
            agentLabel,
            op: "replace_all",
            sectionId: undefined,
            markdown: undefined,
            ifMatch: undefined,
            candidates,
            blocks,
            unbound: prepared.unbound,
            contentLength: input.content.length,
          }),
        this.deps.queueWaitMs
      );
      // 套用的轉換在 worker 裡逾時或用完記憶體（內容太複雜）：同解析失敗回 400（剛建的列照下面刪掉）。
      if (!result.ok && result.code === "unsupported_block" && result.detail === "too_complex") {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "parse", code: "unsupported_block", detail: "too_complex" };
      }
      if (!result.ok) throw new Error(`帶 content 建立筆記時套用失敗：${result.code}`);
      // #387：寫下去的連結記在寫入者名下（同 `applyEdit` 的解析分支；檔案新增不記，批次的行為不變）。
      if (!pre) {
        const written = shownLinkTextsOf(blocks, new Map());
        written.free.push(...cleared); // 被清掉的原文字也記（同 `prepareEdit`）
        this.shownLinks.record(input.userId, written);
      }
      // #138：這條路徑**刻意不 touch** presence。筆記是這一發剛建出來的，不可能有人正開著它，
      // `touch` 內部的 `documents.get` 一定落空＝必然 no-op。另外三條寫入路徑都 touch，
      // 只有它不 touch 是刻意的——不要當成漏接補上去。
    } catch (err) {
      // 套用的轉換排不進 parse worker（全忙排太久）：刪掉剛建的列、回 503（同解析排不進）。
      if (err instanceof ParserBusyError) {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "parser_busy" };
      }
      // 內容會讓新筆記超過大小上限：刪掉剛建的列、回 413（什麼都沒留下）。
      if (err instanceof NoteTooLargeError) {
        await this.dropCreated(log, note.id);
        return { ok: false, kind: "too_large", limitBytes: err.limitBytes };
      }
      // 內容套用失敗＝這篇筆記不該存在。best-effort 刪除（刪不掉只 warn，不要用第二個錯誤
      // 蓋掉第一個），回 internal。
      log.error({ err, noteId: note.id }, "帶 content 建立筆記：套用內容失敗");
      await this.dropCreated(log, note.id);
      return { ok: false, kind: "internal" };
    }
    return { ok: true, noteId: note.id, inserted: note, unbound: prepared.unbound };
  }
}
