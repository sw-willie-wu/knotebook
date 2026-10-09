import { useTranslation } from "react-i18next";
import { useVersionList } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { X } from "@/components/ui/icons";
import { useVersions } from "@/lib/versions-context";
import { cn } from "@/lib/utils";
import { editorsText, formatVersionTime } from "./version-labels";

/**
 * 頁首下方的預覽橫幅（spec §8.4）：「正在預覽 vN · 時間 · editors ｜ 比較對象 ｜ 並排／單欄 ｜ 只看差異 ｜ ✕」。Esc＝✕（掛在 NotePage，Task 10）。
 * 切換鈕的按下態用 `bg-primary/15`＋`aria-pressed`（預檢 P11：橫幅本身是 `bg-accent`，按下態若也用 accent 就看不出來）。
 * `narrow`：窄視窗整頁沒有並排，並排／單欄兩顆鈕不渲染。
 */
export function PreviewBanner({ narrow = false }: { narrow?: boolean }) {
  const { t, i18n } = useTranslation();
  const { noteId, preview, compareTo, setCompareTo, splitMode, setSplitMode, onlyChanges, setOnlyChanges, stopPreview } = useVersions();
  const list = useVersionList(noteId ?? "", preview !== null);
  if (!preview) return null;
  const rows = list.data?.pages.flatMap((p) => p.versions) ?? [];
  const row = rows.find((r) => r.seq === preview.seq);
  const hasOlder = rows.some((r) => r.seq < preview.seq) || list.hasNextPage;
  const toggle = (on: boolean) => cn("h-7", on && "bg-primary/15");
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
      {!narrow && (
        <>
          <Button type="button" variant="ghost" size="sm" className={toggle(splitMode === "split")} aria-pressed={splitMode === "split"} onClick={() => setSplitMode("split")}>
            {t("versions.preview.split")}
          </Button>
          <Button type="button" variant="ghost" size="sm" className={toggle(splitMode === "single")} aria-pressed={splitMode === "single"} onClick={() => setSplitMode("single")}>
            {t("versions.preview.single")}
          </Button>
        </>
      )}
      <Button type="button" variant="ghost" size="sm" className={toggle(onlyChanges)} aria-pressed={onlyChanges} onClick={() => setOnlyChanges(!onlyChanges)}>
        {t("versions.preview.onlyChanges")}
      </Button>
      <Button type="button" variant="ghost" size="icon" className="ml-auto h-7 w-7" aria-label={t("versions.preview.close")} onClick={stopPreview}>
        <X aria-hidden="true" className="h-4 w-4" />
      </Button>
    </div>
  );
}
