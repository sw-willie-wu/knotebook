/**
 * #108：**兩支寫入工具共用**的模型面字串。
 *
 * 為什麼不各寫一份：`edit_note` 與 `create_note` 走的是同一條解析管線（`parseMarkdownForNote`）
 * 與同一顆 `edit` 桶，同一個碼在兩支工具上是同一件事。抄兩份的漂移（有人只改了其中一支的
 * 措辭）**不會有任何測試變紅**——這正是這個 repo 反覆抓到的形。
 *
 * 模型看得到的字串一律英文（同 `docs/`；不是 UI 文案，不走 i18n）。
 */
import type { ParseError } from "../notes/editing/markdown.js";

/** `edit` 桶（`docs/ai-editing.md` 的 Writes 那一列）擋下來時模型看到的字。 */
export const WRITE_RATE_LIMITED_MESSAGE = "Too many note writes right now. Wait a moment before writing again.";

/**
 * 解析／套用失敗的逐碼說明。`empty_section` 只有 `edit_note` 產得出來（`create_note` 的失敗
 * 形只有 {@link ParseError} 三個），但它與另外三個是同一張表，分開就會變成兩份。
 */
export function writeFailureMessage(code: ParseError | "empty_section"): string {
  switch (code) {
    case "unsupported_block":
      return "That markdown contains something this editor cannot store. Plain markdown — headings, text, lists, code, tables — works.";
    case "empty_content":
      return "That markdown is empty once parsed. Send at least one non-blank block.";
    case "too_many_blocks":
      return "That markdown is too many blocks for one note. Split it up.";
    case "empty_section":
      return "That would leave the section empty. Use delete_section if you meant to remove it.";
  }
}
