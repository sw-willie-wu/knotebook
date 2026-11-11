import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/**
 * 單篇移出最愛的確認框（筆記 ⋮、頁首星號共用）。
 *
 * 不直接用 `sidebar/select-dialogs.tsx`：那個檔只准經 `SelectLazy` 引用（lazy chunk），而 ⋮ 在首包。
 * 結構照垃圾桶的 `PurgeConfirmDialog`：取消在 `DialogFooter` 的第一個子節點（開框時焦點落在它，預設動作是不移出），
 * 確認鈕是 destructive。送出中兩鈕 disabled，Esc／點框外／✕ 一律忽略，框開到結果回來。
 * 關框後的焦點由呼叫端決定（`onCloseAutoFocus`）。
 */
interface FavoriteRemoveDialogProps {
  title: string;
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus: (event: Event) => void;
}

export function FavoriteRemoveDialog({ title, open, pending, onConfirm, onOpenChange, onCloseAutoFocus }: FavoriteRemoveDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("note.favorite.removeTitle")}</DialogTitle>
          <DialogDescription>{t("note.favorite.removeDescription", { title })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {t("note.favorite.removeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
