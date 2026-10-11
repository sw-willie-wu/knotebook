import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 權限 pill（#247：個人設定的群組總覽、token 權限、Part 3 的群組角色）。**只列有的**，沒有的不顯示、不打叉。
 * `destructive`＝不可逆後果的權限（token 的「搬移」，§5.3）。`data-pill` 是測試取 pill 的握把。
 */
export function Pill({ tone = "default", children }: { tone?: "default" | "destructive"; children: ReactNode }) {
  return (
    <span
      data-pill=""
      className={cn(
        "inline-flex items-center rounded-full border px-2 py-0.5 text-xs leading-4",
        tone === "destructive" ? "border-transparent bg-destructive/10 text-destructive" : "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}
