/**
 * 管理面板托盤（#247 §4.3）的 class：頁底色 45%＋毛玻璃，陰影只在這一層；卡本身不投影。
 * `ManagementShell`（站台管理／群組／設定）與快捷鍵介紹頁（`ShortcutsDialog`）共用，改托盤只動這裡。
 */
export const managementTray =
  "flex h-full min-h-0 w-full min-w-0 gap-2 rounded-2xl bg-background/45 p-2 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-md md:gap-3 md:p-3";
