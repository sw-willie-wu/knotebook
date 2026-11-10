import { cn } from "@/lib/utils";

/**
 * 管理面板托盤（#247）的 class：頁底色 45%＋毛玻璃，陰影只在這一層；卡本身不投影。
 * `ManagementShell`（站台管理／群組／設定）與快捷鍵介紹頁（`ShortcutsDialog`）共用，改托盤只動這裡。
 */
export const managementTray =
  "flex h-full min-h-0 w-full min-w-0 gap-2 rounded-2xl bg-background/45 p-2 shadow-[0_20px_60px_rgba(0,0,0,.35)] backdrop-blur-md md:gap-3 md:p-3";

/**
 * 左欄項次的 class（`ManagementShell` 的 `ManagementNavItem` 與快捷鍵介紹頁的分類鈕共用——兩者是同一種視覺語彙，
 * 差別只在一個是 NavLink、一個是 state 驅動的按鈕）。`active`＝目前所在項次。
 */
export function managementNavItemClass(active: boolean): string {
  return cn(
    "flex h-9 items-center gap-2 rounded-lg px-3 text-sm transition-colors " +
      "hover:bg-brand-soft hover:text-brand-on-soft active:bg-brand-soft-strong",
    active && "bg-brand-soft font-medium text-brand-on-soft hover:bg-brand-soft-strong",
  );
}
