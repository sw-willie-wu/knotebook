import { AI_SSE_EVENTS, type AiActionDto } from "@knotebook/shared";
import { api, ApiFail } from "./client";

/** `GET /api/ai/actions`（Task 4）：可解析的 AI 動作清單。走一般 `api()`（JSON 契約）。 */
export function fetchAiActions(): Promise<AiActionDto[]> {
  return api<{ actions: AiActionDto[] }>("/api/ai/actions").then((body) => body.actions);
}

export interface StreamCallbacks {
  onDelta(text: string): void;
}

interface ApiErrorPayload {
  code: string;
  message: string;
}

/** `{error:{code,message}}` 的最小解析——刻意跟 `api/client.ts` 的 `isApiErrorBody` 分開一份
 * （這支不透過 `api()`，見下方 `streamAiAction` 檔頭理由），解不出來就回 `null`，呼叫端退回
 * 通用的 `"internal"`。 */
function parseErrorBody(body: unknown): ApiErrorPayload | null {
  if (typeof body !== "object" || body === null) return null;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  const message = (error as { message?: unknown }).message;
  return typeof code === "string" && typeof message === "string" ? { code, message } : null;
}

/** 一個完整 SSE frame（`event: X\ndata: Y`，frame 之間以空行分隔）解析出 `{event, data}`；
 * 解不出 `event:` 行（例如純空白 keep-alive frame）回 `null`，呼叫端略過不處理。 */
function parseSseFrame(frame: string): { event: string; data: unknown } | null {
  let event = "";
  let dataLine = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLine = line.slice(5).trim();
  }
  if (!event) return null;
  try {
    return { event, data: JSON.parse(dataLine || "{}") };
  } catch {
    return null;
  }
}

/**
 * `POST /api/ai` 的手寫 SSE client（spec §13.2/§13.5-1，Task 5 wire 契約）。
 *
 * **不走 `api()`**：`api()` 假設回應是單一 JSON body，非 2xx 才走它的錯誤解析——這裡的
 * 2xx 回應是一段 `text/event-stream`，得自己用 `fetch` + `ReadableStream` 手動收流。但
 * `api()` 幫忙補的兩件事仍要自己帶：
 * - `Content-Type: application/json`——漏這個 header，server 的 `app.ts` 全域 CSRF hook
 *   會直接 415 擋下（而且 fetch 完全被 stub 掉的單元測試測不出這個坑，只有手動對真
 *   server 驗收才會炸，見 brief）。
 * - `credentials: "include"`——沒有它，session cookie 不會隨請求送出，pre-stream 授權檢查
 *   一律 401。
 *
 * pre-stream（HTTP 狀態非 2xx，代表 server 還沒 `reply.hijack()`）解析
 * `{error:{code,message}}` 丟 `ApiFail`（直接重用 `api/client.ts` 的 `ApiFail` 型別，不是
 * 額外定義一份）；SSE 流中途收到 `error` 事件同樣丟 `ApiFail`（status 固定填 200——HTTP
 * status 這時早就送出去了，`code`/`message` 才是唯一有意義的資訊）；收到 `done` 事件視為
 * 串流正常結束，resolve。
 */
export async function streamAiAction(
  opts: {
    actionId: string;
    noteId: string;
    text: string;
    signal: AbortSignal;
  } & StreamCallbacks,
): Promise<void> {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    signal: opts.signal,
    body: JSON.stringify({ action_id: opts.actionId, note_id: opts.noteId, text: opts.text }),
  });

  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    const parsed = parseErrorBody(body);
    if (parsed) throw new ApiFail(response.status, parsed.code, parsed.message);
    throw new ApiFail(response.status, "internal", "Unexpected error response from server");
  }

  const reader = response.body?.getReader();
  if (!reader) return; // 沒有 body 可讀——防禦性分支，真正的 server 一定會給 event-stream body

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) return; // 連線提早結束、沒收到 `done` 事件——當作串流正常收尾，不視為錯誤
    buffer += decoder.decode(value, { stream: true });

    let separatorIndex: number;
    while ((separatorIndex = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      const parsed = parseSseFrame(frame);
      if (!parsed) continue;

      if (parsed.event === AI_SSE_EVENTS.delta) {
        const payload = parsed.data as { text?: unknown };
        if (typeof payload.text === "string") opts.onDelta(payload.text);
      } else if (parsed.event === AI_SSE_EVENTS.done) {
        return;
      } else if (parsed.event === AI_SSE_EVENTS.error) {
        const payload = parsed.data as { code?: unknown; message?: unknown };
        throw new ApiFail(
          200,
          typeof payload.code === "string" ? payload.code : "internal",
          typeof payload.message === "string" ? payload.message : "AI stream error",
        );
      }
    }
  }
}
