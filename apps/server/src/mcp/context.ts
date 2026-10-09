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
import type { GroupTestHook } from "../groups/test-hook.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { NoteCreateHooks } from "../notes/create.js";
import type { SearchIndexHooks } from "../notes/tx/search-index.js";

export interface McpToolCtx {
  db: Db;
  collab?: CollabServer;
  editing?: EditingRuntime;
  presence?: PresenceRegistry;
  /**
   * #108 §10.1（D22／M5）：`buildApp` 建的**唯一**寫入 service——MCP 的寫入工具與 REST 的三條
   * 寫入路徑共用同一個 `NoteWriteQueue`，同一篇筆記因此串行。
   * 消費端＝`tools/edit-note.ts`（PR2 Task 2 起）與 `tools/create-note.ts`（Task 3 起）。
   * 「候選集合 → agentLabel → 佇列 → applyEdit → presence」這串外圍順序只描述 `edit_note`
   * 走的 `applyToNote`；`create_note` 走的是 `createWithContent`，同樣有候選集合／
   * agentLabel／佇列／`applyEdit`，但**刻意不 touch presence**（剛建的筆記不可能有人正開著，
   * `write-service.ts` 的 `createWithContent` 逐字說明）。
   */
  writes: NoteWriteService;
  /**
   * `contentRead` 給兩支讀取工具；`edit`／`tokenWrite` 給寫入工具——`tokenWrite` 由
   * `requireWriteScope(ctx)` 扣（在 `resolveRole` **之前**，對齊 REST 的 preHandler），
   * `edit` 由工具自己在角色檢查**之後**扣（`role === "none"` 的 404 不啃它）；
   * `search` 給 `search_notes`（#93）；`upload` 給 `copy_note`（#180）。
   */
  limiters: {
    contentRead: FixedWindowLimiter;
    edit: FixedWindowLimiter;
    tokenWrite: FixedWindowLimiter;
    search: FixedWindowLimiter;
    /** #180：`copy_note` 依「會被複製的附件數」扣——與上傳端點、REST 複製**同一實例**（spec §3.5、F40）。 */
    upload: FixedWindowLimiter;
  };
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
  /**
   * #200：`publicUrlIssuer(config.publicUrl)`（scheme://host[:port]，無尾斜線）。唯一消費端＝`create_transfer_token`
   * 組 `url`／`curl`。只放這個窄欄位，不把 `config` 塞回 ctx（#108 收尾刻意拿掉過 `config`）。
   */
  publicOrigin: string;
  hooks?: McpTestHooks;
  /**
   * #175 PR5：群組測試注入縫（生產不注入＝零成本）。唯一消費端＝`tools/create-note.ts` 的 `"membership-checked"`
   * （群組成員與新建旗標檢查之後、建立筆記之前——與 `POST /api/notes {groupId}` 同一個點名）。
   */
  groupTestHook?: GroupTestHook;
  /** #180：`move_note_to_group` commit 後踢線（`onGroupAccessChanged`）。`app.ts` 傳 `deps.collabHooks`（與 `notesRoutes` 同一個）。 */
  collabHooks: CollabHooks;
  /**
   * #180：`copy_note` 複製附件檔的目錄；#200 §7 的 `read_note_image` 重用同一欄（spec §9-2：只加這一次）。
   */
  uploadsDir: string;
  /** #180：移動與複製的空間鎖等待上限（ms），與 `notesRoutes` 同一個值。 */
  storageLockTimeoutMs: number;
  /** #180 測試縫（生產不注入）：`edit_note` 的 rename 每輪候選、UPDATE 之前（語意同 `NotesRouteDeps.slugUpdateTestHook`）。 */
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  /** #180 測試縫：`copy_note` 交易內建列的 slug 迴圈（語意同 `NotesRouteDeps.noteCreateHooks`）。 */
  noteCreateHooks?: NoteCreateHooks;
  /** #180 測試縫：`copy_note` 交易內全文索引（語意同 `NotesRouteDeps.searchIndexHooks`）。 */
  searchIndexHooks?: SearchIndexHooks;
}
