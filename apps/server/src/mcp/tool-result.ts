/**
 * #108 §8.1 D11／D31／M10／M15：**我們自己產生的**工具結果（成功與錯誤兩側）唯一的建構點。
 * 兩支建構子共用同一條鏡像等式——`content[0].text` 逐字是 `JSON.stringify(structuredContent)`
 * ——所以它們必須放在一起；分開就是同一條規則有兩份實作。
 *
 * ⚠ 錯誤側只涵蓋 (4b)。SDK 自產的四條路徑（未知工具名／輸入 schema 不符／輸出驗證失敗／未捕捉例外，D12 的
 * (4a)）**攔不到**——它們在 SDK 內部組裝，**沒有** `code`、**沒有** `structuredContent`。
 * 任何「所有工具錯誤都帶 `code`」的宣稱都是假的。
 *
 * `runTool()` 是第四條路徑的堵口：每支工具 handler 都由它包起來，未預期的例外轉成
 * `internal` ＋ 固定字串，**不得**讓原始 `error.message` 冒到 SDK 的 catch 直送模型。
 */
import type { FastifyBaseLogger } from "fastify";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorCode } from "@knotebook/shared";
import type { McpTestHooks } from "./hooks.js";

type TextBlock = { type: "text"; text: string };

/** `code` 逐字沿用 `ERROR_CODES`（M4：錯誤碼單一真相，不自創語意重疊的新碼）。 */
export type ToolErrorPayload = { code: ErrorCode; message: string } & Record<string, unknown>;

export type ToolErrorResult = CallToolResult & {
  isError: true;
  content: TextBlock[];
  structuredContent: ToolErrorPayload;
};

/**
 * `content[0].text` 一律逐字是 `JSON.stringify(structuredContent)`（M10 的鏡像等式）——
 * 兩邊同時回、內容等價，模型不論讀哪一邊都得到同一份資訊。
 *
 * ⚠ **`extra` 在 PR1 是零消費端**（全樹七個呼叫點全是兩引數）。**唯一的消費端是 PR2 的
 * `edit_note`**：`fingerprint_mismatch` 依規格案 20 要回 `{ code, message, outline }`，
 * 而那個 `outline` 是**物件**（`{ sections, truncated }`，省略 `nextSectionOffset`——D-E），
 * 由同一支 `buildOutlinePage` 產出。`read_note_section` 的 `section_not_found` 也預計走這條
 * 帶回可用的段落清單。**PR2 若改成別的形（例如各自定一個回傳型別），這個參數要一起拿掉，
 * 不要留無主參數。**（同一次收尾已經拿掉真的無主的 `McpToolCtx.config`。）
 */
export function toolError(code: ErrorCode, message: string, extra?: Record<string, unknown>): ToolErrorResult {
  const structuredContent: ToolErrorPayload = { code, message, ...(extra ?? {}) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/**
 * 成功側的同一條鏡像等式（D11／M10）：`structuredContent` 與 `content[0].text` **同時**回，
 * 後者逐字是前者的 `JSON.stringify`。SDK **不會**替我們生 `content`（宣告 `outputSchema` 時
 * 它只驗 `structuredContent`），而舊世代 client 只看 `content`——兩邊都得自己給。
 */
export function toolResult<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/** 例外逃出 handler 時模型會看到的固定字串（**不含任何例外訊息**）。 */
const INTERNAL_MESSAGE = "The server hit an unexpected error handling this tool call.";

export interface RunToolCtx {
  log: FastifyBaseLogger;
  hooks?: McpTestHooks;
}

/**
 * 每支工具 handler 的統一外殼：`beforeTool` 注入縫 ＋ try/catch。
 *
 * ⚠ **只做 try/catch ＋ hook**：不做 scope 檢查、不扣桶。scope 與扣桶是
 * `requireWriteScope()`（PR2）的事，兩者不得混為一談。
 */
export async function runTool<T extends CallToolResult>(
  name: string,
  ctx: RunToolCtx,
  fn: () => Promise<T>
): Promise<T | ToolErrorResult> {
  try {
    ctx.hooks?.beforeTool?.(name);
    return await fn();
  } catch (err) {
    ctx.log.error({ err, tool: name }, "MCP 工具丟出未預期的例外");
    return toolError("internal", INTERNAL_MESSAGE);
  }
}
