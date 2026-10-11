import type { ReactNode } from "react";
import { NavLink } from "react-router";
import { cn } from "@/lib/utils";

/**
 * 左側導覽項的共用樣式——**只剩站台管理頁 `/admin/*`（`pages/AdminPage.tsx`）在用**；設定 modal
 * 自 #247 起改用 `components/management/ManagementShell` 的 `ManagementNavItem`。#247 Part 3 把站台
 * 管理改成 modal 後本檔刪除。
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
