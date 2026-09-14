/**
 * #108 §8.2 `list_notes`：呼叫者看得見的筆記（自有 ∪ 被分享），keyset 分頁。
 *
 * ⚠ **keyset 分頁不是快照**——但**成因不是「邊列邊改」**（#146 更正：這裡原本寫「`edit_note`
 * 會更新 `updated_at`」，是假的，而 PR3 的稽核表一度拿這句註解當證據，證據鏈是循環的）。
 * 查證：全 repo **零個 `$onUpdate`**；`notes.updated_at` 只有兩種東西會動——insert 的
 * `defaultNow()`，以及 `routes/notes.ts` 標題／slug 的 PATCH 那三處 DB 端 `now()`（#142）。
 * `notes/editing/` 整個目錄**零個 `updatedAt` 引用**（`edit_note` 走的 write-service →
 * mergeDiff → collab store 完全不碰它），`collab/store.ts` 動的是 `note_states` 那張別的表，
 * 而 `notes.linksClock`／`lastEditedAt` 的 UPDATE 都沒有一併寫 `updated_at`。
 * 所以真正會漏列的是**游標下方的列被搬到上方**：分頁期間有人新建筆記或改標題／slug。
 * 「你編輯你剛列出來的那些」造不成漏列——那些列本來就在游標**上方**。
 * ⚠ **第三個成因不是「被搬上去」而是「本來就在上面才加進來」**：分頁期間有人把一篇筆記分享給你。
 * 分享只寫 `note_shares`（`routes/notes.ts:1044` 的 insert／`:1097` 的 delete，**都不碰
 * `notes.updated_at`**），而可見性是 `owned ∪ shared`、**每一頁現算**（`notes/list-query.ts`
 * ＋ `mcp/queries.ts` 的 unionAll ＋ keyset 述詞）——那篇筆記於是以自己**未變動**的
 * `updated_at` 加入結果集，落點若在已經翻過去的區段，**沒有任何一頁會顯示它**。
 * 這一條模型偵測不到也閃避不了，所以 `description` 必須講（**不得只列前兩個成因**）。
 * 處置有兩處：known-limitations（PR3 已改成正確版本）＋工具 `description`
 * （`LIST_NOTES_DESCRIPTION`，不是欄位的 `.describe()`）裡逐字給模型看的那句話
 * （在下面，**不得刪**；守衛＝`mcp-notes.test.ts` 的「兩句逐字文案在 wire 上出現」那一案）。
 *
 * ⚠ 查詢組裝在 `mcp/queries.ts`：branch select 是單次使用的一次性物件，判 `hasMore`
 * 一律靠 `.limit(limit + 1)` 多取一列，**不得發第二個查詢**。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UUID_RE } from "../../notes/service.js";
import { noNul } from "../../notes/schemas.js";
import { noteSummarySchema, toNoteSummary } from "../dto.js";
import { MCP_PAGE_MAX } from "../limits.js";
import { buildNoteListQuery, type NoteListCursor } from "../queries.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

const DEFAULT_LIMIT = 50;
const CURSOR_SEP = "|";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
export const LIST_NOTES_DESCRIPTION =
  "List the notes you can see — the ones you own and the ones other people shared with you — " +
  "most recently updated first. Each result carries `ownerHandle` and `role` so you can tell whose " +
  "content you are reading. Paging reads live data, not a snapshot: creating a note, or changing a note's " +
  "title or slug, moves it to the top of this order, above the cursor you are holding, so no later page " +
  "shows it. Editing a note's content does not move it. A note shared with you while you page joins the list " +
  "at its own unchanged position, which may already be above your cursor.";

export const listNotesInput = {
  cursor: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Opaque cursor from a previous call's `nextCursor`. Omit it to start at the first page."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MCP_PAGE_MAX)
    .optional()
    .describe(`How many notes to return, 1 to ${MCP_PAGE_MAX}. Defaults to ${DEFAULT_LIMIT}.`),
};

export const listNotesOutput = {
  notes: z.array(noteSummarySchema).describe("The page of notes, most recently updated first."),
  nextCursor: z
    .string()
    .nullable()
    .describe("Pass this back as `cursor` for the next page; `null` means this was the last page."),
};

export interface ListNotesArgs {
  cursor?: string;
  limit?: number;
}

/**
 * ⚠ 時間戳一律取 **`updatedAtMs`（排序鍵本身）**，不是 `updatedAt`。`toISOString()` 只有毫秒，
 * 而 `notes.updated_at` 是微秒——游標與排序鍵不同精度就會靜默漏列（見 `mcp/queries.ts`）。
 * 兩者今天在 JS 裡剛好相等（node-postgres 解 timestamptz 是**截斷**到毫秒，實測
 * `.123900` → `.123`，與 `date_trunc('milliseconds', …)` 一致），但那是它的實作細節，
 * 不是我們該賴以正確的東西。
 */
function encodeCursor(row: { updatedAtMs: Date; id: string }): string {
  return Buffer.from(`${row.updatedAtMs.toISOString()}${CURSOR_SEP}${row.id}`, "utf8").toString("base64url");
}

/**
 * 不變量 S 的前兩關（第三關是 drizzle 的參數化）。base64url 解碼對垃圾輸入不丟例外、只會
 * 回一串垃圾，所以格式關不能省：少了 `UUID_RE` 或日期有效性檢查，垃圾就會進 keyset 述詞，
 * pg 報型別錯 → 模型收到 `internal` 而不是「你的游標壞了」。
 *
 * ⚠ **`noNul` 這一關是真的守衛，不是裝飾**（本檔一度自陳「結構上做不出有鑑別力的測試」——
 * **那句是錯的，2026-09-07 推翻**）。關鍵是 NUL 的**落點**：
 *   - 落在 id 欄 → 先被 `UUID_RE` 擋掉，`noNul` 拿掉也不會有測試變紅；
 *   - **接在時間戳後面 → `new Date("…Z" + NUL)` 仍然有效**（實測 `toISOString()` 原樣回傳），
 *     `UUID_RE` 又只管 id 欄——三關裡只剩 `noNul` 擋得住它。拿掉它，那發游標會**成功**
 *     回一整頁筆記。
 * 守衛＝`mcp-notes.test.ts` 的「壞 cursor 四發」第四發（突變實測：拿掉這一行只有它紅）。
 */
function decodeCursor(raw: string): NoteListCursor | null {
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (!noNul(decoded)) return null;
  const parts = decoded.split(CURSOR_SEP);
  if (parts.length !== 2) return null;
  const [ts, id] = parts as [string, string];
  if (!UUID_RE.test(id)) return null;
  const updatedAt = new Date(ts);
  if (Number.isNaN(updatedAt.getTime())) return null;
  return { updatedAt, id };
}

export async function listNotes(args: ListNotesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  let cursor: NoteListCursor | null = null;
  if (args.cursor !== undefined) {
    cursor = decodeCursor(args.cursor);
    if (cursor === null) {
      return toolError("invalid_body", "The `cursor` value is not one this server issued. Omit it to start over.");
    }
  }

  const rows = await buildNoteListQuery(ctx.db, { userId: ctx.userId, cursor, limit });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return toolResult({
    notes: page.map(row => toNoteSummary(row, row.role)),
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  });
}
