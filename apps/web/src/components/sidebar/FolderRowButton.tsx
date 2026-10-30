import { ChevronRight, Folder } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * 資料夾列的折疊主鈕（資料夾 spec §6.3）：`aria-expanded`、前導 chevron（展開旋轉 90°）＋`Folder` 圖示（皆 aria-hidden）＋名稱
 * （truncate、title＝名稱）。可及名稱只有資料夾名（§6.14）。外層列要帶 `group/folderrow`；高度跟外層列（h-11 md:h-7）。
 * NoteList 與選取樹共用（同 `GroupRowButton`）。
 */
export function FolderRowButton({ name, open, onToggle }: { name: string; open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-left text-[13px] font-medium text-foreground group-hover/folderrow:text-brand-on-soft"
    >
      <ChevronRight
        aria-hidden="true"
        className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover/folderrow:text-brand-on-soft", open && "rotate-90")}
      />
      <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/folderrow:text-brand-on-soft" />
      <span className="truncate" title={name}>
        {name}
      </span>
    </button>
  );
}
