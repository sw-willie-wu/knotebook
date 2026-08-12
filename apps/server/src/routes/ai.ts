import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { AI_SSE_EVENTS, type AiActionDto } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { aiActions } from "../db/schema.js";
import { loadAiSnapshot, resolveActionModel } from "../ai/resolve.js";
import { AiKeyDecryptError, decryptApiKey } from "../ai/crypto.js";
import type { AiRuntime } from "../ai/runtime.js";
import { renderUserTemplate, streamAnthropic, streamOpenAiCompatible, type UpstreamHandle } from "../ai/upstream.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { resolveRole, UUID_RE } from "../notes/service.js";

export interface AiRouteDeps {
  db: Db;
  config: AppConfig;
  runtime: AiRuntime;
  /** per-user 節流（`AI_LIMIT`，同 collabToken/slugPatch/upload 慣例，key=userId）。 */
  limiters: { ai: FixedWindowLimiter };
  /**
   * SSE 收流後的 idle 逾時（無 delta）覆寫值，毫秒。**測試 seam**——CI flake round 2
   * 診斷：`vi.useFakeTimers` × 真實 SSE I/O（fake upstream 是真的 `http.createServer`，
   * app 端打的是真 `fetch()`）在 CI 上互動不可靠（本機兩輪都綠、CI 兩次都在
   * `startFakeUpstream` 的 `onTestFinished` server.close() 卡 180s hook timeout——代表
   * 測試本體已經跑完、只是連線沒被關掉，指向假時鐘沒能可靠驅動這條 `setTimeout`）。round 1
   * 的「確定性 arm 訊號」方向沒錯但沒治本，round 2 改結構：讓 idle timeout 這個數字可被
   * 測試注入一個短的**真實**值，測試改用真實時間等待，完全不碰 `vi.useFakeTimers`。
   * **選配**：不傳沿用生產預設 `IDLE_TIMEOUT_MS`（60s）——production（`src/app.ts`
   * 未傳 `BuildAppOptions.aiIdleTimeoutMs` 時）與其餘測試（未特別覆寫時）行為不變。
   */
  idleTimeoutMs?: number;
}

// body 刻意 snake_case（spec §6 明文例外，與其他路由的 camelCase 慣例不同）。
const postAiBodySchema = z.object({
  action_id: z.string().min(1),
  note_id: z.string().min(1),
  text: z.string().min(1),
});

const AI_UNAVAILABLE_MESSAGE = "此 AI 服務目前無法使用，請聯絡管理員";
/** SSE 收流後的 idle 逾時（無 delta）生產預設值——`AiRouteDeps.idleTimeoutMs` 未傳時採用。
 * 導出（非 module-private）：`test/unit` 有一條形狀測試釘住這個預設值，防止未來改動時
 * 悄悄把預設值改壞卻沒有任何測試示警（見該測試檔說明）。 */
export const IDLE_TIMEOUT_MS = 60_000;

/**
 * 一般 session 用 AI 路由：`GET /api/ai/actions`（Task 4）＋`POST /api/ai` SSE 端點
 * （Task 5，spec §13.2/§13.5-1）。
 */
export function aiRoutes(deps: AiRouteDeps) {
  // 解析一次即定案（同一個 aiRoutes(...) 呼叫掛出來的所有請求共用同一個值）——
  // `deps.idleTimeoutMs` 未傳（生產／未覆寫的測試）時採用生產預設。
  const idleTimeoutMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  return async function register(app: FastifyInstance): Promise<void> {
    // 依 sort_order, id 排序（次要鍵慣例，同 `admin-users.ts` GET 列表）；只帶
    // `{id, name, applyMode}`——systemPrompt/userTemplate 這些不需要洩給非 admin。
    //
    // 「可解析」判定與 `POST /api/ai`（Task 5）**共用同一支 `resolveActionModel`**
    // （spec §13.2 單一真相）：一次 `loadAiSnapshot` 取快照，對每筆 enabled action 套用，
    // 只有解析得出 model/provider 的 action 才出現在清單——全新實例（零 provider）／
    // 全部降級但仍 enabled 的 provider（降級不參與此判定，只影響 POST 執行）／
    // action 綁定的 model 已停用但存在其他可回退的 enabled chat model，皆各自對應
    // 「回空」「照常出現」「照常出現」三種正確行為，不必個別特判。
    app.get("/api/ai/actions", { preHandler: app.authenticate }, async () => {
      const [snapshot, actionRows] = await Promise.all([
        loadAiSnapshot(deps.db),
        deps.db.select().from(aiActions).where(eq(aiActions.enabled, true)).orderBy(asc(aiActions.sortOrder), asc(aiActions.id)),
      ]);

      const actions: AiActionDto[] = [];
      for (const row of actionRows) {
        const resolved = resolveActionModel({ modelId: row.modelId }, snapshot);
        if (resolved === null) continue;
        actions.push({ id: row.id, name: row.name, applyMode: row.applyMode as "direct" | "preview" });
      }

      return { actions };
    });

    /**
     * `POST /api/ai`（spec §13.2/§13.5-1）：body 為 snake_case `{action_id, note_id, text}`
     * （spec §6 刻意例外）。授權/節流/解析全在 `reply.hijack()` **之前**完成——pre-stream 錯誤
     * 走一般 `sendError`（400/401/403/404/429/503）；一旦 hijack，之後整段 try/catch/finally
     * 包死，任何例外只會送出固定文案的 SSE `error` 事件，絕不逃到全域 errorHandler
     * （spec §13.2）。
     *
     * 授權沿用 uploads/notes 慣例：note 無權（含 note_id 非合法 uuid，`resolveRole` 內建擋）
     * → 404；viewer → 403；editor/owner 才可執行 AI 動作。
     */
    app.post("/api/ai", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = postAiBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const { action_id: actionId, note_id: noteId, text } = parsed.data;

      // 非 uuid 一律 400（不進 resolveRole/DB 查詢——UUID_RE 是 resolveRole 內部同一份
      // guard，但這裡刻意提前擋掉，避免「格式不合法」與「無權限/找不到」在同一個 404 分支
      // 裡混淆，且 action_id 若非 uuid，後面 aiActions 查詢會直接讓 pg 丟裸例外）。
      if (!UUID_RE.test(actionId) || !UUID_RE.test(noteId)) {
        return sendError(reply, 400, "invalid_body", "action_id/note_id 格式錯誤");
      }

      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") return sendError(reply, 404, "not_found", "找不到此筆記");
      if (role === "viewer") return sendError(reply, 403, "forbidden", "沒有編輯權限");

      if (!deps.limiters.ai.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }

      const [action] = await deps.db.select().from(aiActions).where(eq(aiActions.id, actionId)).limit(1);
      if (!action || !action.enabled) return sendError(reply, 404, "not_found", "找不到此動作");

      // 與 GET /api/ai/actions 共用同一支 loadAiSnapshot/resolveActionModel（spec §13.2 單一
      // 真相）：GET 清單「有出現」與這裡「解析得出」必然一致，不會出現清單有但打不通、或
      // 清單沒有但仍能執行的漂移。
      const snapshot = await loadAiSnapshot(deps.db);
      const resolved = resolveActionModel({ modelId: action.modelId }, snapshot);
      if (resolved === null) {
        return sendError(reply, 503, "ai_not_configured", "AI 尚未設定，請聯絡管理員");
      }

      // anthropic 且無 key：**獨立檢查**（不透過 degraded 集合）——NULL key 是「尚未設定」的
      // 合法初始狀態（同 `ai/runtime.ts` checkProviderKeys 的「跳過不降級」語意），不是「壞掉」。
      if (resolved.provider.type === "anthropic" && resolved.provider.apiKeyEncrypted === null) {
        return sendError(reply, 503, "provider_unavailable", AI_UNAVAILABLE_MESSAGE);
      }

      // 已知降級（啟動自檢或先前任一次解密失敗）：不必再試一次解密，直接回絕，不打 upstream。
      if (deps.runtime.degraded.has(resolved.provider.id)) {
        return sendError(reply, 503, "provider_unavailable", AI_UNAVAILABLE_MESSAGE);
      }

      // apiKey 在 pre-stream 解密（hijack 之後不做任何可拋錯的準備工作）：解不開 → 503 +
      // 補進 degraded（與 admin-ai.ts 的 `/test` 端點同款流程）。openai_compatible 允許
      // NULL key（本機/無驗證的 vLLM），此時 apiKey 維持 undefined。
      let apiKey: string | undefined;
      if (resolved.provider.apiKeyEncrypted !== null) {
        try {
          apiKey = decryptApiKey(deps.config.appSecret, resolved.provider.apiKeyEncrypted);
        } catch (err) {
          if (!(err instanceof AiKeyDecryptError)) throw err;
          deps.runtime.degraded.add(resolved.provider.id);
          return sendError(reply, 503, "provider_unavailable", AI_UNAVAILABLE_MESSAGE);
        }
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      raw.on("error", err => request.log.warn({ err }, "sse socket error")); // 無 listener 時 destroyed write 會以未處理 error 事件冒出
      const send = (event: string, data: unknown): void => {
        if (raw.destroyed || raw.writableEnded) return; // client 已離開——catch/finally 的送出路徑也會走到這裡
        try {
          raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch {
          /* client 已離開，僅止損 */
        }
      };
      const upstreamAbort = new AbortController();
      // 【偏離 brief 骨架，記錄理由，fix round 1 M-1 校正機制描述】骨架原文用
      // `request.raw.on("close", ...)`。實測（Node ≥16 `http.IncomingMessage` 語意 + 本專案
      // 實際 handler 結構交叉驗證）：`request.raw` 的 'close' 語意是「這個 *request*（含其
      // body）已完成」，不是「client 連線已斷」——一旦 request body 讀完就視為完成。在本
      // handler 的實際非同步結構下（hijack 前有多次 await：authenticate、resolveRole、
      // limiter、action 查詢、loadAiSnapshot、decryptApiKey），這個事件會在 handler 起跑後
      // 約 1ms 內自發 fire 一次——若監聽器已註冊，會被正常呼叫，導致我們把 `upstreamAbort`
      // 誤觸發（造成 SSE 只送出 `error` 事件，即使 client 根本沒斷線）；若監聽器還沒註冊到，
      // 則永久錯過（EventEmitter 不會回放過去事件），之後 client 真的斷線也偵測不到。兩種
      // 失效模式在沙盒重現腳本裡都各自出現過，共同結論是：`request.raw` 的 'close' 與「client
      // 連線是否還活著」無穩定對應關係，不可用。
      // 正確訊號是 **response**（`reply.raw`，這裡已經是 `raw`）的 'close' 事件——它綁定的
      // 是底層 socket 真正的生命週期（無論是我們自己呼叫 `raw.end()` 正常結束，或 client
      // 提早斷線），才是這裡真正要問的問題。掛在 `raw` 上：正常完成路徑會在 `finally` 呼叫
      // `raw.end()` 之後才觸發，此時 `upstreamAbort.abort()` 是無害的 no-op（generator 早已
      // 跑完，沒有任何東西還在監聽這個 signal）。
      raw.on("close", () => upstreamAbort.abort());
      // fix round 1 I-3：pre-stream 階段（hijack 之前那一串 await：authenticate/resolveRole/
      // limiter/action 查詢/loadAiSnapshot/decryptApiKey）client 若已斷線，`raw` 的 'close'
      // 可能早在我們掛上面這個 listener之前就已經 fire 過、錯過了——這裡補一次立即檢查，
      // 把「listener 註冊時連線已經死了」這個既成事實同步反應出來，不必等到 upstream 真的
      // 送出第一個位元組才發現對方早就不在了。`streamOpenAiCompatible`／`streamAnthropic`
      // 兩者對已 abort 的 signal 都有前置守衛（`opts.signal.aborted` 時直接 abort 內部
      // controller），連 fetch/SDK 呼叫都不會真的發出去。
      if (raw.destroyed) upstreamAbort.abort();
      let idleTimer: NodeJS.Timeout | undefined;
      const resetIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => upstreamAbort.abort(), idleTimeoutMs);
      };
      // fix round 1 I-2：`UpstreamHandle.abort()` 骨架介面本來就有這個方法，但先前只讓
      // `upstreamAbort`（route 端擁有的 controller）驅動中止，從未呼叫過它——導致
      // `[DONE]`／正常收流完成後，如果上游自己沒有主動關閉底層連線（部分 vLLM/相容伺服器
      // 行為），我們這端不會主動要求關閉，造成一個不會再被讀取、但也沒被中止的 socket 洩漏。
      // 用外層變數持有 handle（try 內才賦值，pre-stream 例外/沒進 try 分支時仍是
      // undefined），finally 統一呼叫 `handle?.abort()`——涵蓋正常結束、上游錯誤、idle
      // timeout、client 斷線四種收尾路徑，兩個 provider 分支皆受惠。
      let handle: UpstreamHandle | undefined;
      try {
        const opts = {
          baseUrl: resolved.provider.baseUrl,
          model: resolved.model.modelId,
          system: action.systemPrompt,
          user: renderUserTemplate(action.userTemplate, text),
          signal: upstreamAbort.signal,
        };
        handle =
          resolved.provider.type === "anthropic"
            ? streamAnthropic({ ...opts, apiKey: apiKey! })
            : streamOpenAiCompatible({ ...opts, apiKey });
        resetIdleTimer();
        for await (const delta of handle.stream) {
          resetIdleTimer();
          send(AI_SSE_EVENTS.delta, { text: delta }); // 變數名 delta——不得叫 text，會遮蔽上方 request body 的 text
        }
        send(AI_SSE_EVENTS.done, {});
      } catch (err) {
        request.log.warn({ err }, "ai upstream failed"); // 上游細節只進 log（含 UpstreamError.upstreamBody，若有）
        send(AI_SSE_EVENTS.error, { code: "upstream_error", message: "upstream request failed" }); // 固定文案，絕不含上游 body
      } finally {
        handle?.abort(); // I-2：無論收尾路徑為何，一律確保 upstream 連線被要求關閉，不留給對方單方面決定
        clearTimeout(idleTimer);
        if (!raw.writableEnded) raw.end();
      }
      // hijack 之後整段 try/catch/finally 包死——任何例外不得逃到全域 errorHandler（spec §13.2）。
    });
  };
}
