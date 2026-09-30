import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "@/lib/utils";

/**
 * 左側導覽項的共用樣式（設定 modal 的導覽與站台管理頁 `/admin/*` 的側欄導覽共用）。
 * 用 `NavLink` 而非 `Button`／`onClick` 手動 `navigate`，讓「目前在哪一區」的高亮
 * 完全交給 react-router 判斷（不用自己比對 pathname）。
 *
 * 這一層**不帶任何 `state` 語意**：要轉傳 `backgroundLocation` 的是設定 modal，由它
 * 自己包一層（見 `SettingsModal.tsx` 的 `SettingsNavLink`）；站台管理頁是一般頁面、
 * 不需要 state，直接用這個。
 */
export function NavItemLink({
  to,
  state,
  children,
}: {
  to: string;
  state?: unknown;
  children: ReactNode;
}) {
  return (
    <NavLink
      to={to}
      state={state}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          isActive
            ? "bg-accent font-medium text-accent-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        )
      }
    >
      {children}
    </NavLink>
  );
}
