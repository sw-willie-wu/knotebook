import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";

/**
 * 一次性連結的「只顯示這一次」畫面（#286；之後的邀請連結共用）。放在呼叫端的 `DialogContent` 內。
 * 形狀比照 `ApiTokensSection` 的明文畫面：唯讀欄永遠可選取複製，不靠 toast；**刻意不複用 ManualCopyField**
 * （它硬寫的說明語意不對，且內含自己的 DialogDescription，同一個 DialogContent 會出現兩個）。
 */
export function OneTimeLinkResult({ title, url, expiresAt }: { title: string; url: string; expiresAt: string }) {
  const { t, i18n } = useTranslation();
  const when = new Date(expiresAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("admin.oneTimeLink.onceWarning", { when })}</DialogDescription>
      </DialogHeader>
      <Input
        readOnly
        value={url}
        aria-label={t("admin.oneTimeLink.linkLabel")}
        className="font-mono"
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
      />
      <DialogFooter>
        <Button
          type="button"
          // ⚠ 不用 `secondary`：淺色下與面板底幾乎同色，看起來像 hover 高亮不像按鈕（同 ApiTokensSection）。
          variant="outline"
          onClick={() => {
            void copyText(url).then((ok) => {
              toast(
                ok
                  ? { title: t("admin.oneTimeLink.copied") }
                  : { title: t("admin.oneTimeLink.copyFailed"), variant: "destructive" },
              );
            });
          }}
        >
          {t("admin.oneTimeLink.copy")}
        </Button>
        <DialogClose asChild>
          <Button type="button" variant="brandDeep">
            {t("admin.oneTimeLink.done")}
          </Button>
        </DialogClose>
      </DialogFooter>
    </>
  );
}
