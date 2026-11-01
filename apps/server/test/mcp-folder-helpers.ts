/**
 * 資料夾 PR-3d（plan docs/superpowers/plans/2026-10-28-folders-pr3d.md H7）：MCP 資料夾測試共用的呼叫工具。
 * `callTool` 打 `/api/mcp` 的 tools/call；`restFolder` 以同一人 cookie 打 REST（比對錯誤形用）；`expectSameNotFound` 逐欄比兩個錯誤結果。
 */
import { expect } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { inject } from "./trash-helpers.js";

export type McpAuth = { token: string } | { cookie: string };
export type ToolCallResult = {
  isError?: true;
  structuredContent?: Record<string, unknown> & { code?: string; message?: string };
  content: Array<{ type: string; text?: string }>;
};

/** tools/call 一發；HTTP 層必須 200（工具錯誤在 result 裡）。 */
export async function callTool(app: FastifyInstance, auth: McpAuth, name: string, args?: unknown): Promise<ToolCallResult> {
  const params = args === undefined ? { name } : { name, arguments: args };
  const res = await mcpPost(app, rpc("tools/call", params), auth);
  expect(res.statusCode, res.body).toBe(200);
  const result = res.json().result as ToolCallResult;
  return { isError: result.isError, structuredContent: result.structuredContent, content: result.content };
}

/** 同一人 cookie 打 REST（資料夾路由）。 */
export function restFolder(
  app: FastifyInstance,
  userId: string,
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return inject(app, method, url, userId, body);
}

/** 兩個工具錯誤結果逐欄相同（看不到＝不存在，AG-F3）：isError、structuredContent、鏡像 text 都相同，且碼是 not_found。 */
export function expectSameNotFound(a: ToolCallResult, b: ToolCallResult): void {
  expect(a.isError).toBe(true);
  expect(a.structuredContent?.code).toBe("not_found");
  expect(b).toEqual(a);
}
