/**
 * #108：工具本體與 `registerTool` 接線的分界。
 *
 * ⚠ **`tools/list` 的過濾不是安全邊界**：client 可以直接 `tools/call` 一個從沒列過的名字，
 * 所以真正的關是**呼叫時再驗**（D6(b)；PR2 的 `requireWriteScope()`）。這裡的過濾只是
 * 「不宣告服務不了的東西」，讓模型少打一輪。
 *
 * ⚠ **每一支工具都要經過 `runTool()`**：它是 D31／M15 的 try/catch（未捕捉例外不得冒到
 * SDK，否則原始 `error.message` 會原樣進模型脈絡）＋ `beforeTool` 注入縫。漏包某一支
 * 不會有任何編譯錯誤——**守衛是「`beforeTool` 名字集合」那一族，而它是逐檔各守各的**：
 * `mcp-notes.test.ts` 那一案只斷言 `{list_notes, search_notes}` 且只打那兩支，對下面兩支
 * 漏包**恆綠**；守住下面兩支的是 `mcp-content.test.ts` 的四支涵蓋率案與案 16 的正向對照
 * （突變實測：把 `read_note_section` 拆出 `runTool` 只讓那兩案紅）。**新增工具時要一併
 * 把它加進那個名字集合，否則等於沒有守衛。**
 *
 * ⚠ 呼叫順序是契約（§8.1 D32）：建 `McpServer` → **本函式** → `registerCapabilities` →
 * `connect()`。`registerTool` 內部會無條件把 `listChanged` 設回 `true`。
 *
 * 部署形態的閘門（D-A）：`read_note_outline`／`read_note_section` 只在 `ctx.collab &&
 * ctx.editing` 都在時註冊——沒有 live doc 的來源就沒有「讀最新內容」這回事，寧可整條不宣告
 * 也不要掛一支只會回半套答案的工具（照抄 `routes/notes.ts` 對內容端點的既有判準）。
 * `list_notes`／`search_notes` 只查 DB，永遠註冊。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { runTool } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";
import { LIST_NOTES_DESCRIPTION, listNotes, listNotesInput, listNotesOutput } from "./tools/list-notes.js";
import {
  READ_NOTE_OUTLINE_DESCRIPTION,
  readNoteOutline,
  readNoteOutlineInput,
  readNoteOutlineOutput,
} from "./tools/read-note-outline.js";
import {
  READ_NOTE_SECTION_DESCRIPTION,
  readNoteSection,
  readNoteSectionInput,
  readNoteSectionOutput,
} from "./tools/read-note-section.js";
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

  // D-A：讀 live doc 的兩支只在生產形態（collab ＋ editing 都在）宣告。`tools/list` 的長度
  // 因此是**憑證 scope 與部署形態兩者的函式**。
  // ⚠ **寫成區塊而不是 early return**：early return 會讓這道閘門的作用域變成「函式尾端全部」，
  //   之後在下面新增一支**不需要 collab** 的工具會被靜默閘掉，而且沒有任何編譯錯誤。
  if (ctx.collab && ctx.editing) {
    server.registerTool(
      "read_note_outline",
      {
        description: READ_NOTE_OUTLINE_DESCRIPTION,
        inputSchema: readNoteOutlineInput,
        outputSchema: readNoteOutlineOutput,
      },
      async args => runTool("read_note_outline", ctx, () => readNoteOutline(args, ctx))
    );

    server.registerTool(
      "read_note_section",
      {
        description: READ_NOTE_SECTION_DESCRIPTION,
        inputSchema: readNoteSectionInput,
        outputSchema: readNoteSectionOutput,
      },
      async args => runTool("read_note_section", ctx, () => readNoteSection(args, ctx))
    );
  }
}
