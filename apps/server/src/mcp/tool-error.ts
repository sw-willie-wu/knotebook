/**
 * #108 §8.1 D31／M15：**我們自己產生的**工具錯誤（D12 的 (4b)）唯一的建構點。
 *
 * ⚠ SDK 自產的四條路徑（未知工具名／輸入 schema 不符／輸出驗證失敗／未捕捉例外，D12 的
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
 */
export function toolError(code: ErrorCode, message: string, extra?: Record<string, unknown>): ToolErrorResult {
  const structuredContent: ToolErrorPayload = { code, message, ...(extra ?? {}) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
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
