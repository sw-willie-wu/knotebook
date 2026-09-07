/**
 * #108 §8.6 `edit_note`：改一篇筆記的一段或整篇。與 `POST /api/notes/:id/edits` 逐欄同形、
 * 同驗證規則、同必填矩陣（D18：**寫入側不發明第二套契約**）。
 *
 * ⚠ **必填矩陣的單一真相是 `notes/schemas.ts` 的 `editBodySchema`**（D-N）。raw shape 只是把
 * 欄位攤平給模型看——**不得把整個 discriminatedUnion 當 `inputSchema` 傳給 `registerTool`**：
 * 它**不會 throw、執行期驗證照常**，但公告出去的 JSON Schema 會靜默變成
 * `{"type":"object","properties":{}}`——**模型看不到任何欄位**（實測 2026-09-08：entry 從
 * raw shape 的 641 bytes 掉到 126）。守衛＝`mcp-edit-note.test.ts` 的 S1，它是**那個症狀**
 * （properties 空掉）唯一的守衛。
 * ⚠ **誠實記下**：這條突變在**今天的接線上**還會順帶讓八案一起紅，但那是另一個原因——
 * raw shape 有 `note_id` 而 `editBodySchema` 的每個分支都 `.strict()`，union 會把它判成
 * `unrecognized_keys`，所以每一發呼叫都失敗。**那個副作用是巧合**：union 哪天多一個
 * `note_id` 鍵，八案就全部恢復綠，只剩 S1 紅。**不要把那八案當成這條的守衛。**
 * ⚠ 餵進 `editBodySchema` 的物件要**逐鍵條件展開**：`.strict()` 看的是 `Object.keys`，
 * `{op:"append", section_id: undefined}` 會被判 `unrecognized_keys`（`delete_section` ＋
 * `markdown: undefined` 同一顆雷）。守衛＝S4 那兩發。
 *
 * ⚠ **`outline` 帶逐段指紋是 M12 的明文例外**（D18 的 REST 對等：`docs/ai-editing.md` 逐字
 * 承諾「連續寫入不必回頭再讀」）；**錯誤側一律不帶**——`fingerprint_mismatch` 代表你的視圖
 * 已經過期，遞一個新權杖讓你盲目重試是錯的（案 20）。
 * ⚠ `fingerprint_mismatch` 的 outline 走 `loadNoteDoc` + `outlineOf`，**不走 `readNoteContent`**
 * （REST 的 409 走的是後者，而它會 mount 編輯器並匯出整篇 markdown；案 20 逐字要求回應裡
 * 不含任何 markdown）。這讓「不含 markdown」是結構性的，而不是靠記得刪欄位。
 *
 * ⚠ `section_id` **從來不進 SQL**（`applyEdit` 內部是對 outline 做記憶體裡的 `find`），
 * 所以不變量 S 對它只有前兩關（格式 guard ＋ NUL），由 `SEC` 承擔（M9／M14）。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { outlineOf } from "../../notes/editing/fingerprint.js";
import { loadNoteDoc } from "../../notes/editing/read.js";
import { editBodySchema, FP, MD, NOTE_ID, SEC } from "../../notes/schemas.js";
import { resolveRole } from "../../notes/service.js";
import { MCP_PAGE_MAX } from "../limits.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../note-read.js";
import { buildOutlinePage, outlineEntryWithFingerprintSchema } from "../outline-page.js";
import { toolError, toolResult } from "../tool-result.js";
import { WRITE_RATE_LIMITED_MESSAGE, writeFailureMessage } from "../write-messages.js";
import { requireWriteScope } from "../write-scope.js";
import type { McpToolCtx } from "../context.js";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
export const EDIT_NOTE_DESCRIPTION =
  "Change one note. Five operations: `replace_all` rewrites the whole note, `replace_section` " +
  "and `delete_section` act on one section, `insert_after` puts new markdown after a section, " +
  "and `append` adds to the end. Every operation except `append` needs `if_match`, the " +
  "fingerprint of what you are replacing — a section's from read_note_section (once you have " +
  "read to its end) or from a previous edit_note reply; the whole note's from a previous " +
  "edit_note reply. Every change is recorded and the note's owner can undo it.";

/**
 * ⚠ **`op` 是唯一沒有與 REST 共用物件的欄位**：那邊是 `discriminatedUnion` 的五個 `z.literal`，
 * 這邊要的是一個帶 `.describe()` 的 `z.enum`（raw shape 表達不了 per-op 必填矩陣）。兩份字串
 * 集合由 `test/unit/mcp-write-schemas.test.ts` 對起來——沒有它，加第六個 op 只有一邊會知道。
 * 其餘四個欄位逐字重用 `notes/schemas.ts` 的 base（M14），建法一律 `BASE.optional().describe()`。
 */
export const editNoteInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  op: z
    .enum(["replace_all", "replace_section", "insert_after", "append", "delete_section"])
    .describe("What to do. `replace_section`, `insert_after` and `delete_section` need `section_id`; only `append` may omit `if_match`."),
  section_id: SEC.optional()
    .describe("Which section to act on, from read_note_outline. Required for replace_section, insert_after and delete_section."),
  markdown: MD.optional().describe("The new markdown. Required for every operation except delete_section."),
  if_match: FP.optional()
    .describe("The fingerprint of what you are replacing. Required for every operation except append; the write fails if the note changed since you read it."),
};

export const editNoteOutput = {
  editId: z.string().describe("Id of this change in the note's history; the owner can undo it with this."),
  fingerprint: z.string().describe("The whole note's new fingerprint. Pass it as `if_match` to a following replace_all."),
  outline: z
    .object({
      sections: z.array(outlineEntryWithFingerprintSchema).describe("One page of the note's sections, in document order."),
      truncated: z.boolean().describe("True when the note has more sections than this page shows."),
    })
    .describe(
      `The note's sections after your change, at most ${MCP_PAGE_MAX}. For replace_section and insert_after the page ` +
        "starts at the section that now holds what you wrote — which may be the preceding section, if your markdown " +
        "did not begin with a heading. For replace_all, append and delete_section it starts at the beginning of the " +
        "note, so on a note with more than 100 sections an append will not show you the end you just wrote; read it " +
        "back with read_note_outline."
    ),
  unboundWikilinks: z.number().describe("How many `[[wikilinks]]` in what you wrote point at no existing note."),
};

export interface EditNoteArgs {
  note_id: string;
  op: "replace_all" | "replace_section" | "insert_after" | "append" | "delete_section";
  section_id?: string;
  markdown?: string;
  if_match?: string;
}

const FORBIDDEN_MESSAGE = "You can read this note but not change it. Ask its owner for editor access.";
const SECTION_NOT_FOUND_MESSAGE =
  "This note has no section with that id. Call read_note_outline again — section ids change when the note is edited.";
const MISMATCH_MESSAGE =
  "The note changed since you read it, so this write was not applied. The current outline is below; read what you " +
  "want to change again and retry with a fresh `if_match`.";

/** `section_id` 有意義的三個 op（**三個不是四個**——`replace_all`／`append` 規格明文從 0 起算）。 */
const SECTION_SCOPED = new Set(["replace_section", "insert_after", "delete_section"]);

/** 逐 op 的必填矩陣說明——`editBodySchema` 擋下來時模型要知道自己少了什麼。 */
function invalidBodyMessage(op: string, issues: readonly { path: PropertyKey[] }[]): string {
  const fields = [...new Set(issues.map(i => String(i.path[0] ?? "")).filter(Boolean))];
  const which = fields.length === 0 ? "" : ` Check: ${fields.join(", ")}.`;
  return (
    `This \`${op}\` call does not match what that operation needs.${which} ` +
    "replace_section, insert_after and delete_section need `section_id`; every operation except delete_section needs " +
    "`markdown`; every operation except append needs `if_match`. Fields that do not belong to the operation are rejected."
  );
}

export async function editNote(args: EditNoteArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  // 1. §10.2 D23／M13：scope、session 跳過、`tokenWrite` 三件事的**單一入口**，排在
  //    `resolveRole` 之前（REST 的 `tokenWrite` 在 preHandler 扣，`role === "none"` 的 404
  //    一樣啃桶——MCP 對齊 REST）。
  const denied = requireWriteScope(ctx);
  if (denied !== null) return denied;

  // 2. 必填矩陣（D-N）。⚠ `note_id` **不進去**（`editBodySchema` 每個分支都 `.strict()`，
  //    多一把鍵就是 `unrecognized_keys`）；`op` 恆帶；其餘三個**逐鍵條件展開**（P15）。
  const parsed = editBodySchema.safeParse({
    op: args.op,
    ...(args.section_id === undefined ? {} : { section_id: args.section_id }),
    ...(args.markdown === undefined ? {} : { markdown: args.markdown }),
    ...(args.if_match === undefined ? {} : { if_match: args.if_match }),
  });
  if (!parsed.success) return toolError("invalid_body", invalidBodyMessage(args.op, parsed.error.issues));

  // 3. L3：每支工具自己 `resolveRole`。`none` 一律當「找不到」，與「存在但你沒權限」用**同一個
  //    字串**（M2／案 17，重用 `note-read.ts` 那一份）。
  const role = await resolveRole(ctx.db, ctx.userId, args.note_id);
  if (role === "none") return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);
  if (role === "viewer") return toolError("forbidden", FORBIDDEN_MESSAGE);

  // 4. `edit` 桶在**角色檢查之後**扣（`role === "none"` 的 404 不啃它，比照 `routes/notes.ts`），
  //    但在任何 mount／直連之前——429 是拒絕案，不得留下任何落盤或紀錄（M6）。桶 key 是裸 userId。
  if (!ctx.limiters.edit.consume(ctx.userId)) return toolError("too_many_requests", WRITE_RATE_LIMITED_MESSAGE);

  // 5. 結構上到不了：`edit_note` 只在 `collab && editing` 都在時才註冊。留著是因為兩者在型別上
  //    選配——`runTool()` 會把它轉成 `internal`，不讓例外冒到 SDK（模型看到的是固定英文字串，
  //    所以這條**內部**訊息用中文是對的）。
  if (!ctx.writes.available) throw new Error("edit_note：寫入 service 不可用（不該被註冊）");

  const out = await ctx.writes.applyToNote(ctx.log, {
    noteId: args.note_id,
    userId: ctx.userId,
    userHandle: ctx.userHandle,
    tokenId: ctx.tokenId,
    op: parsed.data.op,
    sectionId: "section_id" in parsed.data ? parsed.data.section_id : undefined,
    markdown: "markdown" in parsed.data ? parsed.data.markdown : undefined,
    ifMatch: "if_match" in parsed.data ? parsed.data.if_match : undefined,
  });

  if (!out.ok) {
    if (out.kind === "busy") return toolError("server_busy", "Another write to this note is in progress. Try again in a moment.");
    if (out.code === "fingerprint_mismatch") return mismatchError(ctx, args);
    // `section_not_found` **不帶 outline**——取頁規則對它沒有定義，不發明第二條。
    if (out.code === "section_not_found") return toolError("section_not_found", SECTION_NOT_FOUND_MESSAGE);
    return toolError(out.code, writeFailureMessage(out.code));
  }

  // D-J 的取頁規則：section-scoped 的三個 op 從落點那一段起算，`replace_all`／`append` 從 0。
  const sectionOffset = SECTION_SCOPED.has(args.op) ? (out.result.afterSectionIndex ?? 0) : 0;
  const page = buildOutlinePage(out.result.outline, sectionOffset, { withFingerprints: true });
  return toolResult({
    editId: out.result.editId,
    fingerprint: out.result.fingerprint,
    // `nextSectionOffset` 刻意丟掉：`edit_note` 沒有續讀入口，不該回一個沒有工具收得下的游標。
    outline: { sections: page.sections, truncated: page.truncated },
    unboundWikilinks: out.result.unboundWikilinks,
  });
}

/**
 * 案 20：回目前的 outline 讓模型知道現況，但**一個指紋都不帶**。
 * 取頁＝請求裡的 `section_id` 在**目前** outline 的索引；找不到、或不是 section-scoped 的 op
 * → 第 0 頁（不發明第二條規則）。
 */
async function mismatchError(ctx: McpToolCtx, args: EditNoteArgs): Promise<CallToolResult> {
  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, args.note_id);
  const { outline } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
  const at = args.section_id === undefined ? -1 : outline.findIndex(s => s.sectionId === args.section_id);
  const offset = SECTION_SCOPED.has(args.op) && at !== -1 ? at : 0;
  const page = buildOutlinePage(outline, offset);
  return toolError("fingerprint_mismatch", MISMATCH_MESSAGE, {
    outline: { sections: page.sections, truncated: page.truncated },
  });
}
