import { useCallback, useRef } from "react";
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
  const { openDialog, closeDialog, stopPreview, onApplied } = useVersions();
  const { mutateAsync } = useApplyVersion(noteId);
  // requestApply 進行中旗標（Task 9 minor）：連點「套用」時第二次直接 return。`fetchQuery` 會把同鍵的並發重抓併成一次，
  // 但兩次呼叫各自拿到結果後都會走到 applyNow——沒有這道旗標就是兩次 POST apply。
  const inFlight = useRef(false);

  const applyNow = useCallback(
    async (version: VersionDto, discardUnsaved: boolean) => {
      try {
        await mutateAsync({ version, discardUnsaved });
        closeDialog();
        stopPreview();
        // 筆記 query 整組失效（id 鍵＋路徑解析層，NotePage 的 invalidateNoteQueries）——`useApplyVersion.onSuccess`
        // 只失效 `['note', id]`，舊形／路徑鍵由頁面層補（Task 1 carry 裁定）。排在關對話框／離開預覽之後，
        // 自己再包一層：通知出錯不得把已成功的套用變成錯誤 toast（fix round 1 Nit-2）。
        try {
          onApplied();
        } catch {
          // 失效只是讓頁首資料早點對齊；失敗時等下一次 refetch，不影響套用結果。
        }
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
    [mutateAsync, onApplied, closeDialog, stopPreview, openDialog, queryClient, noteId, t],
  );

  const requestApply = useCallback(
    async (version: VersionDto) => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        let dirty: boolean;
        try {
          dirty = (await fetchCurrent(queryClient, noteId)).dirty;
        } catch (err) {
          toast({ title: errorMessage(t, err), variant: "destructive" });
          return;
        }
        if (dirty) openDialog({ kind: "apply", version });
        else await applyNow(version, false);
      } finally {
        inFlight.current = false;
      }
    },
    [queryClient, noteId, openDialog, applyNow, t],
  );

  return { requestApply, applyNow };
}
