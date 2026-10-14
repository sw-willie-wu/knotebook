import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

/**
 * #269 §5.2：舊分頁閘門擋下的分頁（collab 的 `outdated` phase）——頁首上方提示重整。內容照樣可讀、不 toast、不導頁。
 * `onReload` 只為可測（jsdom 的 `location.reload` 不可替換）；生產不傳＝`window.location.reload()`。
 */
export function OutdatedClientBanner({ onReload }: { onReload?: () => void }) {
  const { t } = useTranslation();
  return (
    <div role="alert" className="flex items-center gap-3 border-b border-border bg-muted px-5 py-2 text-sm">
      <p className="min-w-0 flex-1">{t("note.outdated.message")}</p>
      <Button type="button" size="sm" variant="outline" className="shrink-0" onClick={onReload ?? (() => window.location.reload())}>
        {t("note.outdated.reload")}
      </Button>
    </div>
  );
}
