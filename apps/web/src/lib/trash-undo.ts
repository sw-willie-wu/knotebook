import type { QueryClient } from "@tanstack/react-query";
import type { NavigateFunction } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { invalidateTrashRelated, partialRestored, restoreTrashIds, seedRestoredNotes, trashErrorCause } from "@/api/trash";
import { expandAfterRestore } from "@/components/sidebar/folder-index";
import { toast } from "@/components/ui/toast";
import { canRestoreAfterTrash, trashResultMessage } from "@/lib/trash-display";

export type Translate = (key: string, options?: Record<string, unknown>) => string;

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 「已移到垃圾桶」toast（spec §6.10.4／§6.10.7）。`reopen`＝原本開著那篇——復原成功後導回它的 canonical 路徑。
 * 復原鈕的 handler 只用參數捕捉的 queryClient／navigate 與 api/trash.ts 的純函式：toast 常在選單卸載後才被按（讀碼發現 5）。
 * 後四欄給 PR-2c 多選刪除用，不給＝單篇的行為。
 */
export function showTrashedToast(args: {
  notes: ReadonlyArray<Pick<NoteDto, "id" | "group" | "permissions">>;
  queryClient: QueryClient;
  navigate: NavigateFunction;
  t: Translate;
  reopen: boolean;
  /** 預設 `t("trash.moved")`。 */
  title?: string;
  /** 不可復原時與 `trash.movedNoUndoHint` 以「 」接在後面（description 在前）。 */
  description?: string;
  variant?: "default" | "destructive";
  /** 給了就覆蓋由 `reopen` 推算的那篇（`reopen` 只在單篇時推出它）。 */
  reopenId?: string | null;
  /** 沒有 DTO、只有 id 的那幾篇（刪資料夾回的 `trashedNoteIds`）：併進復原的 id（去重），不參與 §6.10.7 判準（plan 讀碼發現 12）。 */
  undoIds?: readonly string[];
}): void {
  const { notes, queryClient, navigate, t, reopen, description, variant } = args;
  const title = args.title ?? t("trash.moved");
  if (!notes.every(canRestoreAfterTrash)) {
    // 群組筆記只有刪除權、沒有編輯權：自己還原不了，只說明誰可以（spec §6.10.7）。
    const hint = t("trash.movedNoUndoHint");
    toast({ title, description: description === undefined ? hint : `${description} ${hint}`, variant });
    return;
  }
  const ids = [...new Set([...notes.map((note) => note.id), ...(args.undoIds ?? [])])];
  const reopenId = args.reopenId !== undefined ? args.reopenId : reopen && ids.length === 1 ? ids[0] : null;
  toast({
    title,
    description,
    variant,
    action: {
      label: t("trash.undo"),
      onClick: () => void undoTrash({ ids, queryClient, navigate, t, reopenId }),
    },
  });
}

/** 復原：還原 `ids`、toast 結果；`reopenId` 在 restored 裡才導回它。seed 必須早於 navigate（讀碼發現 27）。 */
export async function undoTrash(args: {
  ids: readonly string[];
  queryClient: QueryClient;
  navigate: NavigateFunction;
  t: Translate;
  reopenId: string | null;
}): Promise<void> {
  const { ids, queryClient, navigate, t, reopenId } = args;
  // 已還原的那幾篇（成功＝全部、分批中途失敗＝已成功各批）：finally 失效之後拿去展開所在資料夾（資料夾 spec §6.8）。
  let restored: NoteDto[] = [];
  try {
    const result = await restoreTrashIds(ids);
    restored = result.restored;
    seedRestoredNotes(queryClient, result.restored);
    toast({
      title: trashResultMessage("restore", result.restored.length, result.skipped.length, t),
      variant: result.restored.length === 0 ? "destructive" : "default",
    });
    const back = reopenId !== null ? result.restored.find((note) => note.id === reopenId) : undefined;
    if (back) void navigate(canonicalNotePath(back));
  } catch (err) {
    // 分批中途失敗（多選刪除、刪資料夾一次復原整批才會走到）：已成功的那幾篇照樣蓋回常駐層，並回報已還原幾篇（資料夾 spec §6.6 M15）。
    restored = partialRestored(err);
    seedRestoredNotes(queryClient, restored);
    toast({
      title: errorMessage(t, trashErrorCause(err)),
      description: restored.length > 0 ? t("trash.restored", { count: restored.length }) : undefined,
      variant: "destructive",
    });
  } finally {
    invalidateTrashRelated(queryClient, ids);
  }
  // 必須在失效之後（見 expandAfterRestore）。
  void expandAfterRestore(queryClient, restored);
}
