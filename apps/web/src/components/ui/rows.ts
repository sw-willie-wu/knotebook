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
 * 這條常數只管內容列本身。`rows.equal-height.test.tsx` 釘住兩邊都有套用。
 */
export const SIDEBAR_ROW_HEIGHT = "h-9";
