/**
 * 資料夾 PR-3d（spec §5.12）：清單類工具（list_notes／list_trash／list_folders）共用的翻頁欄位 `.describe()`。
 * 模型看得到的字串，改字前讀 memory g:model-facing-string-claims（`PAGE_CUT_SHORT_DESCRIBE` 釘在 mcp-notes.test.ts LN2）。
 */

/** 依大小截短的頁的旗標說明。 */
export const PAGE_CUT_SHORT_DESCRIBE =
  "Present, and true, when this page was cut short to keep the reply small; more follow, so keep paging with `nextCursor`.";

/** `nextCursor` 的說明。 */
export const NEXT_CURSOR_DESCRIBE = "Pass this back as `cursor` for the next page; `null` means this was the last page.";
