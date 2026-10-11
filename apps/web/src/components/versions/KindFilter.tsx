import { useTranslation } from "react-i18next";
import type { VersionKindFilter } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { PRESSED_CLASS } from "./version-labels";

const OPTIONS: Array<{ value: VersionKindFilter; labelKey: string }> = [
  { value: "all", labelKey: "versions.filter.all" },
  { value: "manual", labelKey: "versions.filter.manual" },
];

/**
 * 清單篩選（#258）：「全部／僅手動」兩段切換，放在「目前狀態」下方、清單上方（面板與窄視窗整頁共用）。
 * 狀態在 `useVersions().kindFilter`（controller 持有、換筆記不重設、記在 localStorage）；
 * 只影響清單與比較下拉的選項，不影響目前的預覽／比較對象。按下態沿用橫幅的 `PRESSED_CLASS` ＋ `aria-pressed`。
 */
export function KindFilter({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { kindFilter, setKindFilter } = useVersions();
  return (
    <div role="group" aria-label={t("versions.filter.label")} data-testid="versions-filter" className={cn("flex gap-1", className)}>
      {OPTIONS.map(({ value, labelKey }) => (
        <Button
          key={value}
          type="button"
          variant="ghost"
          size="sm"
          aria-pressed={kindFilter === value}
          className={cn("h-7", kindFilter === value && PRESSED_CLASS)}
          onClick={() => setKindFilter(value)}
        >
          {t(labelKey)}
        </Button>
      ))}
    </div>
  );
}

/** 篩選後清單為空時的一行灰字（只在查詢成功、確實沒有符合的版本時顯示；載入中不顯示）。 */
export function KindFilterEmpty() {
  const { t } = useTranslation();
  return (
    <li data-testid="versions-filter-empty" className="px-2 py-1.5 text-xs text-muted-foreground">
      {t("versions.filter.emptyManual")}
    </li>
  );
}
