import { useId } from "react";
import { useTranslation } from "react-i18next";
import { NOTE_WIDTHS } from "@knotebook/shared";
import { toNoteWidth, useNoteWidth } from "@/components/note-width";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, NoteWidthIcon } from "@/components/ui/icons";

/** 列樣式照 `DropdownMenuCheckboxItem`（RadioItem 是不帶樣式的最小包裝）。 */
const ROW =
  "relative flex cursor-default select-none items-center rounded-sm py-1.5 pl-8 pr-2 text-sm outline-none " +
  "transition-colors focus:bg-accent focus:text-accent-foreground";

/**
 * #297 §4.3：頁首寬度 icon＋三選一選單（站內、每篇各自記，見 `note-width.ts`）。
 * 頁首 content box 寬 ≥ 43.5rem 才顯示（header 是 `@container`）：更窄時「寬」與「標準」一樣寬。
 */
export function NoteWidthMenu({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useNoteWidth(noteId);
  const labelId = useId();
  // 名稱帶現值（不同於 Share 的固定 aria-label）；title 同字。
  const name = t("note.width.current", { name: t(`note.width.${width}`) });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={name}
          title={name}
          className="hidden shrink-0 text-brand hover:text-brand @min-[43.5rem]:inline-flex"
        >
          <NoteWidthIcon width={width} className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel id={labelId}>{t("note.width.label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={width} onValueChange={(v) => setWidth(toNoteWidth(v))} aria-labelledby={labelId}>
          {NOTE_WIDTHS.map((w) => (
            <DropdownMenuRadioItem key={w} value={w} className={ROW}>
              <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
                <DropdownMenuItemIndicator>
                  <Check className="h-4 w-4" />
                </DropdownMenuItemIndicator>
              </span>
              {t(`note.width.${w}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
