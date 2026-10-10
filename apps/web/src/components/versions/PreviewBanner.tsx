import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { ComparePicker } from "./ComparePicker";
import { PRESSED_CLASS } from "./version-labels";

/**
 * 頁首下方的預覽橫幅（spec §8.4【rev 10】）：「正在預覽 vN ｜（單欄時：左下拉 → 右下拉）｜ 並排／單欄 ｜ 只看差異 ｜ ✕」。Esc＝✕（掛在 NotePage，Task 10）。
 * 時間與 editors 不放（面板列已有）、沒有「比較對象」標籤；底色 `bg-brand-soft`（品牌色 tint；`--primary` 是中性近黑，不能用）。
 * 單排：容器 `flex-nowrap`、每顆鈕 `shrink-0`（目標 1400 px 視窗開面板、預覽區約 774 px 放得下；放不下會橫向溢出，不換行）。
 * 切換鈕的按下態用 `PRESSED_CLASS`（`version-labels.ts`，在主色底上再深一階）＋`aria-pressed`。
 * `narrow`：窄視窗整頁沒有並排，並排／單欄兩顆鈕不渲染；預覽區不到 `SPLIT_MIN_WIDTH`（controller 的 `previewWide` 為 false）時也不渲染。
 */
/**
 * 「只看差異」開關（橫幅與整頁共用，final M-1）。它只作用在單欄（spec §8.4）：預覽實際是並排時（controller 的 `splitActive`，
 * 由 `VersionPreview` 回報）停用。用 `aria-disabled` 而不是 `disabled`：`disabled:pointer-events-none` 會讓 `title` 浮不出來，
 * 說明就看不到了；點擊在 handler 裡擋掉。
 */
export function OnlyChangesToggle() {
  const { t } = useTranslation();
  const { onlyChanges, setOnlyChanges, splitActive } = useVersions();
  // `title` 觸控看不到、報讀器不一定念：停用時另掛一段 sr-only 說明給 aria-describedby（final fix 2 N-B）。
  const hintId = useId();
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn("h-7 shrink-0", onlyChanges && PRESSED_CLASS, splitActive && "cursor-not-allowed opacity-50")}
        aria-pressed={onlyChanges}
        aria-disabled={splitActive || undefined}
        title={splitActive ? t("versions.preview.onlyChangesSplitHint") : undefined}
        aria-describedby={splitActive ? hintId : undefined}
        onClick={() => {
          if (!splitActive) setOnlyChanges(!onlyChanges);
        }}
      >
        {t("versions.preview.onlyChanges")}
      </Button>
      {splitActive && (
        <span id={hintId} className="sr-only">
          {t("versions.preview.onlyChangesSplitHint")}
        </span>
      )}
    </>
  );
}

export function PreviewBanner({ narrow = false }: { narrow?: boolean }) {
  const { t } = useTranslation();
  const { preview, setSplitMode, previewWide, splitActive, stopPreview } = useVersions();
  if (!preview) return null;
  const toggle = (on: boolean) => cn("h-7 shrink-0", on && PRESSED_CLASS);
  return (
    <div data-testid="preview-banner" className="flex flex-nowrap items-center gap-2 border-b border-border bg-brand-soft px-5 py-2 text-xs">
      <span className="shrink-0 font-medium">{t("versions.preview.banner", { seq: preview.seq })}</span>
      {/* 比較對象（rev 10）：並排時兩個下拉是兩欄的標頭，橫幅只在單欄時放「左 → 右」。 */}
      {!splitActive && (
        <>
          <ComparePicker side="left" />
          <span aria-hidden="true" className="shrink-0 text-muted-foreground">
            →
          </span>
          <ComparePicker side="right" />
        </>
      )}
      {!narrow && previewWide && (
        <>
          {/* final §14-6：預覽區不夠寬（previewWide=false）就沒有並排，兩顆都不渲染。按下態看實際生效的版面（`splitActive`）：
              auto 時以自動選到的那顆為按下，手動選後就是選的那顆；不會兩顆都沒按下。 */}
          <Button type="button" variant="ghost" size="sm" className={toggle(splitActive)} aria-pressed={splitActive} onClick={() => setSplitMode("split")}>
            {t("versions.preview.split")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className={toggle(!splitActive)} aria-pressed={!splitActive} onClick={() => setSplitMode("single")}>
            {t("versions.preview.single")}
          </Button>
        </>
      )}
      <OnlyChangesToggle />
      <Button type="button" variant="ghost" size="icon" className="ml-auto h-7 w-7 shrink-0" aria-label={t("versions.preview.close")} onClick={stopPreview}>
        <X aria-hidden="true" className="h-4 w-4" />
      </Button>
    </div>
  );
}
