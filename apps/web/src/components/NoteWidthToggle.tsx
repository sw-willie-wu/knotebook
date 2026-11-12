import { useTranslation } from "react-i18next";
import { NOTE_WIDTHS } from "@knotebook/shared";
import { useNoteWidth } from "@/components/note-width";
import { Button } from "@/components/ui/button";
import { NoteWidthIcon } from "@/components/ui/icons";

/**
 * #297：頁首寬度鈕（站內、每篇各自記，見 `note-width.ts`）。按一下換成下一種寬度：
 * 標準 → 寬 → 全寬 → 標準。名稱與 title 寫出目前與下一種。
 * 頁首 content box 寬 ≥ 43.5rem 才顯示（header 是 `@container`）：更窄時「寬」與「標準」一樣寬；
 * 收起時改由頁首 ⋮ 選單設定。
 */
export function NoteWidthToggle({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const [width, setWidth] = useNoteWidth(noteId);
  const next = NOTE_WIDTHS[(NOTE_WIDTHS.indexOf(width) + 1) % NOTE_WIDTHS.length]!;
  // 名稱帶現值與下一種（不同於 Share 的固定 aria-label）；title 同字。
  const name = t("note.width.cycle", { name: t(`note.width.${width}`), next: t(`note.width.${next}`) });
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={name}
      title={name}
      onClick={() => setWidth(next)}
      className="hidden shrink-0 text-brand hover:text-brand @min-[43.5rem]:inline-flex"
    >
      <NoteWidthIcon width={width} className="h-4 w-4" />
    </Button>
  );
}
