import { useId } from "react";
import { useTranslation } from "react-i18next";
import { useVersionList } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { PRESSED_CLASS, editorsText, formatVersionTime } from "./version-labels";

/**
 * 頁首下方的預覽橫幅（spec §8.4）：「正在預覽 vN · 時間 · editors ｜ 比較對象 ｜ 並排／單欄 ｜ 只看差異 ｜ ✕」。Esc＝✕（掛在 NotePage，Task 10）。
 * 切換鈕的按下態用 `PRESSED_CLASS`（`version-labels.ts`）＋`aria-pressed`（預檢 P11：橫幅本身是 `bg-accent`，按下態若也用 accent 就看不出來）。
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
        className={cn("h-7", onlyChanges && PRESSED_CLASS, splitActive && "cursor-not-allowed opacity-50")}
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
  const { t, i18n } = useTranslation();
  const { noteId, preview, compareTo, setCompareTo, setSplitMode, previewWide, splitActive, stopPreview } = useVersions();
  const list = useVersionList(noteId ?? "", preview !== null);
  if (!preview) return null;
  const rows = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const row = rows.find((r) => r.seq === preview.seq);
  const hasOlder = rows.some((r) => r.seq < preview.seq) || list.hasNextPage;
  const toggle = (on: boolean) => cn("h-7", on && PRESSED_CLASS);
  return (
    <div data-testid="preview-banner" className="flex flex-wrap items-center gap-2 border-b border-border bg-accent px-5 py-2 text-xs">
      <span className="min-w-0 truncate font-medium">
        {t("versions.preview.banner", {
          seq: preview.seq,
          when: row ? formatVersionTime(row.createdAt, i18n.language) : "",
          who: row ? editorsText(t, row.editors) : "",
        })}
      </span>
      <span className="text-muted-foreground">{t("versions.preview.compareLabel")}</span>
      <Button type="button" variant="ghost" size="sm" className={toggle(compareTo === "previous")} aria-pressed={compareTo === "previous"} onClick={() => setCompareTo("previous")}>
        {t("versions.preview.comparePrevious")}
      </Button>
      <Button type="button" variant="ghost" size="sm" className={toggle(compareTo === "current")} aria-pressed={compareTo === "current"} onClick={() => setCompareTo("current")}>
        {t("versions.preview.compareCurrent")}
      </Button>
      {compareTo === "previous" && !hasOlder && list.isSuccess && <span>{t("versions.preview.vsEmpty")}</span>}
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
      <Button type="button" variant="ghost" size="icon" className="ml-auto h-7 w-7" aria-label={t("versions.preview.close")} onClick={stopPreview}>
        <X aria-hidden="true" className="h-4 w-4" />
      </Button>
    </div>
  );
}
