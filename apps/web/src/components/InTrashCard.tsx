import { useTranslation } from "react-i18next";
import { useRestoreTrash } from "@/api/trash";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { RotateCcw } from "@/components/ui/icons-extra";
import { toast } from "@/components/ui/toast";
import { toastTrashFailure } from "@/components/sidebar/trash-dialogs";
import { useSidebarTabActions } from "@/lib/sidebar-tab";
import { trashResultMessage } from "@/lib/trash-display";

/**
 * 筆記頁解析層拿到 404 `in_trash` 時的卡片：只有有垃圾桶權的人會拿到 in_trash。
 * 必須渲染在 AppShell 的 children 內（用 actions context 的 showTab）。
 * - 還原成功 → `onRestored()`（呼叫端重抓解析層，畫面換成筆記即回饋，不另 toast）。
 * - 全略過（已被別人還原、或已永久刪除）→ toast 結果句＋`onRestored()`：重抓後落到筆記或連結無效出口。
 * - 失敗 → toast `errors.<code>`，卡片留著可再按。
 */
export function InTrashCard({ noteId, onRestored }: { noteId: string; onRestored: () => void }) {
  const { t } = useTranslation();
  const { showTab } = useSidebarTabActions();
  const restore = useRestoreTrash();

  const handleRestore = async () => {
    try {
      const result = await restore.mutateAsync([noteId]);
      if (!result.restored.some((note) => note.id === noteId)) {
        toast({ title: trashResultMessage("restore", 0, result.skipped.length, t), variant: "destructive" });
      }
      onRestored();
    } catch (err) {
      toastTrashFailure("restore", err, t);
    }
  };

  return (
    <div className="space-y-3 p-6">
      <h2 className="text-base font-semibold">{t("trash.inTrashTitle")}</h2>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" disabled={restore.isPending} onClick={() => void handleRestore()}>
          <RotateCcw aria-hidden="true" className="h-4 w-4" />
          {t("trash.restore")}
        </Button>
        <Button type="button" variant="outline" onClick={() => showTab("trash")}>
          <Trash aria-hidden="true" className="h-4 w-4" />
          {t("trash.goToTrash")}
        </Button>
      </div>
    </div>
  );
}
