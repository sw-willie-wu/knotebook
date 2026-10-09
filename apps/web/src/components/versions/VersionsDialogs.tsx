import { useState, type FormEvent } from "react";
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

function SaveDialog({ noteId, then }: { noteId: string; then?: VersionDto }) {
  const { t } = useTranslation();
  const { closeDialog } = useVersions();
  const list = useVersionList(noteId, true);
  const save = useSaveVersion(noteId);
  const { applyNow } = useApplyFlow(noteId);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nextSeq = list.data?.pages[0]?.current.nextSeq;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    try {
      const row = await save.mutateAsync(name);
      toast({ title: row.upgraded ? t("versions.toast.upgraded", { seq: row.seq }) : t("versions.toast.saved", { seq: row.seq }) });
      if (then) await applyNow(then, false);
      else closeDialog();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && closeDialog()}>
      {/* 表單型對話框一律 dismissOnOutside={false}（`ui/dialog.tsx:48-55` 的 repo 慣例，gate r1 M-3）：誤點外面不得丟掉已填的名稱；Esc／取消照常關 */}
      <DialogContent dismissOnOutside={false}>
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
            <Button type="submit" variant="brandDeep" disabled={save.isPending}>
              {t("versions.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ApplyDialog({ noteId, version }: { noteId: string; version: VersionDto }) {
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
      <DialogContent>
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

function RenameDialog({ noteId, version }: { noteId: string; version: VersionDto }) {
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
      <DialogContent dismissOnOutside={false}>
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

function DeleteDialog({ noteId, version }: { noteId: string; version: VersionDto }) {
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
      <DialogContent>
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

/** 版本對話框的單一掛載點（NotePage 以 lazy 掛，Task 10）：依 context 的 `dialog` 分派；`null` 時不渲染。 */
export function VersionsDialogs() {
  const { noteId, dialog } = useVersions();
  if (!noteId || !dialog) return null;
  switch (dialog.kind) {
    case "save":
      return <SaveDialog key={`save-${dialog.then?.id ?? ""}`} noteId={noteId} then={dialog.then} />;
    case "apply":
      return <ApplyDialog key={`apply-${dialog.version.id}`} noteId={noteId} version={dialog.version} />;
    case "rename":
      return <RenameDialog key={`rename-${dialog.version.id}`} noteId={noteId} version={dialog.version} />;
    case "delete":
      return <DeleteDialog key={`delete-${dialog.version.id}`} noteId={noteId} version={dialog.version} />;
  }
}
