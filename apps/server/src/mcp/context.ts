/**
 * #108：一發 `POST /api/mcp` 綁進工具閉包的執行脈絡。
 *
 * 每支工具是一支**可以單獨呼叫**的 `async (args, ctx) => result` 函式（案 21b(ii) 那種
 * 「繞過 HTTP 直接餵 handler」的探針要的就是這個），所以身分與資源一律走這個物件，
 * 不從 `FastifyRequest` 裡撈。
 *
 * `collab`／`editing`／`presence` 選配的理由同 `McpRouteDeps`（D-A）：無 collab 的 app 上
 * 讀 live doc 的兩支工具整條不註冊，只查 DB 的兩支照常在。
 */
import type { FastifyBaseLogger } from "fastify";
import type { TokenScope } from "@knotebook/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CollabServer } from "../collab/server.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import type { PresenceRegistry } from "../notes/editing/presence.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { McpTestHooks } from "./hooks.js";

export interface McpToolCtx {
  db: Db;
  config: AppConfig;
  collab?: CollabServer;
  editing?: EditingRuntime;
  presence?: PresenceRegistry;
  limiters: { contentRead: FixedWindowLimiter };
  log: FastifyBaseLogger;
  /** 呼叫者本人（`request.user!.id`）——L3 的可見性一律以它為準。 */
  userId: string;
  /** 呼叫者的 handle；presence 顯示名要用（Task 4）。 */
  userHandle: string;
  /** token 路徑才有；`null` ＝ cookie session。agent 顯示名由它查出（Task 4）。 */
  tokenId: string | null;
  authKind: "token" | "session";
  /** token 路徑才有的落庫 scope；`null` ＝ session（視同讀寫全權，§7.3）。 */
  tokenScope: TokenScope | null;
  hooks?: McpTestHooks;
}
