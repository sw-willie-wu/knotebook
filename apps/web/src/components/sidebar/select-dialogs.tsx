import "@/i18n/select-strings";
import type { ReactNode, Ref } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { DestTarget } from "./destination-level";

/**
 * 一般 tab 選取模式的移入群組／複製確認框（#181 PR-2c，spec §6.11；複製先確認是 Willie 裁定 Q2）。複數版移入確認框是通用句，
 * 不預查每篇的分享與公開連結（plan 讀碼發現 7）。篇數由呼叫端在目的地選定那一刻快照（讀碼發現 19）。
 * PR-3b-2（資料夾 spec §6.10）：目的地名稱換成完整路徑（`destinationPathLabel`，根層＝空間名）；另加刪資料夾的彙總確認框。
 * **送出中（`progress` 非 null）框開到批次結束**：送出與取消 disabled、框內顯示進度；✕（`DialogPrimitive.Close`）、Esc 與點框外
 * 都經 Dialog root 的 `onOpenChange(false)`，這裡一律忽略（不改 `ui/dialog.tsx`）。批次結束由呼叫端把 `open` 設 false。
 * 只准經 `SelectLazy` 引用。
 */

export type SelectProgress = { done: number; total: number } | null;

interface ConfirmProps {
  count: number;
  open: boolean;
  progress: SelectProgress;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
  /** 呼叫端的焦點守衛用（焦點仍在框內也算「沒有移到別處」）。 */
  contentRef?: Ref<HTMLDivElement>;
}

function ConfirmShell({
  title,
  description,
  submitLabel,
  submitVariant,
  open,
  progress,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
  contentRef,
  children,
}: Omit<ConfirmProps, "count"> & {
  title: string;
  description: ReactNode;
  submitLabel: string;
  submitVariant: "destructive" | "outline";
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const busy = progress !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent ref={contentRef} dismissOnOutside={false} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        {progress !== null && (
          <p role="status" className="text-sm text-muted-foreground">
            {t("select.progress", progress)}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant={submitVariant} disabled={busy} onClick={onConfirm}>
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MoveConfirmDialog({ count, groupName, ...rest }: ConfirmProps & { groupName: string }) {
  const { t } = useTranslation();
  return (
    <ConfirmShell
      {...rest}
      title={t("share.move.moveSubmit")}
      description={t("select.moveLead", { count, group: groupName })}
      submitLabel={t("share.move.moveSubmit")}
      submitVariant="destructive"
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        <li>{t("select.moveRemovesShares")}</li>
        <li>{t("select.moveClosesPublicLinks")}</li>
        <li>{t("select.moveUrlChange")}</li>
        <li>{t("select.moveOwnership")}</li>
      </ul>
    </ConfirmShell>
  );
}

/** 複製確認框的鈕字與說明（spec §6.10「執行」）：建立副本、我的筆記（根層照現行、資料夾帶完整路徑）、群組（完整路徑）。 */
function copyCopy(t: (key: string, options?: Record<string, unknown>) => string, count: number, target: DestTarget, pathLabel: string) {
  if (target.kind === "makeCopy") return { label: t("share.move.copyHereSubmit"), lead: t("select.copyLeadMakeCopy", { count }) };
  if (target.space.kind === "group") return { label: t("share.move.copySubmit"), lead: t("select.copyLead", { count, group: pathLabel }) };
  const lead = target.folder === null ? t("select.copyLeadPersonal", { count }) : t("select.copyLead", { count, group: pathLabel });
  return { label: t("share.move.copyPersonalSubmit"), lead };
}

/** `pathLabel`＝`destinationPathLabel`（建立副本與我的筆記根層用不到）。 */
export function CopyConfirmDialog({ count, target, pathLabel, ...rest }: ConfirmProps & { target: DestTarget; pathLabel: string }) {
  const { t } = useTranslation();
  const { label, lead } = copyCopy(t, count, target, pathLabel);
  return <ConfirmShell {...rest} title={label} description={lead} submitLabel={label} submitVariant="outline" />;
}

/**
 * 選了資料夾按「刪除」的彙總確認框（資料夾 spec §6.10 m7）：標題資料夾數、內文會進垃圾桶的篇數（各資料夾子樹活筆記的聯集）、
 * 另選了筆記時加一句（也在可及描述裡）；與我共享 tab 是「移除」（資料夾只是自己的分類，筆記回最上層）。數字由呼叫端在開框那一刻快照。
 * 送出中規則同 `ConfirmShell`（框開到批次結束）。
 */
export function DeleteFoldersConfirmDialog({
  folderCount,
  noteCount,
  alsoNotes,
  shared,
  ...rest
}: Omit<ConfirmProps, "count"> & { folderCount: number; noteCount: number; alsoNotes: number; shared: boolean }) {
  const { t } = useTranslation();
  if (shared) {
    return (
      <ConfirmShell
        {...rest}
        title={t("select.removeFoldersTitle", { count: folderCount })}
        description={t("select.removeFoldersBody")}
        submitLabel={t("select.removeConfirm")}
        submitVariant="destructive"
      />
    );
  }
  return (
    <ConfirmShell
      {...rest}
      title={t("select.deleteFoldersTitle", { count: folderCount })}
      // 附加句也在 DialogDescription 裡（開框時跟內文一起唸）；兩句之間的空白讓可及描述不黏字，畫面上附加句另起一行。
      description={
        <>
          <span>{t("select.deleteFoldersBody", { count: noteCount })}</span>
          {alsoNotes > 0 && (
            <>
              {" "}
              <span className="mt-2 block">{t("select.deleteFoldersAlsoNotes", { count: alsoNotes })}</span>
            </>
          )}
        </>
      }
      submitLabel={t("select.deleteConfirm")}
      submitVariant="destructive"
    />
  );
}
