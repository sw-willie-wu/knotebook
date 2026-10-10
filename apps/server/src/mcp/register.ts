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
 * （`{list_notes, search_notes}`）、`mcp-content.test.ts`（**四支 live doc／DB 唯讀工具全打**，不含 `read_note_image`——它由 P13 守，
 * `{list_notes, read_note_outline, read_note_section, search_notes}`）、PR2 起
 * `mcp-tools-list.test.ts`（P13：`{edit_note, create_note}`）；#200 起 P13 的集合是
 * `{create_note, create_transfer_token, edit_note}`；#180 起加 `copy_note`、`move_note_to_group`，#200 §9.3 M7 再加 `read_note_image`，集合是
 * `{copy_note, create_note, create_transfer_token, edit_note, move_note_to_group, read_note_image}`。**新增工具時要一併把它
 * 加進其中一個名字集合，否則等於沒有守衛。**
 *
 * ⚠ 新增工具一律 `z.object(<shape>).strict()` 註冊；`test/unit/mcp-register.test.ts`（U-F1，覆蓋 authKind × scope × 有無 collab 的六種組合）的名字常數也要補——它會紅。
 *
 * ⚠ 呼叫順序是契約（§8.1 D32）：建 `McpServer` → **本函式** → `registerCapabilities` →
 * `connect()`。`registerTool` 內部會無條件把 `listChanged` 設回 `true`。**守衛＝
 * `test/mcp-tools-list.test.ts` 的 `listChanged === false` 那一案**（順序調換 → 只有它紅，
 * 突變實跑；在本函式註冊第一支工具之前，那條契約是零鑑別力的）。
 *
 * 部署形態的閘門（D-A）：`read_note_outline`／`read_note_section` 只在 `ctx.collab &&
 * ctx.editing` 都在時註冊——沒有 live doc 的來源就沒有「讀最新內容」這回事，寧可整條不宣告
 * 也不要掛一支只會回半套答案的工具（照抄 `routes/notes.ts` 對內容端點的既有判準）。判準存在
 * `canRead` 變數，#93 起 search_notes 的變體（description 與 `sectionId` 的說明）也看它。
 * `list_notes`／`search_notes` 只查 DB，永遠註冊；`read_note_image`（#200）只讀 DB 與磁碟，同樣在閘門外、任何憑證都註冊。
 * **這道閘門由兩案守**（都是無 collab 的 app，斷名字集合）：`test/mcp-tools-list.test.ts` 的 D-A 案（讀寫憑證，六支）、
 * `test/mcp-create-note.test.ts` 的 D-M 案（讀寫搬移憑證，七支，多 `move_note_to_group`）。`create_note`／`copy_note`／
 * `move_note_to_group` 都在閘門外（D-M）。
 * ⚠ 但它們**只擋得住「悄悄搬邊」，擋不住「放錯邊」**：新增一支工具一定會讓那一案紅（名字
 * 集合對不上），可是把名字補進 `LIVE_DOC_TOOLS`／`DB_ONLY_TOOLS` 哪一邊是人判的——
 * 判錯了測試照樣綠。**放進閘門的判準是「這支工具要不要讀 live doc」，不是「它比較像哪一支」。**
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
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
import { searchNotes, searchNotesDescription, searchNotesInput, searchNotesOutputFor } from "./tools/search-notes.js";
import { EDIT_NOTE_DESCRIPTION, editNote, editNoteInput, editNoteOutput } from "./tools/edit-note.js";
import { CREATE_NOTE_DESCRIPTION, createNote, createNoteInput, createNoteOutput } from "./tools/create-note.js";
import {
  COPY_NOTE_DESCRIPTION,
  COPY_NOTE_DESCRIPTION_NO_MOVE,
  copyNoteInput,
  copyNoteInputNoMove,
  copyNoteOutput,
  copyNoteTool,
} from "./tools/copy-note.js";
import {
  MOVE_NOTE_TO_GROUP_DESCRIPTION,
  moveNoteToGroupInput,
  moveNoteToGroupOutput,
  moveNoteToGroupTool,
} from "./tools/move-note-to-group.js";
import {
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RO,
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RW,
  createTransferToken,
  createTransferTokenInputRo,
  createTransferTokenInputRw,
  createTransferTokenOutput,
} from "./tools/create-transfer-token.js";
import {
  READ_NOTE_IMAGE_DESCRIPTION_SESSION,
  READ_NOTE_IMAGE_DESCRIPTION_TOKEN,
  readNoteImage,
  readNoteImageInput,
  readNoteImageOutput,
} from "./tools/read-note-image.js";
import { canMoveNotes, canWriteNotes } from "./write-scope.js";

export function registerMcpTools(server: McpServer, ctx: McpToolCtx): void {
  // 唯讀工具的最低 scope 都是 `notes:read`，而 L1（`authenticateAny`）已經保證
  // 到得了這裡的憑證至少有它——所以它們沒有 scope 過濾面。寫入工具才有。
  // ⚠ **這道過濾不是安全邊界**（見檔頭）：真正的關是每支寫入工具第一行的 `requireWriteScope()`。
  //   ⚠ 但反過來說也成立，而且是 PR2 的實測結論：`McpServer` 的「清單」**就是**「註冊表」，
  //   所以沒註冊的名字連 handler 都到不了（`tools/call` 走 SDK 的未知工具名分支）——
  //   **`insufficient_scope` 在 HTTP 上因此是死碼**，別在整合測試裡去釘它。
  const canWrite = canWriteNotes(ctx);
  // #239：移入／複製進群組要 `notes:move`（session 恆真；token 要 write 且 move）。只管 move_note_to_group 的註冊與
  // copy_note 的說明二選一；create_note／edit_note 不看它（W9）。
  const canMove = canMoveNotes(ctx);
  // #93：讀 live doc 的工具在不在，決定 search_notes 的 description 與 sectionId 說明的變體（spec §8.2 I5）。
  // 與下面讀取工具的閘門是**同一個判準、同一個時間點**（註冊時）。
  const canRead = Boolean(ctx.collab && ctx.editing);

  server.registerTool(
    "list_notes",
    { description: LIST_NOTES_DESCRIPTION, inputSchema: z.object(listNotesInput).strict(), outputSchema: listNotesOutput },
    async args => runTool("list_notes", ctx, () => listNotes(args, ctx))
  );

  server.registerTool(
    "search_notes",
    { description: searchNotesDescription(canRead), inputSchema: z.object(searchNotesInput).strict(), outputSchema: searchNotesOutputFor(canRead) },
    async args => runTool("search_notes", ctx, () => searchNotes(args, ctx))
  );

  // D-A：讀 live doc 的兩支只在生產形態（collab ＋ editing 都在）宣告。`tools/list` 的長度
  // 因此是**憑證 scope 與部署形態兩者的函式**。判準存在 `canRead` 變數，#93 起 search_notes 的變體也看它。
  // ⚠ **寫成區塊而不是 early return**：early return 會讓這道閘門的作用域變成「函式尾端全部」，
  //   之後在下面新增一支**不需要 collab** 的工具會被靜默閘掉，而且沒有任何編譯錯誤。
  if (canRead) {
    server.registerTool(
      "read_note_outline",
      {
        description: READ_NOTE_OUTLINE_DESCRIPTION,
        inputSchema: z.object(readNoteOutlineInput).strict(),
        outputSchema: readNoteOutlineOutput,
      },
      async args => runTool("read_note_outline", ctx, () => readNoteOutline(args, ctx))
    );

    server.registerTool(
      "read_note_section",
      {
        description: READ_NOTE_SECTION_DESCRIPTION,
        inputSchema: z.object(readNoteSectionInput).strict(),
        outputSchema: readNoteSectionOutput,
      },
      async args => runTool("read_note_section", ctx, () => readNoteSection(args, ctx))
    );

    // D-M：`edit_note` **進**這道閘門——判準是「這支工具要不要讀／寫 live doc」，而
    // `applyEdit` 會開直連寫 live doc（與 REST 的 `POST /:id/edits` 註冊閘門一致）。
    if (canWrite) {
      server.registerTool(
        "edit_note",
        { description: EDIT_NOTE_DESCRIPTION, inputSchema: z.object(editNoteInput).strict(), outputSchema: editNoteOutput },
        async args => runTool("edit_note", ctx, () => editNote(args, ctx))
      );
    }
  }

  // ⚠ **`create_note` 在閘門外面**（D-M）——這就是上面那段「寫成區塊而不是 early return」
  // 預告的那一支：不帶 `content` 時它只 insert 一列，完全不碰 live doc，而 REST 的
  // `POST /api/notes` 本來就無條件註冊、帶 content 而沒有 collab 時回 `400 invalid_body`
  // （工具側的對等答案是 `invalid_body`，由 `createNote` 自己判 `ctx.writes.available`）。
  // 把它移進閘門就是發明第二套行為——守衛＝`mcp-create-note.test.ts` 的 D-M 那一案
  // （無 collab 的 app ＋**讀寫**憑證，斷言名字的集合）。
  //
  // #241（原 #180 W15／spec §4.7 只套三支）：**所有工具**都以 `.strict()` 物件註冊——raw shape 會**靜默丟掉**未知鍵
  // （spec F60 實測）：用舊鍵 `groupId` 呼叫 `create_note` 會被當成「沒給群組」建成個人筆記；`edit_note` 的 `append`
  // 帶拼錯的 `ifMatch` 會跳過指紋比對照寫。strict 後回 SDK 輸入驗證錯誤、什麼都沒做；`tools/list` 的 JSON 與 raw shape
  // 逐字相同（F60），`inputSchema.properties` 不會空掉（裸 `ZodObject`，[[g:mcp-typescript-sdk-gotchas]] 第 1 節）。
  // 守衛＝`test/unit/mcp-register.test.ts`（U-F1，實際註冊物的結構）與 `mcp-tools-list.test.ts` 的 X-241（wire）；
  // 另有 `mcp-groups.test.ts` M-G1、`mcp-edit-note.test.ts` E-241。
  if (canWrite) {
    server.registerTool(
      "create_note",
      { description: CREATE_NOTE_DESCRIPTION, inputSchema: z.object(createNoteInput).strict(), outputSchema: createNoteOutput },
      async args => runTool("create_note", ctx, () => createNote(args, ctx))
    );
  }

  // #180 spec §5.1：move_note_to_group 在 collab 閘門外（只碰 DB；踢線經 collabHooks）。
  // #239：沒 notes:move 不註冊（同 canWrite 慣例：不宣告服務不了的工具）——session 與讀寫搬移 token 才有；讀寫 token 呼叫它
  // 拿到 SDK 的 Tool not found。守衛＝`mcp-tools-list` 的「#239：讀寫無搬移憑證 → 九支」案。
  // `.strict()` 註冊（spec §4.7）；annotations 兩值都等於 SDK 預設，寫出來讓 client 不必依賴預設——**不宣稱任何 client 因此改變行為**。
  // 守衛：annotations＝`mcp-tools-list` V11；strict＝`mcp-move` M-G2；runTool＝P13。
  if (canMove) {
    server.registerTool(
      "move_note_to_group",
      {
        description: MOVE_NOTE_TO_GROUP_DESCRIPTION,
        inputSchema: z.object(moveNoteToGroupInput).strict(),
        outputSchema: moveNoteToGroupOutput,
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      async args => runTool("move_note_to_group", ctx, () => moveNoteToGroupTool(args, ctx))
    );
  }

  // #180 spec §6.1：copy_note 在 collab 閘門**外**（REST 複製無條件註冊；`loadNoteDoc` 無 collab 時讀 note_states，F35）。
  // `.strict()` 註冊（spec §4.7、F60：照 create_note 舊習慣傳 `groupId` 會被靜默丟掉→複製成個人筆記；strict 後回驗證錯誤）。
  // annotations：`destructiveHint: false`（W12）；`idempotentHint` 不寫（SDK 預設 false，而每一發都建新筆記，F48）。
  // 守衛：無 collab 集合＝`mcp-tools-list` D-A 案／`mcp-create-note:238`；strict＝`mcp-copy` M-G2；runTool＝P13。
  // #239：仍在 canWrite 內（不帶 group_id 的複製只要 notes:write）；description 與 `group_id` 的說明依 canMove 二選一
  // （spec §7.5(b)(c)），帶 group_id 時執行期另驗 notes:move（`copy-note.ts`）。守衛＝`mcp-tools-list` 的 #239 M1b。
  if (canWrite) {
    server.registerTool(
      "copy_note",
      {
        description: canMove ? COPY_NOTE_DESCRIPTION : COPY_NOTE_DESCRIPTION_NO_MOVE,
        inputSchema: z.object(canMove ? copyNoteInput : copyNoteInputNoMove).strict(),
        outputSchema: copyNoteOutput,
        annotations: { destructiveHint: false },
      },
      async args => runTool("copy_note", ctx, () => copyNoteTool(args, ctx))
    );
  }

  // #200 spec §6.1：`create_transfer_token` **只在 token 路徑**註冊（session 沒有母憑證可綁），且在部署形態閘門外
  // （它只查 DB）。purpose 的 enum 與描述依憑證二選一——唯讀憑證看不到 upload（不描述它沒有的東西，同 instructions）。
  // 守衛＝`mcp-transfer.test.ts` M1 的三案（讀寫／唯讀／session）與 `mcp-tools-list.test.ts` 的名字集合。
  if (ctx.authKind === "token") {
    if (canWrite) {
      server.registerTool(
        "create_transfer_token",
        { description: CREATE_TRANSFER_TOKEN_DESCRIPTION_RW, inputSchema: z.object(createTransferTokenInputRw).strict(), outputSchema: createTransferTokenOutput },
        async args => runTool("create_transfer_token", ctx, () => createTransferToken(args, ctx))
      );
    } else {
      server.registerTool(
        "create_transfer_token",
        { description: CREATE_TRANSFER_TOKEN_DESCRIPTION_RO, inputSchema: z.object(createTransferTokenInputRo).strict(), outputSchema: createTransferTokenOutput },
        async args => runTool("create_transfer_token", ctx, () => createTransferToken(args, ctx))
      );
    }
  }

  // #200 §7.1：read_note_image 在**所有閘門外**——讀寫／唯讀 token 與 session 都註冊（只讀 DB 與磁碟，不讀 live doc）。
  // 描述依 authKind 二選一（session 版不提 create_transfer_token，它在 session 不存在）。#180 §9-3：註冊順序排最後。
  // 守衛：集合＝`mcp-tools-list`（案 8／9／9b／D-A）、`mcp-image` M1；runTool＝P13。
  server.registerTool(
    "read_note_image",
    {
      description: ctx.authKind === "token" ? READ_NOTE_IMAGE_DESCRIPTION_TOKEN : READ_NOTE_IMAGE_DESCRIPTION_SESSION,
      inputSchema: z.object(readNoteImageInput).strict(),
      outputSchema: readNoteImageOutput,
    },
    async args => runTool("read_note_image", ctx, () => readNoteImage(args, ctx))
  );
}
