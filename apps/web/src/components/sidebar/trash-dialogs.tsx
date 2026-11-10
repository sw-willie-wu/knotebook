import { useTranslation } from "react-i18next";
import type { TrashItemDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { TrashBatchError, trashErrorCause } from "@/api/trash";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { splitTrashSections, trashResultMessage } from "@/lib/trash-display";

/**
 * 垃圾桶的確認框與結果 toast。還原不確認；永久刪除（單篇、多選）與清空才確認。
 * 呼叫端在 `onConfirm` 的 mutation **成敗都關框**、結果一律走 toast（失敗時清單重抓，
 * 框內篇數會當著使用者的面改掉）。
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

interface ConfirmShellProps {
  open: boolean;
  pending: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}

export function PurgeConfirmDialog({ count, open, pending, onConfirm, onOpenChange, onCloseAutoFocus }: ConfirmShellProps & { count: number }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("trash.purgeTitle", { count })}</DialogTitle>
          <DialogDescription>{t("trash.purgeDescription")}</DialogDescription>
        </DialogHeader>
        <ConfirmFooter pending={pending} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

/** 「（含其他成員刪除的）」逐區判斷：該區至少一篇不是我刪的（`deletedBy: null`＝已刪帳號，也算別人）。 */
function deletedByOthers(items: readonly TrashItemDto[], meHandle: string | null): boolean {
  return items.some((item) => item.deletedBy === null || item.deletedBy.handle !== meHandle);
}

export function EmptyTrashDialog({
  items,
  meHandle,
  open,
  pending,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
}: ConfirmShellProps & { items: readonly TrashItemDto[]; meHandle: string | null }) {
  const { t } = useTranslation();
  const { personal, workspace } = splitTrashSections(items);
  // 前導分隔在鍵值裡（en 帶一個空白、zh-TW 的全形括號不帶），這裡只拼接。
  const line = (key: "trash.emptyPersonal" | "trash.emptyWorkspace", section: readonly TrashItemDto[]) =>
    t(key, { count: section.length }) + (deletedByOthers(section, meHandle) ? t("trash.includesOthers") : "");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("trash.emptyTitle")}</DialogTitle>
          <DialogDescription>{t("trash.emptyDescription", { count: items.length })}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {personal.length > 0 && <li>{line("trash.emptyPersonal", personal)}</li>}
          {workspace.length > 0 && <li>{line("trash.emptyWorkspace", workspace)}</li>}
        </ul>
        <ConfirmFooter pending={pending} onConfirm={onConfirm} />
      </DialogContent>
    </Dialog>
  );
}

function ConfirmFooter({ pending, onConfirm }: { pending: boolean; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <DialogClose asChild>
        <Button type="button" variant="outline">
          {t("home.cancel")}
        </Button>
      </DialogClose>
      <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
        {t("trash.purge")}
      </Button>
    </DialogFooter>
  );
}

type TrashResult = TrashRestoreResultDto | TrashPurgeResultDto;
type TrashKind = "restore" | "purge";

function doneCount(result: TrashResult): number {
  return "restored" in result ? result.restored.length : result.purged.length;
}

/** 成功：「已還原／已永久刪除 N 篇」，有略過加「，M 篇已不在垃圾桶」；一篇都沒做到（全被略過）用 destructive。 */
export function toastTrashResult(kind: TrashKind, result: TrashResult, t: Translate): void {
  const done = doneCount(result);
  toast({ title: trashResultMessage(kind, done, result.skipped.length, t), variant: done === 0 ? "destructive" : "default" });
}

/**
 * 失敗：標題 `errors.<code>`；分批中途失敗（之前的批已成功）時描述報已完成篇數。
 * 第一批就失敗＝什麼都沒做，不加「已還原 0 篇」。
 */
export function toastTrashFailure(kind: TrashKind, err: unknown, t: Translate): void {
  const cause = trashErrorCause(err);
  const title = cause instanceof ApiFail ? t(`errors.${cause.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
  let description: string | undefined;
  if (err instanceof TrashBatchError) {
    const partial = err.partial as TrashResult;
    if (doneCount(partial) + partial.skipped.length > 0) description = trashResultMessage(kind, doneCount(partial), partial.skipped.length, t);
  }
  toast({ title, description, variant: "destructive" });
}
