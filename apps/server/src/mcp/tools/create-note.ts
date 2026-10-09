/**
 * #108 §8.7 `create_note`：建一篇新筆記。與 `POST /api/notes` 的 body 同物件（`TITLE`／`MD`／`GROUP_ID`）、同驗證規則、
 * 同管線；鍵名依 MCP 輸入一律 snake_case（W15）——REST 是 `groupId`、這裡是 `group_id`，這是對 D18 的鍵名偏離（#180 spec §4.7）。
 * （D18：**寫入側不發明第二套契約**）——`content` 逐字重用 `MD`、`title` 逐字重用 `TITLE`（M14）。
 *
 * ⚠ **這支工具不進部署形態閘門**（裁決 D-M）：判準是「要不要讀 live doc」。不帶 `content` 時
 * 它只建一列（`notes/create.ts`；帶 `title` 時多一次——最壞每輪 20 次、最多 5 輪——scope 範圍
 * （個人＝owner、群組＝該群組）的 slug 探測查詢，#145），完全不碰 live doc；而 REST 的 `POST /api/notes` 本來就無條件註冊、帶
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
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isForeignKeyViolation } from "../../db/pg-errors.js";
import { insertNoteWithAutoSlug } from "../../notes/create.js";
import { loadCreateTarget } from "../../notes/create-target.js";
import { roleFromGroupFlags } from "../../notes/service.js";
import type { SlugScope } from "../../notes/slug.js";
import { GROUP_ID, MD, TITLE } from "../../notes/schemas.js";
import { noteSummarySchema, toNoteSummary } from "../dto.js";
import { insertedRow, rereadVisibleNote } from "../note-rows.js";
import { toolError, toolResult } from "../tool-result.js";
import { WRITE_RATE_LIMITED_MESSAGE, writeFailureMessage } from "../write-messages.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
// ⚠ #175 PR5：G1／D2／D3 三句逐字取自 `docs/mcp.md` 的 `create_note` 段（先寫文件、再照抄，spec §9.2），
//   差異只有三種：① G1 句首主詞（「`create_note` creates」→「Create」）；② D2／D3 的句首銜接
//   （「Leave `content` out for」→「or leave it out for」、「Its `id` is what you pass to」→「The reply carries the
//   new note's `id` — pass it to」）；③ `edit_note`／`read_note_outline` 去反引號（本檔既有工具名不加反引號）。
// ⚠ D2／D3 的 edit_note 承諾**收窄到 `role` 允許時**：群組的 create-only 角色（能建不能編，0013 起）建出的筆記
//   `role` 是 `viewer`，`edit_note` 對它一律 `forbidden`（`edit-note.ts` 的 viewer 分支）——「可以之後 edit_note」
//   對它是假話，gate r1 I-1。
export const CREATE_NOTE_DESCRIPTION =
  "Create a new note — yours, or in one of your groups when you pass `group_id`. Pass `content` to fill it in at the same time, " +
  "or leave it out for an empty note, which edit_note can fill in later if the reply's `role` is `owner` or `editor`. " +
  // ⚠ #146：**只有解析失敗那條路**「沒有留下筆記」。`internal`（套用失敗）那條路是先 insert
  //   再套用，清理是 best-effort——`write-service.ts` 的 catch 刪不掉時只 `log.warn`，照樣回
  //   `internal`，**現場會留下一篇空筆記**。所以限定成 "a call that fails to parse"
  //   （與 `docs/mcp.md` 同字）；`internal` 的殘留由該工具的錯誤說明負責。
  "Bad markdown is rejected before anything is stored, so a call that fails to parse leaves no " +
  "note behind. The reply carries the new note's `id` — pass it to read_note_outline, or to edit_note when its `role` allows writing " +
  // ⚠ #146：`url` 走 `canonicalNotePath`，回的是 `/n/<owner>/<slug>`（群組筆記是 `/g/<group id>/<slug>`）這個**站內相對路徑**
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
    // ⚠ #145：這一段與 `docs/mcp.md` 的 `create_note` bullet **除下列四項差異外逐字同源**：
    //   ① 前面多一句「The note's title.」②去掉 markdown 粗體 ③去掉 `title` 兩側的
    //   backtick ④開頭用祈使的「Leave it out」（而非「Leave out `title`」）。
    //   #175 PR5：去重範圍片語（「…against the other notes in the same place — your personal notes, or that
    //   group's notes — with a numeric suffix」，T1）與 docs 及 spec §9.2 逐字相同，不在上述四項差異內。
    //   「same place」的範圍＝`SlugScope`（個人＝owner 自己的筆記、群組＝該群組的筆記），由
    //   `notes/slug.ts` 的 `probeUniqueSlug` 述詞決定（`owner_id = me` 或 `group_id = g`，不含分享給你的筆記）。
    //   ⚠ 不准壓短：「沒給 title → untitled-…」這種縮寫會讓模型反推「給了就跟標題走」，
    //   但退位形（純標點／保留字／uuid 形標題）拿到的是 `untitled`（**無**尾碼）。
    .describe(
      "The note's title. Leave it out and the note is called \"Untitled\" and keeps a " +
        "database-assigned `untitled-<8 hex characters>` URL. A title you pass here is also what " +
        "the note's URL is derived from, de-duplicated against the other notes in the same place — " +
        "your personal notes, or that group's notes — with a numeric suffix (`meeting-notes`, " +
        "then `meeting-notes-2`). Some titles have no usable URL form " +
        "and fall back to `untitled`, numbered the same way — punctuation on its own, a reserved " +
        "word, or a uuid, or a title ending in one. No tool here renames a note afterwards, so " +
        "pass one if you know it.",
    ),
  // ⚠ #175 PR5：G2 逐字取自 `docs/mcp.md` `group_id` bullet 的第二到第五句（「Pass the id of one of your
  //   groups…」→ `.describe()` 句首改「The id of one of your groups…」，唯一差異）。bullet 其餘句子（id 去哪找、
  //   兩種拒絕、非 uuid 的輸入檢查）是文件對人說的，不放進模型面字串。
  //   `GROUP_ID` 與 REST `createBodySchema.groupId` 是同一個物件（D18／M14；`mcp-write-schemas.test.ts` 釘同源）。
  group_id: GROUP_ID.optional().describe(
    "The id of one of your groups where your role lets you create notes. The note then belongs to the group, " +
      "not to you. Leave it out for a personal note. If your role there can create notes but not edit them, " +
      "the note is read-only for you: the reply's `role` is `viewer`.",
  ),
  content: MD.optional()
    .describe("Markdown for the new note. Leave it out to create an empty note. Some deployments cannot store content this way and answer `invalid_body`; create the note without it and the note still exists. Colors work as in edit_note."),
};

export const createNoteOutput = {
  note: noteSummarySchema.describe("The note that was created, in the same shape list_notes returns."),
};

export interface CreateNoteArgs {
  title?: string;
  content?: string;
  group_id?: string;
}

/** spec §9.2 兩句專用訊息（逐字；`docs/mcp.md` Errors 段描述同一條件）。**不得**重用 `NOTE_NOT_FOUND_MESSAGE`——
 *  那句談「筆記」，這裡談「群組」，且兩種 404（非成員／不存在）必須逐位元組相同。 */
const GROUP_NOT_FOUND_MESSAGE = "No group with that id among the groups you belong to.";
const CREATE_IN_GROUP_FORBIDDEN_MESSAGE = "Your role in that group can't create notes. Leave out `group_id` to create a personal note.";

const NO_CONTENT_SUPPORT_MESSAGE =
  "This deployment cannot create a note with content. Call create_note again without `content`.";
const CREATE_FAILED_MESSAGE = "The note could not be created and nothing was stored. Try again.";

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

  // 2a. #175 PR5 群組目標（§9.3）。**順序是契約**：群組檢查 → `available` → 扣 `edit` 桶（與 REST `POST /api/notes`
  //    對齊：兩種拒絕零副作用、不啃 `edit` 桶；`tokenWrite` 已在上面照扣）。成員資格／新建旗標判準是
  //    `notes/create-target.ts` 的**同一份**實作（REST 兩個呼叫點與這裡共用）。交易外查（C8：撤旗標與建立之間
  //    不保證，spec §15 第 5 條）。
  //    非成員（含站台 admin，§5.5 無豁免）與不存在同一條 `group_not_found`；成員但沒有新建旗標 → `forbidden`。
  //    `role` 照旗標算、不假設 editor：0013 起 create-only 角色（能建不能編）得 `viewer`。
  let target: { scope: SlugScope; ownerHandle: string | null; groupName: string | null; role: string };
  if (args.group_id !== undefined) {
    const m = await loadCreateTarget(ctx.db, ctx.userId, args.group_id);
    if (!m) return toolError("group_not_found", GROUP_NOT_FOUND_MESSAGE);
    if (!m.canCreate) return toolError("forbidden", CREATE_IN_GROUP_FORBIDDEN_MESSAGE);
    await ctx.groupTestHook?.("membership-checked", { groupId: args.group_id });
    target = { scope: { groupId: args.group_id }, ownerHandle: null, groupName: m.name, role: roleFromGroupFlags(m) };
  } else {
    target = { scope: { ownerId: ctx.userId }, ownerHandle: ctx.userHandle, groupName: null, role: "owner" };
  }
  // 檢查之後群組被刪：建列那一發撞 FK 23503（REST `routes/notes.ts` 同形映射；建列在 service 的 try 之外，所以
  // 原樣拋到這裡）。**只在群組分支映射**——個人分支的 23503 只可能來自 `owner_id → users`，而 `src/` 內沒有硬刪
  // users 的路徑，不擴大映射面。
  const mapGroupFk = (err: unknown): CallToolResult => {
    if (args.group_id !== undefined && isForeignKeyViolation(err)) return toolError("group_not_found", GROUP_NOT_FOUND_MESSAGE);
    throw err;
  };

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

    let out;
    try {
      out = await ctx.writes.createWithContent(ctx.log, {
        userId: ctx.userId,
        userHandle: ctx.userHandle,
        tokenId: ctx.tokenId,
        title: args.title,
        content: args.content,
        scope: target.scope,
      });
    } catch (err) {
      return mapGroupFk(err);
    }
    if (!out.ok) {
      // 解析失敗＝一列都沒建（「解析在建列之前」是契約）；`internal` ＝套用失敗，service 已經
      // best-effort 刪掉剛建的列。**佇列逾時走的是後者**，不是 `server_busy`。
      if (out.kind === "parse") return toolError(out.code, writeFailureMessage(out.code));
      return toolError("internal", CREATE_FAILED_MESSAGE);
    }
    const fresh = await rereadVisibleNote(ctx, out.noteId, target.scope);
    return toolResult({ note: toNoteSummary(fresh ?? insertedRow(out.inserted, target), fresh?.role ?? target.role) });
  }

  // 5. 不帶 `content`：只建一列（`notes/create.ts`），不碰 live doc、不吃 `edit` 桶、不重讀
  //    （`last_edited_*` 四欄還是 insert 的預設值，`toNoteSummary` 於是把 `lastEdited` 給
  //    null——不必為了一個必然落空的 JOIN 多發一次查詢）。帶 `title` 時 slug 在這一刻就跟
  //    標題走（#145），所以回應裡的 `url` 不必二次寫入就已經是最終網址。
  let created;
  try {
    created = await insertNoteWithAutoSlug(ctx.db, target.scope, args.title);
  } catch (err) {
    return mapGroupFk(err);
  }
  return toolResult({ note: toNoteSummary(insertedRow(created, target), target.role) });
}
