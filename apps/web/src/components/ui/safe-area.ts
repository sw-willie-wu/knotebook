/**
 * 頁面邊緣的 safe area（瀏海、圓角、Home 指示條；橫拿時的側邊）單一出處。
 * `index.html` 設了 `viewport-fit=cover`，內容會延伸到那些區域，所以貼邊的版面要用
 * `env(safe-area-inset-*)` 退開；沒有 inset 的裝置（桌機、多數 Android）`env()` 是 0，
 * `max(基本邊距, inset)` 即基本邊距，畫面不變。
 *
 * 四邊分開寫（不用簡寫）：Tailwind 的 arbitrary value 只能對應單一屬性；class 字面要完整出現在原始碼，
 * 所以是常數字串而不是組字。
 */

/** AppShell 外框：基本 12 px。 */
export const SAFE_FRAME_PADDING =
  "pt-[max(0.75rem,env(safe-area-inset-top))] pr-[max(0.75rem,env(safe-area-inset-right))] pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))]";

/** 登入等全頁卡片的頁面內距：基本 32 px。 */
export const SAFE_PAGE_PADDING =
  "pt-[max(2rem,env(safe-area-inset-top))] pr-[max(2rem,env(safe-area-inset-right))] pb-[max(2rem,env(safe-area-inset-bottom))] pl-[max(2rem,env(safe-area-inset-left))]";

/** 錯誤頁等較緊的全頁內距：基本 24 px。 */
export const SAFE_PAGE_PADDING_COMPACT =
  "pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1.5rem,env(safe-area-inset-right))] pb-[max(1.5rem,env(safe-area-inset-bottom))] pl-[max(1.5rem,env(safe-area-inset-left))]";

/** 自己有底色、本身沒有基本邊距的整頁容器：直接退開四邊。 */
export const SAFE_INSETS =
  "pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]";
