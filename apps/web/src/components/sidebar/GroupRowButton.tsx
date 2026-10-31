import { ChevronRight, Users } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * 群組 tab 群組列的折疊主鈕（`aria-expanded`、前導槽 Users／chevron、名稱 truncate）。NoteList 與選取樹共用，外觀逐字同 PR-1。
 * 前導圖示槽平常是 `Users`，列 hover／列內有 `:focus-visible`（鍵盤焦點；滑鼠點完留下的焦點不算）時換成 chevron；觸控裝置
 * （`hover: none`）一律 chevron。兩個圖示都 `aria-hidden`，button 的名稱只有群組名。外層列要帶 `group/grouprow`。
 */
export function GroupRowButton({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-foreground group-hover/grouprow:text-brand-on-soft"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted-foreground group-hover/grouprow:text-brand-on-soft">
        <Users
          aria-hidden="true"
          className="h-3.5 w-3.5 group-hover/grouprow:hidden group-has-[:focus-visible]/grouprow:hidden [@media(hover:none)]:hidden"
        />
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "hidden h-3 w-3 transition-transform group-hover/grouprow:block group-has-[:focus-visible]/grouprow:block [@media(hover:none)]:block",
            open && "rotate-90",
          )}
        />
      </span>
      <span className="truncate">{name}</span>
    </button>
  );
}
