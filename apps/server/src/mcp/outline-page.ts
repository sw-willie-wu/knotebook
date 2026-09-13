/**
 * #108 §8.1／§8.3：outline 的一頁。「一次最多 100 筆」這個數字在這一支落地，只有一份。
 *
 * ⚠ **`section_offset` 的單位是段落序號**，與 `read_note_section` 的 `offset`（UTF-16 code
 * unit）不同單位——所以刻意不同名（規格 §8.3，gate r4 Important 5）。
 *
 * ⚠ **預設輸出一欄指紋都不帶**（`blockIds` 永遠不帶）：「丟掉指紋」只發生在這一支，
 * `read_note_outline` 拿到的就已經是乾淨的形（M12(1)）。
 *
 * ⚠ **`withFingerprints` 是 M12 的明文例外，只有 `edit_note` 的「成功」回應傳 `true`**
 * （§8.6／D18 的 REST 對等：`docs/ai-editing.md` 逐字承諾「連續寫入不必回頭再讀」）。
 * `read_note_outline` 與 `edit_note` 的 `fingerprint_mismatch` **兩處都不得傳 `true`**
 * （案 20 逐字：錯誤回應的 outline 一個 entry 都不含指紋——你的視圖已經過期，遞一個新
 * 權杖讓你盲目重試是錯的）。**旗標預設關閉**，所以「忘記關」寫不出來，只有「刻意打開」
 * 寫得出來。
 * **兩個方向的守衛不對稱，兩條突變都實跑過（2026-09-08）**：
 * 1. 預設值改成 `true` → **三案紅**（本檔單元的 `:62` key 集合、`mcp-content.test.ts` 的
 *    案 14a、`mcp-edit-note.test.ts` 的案 20）——「多帶指紋」有三道獨立的 key 集合斷言。
 * 2. `edit_note` 的成功回應改傳 `false` → **`mcp-edit-note.test.ts` 八案一起紅，紅法是
 *    `isError`**：真正抓到它的是 `outputSchema` 裡 `outlineEntryWithFingerprintSchema` 的
 *    **非選配** `fingerprint`（SDK 的 `validateToolOutput` 把整個結果轉成錯誤），**不是**
 *    19b 那條 key 集合斷言。形狀與 PR1 `headingTruncated` 那條 `z.literal(true)` 的教訓相同
 *    ——**不要把 19b 寫成「它唯一的守衛」**。
 *
 * **交接註記（D-E）**：`edit_note` 的成功回應與 `fingerprint_mismatch` 兩側**呼叫同一支**，
 * 但把 `truncated` 放進 `outline` **物件裡**（`outline: { sections, truncated }`）
 * 並**丟掉 `nextSectionOffset`**（§8.6 明文：沒有續讀入口就別回一個沒有工具收得下的游標）。
 */
import { z } from "zod";
import { MCP_PAGE_MAX, MCP_TEXT_MAX, truncateText } from "./limits.js";

/**
 * 這一支**真正讀到的**欄位——`OutlineEntry`（`notes/editing/fingerprint.ts`，多一個
 * `blockIds`）與 `NoteOutlineEntry`（`applyEdit` 的回傳，`mergeDiff` 的 `stripIds` 已經
 * 把 `blockIds` 丟掉了）都收得下。**參數型別放寬到這個形是零行為變動**（D-I／P2）。
 */
export interface OutlinePageInput {
  sectionId: string;
  level: number;
  heading: string;
  chars: number;
  fingerprint: string;
}

export interface OutlineEntryForModel {
  sectionId: string;
  level: number;
  heading: string;
  /**
   * 只在真的被截斷時才有這把 key，值恆為 `true`。**守衛分兩層，兩條突變都實跑過**：
   * 1. 寫成 `headingTruncated: false` → MCP 那條路上抓到它的是 `outputSchema` 的
   *    `z.literal(true)`（SDK 的 `validateToolOutput` 把整個結果轉成 `isError`，
   *    `mcp-content.test.ts` 十條一起紅），**不是** wire 上的 key 集合斷言。
   * 2. 寫成 `headingTruncated: undefined` → **`mcp-content.test.ts` 一條都不紅**
   *    （`JSON.stringify` 丟掉 undefined 欄位，wire 上與「沒有這把 key」逐位元組相同）；
   *    抓到它的是 `test/unit/mcp-outline-page.test.ts` 的 key 集合斷言——它直接對
   *    `buildOutlinePage` 的回傳**物件**斷言，`Object.keys` 看得到值為 undefined 的 key。
   * ⚠ **這一點與 `dto.ts` 的 `titleTruncated` 不同**：那一支沒有單元層的呼叫端，
   *    `undefined` 在那裡是真的沒有守衛。
   */
  headingTruncated?: true;
  chars: number;
  /** 只在 `withFingerprints: true` 時才有這把 key（M12 的明文例外，見檔頭）。 */
  fingerprint?: string;
}

/** `outputSchema` 用的 zod 形；欄位順序與 {@link OutlineEntryForModel} 一致。 */
export const outlineEntrySchema = z.object({
  sectionId: z.string().describe("Pass this to read_note_section. `_top` is the text before the first heading."),
  level: z.number().describe("Heading depth; `0` for the `_top` section."),
  heading: z.string().max(MCP_TEXT_MAX).describe("The section's heading text, cut at 200 characters."),
  headingTruncated: z.literal(true).optional().describe("Present only when `heading` was cut."),
  chars: z.number().describe("Characters in this section — the full length, not the cut heading."),
});

/** `edit_note` 的**成功**回應專用（M12 的明文例外）：同一份 entry 形 ＋ 逐段指紋。
 *  用 `.extend()` 而不是另寫一份——四個共同欄位的上限與說明只能有一個定義。 */
export const outlineEntryWithFingerprintSchema = outlineEntrySchema.extend({
  fingerprint: z
    .string()
    .describe("Concurrency token for this section. Pass it as `if_match` to replace or delete this section."),
});

export interface OutlinePage {
  sections: OutlineEntryForModel[];
  truncated: boolean;
  nextSectionOffset: number | null;
}

/**
 * `sectionOffset` 大於（或等於）總段數不是錯誤——回空陣列 ＋ `truncated: false` ＋
 * `nextSectionOffset: null`（§8.3）。**邊界是 `>` 不是 `>=`**：恰好 100 段時再發一頁
 * 是空的，回 `truncated: true` 等於叫模型多打一發。
 */
export function buildOutlinePage(
  entries: readonly OutlinePageInput[],
  sectionOffset: number,
  opts: { withFingerprints?: boolean } = {}
): OutlinePage {
  const slice = entries.slice(sectionOffset, sectionOffset + MCP_PAGE_MAX);
  const truncated = entries.length > sectionOffset + slice.length;
  return {
    sections: slice.map(entry => {
      const heading = truncateText(entry.heading);
      return {
        sectionId: entry.sectionId,
        level: entry.level,
        heading: heading.text,
        ...(heading.truncated ? { headingTruncated: true as const } : {}),
        chars: entry.chars,
        ...(opts.withFingerprints ? { fingerprint: entry.fingerprint } : {}),
      };
    }),
    truncated,
    nextSectionOffset: truncated ? sectionOffset + slice.length : null,
  };
}
