/**
 * #108：工具本體與 `registerTool` 接線的分界。
 *
 * ⚠ **`tools/list` 的過濾不是安全邊界**：client 可以直接 `tools/call` 一個從沒列過的名字，
 * 所以真正的關是**呼叫時再驗**（D6(b)；PR2 的 `requireWriteScope()`）。這裡的過濾只是
 * 「不宣告服務不了的東西」，讓模型少打一輪。
 *
 * ⚠ **每一支工具都要經過 `runTool()`**：它是 D31／M15 的 try/catch（未捕捉例外不得冒到
 * SDK，否則原始 `error.message` 會原樣進模型脈絡）＋ `beforeTool` 注入縫。漏包某一支
 * 不會有任何編譯錯誤——**守衛是「`beforeTool` 名字集合」那一族，而它現在分散在三個檔，
 * 逐檔各守各的**（集合逐字對照該案本身，不是憑印象簡化）：`mcp-notes.test.ts`
 * （`{list_notes, search_notes}`）、`mcp-content.test.ts`（**四支唯讀工具全打**，
 * `{list_notes, read_note_outline, read_note_section, search_notes}`）、PR2 起
 * `mcp-tools-list.test.ts`（P13：`{edit_note, create_note}`）。**新增工具時要一併把它
 * 加進其中一個名字集合，否則等於沒有守衛。**
 *
 * ⚠ 呼叫順序是契約（§8.1 D32）：建 `McpServer` → **本函式** → `registerCapabilities` →
 * `connect()`。`registerTool` 內部會無條件把 `listChanged` 設回 `true`。**守衛＝
 * `test/mcp-tools-list.test.ts` 的 `listChanged === false` 那一案**（順序調換 → 只有它紅，
 * 突變實跑；在本函式註冊第一支工具之前，那條契約是零鑑別力的）。
 *
 * 部署形態的閘門（D-A）：`read_note_outline`／`read_note_section` 只在 `ctx.collab &&
 * ctx.editing` 都在時註冊——沒有 live doc 的來源就沒有「讀最新內容」這回事，寧可整條不宣告
 * 也不要掛一支只會回半套答案的工具（照抄 `routes/notes.ts` 對內容端點的既有判準）。
 * `list_notes`／`search_notes` 只查 DB，永遠註冊。
 * **這道閘門唯一的守衛是 `test/mcp-tools-list.test.ts` 的「無 collab 的 app ＋讀寫憑證：只宣告
 * 查得動 DB 的兩支與 create_note」**（Task 4 起改用讀寫憑證，見該案註解）——它斷言的是**三個
 * 名字的集合**（`create_note` 因 D-M 不進這道閘門），所以往任一側搬工具都會紅（兩條突變都實跑過）。
 * ⚠ 但它**只擋得住「悄悄搬邊」，擋不住「放錯邊」**：新增一支工具一定會讓那一案紅（名字
 * 集合對不上），可是把名字補進 `LIVE_DOC_TOOLS`／`DB_ONLY_TOOLS` 哪一邊是人判的——
 * 判錯了測試照樣綠。**放進閘門的判準是「這支工具要不要讀 live doc」，不是「它比較像哪一支」。**
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
import { EDIT_NOTE_DESCRIPTION, editNote, editNoteInput, editNoteOutput } from "./tools/edit-note.js";
import { CREATE_NOTE_DESCRIPTION, createNote, createNoteInput, createNoteOutput } from "./tools/create-note.js";
import { canWriteNotes } from "./write-scope.js";

export function registerMcpTools(server: McpServer, ctx: McpToolCtx): void {
  // 四支唯讀工具的最低 scope 都是 `notes:read`，而 L1（`authenticateAny`）已經保證
  // 到得了這裡的憑證至少有它——所以它們沒有 scope 過濾面。寫入工具才有。
  // ⚠ **這道過濾不是安全邊界**（見檔頭）：真正的關是每支寫入工具第一行的 `requireWriteScope()`。
  //   ⚠ 但反過來說也成立，而且是 PR2 的實測結論：`McpServer` 的「清單」**就是**「註冊表」，
  //   所以沒註冊的名字連 handler 都到不了（`tools/call` 走 SDK 的未知工具名分支）——
  //   **`insufficient_scope` 在 HTTP 上因此是死碼**，別在整合測試裡去釘它。
  const canWrite = canWriteNotes(ctx);

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

    // D-M：`edit_note` **進**這道閘門——判準是「這支工具要不要讀／寫 live doc」，而
    // `applyEdit` 會開直連寫 live doc（與 REST 的 `POST /:id/edits` 註冊閘門一致）。
    if (canWrite) {
      server.registerTool(
        "edit_note",
        { description: EDIT_NOTE_DESCRIPTION, inputSchema: editNoteInput, outputSchema: editNoteOutput },
        async args => runTool("edit_note", ctx, () => editNote(args, ctx))
      );
    }
  }

  // ⚠ **`create_note` 在閘門外面**（D-M）——這就是上面那段「寫成區塊而不是 early return」
  // 預告的那一支：不帶 `content` 時它只 insert 一列，完全不碰 live doc，而 REST 的
  // `POST /api/notes` 本來就無條件註冊、帶 content 而沒有 collab 時回 `400 invalid_body`
  // （工具側的對等答案是 `invalid_body`，由 `createNote` 自己判 `ctx.writes.available`）。
  // 把它移進閘門就是發明第二套行為——守衛＝`mcp-create-note.test.ts` 的 D-M 那一案
  // （無 collab 的 app ＋**讀寫**憑證，斷言三個名字的集合）。
  if (canWrite) {
    server.registerTool(
      "create_note",
      { description: CREATE_NOTE_DESCRIPTION, inputSchema: createNoteInput, outputSchema: createNoteOutput },
      async args => runTool("create_note", ctx, () => createNote(args, ctx))
    );
  }
}
