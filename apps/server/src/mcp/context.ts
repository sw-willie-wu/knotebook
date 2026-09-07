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
   * ⚠ **PR2 Task 1 這一欄是零讀取的**：唯一的消費端是 Task 2／3 的 `edit_note`／`create_note`
   * （外圍順序：候選集合 → agentLabel → 佇列 → applyEdit → presence 都在它裡面）。
   * **若那兩支最後改成別的形，這一欄要一起拿掉，不要留無主欄位**（同一次收尾已經把真的
   * 無主的 `config` 拿掉了）。
   */
  writes: NoteWriteService;
  /**
   * `contentRead` 給兩支讀取工具；`edit`／`tokenWrite` 是 PR2 的兩支寫入工具要用的
   * （`tokenWrite` 由 `requireWriteScope(ctx)` 扣，`edit` 在角色檢查之後扣）——**Task 1 兩者
   * 都是零讀取**，處置同 `writes`。
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
   * ⚠ **`authKind`／`tokenScope` 在 PR1 是零讀取的**（本棒四支工具都只要 `notes:read`，
   * 而 L1 的 `authenticateAny` 已經保證到得了這裡的憑證至少有它）。
   * **唯一的消費端是 PR2 的 `requireWriteScope(ctx)`**（規格 §10.2 D23／不變量 M13）：
   * 它拿 `tokenScope` 判有沒有 `notes:write`、拿 `authKind === "session"` 跳過 scope 檢查
   * 與 token 桶。留著是因為 PR2 一定會用；**PR2 若改成別的形，這兩欄要一起拿掉，
   * 不要留無主欄位。**（同一次收尾已經把真的無主的 `config` 拿掉了。）
   */
  authKind: "token" | "session";
  /** token 路徑才有的落庫 scope；`null` ＝ session（視同讀寫全權，§7.3）。消費端同上。 */
  tokenScope: TokenScope | null;
  hooks?: McpTestHooks;
}
