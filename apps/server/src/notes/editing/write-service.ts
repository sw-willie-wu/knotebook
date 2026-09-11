/**
 * #108 §10.1（D22／不變量 M5）：**同一篇筆記的所有寫入路徑**——REST 的 `/edits`、
 * `/revert`、`POST /api/notes` 帶 `content`，以及 PR2 之後 MCP 的 `edit_note`／`create_note`
 * ——必須經過**同一個** `NoteWriteQueue` 實例（`buildApp` 建一次、兩個路由共用）。不同實例
 * ＝沒有串行可言，而 #137 修過的資料損毀級 bug 與撤回的冪等守衛都建立在串行之上
 * （理由鏈逐字寫在 `queue.ts` 那段長註解裡）。
 *
 * 收進來的是**外圍順序**（候選集合 → agentLabel → 佇列 → `applyEdit`／`revertEdit` →
 * presence touch），**不收授權與限流**：那兩者在 REST 與 MCP 上的答案形不同（HTTP 狀態碼
 * vs 工具錯誤），收進來就得在這裡分支「我是誰的呼叫端」，比重複更糟。
 *
 * ⚠ **presence 目標只能取自 `presenceTargetForWrite(op, afterBlockIds)`**——#106 三棒各在
 * 這裡錯過一次（請求帶的 `section_id` 是 heading 的 block id，寫完就已經不存在了）。
 * ⚠ **帶 content 建立筆記的佇列逾時答案是 `500 internal` 不是 `503`**（`docs/ai-editing.md`
 * 逐字），所以 `createWithContent` 的 catch **刻意不分辨例外型別**，`QueueBusyError` 一併吃掉。
 * 這條逾時在真實路徑上不可達（plan 誠實缺口 13）；catch 不分辨型別是為了讓 REST 與 MCP
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
import { eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import * as Y from "yjs";
import type { EditOp } from "@knotebook/shared";
import { currentAgentLabel } from "../../auth/agent-label.js";
import type { CollabServer } from "../../collab/server.js";
import type { Db } from "../../db/index.js";
import { notes } from "../../db/schema.js";
import { applyEdit, type ApplyDeps, type ApplyResult, type EditingTestHooks } from "./apply.js";
import { visibleNoteTitles } from "./candidates.js";
import { parseMarkdownForNote, type ParseError } from "./markdown.js";
import { presenceIdentity, presenceTargetForWrite, type PresenceRegistry, type PresenceTarget } from "./presence.js";
import { NoteWriteQueue, QueueBusyError } from "./queue.js";
import { revertEdit, type RevertResult } from "./revert.js";
import type { EditingRuntime } from "./runtime.js";
import { EditorSession } from "./session.js";

export type ApplyOk = Extract<ApplyResult, { ok: true }>;
export type ApplyFailureCode = Extract<ApplyResult, { ok: false }>["code"];
export type RevertOk = Extract<RevertResult, { ok: true }>;
export type RevertFailureCode = Extract<RevertResult, { ok: false }>["code"];

/**
 * 寫入的三種結局。**兩個型別參數**：`T`＝成功結果，`C`＝該路徑的失敗碼聯集——`applyEdit`
 * 與 `revertEdit` 的碼**不同**，共用一個 `ApplyFailureCode` 會讓 revert 的 `stale`／
 * `already_reverted`／`not_found` 在呼叫端收窄不到（實跑得到 TS2322）。
 * `agentLabel` 一起回，是因為呼叫端組回應／記錄時還用得到，而它是在 service 裡查的。
 */
export type WriteOutcome<T, C> =
  | { ok: true; result: T; agentLabel: string | null }
  | { ok: false; kind: "busy" } // QueueBusyError：等了 `queueWaitMs` 還沒輪到
  | { ok: false; kind: "apply"; code: C };

/**
 * `db.insert(notes).values(...)` 收得下的形。**`title` 未帶時整把鍵都不放進去**——讓 DB 的
 * default `"Untitled"` 生效，而不是在應用層再寫死一次同一個預設值字面量（唯一真相在
 * `db/schema.ts`）。這條規則本來只有 `routes/notes.ts` 的兩行註解在守，本棒起有三個消費端。
 */
export type NoteInsertValues = { ownerId: string } | { ownerId: string; title: string };

export function noteInsertValues(ownerId: string, title: string | undefined): NoteInsertValues {
  return title === undefined ? { ownerId } : { ownerId, title };
}

/**
 * 帶 content 建立的結局。成功時**連 insert 的 `returning()` 那一列一起回**：兩個呼叫端
 * （REST 回 `NoteDto`、MCP 回 `NoteSummaryForModel`）要的 DTO 不同，重讀不可能有共用形，
 * 但「重讀落空時退回這一列」的退路可以共用一份資料。
 */
export type CreateWithContentResult =
  | { ok: true; noteId: string; inserted: typeof notes.$inferSelect }
  | { ok: false; kind: "parse"; code: ParseError }
  | { ok: false; kind: "internal" };

export interface NoteWriteServiceDeps {
  db: Db;
  /** D-A：兩者同生同滅——沒有 collab 的部署寫不動內容，`available` 為 false。 */
  collab?: CollabServer;
  editing?: EditingRuntime;
  /** #138 presence 註冊表（選配；沒有 collab 時是全 no-op 空殼）。 */
  presence?: PresenceRegistry;
  /** `NoteWriteQueue.run` 的等待上限（毫秒）；未傳＝佇列自己的預設 10 s。整合測試壓到 50 ms 才驗得出 503。 */
  queueWaitMs?: number;
  /** 寫入路徑的測試注入縫（生產不注入＝零成本）。 */
  testHooks?: EditingTestHooks;
}

export class NoteWriteService {
  /**
   * ⚠ **全樹唯一的 `new NoteWriteQueue()`**（M5）。`buildApp` 只建一個 service，
   * `notesRoutes` 與 `mcpRoutes` 拿到的是同一個物件。process-local。
   */
  private readonly queue = new NoteWriteQueue();

  constructor(private readonly deps: NoteWriteServiceDeps) {}

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
    return { db: this.deps.db, collab, editing, log, testHooks: this.deps.testHooks };
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
  ): Promise<WriteOutcome<ApplyOk, ApplyFailureCode>> {
    const candidates = await visibleNoteTitles(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
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
          }),
        this.deps.queueWaitMs
      );
    } catch (err) {
      if (err instanceof QueueBusyError) return { ok: false, kind: "busy" };
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code };
    // #138 presence（spec §9）：此時 `applyEdit` 已經 `disconnect()`，內容都在 live doc 上了。
    // ⚠ 目標取自**編輯後**的 `result.afterBlockIds`，不是請求帶進來的 `sectionId`：後者是
    //   heading 的 block id，`replace_section`／`delete_section` 已經把它換掉了。
    this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, presenceTargetForWrite(input.op, result.afterBlockIds));
    return { ok: true, result, agentLabel };
  }

  /** agentLabel → 佇列（與 `applyToNote` **同一顆**）→ `revertEdit` → presence touch。 */
  async revert(
    log: FastifyBaseLogger,
    input: { noteId: string; editId: string; userId: string; userHandle: string; tokenId: string | null }
  ): Promise<WriteOutcome<RevertOk, RevertFailureCode>> {
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
      throw err;
    }
    if (!result.ok) return { ok: false, kind: "apply", code: result.code };
    // #138：`RevertResult` 不帶 sectionId（#137 的既定形），而且被撤回的那一段可能已經不存在
    // ——落在文件開頭，不為了這件事改 #137 的回傳型別。
    this.touch(input.noteId, input.tokenId, input.userHandle, agentLabel, { kind: "doc-start" });
    return { ok: true, result, agentLabel };
  }

  /**
   * 帶 content 建立筆記的完整管線（spec §5 逐字）：**先在空 scratch Y.Doc ＋ mounted 編輯器上
   * 解析驗證 → 建列 → 把解析出的 block JSON 套到真 fork**。解析在建列**之前**是契約，所以壞
   * content 一列都不會建；套用時傳 `blocks` 而非 `markdown`，同一份內容不會被 parse 與
   * wikilink 重綁兩次。
   *
   * 失敗（**含佇列逾時**）＝這篇筆記不該存在：best-effort 刪掉剛建的列，回 `kind:"internal"`
   * （呼叫端映成 `500 internal`）。⚠ **這條 catch 刻意不分辨例外型別**——`QueueBusyError`
   * 一併吃掉，因為這條路徑的逾時答案是 500 不是 503（`docs/ai-editing.md` 逐字）。
   *
   * 不帶 content 的建立**不走這裡**（呼叫端自己 insert，不吃 `edit` 桶）。
   */
  async createWithContent(
    log: FastifyBaseLogger,
    input: { userId: string; userHandle: string; tokenId: string | null; values: NoteInsertValues; content: string }
  ): Promise<CreateWithContentResult> {
    const candidates = await visibleNoteTitles(this.deps.db, input.userId);
    const agentLabel = input.tokenId ? await currentAgentLabel(this.deps.db, input.tokenId) : null;
    const applyDeps = this.applyDeps(log);
    // ⚠ `try { … } finally { s.close() }`（lease 不變量）；且**離開這個區塊之前不得再取得
    // 第二個 lease**——`applyEdit` 自己會再開一次，所以它必須排在 close 之後。
    const scratch = await EditorSession.open(applyDeps.editing, new Y.Doc());
    let prepared: ReturnType<typeof parseMarkdownForNote>;
    try {
      prepared = parseMarkdownForNote(scratch.editor, input.content, candidates);
    } finally {
      scratch.close();
    }
    if ("error" in prepared) return { ok: false, kind: "parse", code: prepared.error };
    const [created] = await this.deps.db.insert(notes).values(input.values).returning();
    const note = created!;
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
            blocks: prepared.blocks,
            unbound: prepared.unbound,
          }),
        this.deps.queueWaitMs
      );
      if (!result.ok) throw new Error(`帶 content 建立筆記時套用失敗：${result.code}`);
      // #138：這條路徑**刻意不 touch** presence。筆記是這一發剛建出來的，不可能有人正開著它，
      // `touch` 內部的 `documents.get` 一定落空＝必然 no-op。另外三條寫入路徑都 touch，
      // 只有它不 touch 是刻意的——不要當成漏接補上去。
    } catch (err) {
      // 內容套用失敗＝這篇筆記不該存在。best-effort 刪除（刪不掉只 warn，不要用第二個錯誤
      // 蓋掉第一個），回 internal。
      log.error({ err, noteId: note.id }, "帶 content 建立筆記：套用內容失敗");
      try {
        await this.deps.db.delete(notes).where(eq(notes.id, note.id));
      } catch (cleanupErr) {
        log.warn({ err: cleanupErr, noteId: note.id }, "帶 content 建立失敗後清除筆記列失敗");
      }
      return { ok: false, kind: "internal" };
    }
    return { ok: true, noteId: note.id, inserted: note };
  }
}
