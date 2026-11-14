import { useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { folderErrorMessage, invalidateFolderRelated, isFolderNotFound } from "@/api/folders";
import { useConfirmNoteStillPersonal, useCopyNote, useMoveNoteToGroup } from "@/api/note-move";
import { usePublicLink } from "@/api/public-link";
import { useShares } from "@/api/shares";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import type { GroupTransferPick, TransferTarget } from "./GroupTransfer";

/**
 * ⋮ 選單「移動到…／複製到…」選定後的確認框（移動、複製）。與選單項（`GroupTransfer.tsx`）分檔：選單項在開啟的選單裡同步渲染，
 * 這支只在選定目的地後才需要，由 `NoteMenu` 以 `lazy()` 載入（首包瘦身）。
 */

/**
 * 選定群組後的確認框（原行內確認的 Dialog 版，文案與規則不變）。不變量：
 * - **移動**（`MoveDialog`）確認列出會失去存取的逐人分享對象、有 token 時說公開連結會關、恆說網址會變與擁有權移交；提交鈕
 *   `destructive`。**shares 與 public-link 兩支都成功之前提交鈕停用**（資料不明時文案會低報被移除的人）。
 *   shares／public-link 的查詢**只由 `MoveDialog` 發**（複製不需要，且在群組筆記／別人分享給我的筆記上會 403 重試）。
 * - 送出前檢查（`useConfirmNoteStillPersonal`）：重讀到已不是我能移動的個人筆記 -> 不送、發 `changedElsewhere` toast。
 *   ⚠ 那支 hook 每次 render 回傳新函式——只在送出 handler 裡直接呼叫，**不得**放進任何 effect 的 deps。
 * - 移動成功：hook 先寫 shares／public-link 再寫 `['note', id]`（順序契約在 `api/note-move.ts`），之後的頁面只讀回應的
 *   `role`／`permissions`，不假設搬完能編輯。
 * - **複製**（`CopyDialog`）確認「原筆記不變」，提交鈕 `outline`；成功 toast 附「前往副本」（altText 鍵 `share.move.openCopyAlt`）。
 * - 失敗一律 toast（`folderErrorMessage`，帶 `max`）並關框——選單已關，沒有別處可放行內訊息。送出中（含送出前檢查）鈕停用、
 *   框不可關閉，避免重送出第二份副本。
 * - 資料夾：「建立副本」（`duplicate`／`inPlace`）帶來源的 `folderId`（來自快取），收到 404
 *   `folder_not_found` → 不帶 `folderId` 重送一次、落在根層並換成 `copiedAtTopLevel` toast；使用者明選的資料夾（`group`／
 *   `personal` 的 `folder`）404 → 不重試、錯誤 toast。兩者都 `invalidateFolderRelated` 讓樹重抓。
 * - 關框後焦點回 `returnFocusRef`（呼叫端的 ⋮ 觸發鈕）：Radix 的還焦點靠 `DialogTrigger`，這裡沒有，會掉到 body。
 */
interface DialogShellProps {
  title: string;
  description: string;
  busy: boolean;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
  children?: ReactNode;
  footer: ReactNode;
}

function DialogShell({ title, description, busy, onClose, returnFocusRef, children, footer }: DialogShellProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent
        dismissOnOutside={false}
        data-testid="group-transfer-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusRef?.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter>{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TransferDialogProps {
  note: NoteDto;
  target: TransferTarget;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

function MoveDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const group = target.type === "group" ? target.group : null;
  const folder = target.type === "group" ? target.folder : undefined;
  // 目的地名稱：群組名；選了群組資料夾時換成完整路徑。
  const destination = folder?.path ?? group?.name ?? "";
  const { t, i18n } = useTranslation();
  const sharesQuery = useShares(note.id);
  const linkQuery = usePublicLink(note.id);
  const move = useMoveNoteToGroup(note.id);
  const confirmStillPersonal = useConfirmNoteStillPersonal(note.id);
  const [submitting, setSubmitting] = useState(false);

  const busy = submitting || move.isPending;
  const dataKnown = sharesQuery.isSuccess && linkQuery.isSuccess;
  const shares = sharesQuery.data ?? [];
  const token = linkQuery.data?.token ?? null;
  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(
    shares.map((share) => share.displayName),
  );

  async function submit(): Promise<void> {
    setSubmitting(true);
    try {
      if (!(await confirmStillPersonal())) {
        toast({ title: t("share.move.changedElsewhere") });
        return;
      }
      if (group === null) return;
      await move.mutateAsync(folder === undefined ? { groupId: group.id } : { groupId: group.id, folderId: folder.id });
      toast({ title: t("share.move.movedToGroup", { group: destination }) });
    } catch (err) {
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={t("share.move.moveSubmit")}
      description={t("share.move.moveLead", { group: destination })}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy || !dataKnown} onClick={() => void submit()}>
            {t("share.move.moveSubmit")}
          </Button>
        </>
      }
    >
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {shares.length > 0 && <li>{t("share.move.moveRemovesPeople", { count: shares.length, names })}</li>}
        {token && <li>{t("share.move.moveClosesPublicLink")}</li>}
        <li>{t("share.move.moveUrlChange")}</li>
        <li>{t("share.move.moveOwnership")}</li>
        <li>{t("share.move.moveClearsVersions")}</li>
      </ul>
    </DialogShell>
  );
}

type CopyInput = { groupId?: string; folderId?: string };

/**
 * `POST /copy` 的 body（根層一律不帶 `folderId`）＋ 退回用的 body（只有「建立副本」且來源在資料夾裡才有）。
 * 「建立副本」落在來源同一資料夾；共享筆記複製到我的筆記不帶自己的共享放置（`note.folderId` 是呼叫者視角的放置）。
 */
function copyRequest(note: NoteDto, target: TransferTarget): { input: CopyInput; fallback: CopyInput | null } {
  const groupPart: CopyInput = target.type === "group" || target.type === "inPlace" ? { groupId: target.group.id } : {};
  if (target.type === "duplicate" || target.type === "inPlace") {
    if (note.folderId === null) return { input: groupPart, fallback: null };
    return { input: { ...groupPart, folderId: note.folderId }, fallback: groupPart };
  }
  return { input: target.folder === undefined ? groupPart : { ...groupPart, folderId: target.folder.id }, fallback: null };
}

function CopyDialog({ note, target, onClose, returnFocusRef }: TransferDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const copy = useCopyNote(note.id);
  const [submitting, setSubmitting] = useState(false);
  const busy = submitting || copy.isPending;
  // 「建立副本」（自己的個人筆記、群組筆記就地）確認框標題／按鈕同字；複製到我的筆記（含其中的資料夾）是「複製到我的筆記」。
  const submitLabel =
    target.type === "group"
      ? t("share.move.copySubmit")
      : target.type === "personal"
        ? t("share.move.copyPersonalSubmit")
        : t("share.move.copyHereSubmit");
  // 「會在「X」建立副本」：X＝群組名，選了資料夾時換成完整路徑。
  const lead =
    target.type === "group"
      ? t("share.move.copyLead", { group: target.folder?.path ?? target.group.name })
      : target.type === "inPlace"
        ? t("share.move.copyLeadInPlace", { group: target.group.name })
        : target.type === "personal" && target.folder !== undefined
          ? t("share.move.copyLead", { group: target.folder.path })
          : t("share.move.copyLeadPersonal");
  const copiedTitle =
    target.type === "group" || target.type === "inPlace"
      ? t("share.move.copiedToGroup", { group: target.group.name })
      : t("share.move.copiedToPersonal");

  async function submit(): Promise<void> {
    setSubmitting(true);
    const request = copyRequest(note, target);
    try {
      let created: NoteDto;
      let atTopLevel = false;
      try {
        created = await copy.mutateAsync(request.input);
      } catch (err) {
        // 只有「建立副本」帶的快取 folderId 失效才自動退回根層重送一次；明選的資料夾不重試（往外丟）。
        if (request.fallback === null || !isFolderNotFound(err)) throw err;
        invalidateFolderRelated(queryClient);
        created = await copy.mutateAsync(request.fallback);
        atTopLevel = true;
      }
      toast({
        title: atTopLevel ? t("share.move.copiedAtTopLevel") : copiedTitle,
        action: {
          label: t("share.move.openCopy"),
          altText: t("share.move.openCopyAlt"),
          onClick: () => void navigate(canonicalNotePath(created)),
        },
      });
    } catch (err) {
      if (isFolderNotFound(err)) invalidateFolderRelated(queryClient);
      toast({ title: folderErrorMessage(t, err), variant: "destructive" });
    } finally {
      setSubmitting(false);
      onClose();
    }
  }

  return (
    <DialogShell
      title={submitLabel}
      description={lead}
      busy={busy}
      onClose={onClose}
      returnFocusRef={returnFocusRef}
      footer={
        <>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            {t("share.move.cancel")}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </>
      }
    />
  );
}

export function GroupTransferDialog({
  note,
  pick,
  onClose,
  returnFocusRef,
}: {
  note: NoteDto;
  pick: GroupTransferPick;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const Body = pick.kind === "move" ? MoveDialog : CopyDialog;
  return <Body note={note} target={pick.target} onClose={onClose} returnFocusRef={returnFocusRef} />;
}
