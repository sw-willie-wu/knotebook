/**
 * #108 `read_note_outline`：一篇筆記有哪些段落、各多長。模型每次都要打的第一發。
 *
 * ⚠ **輸出裡沒有任何內文的 `fingerprint`**——整篇的沒有，逐段的也沒有。唯一的例外是 #381 的 `titleFingerprint`（標題指紋，
 * `edit_note` rename 的 `if_match`）：標題本來就整個在 `note.title` 裡讀得到（除非超過 200 被截），讀 outline 就是「讀過標題」，
 * 下面 (b) 的「無痕變有痕」對標題不適用。它與內文指紋**互不涵蓋**（`outlineOf` 的 whole 只由逐段指紋組成）。兩個理由（它不是一道防線）：
 * (a) **回應更小**：一篇 40 段的筆記就是 40 個模型看不懂也用不到的 16 字元十六進位串。
 * (b) **移除「一次呼叫就繞過」的路徑**：在**已有內容的**筆記上，要零讀取拿到比對值，現在
 *     至少得先寫一次帶非空內容的 `append`，而那次寫入在筆記內容裡看得見、也留下撤得回的
 *     紀錄。**把無痕變成有痕**才是這個收緊買到的東西。
 * ⚠ **不得寫成「所以模型拿不到整篇指紋」**——它拿得到，只是要付一筆有紀錄的寫入。
 *
 * ⚠ **不做 markdown 匯出**，所以這條路徑**完全不碰 jsdom**（同 `notes/editing/read.ts`
 * 檔頭那句「讓最常見的冷讀路徑完全不碰 jsdom」）。
 *
 * ⚠ 分頁不是快照：段落序＝文件位置序，**五個 op 沒有一個是安全的**（#146：原本這裡只列了
 * `insert_after`／`delete_section` 兩個，是不完整的列舉）。段落是 `note-sections.ts` 的
 * `sectionize` 現算出來的，所以**段落數會不會變，取決於送進去的 markdown 有幾顆什麼層級的
 * heading**，不取決於 op 的名字。⚠ 開新段的判準是 `note-sections.ts:59` 的
 * `current.level === 0 || level <= current.level`——**「同層**或更上層**」**（`level` 數字更小
 * ＝層級更高），不是只有同層：`##` 段落裡插一顆 `#` 照樣多一段。
 * - `insert_after`／`append`：插入的 markdown 每多一顆同層或更上層的 heading 就多一段。
 * - `delete_section`：整段連 id 一起消失。
 * - `replace_section`：markdown **不含**標題 → 那一段被溶解進前一段（少一段，`docs/ai-editing.md`
 *   明講）；含兩顆同層或更上層的標題 → 一段變兩段。
 * - `replace_all`：整篇重排，而且每顆 block 都換新 id（known-limitations 有一條專講）。
 * 處置有兩處：known-limitations ＋下面 `description` 裡逐字給模型看的那句
 * （**不得刪**；守衛＝`mcp-content.test.ts` 的「逐字文案在 wire 上出現」那一案）。
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Db } from "../../db/index.js";
import { groups, notes, users } from "../../db/schema.js";
import { fingerprintOf } from "../../notes/editing/fingerprint.js";
import { loadLastEdited } from "../../notes/editing/read.js";
import { viewerFolderIdFor } from "../../notes/note-dto.js";
import { NOTE_ID } from "../../notes/schemas.js";
import type { DbOrTx } from "../../db/tx.js";
import { noteSummarySchema, ownerForModel } from "../dto.js";
import { loadFolderPath, truncateFolderPath } from "../folder-fields.js";
import { MCP_FOLDER_NAME_MAX, MCP_PAGE_MAX, truncateText } from "../limits.js";
import { NOTE_NOT_FOUND_MESSAGE, authorizeNoteRead, readOutlineForTool } from "../note-read.js";
import { buildOutlinePage, outlineEntrySchema } from "../outline-page.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
export const READ_NOTE_OUTLINE_DESCRIPTION =
  "List a note's sections — id, heading, depth and length — so you can pick what to read with " +
  "read_note_section. Call this first: there is no tool that returns a whole note. " +
  `At most ${MCP_PAGE_MAX} sections per call; page with \`section_offset\` while \`truncated\` is true. ` +
  "To list every section, finish listing all pages before you start editing; editing while you page will skip sections.";

/** 帶資料夾時的說明句。 */
export const RO_FOLDER_DESCRIBE =
  "Where this note is filed for you, with the folder names from the top level down, or null at the top level; " +
  "for a note shared with you, where you filed it, not where its owner did. Long paths are cut from the top, with `pathTruncated`.";

export const readNoteOutlineInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  section_offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Where to start in the section list, counted in sections (not characters). " +
        "Use `nextSectionOffset` from the previous call; omit it for the first page."
    ),
};

/** `note` ＝ `NoteSummary` 的子集，**共用同一份 zod**：標題的 200 上限與 `titleTruncated`
 *  的 `z.literal(true)` 只能有一個定義。 */
const noteHeaderSchema = noteSummarySchema.pick({
  id: true,
  title: true,
  titleTruncated: true,
  owner: true,
  role: true,
});

export const readNoteOutlineOutput = {
  note: noteHeaderSchema.describe("Which note this outline belongs to, and your role on it."),
  folder: z
    .object({ id: z.string(), path: z.array(z.string().max(MCP_FOLDER_NAME_MAX)), pathTruncated: z.literal(true).optional() })
    .nullable()
    .describe(RO_FOLDER_DESCRIBE),
  totalChars: z.number().describe("Characters in the whole note — not just this page of sections."),
  sections: z.array(outlineEntrySchema).describe("This page of sections, in document order."),
  truncated: z.boolean().describe("True when more sections follow this page."),
  nextSectionOffset: z
    .number()
    .nullable()
    .describe("Pass this back as `section_offset` for the next page; `null` means this was the last page."),
  lastEdited: noteSummarySchema.shape.lastEdited.describe("Who last changed this note, and when."),
  // #381：回應欄位一律 camelCase；算標題**全文**（`note.title` 可能被截）。不點名 edit_note——唯讀憑證也看得到這支工具。
  titleFingerprint: z
    .string()
    .describe("The fingerprint of the note's whole title, even when `note.title` is cut. Renaming the note needs it as `if_match`."),
};

/**
 * 資料夾：呼叫者視角的所在資料夾（`viewerFolderIdFor`：群組筆記與 owner 取 `notes.folder_id`，被分享者取自己的放置）
 * ＋完整路徑（根 → 葉，`truncateFolderPath`）。根層 → null；兩句之間資料夾被刪（`loadFolderPath` 落空）→ null。
 */
export async function outlineFolderFor(
  db: DbOrTx,
  note: { id: string; ownerId: string | null; groupId: string | null; folderId: string | null },
  userId: string,
): Promise<{ id: string; path: string[]; pathTruncated?: true } | null> {
  const folderId = await viewerFolderIdFor(db, note, userId);
  if (folderId === null) return null;
  const names = await loadFolderPath(db, folderId);
  if (names === null) return null;
  const path = truncateFolderPath(names);
  return { id: folderId, path: path.path, ...(path.truncated ? { pathTruncated: true as const } : {}) };
}

export interface ReadNoteOutlineArgs {
  note_id: string;
  section_offset?: number;
}

/** `resolveRole` 判定完到這裡的 re-select 之間存在競態視窗（同 `routes/notes.ts` 的
 *  `loadNoteWithOwner`）：另一個請求剛好把它刪了就查不到列，不拿 non-null assertion 賭。
 *  #175：users 與 groups 都 LEFT JOIN——INNER JOIN users 會讓群組筆記（沒有 owner）回 `not_found`。 */
async function loadNoteHeader(
  db: Db,
  noteId: string
): Promise<
  | { id: string; title: string; ownerHandle: string | null; ownerId: string | null; groupId: string | null; groupName: string | null; folderId: string | null }
  | undefined
> {
  const [row] = await db
    .select({
      id: notes.id,
      title: notes.title,
      ownerHandle: users.handle,
      ownerId: notes.ownerId,
      groupId: notes.groupId,
      groupName: groups.name,
      folderId: notes.folderId,
    })
    .from(notes)
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .where(eq(notes.id, noteId))
    .limit(1);
  return row;
}

export async function readNoteOutline(args: ReadNoteOutlineArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const access = await authorizeNoteRead(ctx, args.note_id, undefined);
  if (!access.ok) return access.error;
  const header = await loadNoteHeader(ctx.db, args.note_id);
  // 競態：`resolveRole` 說有，另一個請求在這中間把它刪了。同一個字串——三種「找不到」在
  // wire 上必須無法區分（案 17）。
  if (header === undefined) return toolError("not_found", NOTE_NOT_FOUND_MESSAGE);

  // 大綱在 parse worker 裡算（很小的筆記在主執行緒；`readNoteOutline`）。worker 全忙 → server_busy；太大 → too_complex。
  // ⚠ 只取 `outline`：`whole`（整篇指紋）在這裡就被丟掉，逐段的 `fingerprint`／`blockIds`
  //   由 `buildOutlinePage` 丟掉。
  const read = await readOutlineForTool(ctx, args.note_id);
  if ("error" in read) return read.error;
  const { outline } = read;
  const title = truncateText(header.title);
  const page = buildOutlinePage(outline, args.section_offset ?? 0);
  return toolResult({
    note: {
      id: args.note_id,
      title: title.text,
      ...(title.truncated ? { titleTruncated: true as const } : {}),
      owner: ownerForModel(header),
      role: access.role,
    },
    folder: await outlineFolderFor(ctx.db, header, ctx.userId),
    // 整篇字數，**不是這一頁的**：模型靠它判斷這篇值不值得逐段讀完。
    totalChars: outline.reduce((n, entry) => n + entry.chars, 0),
    ...page,
    lastEdited: await loadLastEdited(ctx.db, args.note_id),
    titleFingerprint: fingerprintOf(header.title),
  });
}
