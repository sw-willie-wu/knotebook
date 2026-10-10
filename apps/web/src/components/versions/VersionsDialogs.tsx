import { useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { VersionDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteVersion, useRenameVersion, useSaveVersion, useVersionList } from "@/api/versions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useVersions } from "@/lib/versions-context";
import { useApplyFlow } from "./use-apply-flow";

// spec §6.3：上限 120 字（server 為最終裁決）。PR1 在 shared 匯出 `VERSION_NAME_MAX`（gate r1 N-4）——直接 import，不另寫一份常數；
// Task 0 Step 2 一併核對它存在（不存在 → 交回、暫以字面 120 並註明）。
import { VERSION_NAME_MAX } from "@knotebook/shared";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 關閉時的焦點還原（final I-2），由 `VersionsDialogs` 交給四個對話框的 `DialogContent`。 */
type CloseAutoFocus = (event: Event) => void;

function SaveDialog({ noteId, then, onCloseAutoFocus }: { noteId: string; then?: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog } = useVersions();
  const list = useVersionList(noteId, true);
  const save = useSaveVersion(noteId);
  const { applyNow } = useApplyFlow(noteId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  // 整段 submit 的進行中旗標（final M-4）：帶 `then` 時存檔成功後 `save.isPending` 已翻回 false，
  // 但還要等套用完成——這段期間不得再送出（否則多存一次、多送一次 apply）。ref 擋重入、state 讓鈕 disabled。
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const nextSeq = list.data?.pages[0]?.current.nextSeq;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const row = await save.mutateAsync(name);
      toast({ title: row.upgraded ? t("versions.toast.upgraded", { seq: row.seq }) : t("versions.toast.saved", { seq: row.seq }) });
      if (then) await applyNow(then, false);
      else closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      {/* 表單型對話框一律 dismissOnOutside={false}（`ui/dialog.tsx:48-55` 的 repo 慣例，gate r1 M-3）：誤點外面不得丟掉已填的名稱；Esc／取消照常關 */}
      <DialogContent dismissOnOutside={false} onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{t("versions.dialog.saveTitle")}</DialogTitle>
            {nextSeq !== undefined && <DialogDescription>{t("versions.dialog.saveDescription", { seq: nextSeq })}</DialogDescription>}
          </DialogHeader>
          <label className="mt-4 block text-sm" htmlFor="version-save-name">
            {t("versions.dialog.nameLabel")}
          </label>
          <Input id="version-save-name" value={name} maxLength={VERSION_NAME_MAX} onChange={(e) => setName(e.target.value)} className="mt-1" />
          {error !== null && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("versions.dialog.cancel")}
            </Button>
            <Button type="submit" variant="brandDeep" disabled={busy || save.isPending}>
              {t("versions.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApplyDialog({ noteId, version, onCloseAutoFocus }: { noteId: string; version: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog, openSave } = useVersions();
  const { applyNow } = useApplyFlow(noteId);
  const [busy, setBusy] = useState(false);

  async function discard() {
    setBusy(true);
    try {
      await applyNow(version, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("versions.dialog.applyTitle", { seq: version.seq })}</DialogTitle>
          <DialogDescription>{t("versions.dialog.applyDescription", { seq: version.seq })}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" disabled={busy} onClick={closeDialog}>
            {t("versions.dialog.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={busy} onClick={() => void discard()}>
            {t("versions.dialog.applyDiscard")}
          </Button>
          <Button type="button" variant="brandDeep" disabled={busy} onClick={() => openSave(version)}>
            {t("versions.dialog.applySaveFirst")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenameDialog({ noteId, version, onCloseAutoFocus }: { noteId: string; version: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog } = useVersions();
  const rename = useRenameVersion(noteId);
  const [name, setName] = useState(version.name ?? "");
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      await rename.mutateAsync({ seq: version.seq, name });
      toast({ title: t("versions.toast.renamed") });
      closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent dismissOnOutside={false} onCloseAutoFocus={onCloseAutoFocus}>
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{t("versions.dialog.renameTitle", { seq: version.seq })}</DialogTitle>
            {version.kind === "auto" && <DialogDescription>{t("versions.dialog.renameAutoHint")}</DialogDescription>}
          </DialogHeader>
          <label className="mt-4 block text-sm" htmlFor="version-rename-name">
            {t("versions.dialog.nameLabel")}
          </label>
          <Input id="version-rename-name" value={name} maxLength={VERSION_NAME_MAX} onChange={(e) => setName(e.target.value)} className="mt-1" />
          {error !== null && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={closeDialog}>
              {t("versions.dialog.cancel")}
            </Button>
            <Button type="submit" variant="brandDeep" disabled={rename.isPending}>
              {t("versions.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ noteId, version, onCloseAutoFocus }: { noteId: string; version: VersionDto; onCloseAutoFocus: CloseAutoFocus }) {
  const { t } = useTranslation();
  const { closeDialog, preview, stopPreview } = useVersions();
  const del = useDeleteVersion(noteId);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    try {
      await del.mutateAsync(version.seq);
      toast({ title: t("versions.toast.deleted", { seq: version.seq }) });
      if (preview?.seq === version.seq) stopPreview();
      closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("versions.dialog.deleteTitle", { seq: version.seq })}</DialogTitle>
          <DialogDescription>{t("versions.dialog.deleteDescription")}</DialogDescription>
        </DialogHeader>
        {error !== null && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={closeDialog}>
            {t("versions.dialog.cancel")}
          </Button>
          <Button type="button" variant="destructive" disabled={del.isPending} onClick={() => void submit()}>
            {t("versions.dialog.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 版本對話框的單一掛載點（NotePage 以 lazy 掛，Task 10）：依 context 的 `dialog` 分派；`null` 時不渲染。
 *
 * 焦點還原（final I-2）：四個對話框都是受控、沒有 `DialogTrigger`，Radix 關閉時只會 `triggerRef.current?.focus()`（null），
 * 焦點落到 body（Ctrl+S 存完游標離開編輯器）。所以在「沒有對話框 → 有對話框」那一刻記下 `document.activeElement`
 * （Ctrl+S 時就是編輯器的 contenteditable），整段對話（含三選一 → 儲存的換框）結束時還回去（同 `GroupNameDialog`／`LinkDialog` 的手動還原）；
 * 元素已卸載（從頁首 ⋮ 開時記到的是選單項）就退回 `returnFocusRef`（⋮ 觸發鈕，同 VersionsSheet），也沒有就不動。換框（apply → save、存完套用遇 409 → apply）時舊框卸載也會
 * 觸發 onCloseAutoFocus（`@radix-ui/react-focus-scope` dist `index.mjs:94` 在 setTimeout 裡送出），那時還有對話框開著：不還原。
 * `openRef` 有兩件事：(1) 卸載時歸零——NotePage 條件掛、關閉即卸載，沒有這步所有還原都會被擋（final fix 2 I-A），
 * 測試的 Host 照 NotePage 條件掛，拿掉 cleanup 會紅；(2) 換框時擋還原——這一條在 jsdom 沒有鑑別力（拿掉照樣綠，final fix 突變 M3【驗】），
 * 原因推測是新框的 FocusScope 把焦點拉回框內【推】，留著是為了不讓焦點先跳到編輯器再被拉回（真瀏覽器可能因此捲動）。
 * 記到 `document.body` 視同沒記到，走 ⋮ 退路（final fix 2 M-A）。
 */
export function VersionsDialogs({ returnFocusRef }: { returnFocusRef?: RefObject<HTMLElement | null> } = {}) {
  const { noteId, dialog } = useVersions();
  const isOpen = noteId !== null && dialog !== null;
  const [session, setSession] = useState<{ open: boolean; returnTo: HTMLElement | null }>({ open: false, returnTo: null });
  if (session.open !== isOpen) {
    // body 不算「可還的元素」（final fix 2 M-A）：當成沒記到，關閉時走 ⋮ 退路。
    const active = document.activeElement;
    setSession({ open: isOpen, returnTo: isOpen && active instanceof HTMLElement && active !== document.body ? active : null });
  }
  const openRef = useRef(isOpen);
  useLayoutEffect(() => {
    openRef.current = isOpen;
  });
  // NotePage 只在 dialog !== null 時掛本元件（關閉即卸載，不會再以 isOpen=false render 一次）：卸載時把 openRef 歸零，
  // 否則 FocusScope 在卸載後送出的 onCloseAutoFocus 會被上面的換框守衛擋掉、焦點落到 body（final fix 2 I-A）。
  useLayoutEffect(
    () => () => {
      openRef.current = false;
    },
    [],
  );
  const returnTo = session.returnTo;
  const onCloseAutoFocus = (event: Event) => {
    if (openRef.current) return;
    // 記到的元素已卸載（從頁首 ⋮ 開：記到的是選單項）→ 退回 `returnFocusRef`（NotePage 交下來的 ⋮ 觸發鈕，同 VersionsSheet）。
    const target = returnTo?.isConnected ? returnTo : returnFocusRef?.current;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  };
  if (!noteId || !dialog) return null;
  switch (dialog.kind) {
    case "save":
      return <SaveDialog key={`save-${dialog.then?.id ?? ""}`} noteId={noteId} then={dialog.then} onCloseAutoFocus={onCloseAutoFocus} />;
    case "apply":
      return <ApplyDialog key={`apply-${dialog.version.id}`} noteId={noteId} version={dialog.version} onCloseAutoFocus={onCloseAutoFocus} />;
    case "rename":
      return <RenameDialog key={`rename-${dialog.version.id}`} noteId={noteId} version={dialog.version} onCloseAutoFocus={onCloseAutoFocus} />;
    case "delete":
      return <DeleteDialog key={`delete-${dialog.version.id}`} noteId={noteId} version={dialog.version} onCloseAutoFocus={onCloseAutoFocus} />;
  }
}
