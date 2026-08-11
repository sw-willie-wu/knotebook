import Anthropic from "@anthropic-ai/sdk";

/**
 * Upstream 串流薄層（Task 5，spec §13.2/§13.5-1）：兩個 provider 型別（openai_compatible／
 * anthropic）各一支函式，統一吐出「純 text delta」的 `AsyncIterable<string>`——呼叫端
 * （`routes/ai.ts` 的 `POST /api/ai` handler）完全不需要知道底層是 vLLM 風格的 SSE 逐行解析
 * 還是 `@anthropic-ai/sdk` 的事件物件，只管 `for await` 拿 delta 文字。
 *
 * `redirect: "manual"`（openai_compatible 分支）沿用 Task 4 審查 I-4 的約定：undici 對跨網域
 * 轉址只會剝掉 `Authorization`/`Cookie`，這裡帶的是自訂 `authorization: Bearer ...` header，
 * 3xx 若被追蹤會把它原樣送去第三方主機。手動模式下 3xx 直接落入 `!res.ok`（`res.ok` 只認
 * 2xx），統一映射成 `UpstreamError`，不外洩任何憑證。
 */

/** 非 2xx／流未建立成功時拋出。`status` 供呼叫端 log／分類；`upstreamBody`（截 2048 字元）
 * 只給呼叫端 log 用（`request.log.warn({err}, ...)` 會把這個 Error 的所有 own property
 * 一併序列化）——SSE 送給 client 的 error 事件訊息固定文案，絕不含這個欄位的內容。 */
export class UpstreamError extends Error {
  constructor(
    public status: number,
    public upstreamBody?: string
  ) {
    super("upstream request failed");
    this.name = "UpstreamError";
  }
}

export interface UpstreamHandle {
  /** 純 text delta（reasoning/thinking 內容已在這一層濾掉，不外流）。 */
  stream: AsyncIterable<string>;
  /** 主動中止（額外提供；route handler 目前透過共用的 `AbortController`／傳入的 `signal`
   * 驅動中止，不直接呼叫這個方法——保留給 unit test 或未來呼叫端直接操作單一 handle 用）。 */
  abort(): void;
}

/**
 * `{{text}}` 佔位替換（spec §13.5-1）：`replaceAll` 的搜尋端傳純字串（非 regex）——字面比對
 * `{{text}}`，不會把它的任何字元解讀成正規表示式語法，這是選 `replaceAll` 而非 regex-based
 * `.replace()` 的理由。
 *
 * 但替換端若也傳純字串，JS 規範對「替換字串」本身仍會解讀 `$&`／`$$`／`` $` ``／`$'`／
 * `$<name>` 這類特殊模式（即使搜尋端是純字串搜尋，這條規則對替換端一律生效——不是只有 regex
 * 搜尋才會觸發）。使用者選取的文字若剛好含這些字元組合（例如 `$$`、程式碼裡的樣板字串
 * `${...}`），naive 字串替換會靜默吃掉／扭曲這些字元，等同資料損毀。改用**函式形式**的第二
 * 引數（`() => text`）完全繞開這條替換模式解析——這才是「`replaceAll` 字面語意」真正要求的
 * 行為：字面比對＋字面替換，兩端都不做任何特殊字元解讀，text 逐字元原樣貼回。
 */
export function renderUserTemplate(template: string, text: string): string {
  return template.replaceAll("{{text}}", () => text);
}

const MAX_LOGGED_BODY_CHARS = 2048;

function truncateBody(text: string): string {
  return text.length > MAX_LOGGED_BODY_CHARS ? `${text.slice(0, MAX_LOGGED_BODY_CHARS)}...(truncated)` : text;
}

/**
 * 逐行拆 `ReadableStream<Uint8Array>`：內部維護一個跨 chunk 的字串緩衝區，任何一行（含
 * `data: ...`）跨越兩個 chunk 邊界都會被正確重組——不能假設每個 chunk 剛好在換行處結束。
 * `\r\n`／`\n` 皆視為換行；末尾若有殘留（無結尾換行的最後一行）也會補吐一次。
 */
async function* readSseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const rawLine = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        yield rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      }
    }
    if (buffer.length > 0) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

interface OpenAiCompatibleOpts {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
}

interface OpenAiChatCompletionChunk {
  choices?: Array<{ delta?: { content?: unknown; reasoning_content?: unknown } }>;
}

/**
 * openai_compatible（vLLM 等）串流：`POST {baseUrl}/chat/completions`，`stream: true`。逐行
 * 解析 `data: ...`，只取 `choices[0].delta.content`——`reasoning_content`/`thinking` 這類欄位
 * 存在也完全丟棄，不拼進輸出（spec §8）。`data: [DONE]` 視為正常收流結束（不是錯誤）。
 */
export function streamOpenAiCompatible(opts: OpenAiCompatibleOpts): UpstreamHandle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", onAbort);

  async function* generate(): AsyncGenerator<string> {
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.apiKey !== undefined) headers.authorization = `Bearer ${opts.apiKey}`;

      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: opts.model,
          stream: true,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        }),
        signal: controller.signal,
        redirect: "manual",
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new UpstreamError(res.status, truncateBody(bodyText));
      }
      if (res.body === null) {
        throw new UpstreamError(res.status);
      }

      for await (const line of readSseLines(res.body)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice("data:".length).trim();
        if (payload.length === 0) continue;
        if (payload === "[DONE]") return;

        let parsed: OpenAiChatCompletionChunk;
        try {
          parsed = JSON.parse(payload) as OpenAiChatCompletionChunk;
        } catch {
          // 非預期的畸形行（不是我們定義的錯誤場景，spec 未要求特判）：忽略、繼續解析下一行，
          // 不讓整個串流因單行壞資料而中斷。
          continue;
        }
        const delta = parsed.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) yield delta;
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }

  return { stream: generate(), abort: () => controller.abort() };
}

interface AnthropicOpts {
  apiKey: string;
  baseUrl?: string;
  model: string;
  system: string;
  user: string;
  signal: AbortSignal;
}

// anthropic Messages API 要求 max_tokens；AI 快速動作（重寫/翻譯/摘要/續寫）皆是短中篇文字
// 轉換，不是開放式長文生成，4096 足夠且不過度浪費（brief 未指定精確值，此為保守預設）。
const ANTHROPIC_MAX_TOKENS = 4096;

/**
 * anthropic 串流：`@anthropic-ai/sdk` 的 `client.messages.stream(...)`——認證（`x-api-key`）與
 * `anthropic-version` header 由 SDK 自帶，不必手動組 header（交接約定）。只轉發
 * `content_block_delta` 事件裡 `delta.type === "text_delta"` 的 `.text`；其餘事件類型
 * （`thinking_delta`、`message_start`……）一律忽略，不落進輸出。
 *
 * SDK 拋出的例外（`Anthropic.APIError` 及其子類別）原樣往外丟，不在此層轉譯成
 * `UpstreamError`——呼叫端（route handler）的 catch-all 對任何錯誤型別一視同仁（記 log、送
 * 固定文案的 SSE error 事件），不需要每個 provider 分支各自維持同一套錯誤型別契約。
 *
 * **fix round 1 I-1（安全，審查者用真 SDK + 302 repro 實測）**：`fetchOptions: { redirect:
 * "manual" }`——沿用 Task 4 審查 I-4 的理由（undici 對跨網域轉址只剝 `Authorization`/
 * `Cookie`，SDK 自帶的 `x-api-key` 不在那個剝除清單內，惡意/被劫持的 upstream 若回 302 會把
 * 明文 key 原樣送去轉址目標）。實測：預設（無此選項）302 會讓 attacker 端收到明文 key；加了
 * `redirect:"manual"` 後零外送——手動模式下 3xx 直接變成 SDK 的 `APIError`，被上層 catch-all
 * 收成固定文案 SSE error，與 openai_compatible 分支（同款 `redirect:"manual"`）行為對稱。
 */
export function streamAnthropic(opts: AnthropicOpts): UpstreamHandle {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts.signal.aborted) controller.abort();
  else opts.signal.addEventListener("abort", onAbort);

  async function* generate(): AsyncGenerator<string> {
    try {
      const client = new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseUrl, fetchOptions: { redirect: "manual" } });
      const stream = client.messages.stream(
        {
          model: opts.model,
          max_tokens: ANTHROPIC_MAX_TOKENS,
          system: opts.system,
          messages: [{ role: "user", content: opts.user }],
        },
        { signal: controller.signal }
      );
      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield event.delta.text;
        }
      }
    } finally {
      opts.signal.removeEventListener("abort", onAbort);
    }
  }

  return { stream: generate(), abort: () => controller.abort() };
}
