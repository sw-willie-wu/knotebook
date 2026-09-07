import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { publicUrlIssuer, type AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import type { CollabServer } from "../collab/server.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import type { PresenceRegistry } from "../notes/editing/presence.js";
import type { NoteWriteService } from "../notes/editing/write-service.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError } from "../http/errors.js";
import { mcpOriginAllowed } from "../http/origin.js";
import type { McpTestHooks } from "../mcp/hooks.js";
import { registerMcpTools } from "../mcp/register.js";
import { mcpInstructions, MCP_SERVER_NAME, MCP_SERVER_VERSION, versionReadFailed } from "../mcp/server-info.js";
import { canWriteNotes } from "../mcp/write-scope.js";
import { sendWebResponse, toWebRequest } from "../mcp/transport.js";

/**
 * `/api/mcp`：Streamable HTTP 的 MCP 端點（#108）。
 *
 * **六步順序是契約，不是巧合**：全域 JSON 守衛（`app.ts` 的 `onRequest`）→ 認證
 * （`authenticateAny`，401／403／429 都在這裡）→ Origin 守衛（§7.4 D10）→ 建 `McpServer`
 * ／註冊工具／`registerCapabilities`／`connect` → `handleRequest` → 把 `Response` 具現
 * → 搬回 `reply`；`finally` 關掉 server。整條路徑仍在全域 `onSend` 鏈上，nosniff 不掉（M7）。
 *
 * **stateless、一請求一實例是 SDK 的硬性要求**：`sessionIdGenerator` 不傳，transport 跨請求
 * 重用會直接 throw `Stateless transport cannot be reused across requests.`。
 * `registerCapabilities` 必須排在**註冊完工具之後、`connect()` 之前**——建構選項裡宣告無效，
 * `connect()` 之後呼叫丟例外。
 *
 * **GET／DELETE**：認證通過後一律 `405` ＋ `Allow: POST`（RFC 9110 §15.5.6 的 MUST）。
 * 認證擺在前面是刻意的——未認證的請求要先拿到帶 challenge 的 401，那是 #130 的發現路徑。
 *
 * **⚠ 兩件與規格字面不同、但實測如此的事**：
 * 1. **壞 JSON body 是本站的 `400 bad_request`，不是 JSON-RPC `-32700`**。擋下它的是 Fastify
 *    的 content-type parser，在我們的 handler 之前、也在 SDK 之前。實測（2026-09-07）：
 *    不帶 content-type 且不帶 body → 進到 handler、`parsedBody: undefined` → SDK 自己的
 *    `415 -32000 "Unsupported Media Type: Content-Type must be application/json"`；
 *    帶 `content-type: application/json` 但空 body → Fastify 的 parser 先炸 → 本站 `400
 *    bad_request`。**`-32700` 在這條接線上沒有可達路徑**——規格 §8.1 D12 (2) 那一格描述的
 *    是 SDK 單飛時的行為。
 * 2. **一支工具都沒註冊時，`tools/list`／`tools/call` 回的是 `200` ＋ `-32601 Method not
 *    found`，不是空清單**——那兩個 handler 由第一次 `registerTool()` 才裝上，
 *    `registerCapabilities` 只宣告能力、不裝 handler（所以 `initialize` 照樣回
 *    `listChanged: false`）。看到 `-32601` 不要以為是 `registerCapabilities` 順序寫反了。
 *    ⚠ 這條今天到不了：`registerMcpTools` 至少註冊 `list_notes`／`search_notes` 兩支
 *    （它們只查 DB，不需要 collab）。留著是因為「未來某個 scope 過濾把工具全濾掉」會直接
 *    掉進這個形，而它的症狀（`-32601`）看起來完全不像「清單是空的」。
 *
 * **`tools/list` 的長度是憑證 scope 與部署形態兩者的函式**（D-A）：沒有 `collab`／`editing`
 * 的 app（`buildTestApp` 那種）只註冊查得動 DB 的工具，讀不到 live doc 的兩支整條不宣告。
 */

/** 405／未支援 method 的 body（與 SDK 自己的 `handleUnsupportedRequest` 同形）。 */
const METHOD_NOT_ALLOWED_BODY = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32000, message: "Method Not Allowed: this MCP endpoint only accepts POST." },
} as const;

export interface McpRouteDeps {
  db: Db;
  config: AppConfig;
  /** D-A：兩者皆選配——無 collab 的 app 上路由仍然註冊，只是讀 live doc 的工具不宣告。 */
  collab?: CollabServer;
  editing?: EditingRuntime;
  /**
   * 逐鍵挑（不整包轉傳）：MCP 只該看得到自己會用的三顆桶。`contentRead` 給兩支讀取工具，
   * `edit`／`tokenWrite` 給 PR2 的兩支寫入工具（前者在角色檢查之後扣，後者在 scope 檢查
   * 那一步扣，順序與 REST 對齊）。
   */
  limiters: { contentRead: FixedWindowLimiter; edit: FixedWindowLimiter; tokenWrite: FixedWindowLimiter };
  presence?: PresenceRegistry;
  /**
   * #108 §10.1（D22／M5）：`buildApp` 建的**同一個**寫入 service（`notesRoutes` 拿到的是
   * 同一個物件），MCP 寫入與 REST 寫入因此對同一篇筆記串行。
   * 消費端＝`mcp/tools/edit-note.ts`（Task 2 起）與下一棒的 `create_note`。
   */
  writes: NoteWriteService;
  testHooks?: McpTestHooks;
}

export function mcpRoutes(deps: McpRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    if (versionReadFailed) {
      app.log.warn("讀不到 apps/server/package.json 的 version，MCP serverInfo 退成 0.0.0");
    }

    const endpointUrl = `${publicUrlIssuer(deps.config.publicUrl)}/api/mcp`;
    const publicHost = deps.config.publicUrl.host;

    const authenticate = app.authenticateAny("notes:read", "notes:read notes:write");

    /**
     * 第二支 preHandler，**排在認證之後**（不帶憑證的請求一律先拿 401 ＋ challenge）。
     * 三條 route 共用——只掛在 POST 上會讓 `GET` ＋ 壞 Origin 變成 405 而不是 403。
     */
    const originGuard = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const origin = request.headers.origin;
      // 不帶 `Origin` 的請求不受此限（D10 刻意的放行面：非瀏覽器 client）。
      if (origin === undefined) return;
      if (!mcpOriginAllowed(origin, request.host, publicHost)) {
        // 早退形比照 `auth/bearer.ts` 的 preHandler：`sendError` 之後直接 return，
        // 不把 reply 當回傳值（那會讓 async hook 的語意多一層）。
        sendError(reply, 403, "forbidden", "Origin 驗證失敗");
        return;
      }
    };

    const preHandler = [authenticate, originGuard];

    const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
      reply.header("allow", "POST");
      return reply.code(405).send(METHOD_NOT_ALLOWED_BODY);
    };

    app.get("/api/mcp", { preHandler }, methodNotAllowed);
    app.delete("/api/mcp", { preHandler }, methodNotAllowed);

    // `bodyLimit` 與 `POST /api/notes/:id/edits` 共用同一個常數（`http/body-limits.ts`）——
    // 「兩者逐位元組相同」現在由構造成立，不再是一句要靠人維護的宣稱。
    app.post("/api/mcp", { preHandler, bodyLimit: WRITE_BODY_LIMIT }, async (request, reply) => {
      // #108 D-Q：`instructions` 是 **per-request 二選一**（不是相加）——唯讀憑證看到的那一版
      // 刻意不提寫入工具的名字，改講「怎麼取得寫入權」。判準與註冊時的 scope 過濾**同一份**
      // （`canWriteNotes`），否則會出現「清單裡有工具但 instructions 說你是唯讀的」這種漂移。
      const canWrite = canWriteNotes({ authKind: request.authKind ?? "session", tokenScope: request.tokenScope ?? null });
      const server = new McpServer(
        { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        { instructions: mcpInstructions(canWrite) }
      );
      // 身分綁進工具閉包：每支工具是可以單獨呼叫的 `(args, ctx) => result`，不從
      // `request` 撈東西。註冊必須排在 `registerCapabilities` **之前**（D32 的順序）。
      registerMcpTools(server, {
        db: deps.db,
        collab: deps.collab,
        editing: deps.editing,
        presence: deps.presence,
        writes: deps.writes,
        limiters: deps.limiters,
        log: request.log,
        userId: request.user!.id,
        userHandle: request.user!.handle,
        tokenId: request.tokenId ?? null,
        authKind: request.authKind ?? "session",
        tokenScope: request.tokenScope ?? null,
        hooks: deps.testHooks,
      });
      server.server.registerCapabilities({ tools: { listChanged: false } });
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await server.connect(transport);
      try {
        const res = await transport.handleRequest(toWebRequest(request, endpointUrl), {
          parsedBody: request.body,
        });
        // ⚠ 先具現（M1(b)）：status／headers／body 全部變成值之後才可以關閉 server。
        const status = res.status;
        const headers = [...res.headers] as [string, string][];
        const text = await res.text();
        deps.testHooks?.beforeReply?.();
        return sendWebResponse(reply, { status, headers, text });
      } finally {
        await server.close();
        deps.testHooks?.afterClose?.();
      }
    });
  };
}
