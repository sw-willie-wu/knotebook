import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCopyNote } from "@/api/note-move";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/** ApiFail → errors.<code>；其餘 → errors.fallback（逐檔各寫一份是 repo 慣例，見 ShareDialog.tsx）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 群組版分享面板的「複製到我的筆記」（#175 PR2，spec §8.4）。看得到群組筆記就能讀（主檔規格落差 16），
 * 所以呼叫端一律渲染、不看 `permissions.read`。不另設確認步驟：群組→個人的複製不改動原筆記、不清任何東西
 * （規格落差 13）。成功 toast 附「前往副本」、再呼叫 `onDone`（分享面板傳 `onClose`：關掉模態，鍵盤才摸得到 toast 的
 * 動作鈕）；失敗 destructive toast。
 * ⋮ 選單的同名項（`NoteMenu`）不共用此元件，只共用 `useCopyNote` 與 i18n 鍵。
 */
export function CopyToPersonalButton({ note, onDone }: { note: NoteDto; onDone?: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const copy = useCopyNote(note.id);
  /** 在 handler 開頭同步舉起的送出旗標。光靠 `copy.isPending` 不夠：它在 mutation 開始時就變了，但通知元件重繪要等
   * react-query 的批次（setTimeout 0），那之前若沒有別的重繪，鈕還是可按的。實測：拿掉這個 state（連同
   * `setSubmitting(true)` 引起的那次重繪），ShareDialog.test「群組版『複製到我的筆記』掛著時再按」送出兩次（3/3）。
   * 承重的是「按下當下同步觸發一次重繪」：state 留著、只把 `disabled` 改成只看 `isPending` 不會紅——那次重繪會順帶
   * 讀到已是 pending 的 `isPending`（`useMutation` 的 snapshot 是 `getCurrentResult()`）；`disabled` 裡的
   * `submitting` 是同一件事的保險。複製在 server 交易裡做檔案 I/O、可能很慢，再按一次就是第二份副本。 */
  const [submitting, setSubmitting] = useState(false);

  async function handleCopy(): Promise<void> {
    setSubmitting(true);
    try {
      const created = await copy.mutateAsync(undefined);
      toast({
        title: t("share.move.copiedToPersonal"),
        action: {
          label: t("share.move.openCopy"),
          altText: t("share.move.openCopyAlt"),
          onClick: () => void navigate(canonicalNotePath(created)),
        },
      });
      onDone?.();
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={submitting || copy.isPending}
        onClick={() => void handleCopy()}
      >
        {t("note.menu.copyToPersonal")}
      </Button>
    </div>
  );
}
