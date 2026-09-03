import type { FastifyInstance } from "fastify";
import { sendError } from "../http/errors.js";

/**
 * `/api/mcp` 的 **#108 前暫時形**，是 #130 交付物可用性的必要條件。
 *
 * MCP client 的流程起點是「打 `/api/mcp` 收到 401 ＋ `WWW-Authenticate`」。沒有這條
 * 路由，`/api` 前綴會落到 `http/spa.ts` 的 JSON 404（**不帶 challenge**），client 就
 * 無從發現授權伺服器，整條 OAuth 流程根本起不了頭。
 *
 * challenge 宣告 `notes:read notes:write`（不是 `required` 的 `notes:read`）——MCP
 * client 只會要 challenge 上寫的 scope，給單值會讓它走完 OAuth 只拿到唯讀 token。
 * 授權判定維持最低的 `notes:read`：本 PR 還沒有真的寫入操作。
 *
 * 通過認證後**用 `sendError` 直送 501，不得 `throw`**：`app.ts` 的全域
 * `setErrorHandler` 對 `statusCode >= 500` 一律 `log.error` 並改寫成 500 `internal`，
 * 丟出去就拿不到 `not_implemented`。
 *
 * 三個 method 都掛：MCP 的 Streamable HTTP transport 用 POST 送訊息、GET 開 SSE、
 * DELETE 收工，任何一個沒掛就會回不帶 challenge 的 404。#108 以真實 handler 取代
 * 整個模組。
 */
export function mcpRoutes() {
  return async function register(app: FastifyInstance): Promise<void> {
    const preHandler = app.authenticateAny("notes:read", "notes:read notes:write");

    app.get("/api/mcp", { preHandler }, async (_request, reply) =>
      sendError(reply, 501, "not_implemented", "MCP 端點尚未提供")
    );
    app.post("/api/mcp", { preHandler }, async (_request, reply) =>
      sendError(reply, 501, "not_implemented", "MCP 端點尚未提供")
    );
    app.delete("/api/mcp", { preHandler }, async (_request, reply) =>
      sendError(reply, 501, "not_implemented", "MCP 端點尚未提供")
    );
  };
}
