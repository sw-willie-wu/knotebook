import { Folder } from "@/components/ui/icons";
import { cn } from "@/lib/utils";
import { DROP_SCOPE_CLASS } from "./useSidebarDrag";

/**
 * 疊資料夾預覽（資料夾 spec §6.13 疊資料夾第 2、5 步）：原地取代 B 列，一個展開的資料夾列＋兩個子列（B、A 的淡色虛線佔位）。
 * 整塊是落點（`data-node-kind="preview"`，readDragTarget 先認它；內層不得有 data-node-kind），套落點範圍提示。
 * creating（放開後的「建立中」）：aria-busy、降低不透明度、不再是落點；不加任何字串（總管裁定 2026-10-30 Q5）。首包模組。
 */
export function StackPreview({
  name,
  anchorTitle,
  sourceTitle,
  creating,
  variant,
}: {
  name: string;
  anchorTitle: string;
  sourceTitle: string;
  creating: boolean;
  variant: "plain" | "group";
}) {
  return (
    <li
      data-node-kind="preview"
      data-drop-scope={creating ? undefined : ""}
      aria-busy={creating ? "true" : undefined}
      className={cn("flex flex-col gap-0.5 rounded-md", creating ? "opacity-60" : DROP_SCOPE_CLASS)}
    >
      <div className={cn("flex h-11 items-center gap-1.5 pr-2 text-[13px] font-medium md:h-7", variant === "group" ? "pl-3" : "pl-2")}>
        <Folder aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{name}</span>
      </div>
      <div className="ml-[15px] border-l border-muted-foreground/35 pl-2">
        <ul className="space-y-0.5">
          <li className="flex h-11 items-center pr-2 pl-3 text-[13px] md:h-7">
            <span className="truncate">{anchorTitle}</span>
          </li>
          <li className="flex h-11 items-center rounded-md border border-dashed border-muted-foreground/50 pr-2 pl-3 text-[13px] text-muted-foreground md:h-7">
            <span className="truncate">{sourceTitle}</span>
          </li>
        </ul>
      </div>
    </li>
  );
}
