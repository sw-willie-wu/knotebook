/**
 * #108 §8.7 `create_note`：建一篇新筆記。與 `POST /api/notes` 的 body 同形、同驗證規則、
 * 同管線（D18：**寫入側不發明第二套契約**）——`content` 逐字重用 `MD`、`title` 逐字重用 `TITLE`（M14）。
 *
 * ⚠ **這支工具不進部署形態閘門**（裁決 D-M）：判準是「要不要讀 live doc」。不帶 `content` 時
 * 它只建一列（`notes/create.ts`；帶 `title` 時多一次——最壞每輪 20 次、最多 5 輪——owner
 * 範圍的 slug 探測查詢，#145），完全不碰 live doc；而 REST 的 `POST /api/notes` 本來就無條件註冊、帶
 * content 而沒有 collab 時回 `400 invalid_body`。所以它在 `register.ts` 的閘門**外面**註冊，
 * 帶 `content` 而 `ctx.writes.available` 為假時回 `invalid_body`（與 REST 的 400 對等）。
 * ⚠ **先問 `available` 再走**：`NoteWriteService.applyDeps()` 有一個 throw，三個 REST 呼叫點
 * 都到不了，它留著就是為了接住「`create_note` 忘了先問」這一刻（`write-service.ts` 逐字）。
 *
 * ⚠ **不 touch presence**——`write-service.ts` 從 `routes/notes.ts` 搬過來的那段註解逐字：
 * 「另外三條寫入路徑都 touch，只有它不 touch 是刻意的——不要當成漏接補上去」。筆記是這一發
 * 剛建出來的，不可能有人正開著它。
 * ⚠ **佇列逾時的答案是 `internal` 不是 `server_busy`**（`docs/ai-editing.md` 逐字，與 REST 的
 * 500 對等）：`createWithContent` 的 catch 刻意不分辨例外型別，刪掉剛建的列後回 `kind:"internal"`。
 * ⚠ **`edit` 桶只在帶 `content` 時扣**（與 REST 同）；但 `tokenWrite` **一律**扣——
 * `requireWriteScope()` 是單一入口，不因為「這一發沒有內容」而繞過（規格 §8.8 的對照表）。
 *
 * `url` 走 `canonicalNotePath`，與 `list_notes`／`search_notes` 是**同一個組字點**（`dto.ts`）。
 */
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { notes } from "../../db/schema.js";
import { visibleNoteBranches } from "../../notes/list-query.js";
import { insertNoteWithAutoSlug } from "../../notes/create.js";
import { MD, TITLE } from "../../notes/schemas.js";
import { noteSummarySchema, toNoteSummary, type NoteSummaryRow } from "../dto.js";
import { toolError, toolResult } from "../tool-result.js";
import { WRITE_RATE_LIMITED_MESSAGE, writeFailureMessage } from "../write-messages.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
export const CREATE_NOTE_DESCRIPTION =
  "Create a new note owned by you. Pass `content` to fill it in at the same time, or leave it out " +
  "for an empty note you can write to later with edit_note. " +
  // ⚠ #146：**只有解析失敗那條路**「沒有留下筆記」。`internal`（套用失敗）那條路是先 insert
  //   再套用，清理是 best-effort——`write-service.ts` 的 catch 刪不掉時只 `log.warn`，照樣回
  //   `internal`，**現場會留下一篇空筆記**。所以限定成 "a call that fails to parse"
  //   （與 `docs/mcp.md` 同字）；`internal` 的殘留由該工具的錯誤說明負責。
  "Bad markdown is rejected before anything is stored, so a call that fails to parse leaves no " +
  "note behind. The reply carries the new note's `id` — pass it to edit_note or read_note_outline " +
  // ⚠ #146：`url` 走 `canonicalNotePath`，回的是 `/n/<owner>/<slug>` 這個**站內相對路徑**
  //   （`packages/shared/src/index.ts`）——沒有 scheme、沒有 host，照字面交給人是打不開的。
  //   ⚠ **限定到 `content` 那條路**：不帶 `content` 的建立只建一列（`notes/create.ts`，不經
  //   `applyEdit`）——不留 `note_ai_edits`
  //   列、沒有 editId、**沒有任何東西撤得回**。寫成「Creating a note is recorded…」是對模型說謊，
  //   而模型會照它決定「先建空筆記再 edit_note」安不安全（本檔一度那樣寫，審查抓到）。
  "— and its `url`, the note's page as a site-relative path: put this site's own address in front " +
  "of it before handing it to anyone. Filling it in with `content` is recorded like any other write " +
  "that changes a note's content, and can usually be undone.";

export const createNoteInput = {
  title: TITLE.optional()
    .describe("The note's title. Leave it out and the note is called \"Untitled\"; no tool here renames a note afterwards, so pass one if you know it."),
  content: MD.optional()
    .describe("Markdown for the new note. Leave it out to create an empty note. Some deployments cannot store content this way and answer `invalid_body`; create the note without it and the note still exists."),
};

export const createNoteOutput = {
  note: noteSummarySchema.describe("The note that was created, in the same shape list_notes returns."),
};

export interface CreateNoteArgs {
  title?: string;
  content?: string;
}

const NO_CONTENT_SUPPORT_MESSAGE =
  "This deployment cannot create a note with content. Call create_note again without `content`.";
const CREATE_FAILED_MESSAGE = "The note could not be created and nothing was stored. Try again.";

/**
 * insert 的 `returning()` 那一列 → `toNoteSummary` 收的形。`ownerHandle` 直接取呼叫者
 * （建立者即 owner，同 REST 的 A12，不必補查 `users`）；`editorHandle` 恆為 `null`——這一列
 * 的 `last_edited_by` 若已落款，落款人也就是呼叫者本人，而**只有重讀落空的競態**才會走到這裡。
 */
function insertedRow(row: typeof notes.$inferSelect, ownerHandle: string): NoteSummaryRow {
  return {
    id: row.id,
    title: row.title,
    ownerHandle,
    slug: row.slug,
    updatedAt: row.updatedAt,
    lastEditedAt: row.lastEditedAt,
    lastEditedAgentLabel: row.lastEditedAgentLabel,
    editorHandle: null,
  };
}

/**
 * 重讀那一列拿新鮮的落款（理由逐字在 `routes/notes.ts` 建立路徑的長註解裡：insert 的
 * `returning()` 是在合併**之前**取的，四欄還是 null，直接回它就是送出一個恆空的
 * `lastEdited` 假答案）。可見性走 `visibleNoteBranches` 的 owned 分支——與 `list_notes`／
 * `search_notes` **同一份**可見性語意，不新增第二種查詢形狀。
 * 落空＝回應組裝前這篇又被別的請求刪掉的競態；內容已經寫進去了，呼叫端退回 insert 的那一列
 * （與 REST 同一個判斷：回一個過期的 `lastEdited` 比讓外部 AI 重試建出第二篇有內容的筆記好）。
 */
async function reread(ctx: McpToolCtx, noteId: string): Promise<NoteSummaryRow | undefined> {
  const { owned } = visibleNoteBranches(ctx.db, ctx.userId, { extraWhere: eq(notes.id, noteId) });
  const [row] = await owned;
  return row;
}

export async function createNote(args: CreateNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  // 1. §10.2 D23／M13：scope、session 跳過、`tokenWrite` 三件事的**單一入口**。
  //    ⚠ **不帶 `content` 的呼叫一樣走它**——`tokenWrite` 因此照扣，與 REST 的 `POST /api/notes`
  //    一致（那邊由 preHandler 依宣告的 `notes:write` 扣，不看有沒有 content）。
  //    實測（2026-09-08，`tokenWrite` 覆寫成 `limit: 1`）：第一發不帶 content 的 `create_note`
  //    成功、**第二發就 `too_many_requests`**。
  //    ⚠ **誠實：本檔沒有守衛**——整支拿掉這兩行，`mcp-create-note` 六案全綠（突變實測）。
  //    守衛是 Task 4 的案 32（`tokenWrite` 桶兩支工具各跑一次）。
  const denied = requireWriteScope(ctx);
  if (denied !== null) return denied;

  // 2. 建列整件事（`title` 未帶時整把鍵都不放、讓 DB 的 default `"Untitled"` 與
  //    `untitled-<uuid8>` 生效；帶 title 就派生 auto slug）收在 `notes/create.ts` 的
  //    `insertNoteWithAutoSlug`（#145）。
  //    ⚠ **帶 `content` 時順序是硬要求**：`available` 閘門 → 扣 `edit` 桶 → **才**輪到任何
  //    DB 寫入或 slug 探測（不帶 `content` 的分支不過任何閘門，見步驟 5）。原本這個位置只是
  //    在組一個 values 物件（純物件、零查詢）所以擺在閘門之前無妨；`insertNoteWithAutoSlug`
  //    會發探測查詢，搬到這裡就讓「這個部署不支援 content」的拒絕路徑開始打 DB（違反 M6：
  //    拒絕零副作用）。守衛分兩種形，**實測（2026-09-15）**：
  //    (a) 整支呼叫搬上來 → 既有的**列數**斷言就抓得到：D-M（`countNotes` 2≠1）、案 21 與
  //        案 28(b)（零新增列 1≠0）三案連同下面那一案共 4 條紅。
  //    (b) **只把探測搬上來、INSERT 留在閘門之後** → 整包 925 案只有
  //        `mcp-create-note.test.ts` 那一案紅（`probes()` 半邊，0→1）。

  if (args.content !== undefined) {
    // 3. 沒有協作元件就沒有「內容」這回事（同 REST 的 400，D-M）。**排在扣 `edit` 桶之前**：
    //    這一發從來不會走到寫入管線，不該啃桶（M6：拒絕零副作用）。
    //    守衛＝`mcp-create-note.test.ts` 的 D-M 那一案最後兩行：那個 app 的 `edit` 桶由測試
    //    自己持有（`freshLimiters({ edit })`），所以「還剩幾格」直接數得出來——**「這個部署上
    //    `edit` 桶沒有第二個消費端」不等於觀察不到**（本檔一度這樣自陳，審查推翻）。
    //    突變實測（兩行對調）：那一案紅，`expected 29 to be 30`。
    if (!ctx.writes.available) return toolError("invalid_body", NO_CONTENT_SUPPORT_MESSAGE);
    // 4. `edit` 桶只有帶 `content` 這條路吃（規格 §8.8），且排在**任何 mount 之前**。桶 key 是裸 userId。
    if (!ctx.limiters.edit.consume(ctx.userId)) return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);

    const out = await ctx.writes.createWithContent(ctx.log, {
      userId: ctx.userId,
      userHandle: ctx.userHandle,
      tokenId: ctx.tokenId,
      title: args.title,
      content: args.content,
    });
    if (!out.ok) {
      // 解析失敗＝一列都沒建（「解析在建列之前」是契約）；`internal` ＝套用失敗，service 已經
      // best-effort 刪掉剛建的列。**佇列逾時走的是後者**，不是 `server_busy`。
      if (out.kind === "parse") return toolError(out.code, writeFailureMessage(out.code));
      return toolError("internal", CREATE_FAILED_MESSAGE);
    }
    const fresh = await reread(ctx, out.noteId);
    return toolResult({ note: toNoteSummary(fresh ?? insertedRow(out.inserted, ctx.userHandle), "owner") });
  }

  // 5. 不帶 `content`：只建一列（`notes/create.ts`），不碰 live doc、不吃 `edit` 桶、不重讀
  //    （`last_edited_*` 四欄還是 insert 的預設值，`toNoteSummary` 於是把 `lastEdited` 給
  //    null——不必為了一個必然落空的 JOIN 多發一次查詢）。帶 `title` 時 slug 在這一刻就跟
  //    標題走（#145），所以回應裡的 `url` 不必二次寫入就已經是最終網址。
  const created = await insertNoteWithAutoSlug(ctx.db, ctx.userId, args.title);
  return toolResult({ note: toNoteSummary(insertedRow(created, ctx.userHandle), "owner") });
}
