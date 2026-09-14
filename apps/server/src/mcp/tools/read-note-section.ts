/**
 * #108 §8.4 `read_note_section`：一段筆記的 markdown，單次上限 4000 個 UTF-16 code unit。
 *
 * ⚠ **`fingerprint` 只隨「結束該段的那一頁」附上**（D16／M12(3)）。
 * **理由是正確性，不是安全**：`replace_section` 是整段取代——模型讀了前 4000 字元、以為那
 * 就是全部，寫回去就吃掉了沒讀到的尾巴，而且它不會知道自己刪了什麼。**它防的是循序讀取的
 * 誠實 agent**：`offset` 沒有上界，一發大 `offset` 的呼叫同樣算結束頁、照樣拿得到指紋
 * （規格 §8.4 rev 5 的誠實降級）。**不得把這條寫成一道安全防線。**
 *
 * ⚠ `truncated` 時附上的 `note` 是**解釋性文案**（解釋為什麼沒有 `fingerprint`、怎麼拿到），
 * **不是防線**——沒有任何驗收去斷言「這個欄位存在就安全」（規格 §14.3 對 rev 1 那句的更正）。
 *
 * ⚠ **`heading` 刻意不回**：它在 `NoteOutlineEntry` 上沒有任何上限，留著就得再截一次；
 * 而那顆標題本來就在 `markdown` 的第一行。
 *
 * ⚠ `section_id` **從來不進 SQL**（`readNoteContent` → `outlineOf` → 記憶體裡的 `find`），
 * 所以不變量 S 對它只有前兩關（格式 guard ＋ NUL），由 `SEC` 這個 schema 承擔（M9／M14）。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { loadLastEdited, readNoteContent } from "../../notes/editing/read.js";
import { NOTE_ID, SEC } from "../../notes/schemas.js";
import { noteSummarySchema } from "../dto.js";
import { MCP_SECTION_CHARS, truncateText } from "../limits.js";
import { authorizeNoteRead, SECTION_NOT_FOUND_MESSAGE } from "../note-read.js";
import { toolError, toolResult } from "../tool-result.js";
import type { McpToolCtx } from "../context.js";

export const READ_NOTE_SECTION_DESCRIPTION =
  "Read one section of a note as markdown. Take `section_id` from read_note_outline. " +
  `At most ${MCP_SECTION_CHARS} characters per call: while \`truncated\` is true, call again with \`offset\` ` +
  "set to `nextOffset`. The `fingerprint` you need to replace this section arrives with the page that " +
  "finishes it, so read to the end before you rewrite it.";

/** 被截斷時附上的解釋文案（不是防線，見檔頭）。 */
const TRUNCATED_NOTE =
  "This section is longer than one response. Keep reading with `offset` set to `nextOffset` until " +
  "`truncated` is false — the last page carries the `fingerprint` you need to replace this section.";

export const readNoteSectionInput = {
  note_id: NOTE_ID.describe("The note's id, as returned by list_notes or search_notes."),
  section_id: SEC.describe("Section id from read_note_outline. `_top` is whatever comes before the first heading."),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Where to resume, counted in characters. Use `nextOffset` from the previous call; omit it to start at the beginning."),
};

export const readNoteSectionOutput = {
  section: z.object({
    id: z.string().describe("The section id you asked for."),
    level: z.number().describe("Heading depth; `0` for the `_top` section."),
    // ⚠ `chars` 是**純文字**長度（`sectionize` 的 `textOf`），`offset`／`nextOffset` 是
    //   **markdown** 的 code unit——兩者不同單位（`# Long\n\n…` 那種段落 markdown 比 chars
    //   長好幾格）。不講明的話模型會拿 `chars` 當「讀完了沒」的判準然後早收。判準同這一棒
    //   把 `section_offset` 與 `offset` 刻意取不同名的理由。
    chars: z
      .number()
      .describe(
        "Rough size of the whole section in text characters. This is not the same unit as `offset` — " +
          "to tell whether you have read it all, look at `truncated` and `nextOffset`, not at this number."
      ),
    // ⚠ #146：**不是每一頁的第一行都是標題**。兩個反例都在本檔／`note-sections.ts` 看得到：
    //   `_top` 的 `heading` 是 `""`、`level` 是 `0`（`sectionize` 的第一個 section 就是這樣造的），
    //   它根本沒有標題行；而 `offset > 0` 的續頁是 `markdown.slice(offset)`，從半路切。
    markdown: z
      .string()
      .max(MCP_SECTION_CHARS)
      .describe(
        "This page of the section, as markdown. The first page starts with the section's heading line — except " +
          "`_top`, which has no heading; a later page resumes where the last one stopped."
      ),
    fingerprint: z
      .string()
      .optional()
      .describe("Concurrency token for editing this section. Present only once you have read to the end of it."),
  }),
  truncated: z.boolean().describe("True when this page stopped short of the end of the section."),
  nextOffset: z.number().nullable().describe("Pass this back as `offset`; `null` means you have read the whole section."),
  lastEdited: noteSummarySchema.shape.lastEdited.describe("Who last changed this note, and when."),
  note: z.string().optional().describe("Present only when `truncated` is true: how to finish reading this section."),
};

export interface ReadNoteSectionArgs {
  note_id: string;
  section_id: string;
  offset?: number;
}

export async function readNoteSection(args: ReadNoteSectionArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  const access = await authorizeNoteRead(ctx, args.note_id, args.section_id);
  if (!access.ok) return access.error;
  // D-A：這支工具只在 `collab` 與 `editing` 都在時才註冊，所以經 HTTP 到不了這裡。留著是
  // 因為 `ctx.editing` 在型別上是選配——`runTool()` 會把它轉成 `internal`，不讓例外冒到 SDK。
  // ⚠ 誠實記下：**本棒沒造這個場景**（工具刻意設計成可單獨呼叫，單元探針測得到），不是測不到。
  if (ctx.editing === undefined) throw new Error("read_note_section：editing runtime 缺席（不該被註冊）");

  const result = await readNoteContent({ db: ctx.db, collab: ctx.collab }, ctx.editing, args.note_id, args.section_id);
  if (result === "section_not_found") return toolError("section_not_found", SECTION_NOT_FOUND_MESSAGE);
  // 帶了 section 就不可能拿到整篇形；不收窄的話 spread 一個字串會靜默送出 {0:"…"}。
  if (!("section" in result)) throw new Error("readNoteContent 帶了 section 卻回整篇形");

  const { id, level, chars, markdown, fingerprint } = result.section;
  const offset = args.offset ?? 0;
  // 切片走 `truncateText`（代理對不切半）；`nextOffset` 一律 ＝ `offset ＋ 實際回傳長度`，
  // 不是 `offset + 4000`——退一格的那次若寫死 4000，下一頁會從低位代理開始，接回去少一個
  // code unit、兩頁各帶一個孤立代理（序列化不報錯）。守衛＝`mcp-content.test.ts` 的
  // 「切點落在代理對中間時 nextOffset 跟著退一格」那一案（**只有它**：全 ASCII 的案 14 在
  // 寫死 4000 之下照樣綠，突變實測過）。
  const page = truncateText(markdown.slice(offset), MCP_SECTION_CHARS);
  return toolResult({
    section: {
      id,
      level,
      chars,
      markdown: page.text,
      ...(page.truncated ? {} : { fingerprint }),
    },
    truncated: page.truncated,
    nextOffset: page.truncated ? offset + page.text.length : null,
    lastEdited: await loadLastEdited(ctx.db, args.note_id),
    ...(page.truncated ? { note: TRUNCATED_NOTE } : {}),
  });
}
