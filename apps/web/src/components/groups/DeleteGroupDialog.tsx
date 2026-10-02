import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { groupMembersKey, useDeleteGroup, useGroupMembers } from "@/api/groups";
import { useNotes } from "@/api/notes";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";

/** 與 `ShareDialog.tsx` 的 `SELECT_CLASS` 同形（原生 `<select>`），但撐滿寬度、長 email 以 `truncate` 吃掉不撐破對話框。 */
const SELECT_CLASS =
  "h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

type Mode = "transfer" | "delete";

/** ApiFail → errors.<code>；其餘 → errors.fallback（與 `GroupMenu`／`GroupNameDialog` 同形，repo 慣例逐檔各一份）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 刪除群組的兩模式對話框（#175 spec §8.6 PR4）。側欄 ⋮（`GroupMenu`）與設定頁（`SettingsGroupDetailSection`）
 * 兩個入口共用；呼叫端以 `open && <DeleteGroupDialog … />` 掛載，每次開都是新狀態（比照 `GroupNameDialog`）。
 *
 * - **轉移給管理員**（預設）：下拉只列持內建管理員角色的成員，順序沿用 server（`GET …/members` 內建管理員在前），
 *   第一位預設選中、可以是自己。這是不丟資料的那條路，所以放前面當預設。
 * - **全部刪除**：筆記、附件、修改紀錄永久刪除，必須先勾「我了解…」才能送出；切模式時同步清掉勾選，
 *   避免舊勾選被帶進下一次全刪。
 * - **空群組也顯示兩模式**（主檔 spec 疑點 Q7）：兩者在空群組上效果相同，但介面不分岔，使用者不必猜；
 *   說明句換成「這個群組沒有筆記」。
 * - 篇數取自 `['notes']` 快取（`groupId === group.id`）：側欄本來就載著它，不為對話框多打一發；
 *   尚未載入時說明句改用不含數字的版本，不顯示「0 篇」的假話。
 * - 按鈕變體：確認鈕 `destructive`（一個畫面一顆實心鈕，取消是 `outline`；見 `ui/button.tsx`）。
 *
 * 失敗一律 toast 並**留著對話框**（409 `not_admin`、409 `server_busy`、404…）；`not_admin` 另外重抓成員名單，
 * 讓下拉換成最新的管理員。成功 → `onOpenChange(false)` → `onDeleted?.()`。
 */
export function DeleteGroupDialog({
  group,
  onOpenChange,
  onDeleted,
  returnFocusRef,
}: {
  group: GroupDto;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const deleteGroup = useDeleteGroup();
  const membersQuery = useGroupMembers(group.id);
  const notesQuery = useNotes();
  const [mode, setMode] = useState<Mode>("transfer");
  const [pickedAdmin, setPickedAdmin] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const admins = (membersQuery.data ?? []).filter((m) => m.builtin === "admin");
  // 選中的人若不在（重抓後）名單裡就退回第一位，不留一個送出去必 409 的殘值。
  const selected = admins.find((m) => m.userId === pickedAdmin) ?? admins[0] ?? null;
  const adminsFailed = membersQuery.isError;

  const noteCount = notesQuery.data ? notesQuery.data.filter((n) => n.groupId === group.id).length : null;

  function describe(kind: "transfer" | "delete"): string {
    if (noteCount === 0) return t("groups.delete.emptyDescription");
    const name = selected?.displayName ?? "";
    if (kind === "transfer") {
      return noteCount === null
        ? t("groups.delete.transferDescriptionNoCount", { name })
        : t("groups.delete.transferDescription", { count: noteCount, name });
    }
    return noteCount === null
      ? t("groups.delete.deleteDescriptionNoCount")
      : t("groups.delete.deleteDescription", { count: noteCount });
  }

  function switchMode(next: Mode): void {
    setMode(next);
    setAcknowledged(false);
  }

  const blocked =
    deleteGroup.isPending || (mode === "transfer" && selected === null) || (mode === "delete" && !acknowledged);

  async function handleConfirm(): Promise<void> {
    if (blocked) return;
    try {
      await deleteGroup.mutateAsync({
        id: group.id,
        body: mode === "transfer" && selected ? { mode, transferTo: selected.userId } : { mode: "delete" },
      });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      if (err instanceof ApiFail && err.code === "not_admin") {
        void queryClient.invalidateQueries({ queryKey: groupMembersKey(group.id) });
      }
      return;
    }
    onOpenChange(false);
    onDeleted?.();
  }

  function returnFocus(event: Event): void {
    const target = returnFocusRef?.current;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  }

  const modes: Array<{ value: Mode; label: string }> = [
    { value: "transfer", label: t("groups.delete.transferLabel") },
    { value: "delete", label: t("groups.delete.deleteLabel") },
  ];

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={returnFocus}>
        <DialogHeader>
          <DialogTitle>{t("groups.delete.title")}</DialogTitle>
        </DialogHeader>

        <div role="radiogroup" aria-label={t("groups.delete.modeLabel")} className="space-y-1">
          {modes.map((option) => (
            <label
              key={option.value}
              className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent/60"
            >
              <input
                type="radio"
                name="delete-group-mode"
                checked={mode === option.value}
                onChange={() => switchMode(option.value)}
              />
              {option.label}
            </label>
          ))}
        </div>

        {mode === "transfer" ? (
          <div className="space-y-2">
            <select
              aria-label={t("groups.delete.transferToLabel")}
              className={SELECT_CLASS}
              disabled={membersQuery.isPending || deleteGroup.isPending}
              value={selected?.userId ?? ""}
              onChange={(event) => setPickedAdmin(event.target.value)}
            >
              {admins.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {`${m.displayName} (${m.email})`}
                </option>
              ))}
            </select>
            {adminsFailed && (
              <p role="alert" className="text-sm text-destructive">
                {t("groups.delete.adminsUnavailable")}
              </p>
            )}
            <DialogDescription>{describe("transfer")}</DialogDescription>
          </div>
        ) : (
          <div className="space-y-3">
            <DialogDescription>{describe("delete")}</DialogDescription>
            <div className="flex items-center gap-2">
              <Checkbox
                id="delete-group-acknowledge"
                checked={acknowledged}
                onCheckedChange={(value) => setAcknowledged(value === true)}
              />
              <label htmlFor="delete-group-acknowledge" className="cursor-pointer text-sm">
                {t("groups.delete.acknowledge")}
              </label>
            </div>
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" onClick={() => void handleConfirm()} disabled={blocked}>
            {t("groups.delete.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
