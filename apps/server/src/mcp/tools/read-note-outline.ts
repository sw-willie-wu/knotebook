/**
 * #108 §8.3 `read_note_outline`：一篇筆記有哪些段落、各多長。模型每次都要打的第一發。
 *
 * ⚠ **輸出裡沒有任何 `fingerprint`**——整篇的沒有，逐段的也沒有。兩個理由（§8.10，rev 3
 * 換掉了 rev 2 那個被推翻的「這是一道防線」）：
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
 * ＝層級更高），不是只有同層：`##` 段落裡插一顆 `#` 照樣多一段（r2 審查抓到本註解差這一格）。
 * - `insert_after`／`append`：插入的 markdown 每多一顆同層或更上層的 heading 就多一段。
 * - `delete_section`：整段連 id 一起消失。
 * - `replace_section`：markdown **不含**標題 → 那一段被溶解進前一段（少一段，`docs/ai-editing.md`
 *   明講）；含兩顆同層或更上層的標題 → 一段變兩段。
 * - `replace_all`：整篇重排，而且每顆 block 都換新 id（known-limitations 有一條專講）。
 * 處置有兩處：known-limitations（PR3）＋下面 `description` 裡逐字給模型看的那句
 * （**不得刪**；守衛＝`mcp-content.test.ts` 的「逐字文案在 wire 上出現」那一案）。
 */
import { z } from "zod";
import { eq } from "drizzle-orm";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import type { Db } from "../../db/index.js";
import { notes, users } from "../../db/schema.js";
import { outlineOf } from "../../notes/editing/fingerprint.js";
import { loadLastEdited, loadNoteDoc } from "../../notes/editing/read.js";
import { NOTE_ID } from "../../notes/schemas.js";
import { noteSummarySchema } from "../dto.js";
import { MCP_PAGE_MAX, truncateText } from "../limits.js";
import { NOTE_NOT_FOUND_MESSAGE, authorizeNoteRead } from "../note-read.js";
import { buildOutlinePage, outlineEntrySchema } from "../outline-page.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

/** 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。 */
export const READ_NOTE_OUTLINE_DESCRIPTION =
  "List a note's sections — id, heading, depth and length — so you can pick what to read with " +
  "read_note_section. Call this first: there is no tool that returns a whole note. " +
  `At most ${MCP_PAGE_MAX} sections per call; page with \`section_offset\` while \`truncated\` is true. ` +
  "To list every section, finish listing all pages before you start editing; editing while you page will skip sections.";

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
 *  的 `z.literal(true)` 只能有一個定義（M16／M14 的同一個精神）。 */
const noteHeaderSchema = noteSummarySchema.pick({
  id: true,
  title: true,
  titleTruncated: true,
  ownerHandle: true,
  role: true,
});

export const readNoteOutlineOutput = {
  note: noteHeaderSchema.describe("Which note this outline belongs to, and your role on it."),
  totalChars: z.number().describe("Characters in the whole note — not just this page of sections."),
  sections: z.array(outlineEntrySchema).describe("This page of sections, in document order."),
  truncated: z.boolean().describe("True when more sections follow this page."),
  nextSectionOffset: z
    .number()
    .nullable()
    .describe("Pass this back as `section_offset` for the next page; `null` means this was the last page."),
  lastEdited: noteSummarySchema.shape.lastEdited.describe("Who last changed this note, and when."),
};

export interface ReadNoteOutlineArgs {
  note_id: string;
  section_offset?: number;
}

/** `resolveRole` 判定完到這裡的 re-select 之間存在競態視窗（同 `routes/notes.ts` 的
 *  `loadNoteWithOwner`）：另一個請求剛好把它刪了就查不到列，不拿 non-null assertion 賭。 */
async function loadNoteHeader(db: Db, noteId: string): Promise<{ title: string; ownerHandle: string } | undefined> {
  const [row] = await db
    .select({ title: notes.title, ownerHandle: users.handle })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
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

  const { doc } = await loadNoteDoc({ db: ctx.db, collab: ctx.collab }, args.note_id);
  // ⚠ 只取 `outline`：`whole`（整篇指紋）在這裡就被丟掉，逐段的 `fingerprint`／`blockIds`
  //   由 `buildOutlinePage` 丟掉（M12(1)）。
  const { outline } = outlineOf(doc.getXmlFragment(YDOC_FRAGMENT));
  const title = truncateText(header.title);
  const page = buildOutlinePage(outline, args.section_offset ?? 0);
  return toolResult({
    note: {
      id: args.note_id,
      title: title.text,
      ...(title.truncated ? { titleTruncated: true as const } : {}),
      ownerHandle: header.ownerHandle,
      role: access.role,
    },
    // 整篇字數，**不是這一頁的**：模型靠它判斷這篇值不值得逐段讀完（§8.3）。
    totalChars: outline.reduce((n, entry) => n + entry.chars, 0),
    ...page,
    lastEdited: await loadLastEdited(ctx.db, args.note_id),
  });
}
