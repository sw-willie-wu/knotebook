import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { VersionDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { fetchCurrent, useApplyVersion, versionsKey } from "@/api/versions";
import { toast } from "@/components/ui/toast";
import { useVersions } from "@/lib/versions-context";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 套用流程（spec §8.5）：按「套用」前一律重抓 `current`（`fetchQuery` `staleTime: 0`）——dirty 跳三選一，不 dirty 直接套用
 * （`discardUnsaved: false`）。body 一律帶清單列的 `versionId`。409 `version_unsaved_changes` → 改跳對話框（插進來的修改）；
 * 409 `version_mismatch` → toast、invalidate 清單、離開預覽。**不自動存**（D7）。
 */
export function useApplyFlow(noteId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { openDialog, closeDialog, stopPreview } = useVersions();
  const { mutateAsync } = useApplyVersion(noteId);

  const applyNow = useCallback(
    async (version: VersionDto, discardUnsaved: boolean) => {
      try {
        await mutateAsync({ version, discardUnsaved });
        closeDialog();
        stopPreview();
        toast({ title: t("versions.toast.applied", { seq: version.seq }) });
      } catch (err) {
        if (err instanceof ApiFail && err.status === 409 && err.code === "version_unsaved_changes") {
          openDialog({ kind: "apply", version });
          return;
        }
        closeDialog();
        if (err instanceof ApiFail && err.status === 409 && err.code === "version_mismatch") {
          void queryClient.invalidateQueries({ queryKey: versionsKey(noteId) });
          stopPreview();
        }
        toast({ title: errorMessage(t, err), variant: "destructive" });
      }
    },
    [mutateAsync, closeDialog, stopPreview, openDialog, queryClient, noteId, t],
  );

  const requestApply = useCallback(
    async (version: VersionDto) => {
      let dirty: boolean;
      try {
        dirty = (await fetchCurrent(queryClient, noteId)).dirty;
      } catch (err) {
        toast({ title: errorMessage(t, err), variant: "destructive" });
        return;
      }
      if (dirty) openDialog({ kind: "apply", version });
      else await applyNow(version, false);
    },
    [queryClient, noteId, openDialog, applyNow, t],
  );

  return { requestApply, applyNow };
}
