/**
 * #108：工具本體與 `registerTool` 接線的分界。
 *
 * ⚠ **`tools/list` 的過濾不是安全邊界**：client 可以直接 `tools/call` 一個從沒列過的名字，
 * 所以真正的關是**呼叫時再驗**（D6(b)；PR2 的 `requireWriteScope()`）。這裡的過濾只是
 * 「不宣告服務不了的東西」，讓模型少打一輪。
 *
 * ⚠ **每一支工具都要經過 `runTool()`**：它是 D31／M15 的 try/catch（未捕捉例外不得冒到
 * SDK，否則原始 `error.message` 會原樣進模型脈絡）＋ `beforeTool` 注入縫。漏包某一支
 * 不會有任何編譯錯誤——守衛是 `mcp-notes.test.ts` 的「`beforeTool` 名字集合」那一案。
 *
 * ⚠ 呼叫順序是契約（§8.1 D32）：建 `McpServer` → **本函式** → `registerCapabilities` →
 * `connect()`。`registerTool` 內部會無條件把 `listChanged` 設回 `true`。
 *
 * 部署形態的閘門（D-A）：`read_note_outline`／`read_note_section`（Task 4）只在
 * `ctx.collab && ctx.editing` 都在時註冊；本檔這兩支只查 DB，永遠註冊。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";
import { LIST_NOTES_DESCRIPTION, listNotes, listNotesInput, listNotesOutput } from "./tools/list-notes.js";
import { SEARCH_NOTES_DESCRIPTION, searchNotes, searchNotesInput, searchNotesOutput } from "./tools/search-notes.js";

export function registerMcpTools(server: McpServer, ctx: McpToolCtx): void {
  // 兩支唯讀工具的最低 scope 都是 `notes:read`，而 L1（`authenticateAny`）已經保證
  // 到得了這裡的憑證至少有它——所以本棒沒有 scope 過濾面。PR2 的兩支寫入工具才有。
  server.registerTool(
    "list_notes",
    { description: LIST_NOTES_DESCRIPTION, inputSchema: listNotesInput, outputSchema: listNotesOutput },
    async args => runTool("list_notes", ctx, () => listNotes(args, ctx))
  );

  server.registerTool(
    "search_notes",
    { description: SEARCH_NOTES_DESCRIPTION, inputSchema: searchNotesInput, outputSchema: searchNotesOutput },
    async args => runTool("search_notes", ctx, () => searchNotes(args, ctx))
  );
}
