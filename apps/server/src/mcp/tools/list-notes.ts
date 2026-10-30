/**
 * #108 §8.2 `list_notes`：呼叫者看得見的筆記（自有 ∪ 被分享 ∪ 所屬群組的，#175），keyset 分頁。
 *
 * ⚠ **keyset 分頁不是快照**——但**成因不是「邊列邊改」**（#146 更正：這裡原本寫「`edit_note`
 * 會更新 `updated_at`」，是假的，而 PR3 的稽核表一度拿這句註解當證據，證據鏈是循環的）。
 * 查證：全 repo **零個 `$onUpdate`**；`notes.updated_at` 只有兩種東西會動——insert 的
 * `defaultNow()`，以及標題 PATCH（`routes/notes.ts`）與 slug PATCH（`notes/tx/patch-slug.ts`）兩處 DB 端 `now()`（#142）。
 * `notes/editing/` 整個目錄**零個 `updatedAt` 引用**（`edit_note` 走的 write-service →
 * mergeDiff → collab store 完全不碰它），`collab/store.ts` 動的是 `note_states` 那張別的表，
 * 而 `notes.linksClock`／`lastEditedAt` 的 UPDATE 都沒有一併寫 `updated_at`。
 * 所以真正會漏列的是**游標下方的列被搬到上方**：分頁期間有人新建筆記或改標題／slug。
 * 「你編輯你剛列出來的那些」造不成漏列——那些列本來就在游標**上方**。
 * ⚠ **第三個成因不是「被搬上去」而是「本來就在上面才加進來」**：翻頁期間分享給你的筆記、或你加入的
 * 群組的筆記、或 owner 移進你群組的筆記，以原本的位置加入清單（#175）。分享只寫 `note_shares`（`notes/tx/shares.ts` 的 insert／
 * `routes/notes.ts` 的 delete），加入群組只寫 `group_members`（groups 路由的成員端點），**都不碰
 * `notes.updated_at`**；移進群組（#175 PR2）的 UPDATE 在 `notes/tx/move.ts`，只寫 owner／group／slug／
 * prev_slug／公開 token／別名，**不寫 `updatedAt`**——撞名改了網址名（`-2`）也一樣（守衛＝
 * `test/groups-v2-move.test.ts` 首案與 RF1 案，兩案都斷 `updated_at` 與移動前相等）；而可見性是 `owned ∪ shared ∪ grouped`、**每一頁現算**（`notes/list-query.ts`
 * ＋ `mcp/queries.ts` 的 unionAll ＋ keyset 述詞）——那篇筆記於是以自己**未變動**的
 * `updated_at` 加入結果集，落點若在已經翻過去的區段，**沒有任何一頁會顯示它**。
 * 這一條模型偵測不到也閃避不了，所以 `description` 必須講（**不得只列前兩個成因**）。
 * 處置有兩處：known-limitations（PR3 已改成正確版本）＋工具 `description`
 * （`LIST_NOTES_DESCRIPTION`，不是欄位的 `.describe()`）裡逐字給模型看的那句話
 * （在下面，**不得刪**；守衛＝`mcp-notes.test.ts` 的「三句逐字文案在 wire 上出現」那一案——#175 起
 * 第三成因句也整句釘在那裡，之前只釘了前兩句）。
 *
 * ⚠ 查詢組裝在 `mcp/queries.ts`：branch select 是單次使用的一次性物件，判 `hasMore`
 * 一律靠 `.limit(limit + 1)` 多取一列，**不得發第二個查詢**。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { UUID_RE } from "../../notes/service.js";
import { noNul } from "../../notes/schemas.js";
import { noteSummariesForModel, noteSummarySchema } from "../dto.js";
import { BAD_CURSOR_MESSAGE, BASE64URL_RE, parseCursorTimestamp } from "../keyset-cursor.js";
import { MCP_PAGE_MAX } from "../limits.js";
import { NEXT_CURSOR_DESCRIBE, PAGE_CUT_SHORT_DESCRIBE } from "../paging-strings.js";
import { buildNoteListQuery, type NoteListCursor } from "../queries.js";
import { toolError, toolResult } from "../tool-result.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

const DEFAULT_LIMIT = 50;
const CURSOR_SEP = "|";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
export const LIST_NOTES_DESCRIPTION =
  "List the notes you can see — the ones you own, the notes of your groups, and the ones shared with you — " +
  "most recently updated first. Each result carries `owner` (a person or one of your groups) and `role` so you can " +
  "tell whose content you are reading. Paging reads live data, not a snapshot: creating a note, or renaming it, moves " +
  "it to the top of this order, above the cursor you are holding, so no later page shows it. Editing a note's content " +
  "does not move it. While you page, a note shared with you, a note moved into one of your groups, or the notes of a " +
  "group you join appear at their own unchanged positions, which may already be above your cursor. " +
  "A page can hold fewer notes than `limit` when the notes are large — `pageCutShort` is then true — so keep paging until `nextCursor` is null.";

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
  nextCursor: z.string().nullable().describe(NEXT_CURSOR_DESCRIBE),
  pageCutShort: z.literal(true).optional().describe(PAGE_CUT_SHORT_DESCRIBE),
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

/** 預算的固定部分：空頁＋一個長度與真游標相同的佔位游標（82）＋`pageCutShort` 的保留。 */
const CURSOR_PLACEHOLDER = encodeCursor({ updatedAtMs: new Date("2026-01-01T00:00:00.000Z"), id: "00000000-0000-0000-0000-000000000000" });
export const LIST_BASE_COST = wireCost({ notes: [], nextCursor: CURSOR_PLACEHOLDER }) + PAGE_CUT_RESERVE;

/**
 * 不變量 S 的前兩關（第三關是 drizzle 的參數化）。base64url 解碼對垃圾輸入不丟例外、只會
 * 回一串垃圾，所以格式關不能省：少了 `UUID_RE` 或時間段的格式檢查，垃圾就會進 keyset 述詞，
 * pg 報型別錯 → 模型收到 `internal` 而不是「你的游標壞了」。
 *
 * 時間段走 `parseCursorTimestamp`（資料夾 PR-3d T4 審查 N1）：只收本站發的四位數年份 ISO 形並做往返檢查——
 * 原本的 `new Date(ts)` 會收 `+275760-…` 這類 JS 有效、pg 解析不了的形，落成 `internal`。
 * ⚠ `noNul` 那一關：NUL 接在時間戳後面（`…Z` + NUL）時，2026-09-07 的實測是三關裡只有 `noNul` 擋得住
 * （`new Date` 收它）。改走 `parseCursorTimestamp` 之後格式檢查也擋得住，`noNul` 對那個落點不再是唯一守衛；
 * 留著它是因為它同時擋 id 欄以外的任何落點，成本為零。守衛＝`mcp-notes.test.ts` 的「壞 cursor 四發」第四發。
 * 字元集先擋（同 `decodeKeysetCursor`）：`Buffer.from(…, "base64url")` 會靜默略過字元集外的字元，真游標後面接 `!!` 也解得回來（守衛＝`mcp-notes.test.ts`「真游標後面接 !!」案）。
 */
function decodeCursor(raw: string): NoteListCursor | null {
  if (!BASE64URL_RE.test(raw)) return null;
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  if (!noNul(decoded)) return null;
  const parts = decoded.split(CURSOR_SEP);
  if (parts.length !== 2) return null;
  const [ts, id] = parts as [string, string];
  if (!UUID_RE.test(id)) return null;
  const updatedAt = parseCursorTimestamp(ts);
  if (updatedAt === null) return null;
  return { updatedAt, id };
}

export async function listNotes(args: ListNotesArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const limit = args.limit ?? DEFAULT_LIMIT;
  let cursor: NoteListCursor | null = null;
  if (args.cursor !== undefined) {
    cursor = decodeCursor(args.cursor);
    if (cursor === null) {
      return toolError("invalid_body", BAD_CURSOR_MESSAGE);
    }
  }

  const rows = await buildNoteListQuery(ctx.db, { userId: ctx.userId, cursor, limit });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const summaries = await noteSummariesForModel(ctx.db, page);
  // 資料夾 PR-3d（spec §5.12）：依 wire 成本截頁。截了就回已收的、游標指向被收的最後一篇（`updatedAtMs`，理由同 encodeCursor），
  // 並帶 `pageCutShort: true`；沒截照舊（沒有這把 key）。
  const kept = countWithinWireBudget(summaries.map(wireCost), LIST_BASE_COST);
  if (kept < page.length) {
    return toolResult({ notes: summaries.slice(0, kept), nextCursor: encodeCursor(page[kept - 1]!), pageCutShort: true });
  }
  const last = page[page.length - 1];
  return toolResult({
    notes: summaries,
    nextCursor: hasMore && last ? encodeCursor(last) : null,
  });
}
