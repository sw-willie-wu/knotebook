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
import type { Db } from "../db/index.js";
import type { CollabServer } from "../collab/server.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import type { PresenceRegistry } from "../notes/editing/presence.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { McpTestHooks } from "./hooks.js";

export interface McpToolCtx {
  db: Db;
  collab?: CollabServer;
  editing?: EditingRuntime;
  presence?: PresenceRegistry;
  /**
   * #108 §10.1（D22／M5）：`buildApp` 建的**唯一**寫入 service——MCP 的寫入工具與 REST 的三條
   * 寫入路徑共用同一個 `NoteWriteQueue`，同一篇筆記因此串行。
   * 消費端＝`tools/edit-note.ts`（PR2 Task 2 起）與下一棒的 `create_note`
   * （外圍順序：候選集合 → agentLabel → 佇列 → applyEdit → presence 都在它裡面）。
   */
  writes: NoteWriteService;
  /**
   * `contentRead` 給兩支讀取工具；`edit`／`tokenWrite` 給寫入工具——`tokenWrite` 由
   * `requireWriteScope(ctx)` 扣（在 `resolveRole` **之前**，對齊 REST 的 preHandler），
   * `edit` 由工具自己在角色檢查**之後**扣（`role === "none"` 的 404 不啃它）。
   */
  limiters: { contentRead: FixedWindowLimiter; edit: FixedWindowLimiter; tokenWrite: FixedWindowLimiter };
  log: FastifyBaseLogger;
  /** 呼叫者本人（`request.user!.id`）——L3 的可見性一律以它為準。 */
  userId: string;
  /** 呼叫者的 handle；presence 顯示名要用（Task 4）。 */
  userHandle: string;
  /** token 路徑才有；`null` ＝ cookie session。agent 顯示名由它查出（Task 4）。 */
  tokenId: string | null;
  /**
   * 四支唯讀工具不讀這兩欄（它們都只要 `notes:read`，而 L1 的 `authenticateAny` 已經保證
   * 到得了這裡的憑證至少有它）。**消費端是 `mcp/write-scope.ts`**（規格 §10.2 D23／M13）：
   * `canWriteNotes(...)` 拿它們判有沒有 `notes:write`（`register.ts` 的註冊時過濾、
   * `routes/mcp.ts` 挑 per-request `instructions`、`requireWriteScope` 三處共用同一份判準），
   * `authKind === "session"` 則整條跳過 scope 檢查與 token 桶。
   */
  authKind: "token" | "session";
  /** token 路徑才有的落庫 scope；`null` ＝ session（視同讀寫全權，§7.3）。消費端同上。 */
  tokenScope: TokenScope | null;
  hooks?: McpTestHooks;
}
