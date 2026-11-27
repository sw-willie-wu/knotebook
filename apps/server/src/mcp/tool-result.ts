/**
 * Only our own results. The SDK builds its own errors (unknown tool, schema mismatch, ...)
 * without `code` or `structuredContent`, so "every error carries `code`" is false. The SDK
 * also validates the whole result outside `runTool()`'s try/catch, so a failure there is a
 * JSON-RPC protocol error, not a `toolError` (see `toolResultWithImage`). Both builders share the
 * mirror rule (`content[0].text` is exactly `JSON.stringify(structuredContent)`), so they live together.
 */
import type { FastifyBaseLogger } from "fastify";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ErrorCode } from "@knotebook/shared";
import type { McpTestHooks } from "./hooks.js";

type TextBlock = { type: "text"; text: string };

export type ToolErrorPayload = { code: ErrorCode; message: string } & Record<string, unknown>;

export type ToolErrorResult = CallToolResult & {
  isError: true;
  content: TextBlock[];
  structuredContent: ToolErrorPayload;
};

/** `extra` is used only by `edit_note`'s `fingerprint_mismatch` outline; remove it if that changes. */
export function toolError(code: ErrorCode, message: string, extra?: Record<string, unknown>): ToolErrorResult {
  const structuredContent: ToolErrorPayload = { code, message, ...(extra ?? {}) };
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
  };
}

/** Both sides are returned: with an `outputSchema` the SDK doesn't build `content`, and older clients read only `content`. */
export function toolResult<T extends Record<string, unknown>>(payload: T): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

/**
 * The image block is a second element outside `structuredContent` (base64 appears once on
 * the wire). The SDK's whole-result validation runs outside `runTool()`'s try/catch, so a
 * failure would be a protocol error; unreachable today (valid base64, string mimeType). Cost: one
 * `atob` plus one object copy over a string up to about 7 MB per success; acceptable.
 */
export function toolResultWithImage<T extends Record<string, unknown>>(
  payload: T,
  image: { data: string; mimeType: string }
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }, { type: "image", data: image.data, mimeType: image.mimeType }],
    structuredContent: payload,
  };
}

/**
 * Like `toolResultWithImage`, keeping `content[0]` as the exact JSON mirror of `structuredContent`
 * and placing a large text payload (e.g. SVG XML source) in `content[1]` outside `structuredContent`
 * so it appears once on the wire.
 */
export function toolResultWithText<T extends Record<string, unknown>>(
  payload: T,
  text: string
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }, { type: "text", text }],
    structuredContent: payload,
  };
}

/** Never includes the exception's message. */
const INTERNAL_MESSAGE = "The server hit an unexpected error handling this tool call.";

export interface RunToolCtx {
  log: FastifyBaseLogger;
  hooks?: McpTestHooks;
}

/**
 * Unexpected exceptions become a fixed "internal" message: the SDK's own catch would put the raw
 * `error.message` into the model's context. Only try/catch and the hook; scope checks and limiter
 * charges belong to `require*Scope()`.
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
