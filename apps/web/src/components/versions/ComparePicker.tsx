import { useTranslation } from "react-i18next";
import { useVersionList } from "@/api/versions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Check, ChevronDown } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { TINT_HOVER_CLASS, versionLabel } from "./version-labels";

const CURRENT = "current";

/**
 * 比較對象的一邊（spec §8.4【rev 10】）：左＝預覽的那一版（`preview`，選了＝`startPreview`，與面板點列同義）、
 * 右＝`compareRight`（預設「目前狀態」，選了＝`setCompareRight`）。diff 方向固定左→右，選到左新右舊就是反向 diff、不自動換邊。
 * 選項：左＝已載入清單的所有版本；右＝「目前狀態」＋所有版本。清單還有下一頁時底部一項「載入更早的版本」：
 * `preventDefault` 讓選單不關、接 `fetchNextPage`；失敗不自動重抓（使用者可再按）。
 * 擺放：並排時是兩欄的標頭；單欄（橫幅）與窄視窗整頁（頁首列 2）時成對放，中間一個 `→`。
 */
export function ComparePicker({ side }: { side: "left" | "right" }) {
  const { t } = useTranslation();
  const { noteId, preview, compareRight, startPreview, setCompareRight } = useVersions();
  const list = useVersionList(noteId ?? "", preview !== null);
  const rows = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const target = side === "left" ? preview : compareRight;
  const value = target === CURRENT ? CURRENT : (target?.id ?? "");
  // 觸發鈕只顯示 `vN`／「目前狀態」（總管裁定 C1：名稱只在下拉項裡，免得長名稱把橫幅撐出單排）。
  const label = target === CURRENT ? t("versions.preview.currentOption") : target ? `v${target.seq}` : "";

  const choose = (next: string) => {
    // 重選已勾的那一項＝什麼都不做（不重新取樣「目前狀態」、不重建預覽；review N-3）。
    if (next === value) return;
    if (next === CURRENT) {
      setCompareRight(CURRENT);
      return;
    }
    const row = rows.find((r) => r.id === next);
    if (!row) return;
    const picked = { seq: row.seq, id: row.id };
    if (side === "left") startPreview(picked);
    else setCompareRight(picked);
  };

  const itemClass =
    "relative flex items-center rounded-sm py-1.5 pl-8 pr-2 text-sm transition-colors focus:bg-accent focus:text-accent-foreground data-[highlighted]:bg-accent";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`h-7 min-w-0 shrink-0 gap-1 ${TINT_HOVER_CLASS}`}
          aria-label={t(side === "left" ? "versions.preview.leftPicker" : "versions.preview.rightPicker")}
        >
          <span>{label}</span>
          <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 opacity-70" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[min(20rem,var(--radix-dropdown-menu-content-available-height))] max-w-72 overflow-y-auto">
        <DropdownMenuRadioGroup value={value} onValueChange={choose}>
          {side === "right" && (
            <DropdownMenuRadioItem value={CURRENT} className={itemClass}>
              <ItemCheck />
              {t("versions.preview.currentOption")}
            </DropdownMenuRadioItem>
          )}
          {rows.map((row) => (
            <DropdownMenuRadioItem key={row.id} value={row.id} className={itemClass}>
              <ItemCheck />
              <span className="truncate">{versionLabel(row)}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {list.hasNextPage && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={list.isFetchingNextPage}
              onSelect={(event) => {
                event.preventDefault();
                void list.fetchNextPage();
              }}
            >
              {t("versions.loadMore")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ItemCheck() {
  return (
    <span className="absolute left-2 flex h-3.5 w-3.5 items-center justify-center">
      <DropdownMenuItemIndicator>
        <Check aria-hidden="true" className="h-4 w-4" />
      </DropdownMenuItemIndicator>
    </span>
  );
}
