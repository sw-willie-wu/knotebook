/**
 * 側欄底部帳號列與內文卡 backlinks 列的**共用列高**。
 *
 * 兩者都貼在各自卡片的底緣、隔著卡間 `gap-3` 左右相鄰，高度不一致一眼就看得
 * 出來。兩邊各自算高度（帳號列＝觸發鈕的 `p-1.5` ＋ 24px avatar；backlinks 列
 * ＝文字與 chips 的自然高度）會在任一邊調 padding 時默默錯開，所以列高在這裡
 * 定死一份，兩邊都套這個常數：
 *
 * - 側欄帳號列：`UserMenu.tsx` 的觸發鈕
 * - 內文卡 backlinks 列：`BacklinksSection.tsx` 的內層 flex 列
 *
 * 兩個容器的垂直內距（皆為 `p-2`／`py-2`）與上緣 `border-t` 也必須維持一致，
 * 這條常數只管內容列本身。`rows.equal-height.test.ts` 釘住兩邊都有套用；內距
 * 那一半由各元件自己的 class 斷言守（見該檔的「守不到的」段落）。
 */
export const SIDEBAR_ROW_HEIGHT = "h-9";

/**
 * backlinks 那條 strip 的 chips 容器專用幾何（列高 36px ＋ 捲軸 6px）。
 *
 * 三個值互相咬合，**改一個要重算其餘**：
 *   `h-[42px]`        容器實高 ＝ `SIDEBAR_ROW_HEIGHT`(36) ＋ 捲軸 6
 *   `-mb-1.5`         −6px，把 margin box 拉回 36 ＝ 列高，所以不撐高那一列；
 *                     捲軸因此落在列的下緣之外、footer `py-2` 的留白裡
 *   `scrollbar-x-thin` index.css 的自訂 class：這條 strip 專用的 6px 捲軸
 *                     （全域是 10px）＋1px thumb border。**不能改用 Tailwind 的
 *                     arbitrary variant 寫法**（把偽元素寫進 class 名那種）——
 *                     那會落進 `@layer utilities`，輸給 index.css 的頂層規則，
 *                     實測捲軸仍是 10px。（也因此這裡不把那個 class 名寫成字面：
 *                     Tailwind 的 scanner 不解析註解、照樣會為它產出死 CSS。）
 *
 * 放在這裡而不是元件裡，是為了讓「42 ＝ 36 ＋ 6」這個關係與 `SIDEBAR_ROW_HEIGHT`
 * 並列在同一個檔案：改列高就會看到要一起改這裡。實測效果與取捨見
 * `BacklinksSection.tsx` 的區塊註解。
 */
export const BACKLINKS_SCROLL_ROW = "h-[42px] -mb-1.5 scrollbar-x-thin";
