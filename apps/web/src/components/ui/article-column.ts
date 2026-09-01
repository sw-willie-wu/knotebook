/**
 * 內文卡的**文章欄**：BlockNote 置中 wrapper 的寬度鏈與內距（消費端
 * `NoteEditor.tsx` 與 `PublicNotePage.tsx`——#72 起公開唯讀頁沿用同一條欄）。
 *
 * 歷史：#88 曾讓頁首（標題列）／頁尾（backlinks strip）也套這條欄做三線對齊；
 * #115 版面改版定案「頁首/頁尾回滿卡寬（置左置右）」，對齊機制連同
 * `ARTICLE_COLUMN_INSET` 一併拆除——把欄加回頁首/頁尾是刻意拆掉的行為，
 * `article-column.guard.test.ts` (d) 有反向守衛。
 */

/**
 * 文章欄的置中寬度鏈。
 *
 * 欄寬＝容器的 85%，下限 42.5rem（680px＝改版前寫死的欄寬）、上限 66rem（1056px）。
 * **下限承重、不得改成 `min()`**：中等視窗（捲動容器約 730px）的 85% 只有 620px，
 * 比舊版還窄——clamp 的下限把這一段拉回舊行為。視窗更窄時 `w-full` 讓它縮到滿版
 * （max-width 不會撐出橫向捲動）。百分比對 max-width 以父層寬度解析。
 */
export const ARTICLE_COLUMN = "mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)]";

/**
 * 置中 wrapper 自己那層左右內距。
 *
 * - `md+`：`px-4`（16px）＋ BlockNote `.bn-editor` 內建的 54px ＝ 文字左緣 70px。
 * - `<md`：`px-0`＋ index.css 的 `.bn-editor.bn-editor{padding-inline:1.25rem}`
 *   覆寫 ＝ 文字左緣 20px（與頁首/頁尾的 `px-5` 共線）。`max-md:` 實編
 *   `@media (width < 48rem)`，與 index.css 那條媒體查詢同界——兩邊必須一起動，
 *   否則 767–768px 間會出現 wrapper 已 px-0 而 54px 仍在的縫。
 */
export const ARTICLE_COLUMN_PADDING = "px-4 max-md:px-0";

/**
 * BlockNote `.bn-editor` 內建的 `padding-inline`（側選單／拖曳把手的落點）。
 *
 * 54 已無生產端消費者（#115 拆掉頁首/頁尾的 70px 推導後），留著是**升版哨兵**：
 * `<md` 的 20px 覆寫是以「原值 54」為前提設計的，BlockNote 升版改掉這個值時
 * `article-column.guard.test.ts` (c) 會紅，逼人重新評估兩個斷點的內距，而不是
 * 靜默錯開。
 */
export const BN_EDITOR_INLINE_PADDING_PX = 54;
