/**
 * 內文卡的**文章欄**：頁首（標題列）、內文（BlockNote）、頁尾（backlinks strip）
 * 三者共用的置中寬度鏈與左右內縮（issue #88）。
 *
 * 改版前三者各寫各的：頁首／頁尾是滿卡寬的 `px-5`，內文是置中的 clamp 欄，於是
 * 標題貼在卡片左緣、內文往中間縮——1920 下標題左緣與內文首字差 335px（欄寬改版
 * 前是 523px）。這裡把「欄」抽成一份常數，三處都套，落差歸零。
 *
 * ## 為什麼要兩個常數
 *
 * 內文的文字左緣不是欄的左緣，中間隔了兩層內距：
 *
 *   欄左緣 ──┬── `px-4`（16px，我們自己在置中 wrapper 上加的）
 *            └── `.bn-editor { padding-inline: 54px }`（BlockNote 內建）→ 文字左緣
 *
 * BlockNote 那 54px **不能拿掉**：拖曳把手與 `+`／`⠿` 側選單就落在這條左內距裡，
 * 歸零它們會溢出到欄外，被捲動容器裁掉（捲動容器 `overflow-y-auto`，CSS 規範下
 * `overflow-x` 跟著計算成非 visible）。所以對齊的做法是反過來——頁首／頁尾自己
 * 補上同樣的 16 ＋ 54 ＝ 70px，讓三者的**文字左緣**共線。
 *
 * `article-column.guard.test.ts` 釘住「70 ＝ 16 ＋ 54」這條推導，並直接讀
 * `@blocknote/core` 的 dist CSS 確認 54 這個值還在（升版改掉就會紅——否則只會
 * 靜默地又錯開，而且沒有任何測試看得出來）。
 *
 * ## 已知殘差（捲軸）
 *
 * 頁首／頁尾在捲動容器**之外**（刻意的：它們不隨內文捲動）。內文長到出現垂直
 * 捲軸時，捲動容器的內容寬會少掉捲軸寬（本專案全域 10px），欄的置中基準因此比
 * 頁首／頁尾窄 10px，文字左緣差 5px。短筆記（沒有捲軸）完全對齊。要消掉這 5px
 * 得把捲軸移進欄內或反向補 gutter，兩者都會動到現有的捲軸視覺，不在 #88 範圍。
 */

/**
 * 文章欄的置中寬度鏈（三處共用）。
 *
 * 欄寬＝容器的 85%，下限 42.5rem（680px＝改版前寫死的欄寬）、上限 66rem（1056px）。
 * **下限承重、不得改成 `min()`**：中等視窗（捲動容器約 730px）的 85% 只有 620px，
 * 比舊版還窄——clamp 的下限把這一段拉回舊行為。視窗更窄時 `w-full` 讓它縮到滿版
 * （max-width 不會撐出橫向捲動）。百分比對 max-width 以父層寬度解析。
 */
export const ARTICLE_COLUMN = "mx-auto w-full max-w-[clamp(42.5rem,85%,66rem)]";

/** 置中 wrapper 自己那層左右內距（`NoteEditor.tsx` 的內文欄）。與下面的 inset 咬合。 */
export const ARTICLE_COLUMN_PADDING = "px-4";

/** BlockNote `.bn-editor` 內建的 `padding-inline`（側選單／拖曳把手的落點，不得歸零）。 */
export const BN_EDITOR_INLINE_PADDING_PX = 54;

/**
 * 頁首／頁尾要補的左右內縮 ＝ 16 ＋ 54 ＝ 70px，補完文字左緣才與內文共線。
 *
 * 寫成字面（而不是樣板字串）是 Tailwind scanner 的要求：class 名要能被靜態掃到。
 * 兩個加數與這個字面的一致性由 guard test 守。
 */
export const ARTICLE_COLUMN_INSET = "px-[70px]";
