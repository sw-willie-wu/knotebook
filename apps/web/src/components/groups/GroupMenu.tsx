import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, type Location } from "react-router";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useRemoveMember } from "@/api/groups";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EllipsisVertical } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { DeleteGroupDialog } from "./DeleteGroupDialog";
import { GroupNameDialog } from "./GroupNameDialog";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 側欄群組段標的 ⋮（#175 spec §8.2；#247 起唯一呼叫點是 `NoteList` 的 `size="sidebar"`，管理入口連到群組面板 `/groups/:id`）。**只看 `GroupDto` 的兩個管理旗標，不看 `myRole` 的種類**：
 * - 第一項：`canManageMembers` →「成員與設定」，否則「查看成員」；
 * - `canManageGroup` → 重新命名、—、刪除群組（danger、兩模式對話框 `DeleteGroupDialog`；失敗只 toast、
 *   對話框留著，§8.6）；
 * - 不是最後一位管理員 → 退出群組（排在刪除之後；二次確認）。最後一位管理員＝`myRole.builtin === "admin"`
 *   且 `myRole.memberCount === 1`（`memberCount` 是掛這個角色的人數，內建管理員角色上就是管理員人數）；
 *   server 照舊回 409 `last_admin`，toast 保留當競態後備。
 *
 * 選單項一律 `onSelect` 三步形（`event.preventDefault()` → 關選單 → 動作），`DropdownMenu`
 * controlled——理由見 `NoteMenu.tsx` 檔頭的 focus trap 規矩。改名對話框在開啟時才掛載
 * （`renameOpen &&`），每次開都是新的預填。
 *
 * 「成員與設定」／「查看成員」都導到群組 modal `/groups/:id`（#247 §6.6），帶目前 location 當
 * `backgroundLocation`，關閉群組 modal 時回得來。
 *
 * `size`：`"sidebar"`＝側欄群組列的 24px、hover 浮出（`ui/reveal.ts`；P21 只准側欄例外）；
 * `"default"`＝標準 32px `size="icon"`、常駐（#247 起群組管理改在群組面板 `/groups/:id`，目前沒有呼叫點用它，保留給日後的非側欄入口）。
 *
 * 從 ⋮ 開出的三個對話框關閉時焦點還給 ⋮（`triggerRef`）；刪除／退出成功後這個 ⋮ 可能已
 * 隨群組段卸載，所以只在 `isConnected` 時才搶焦點，否則交給 Radix 預設。
 */
export function GroupMenu({ group, size = "default" }: { group: GroupDto; size?: "sidebar" | "default" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  const removeMember = useRemoveMember(group.id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  function returnFocusToTrigger(event: Event): void {
    const trigger = triggerRef.current;
    if (!trigger?.isConnected) return;
    event.preventDefault();
    trigger.focus();
  }

  const isLastAdmin = group.myRole?.builtin === "admin" && group.myRole.memberCount === 1;
  const canLeave = group.myRole !== null && !isLastAdmin;

  function goToSettings(): void {
    // 已經在某個管理面板裡（/settings/*、/groups/*、/admin/*）時要**轉傳**既有的 backgroundLocation，不能拿面板自己的
    // location 當背景——否則關閉時又 navigate 回面板、Esc／✕ 永遠關不掉（gate r1 I3）。深連結進面板（沒有 state）時也不拿
    // 面板自己當背景。#247 起實際只剩側欄一個呼叫點（群組 modal 與個人設定總覽都沒有 ⋮），判斷保留以防日後新增呼叫點。
    const state = location.state as { backgroundLocation?: Location } | null;
    const inPanel = /^\/(settings|groups|admin)\//.test(location.pathname);
    const backgroundLocation = state?.backgroundLocation ?? (inPanel ? undefined : location);
    navigate(`/groups/${encodeURIComponent(group.id)}`, {
      state: backgroundLocation ? { backgroundLocation } : undefined,
    });
  }

  async function handleLeave(): Promise<void> {
    if (!user) return;
    try {
      await removeMember.mutateAsync(user.id);
      setLeaveOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      setLeaveOpen(false);
    }
  }

  return (
    <>
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("groups.menu.label", { name: group.name })}
            className={size === "sidebar" ? cn("h-6 w-6 shrink-0", hoverReveal("grouprow")) : "shrink-0"}
          >
            <EllipsisVertical aria-hidden="true" className={size === "sidebar" ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              goToSettings();
            }}
          >
            {group.canManageMembers ? t("groups.menu.manage") : t("groups.menu.viewMembers")}
          </DropdownMenuItem>
          {group.canManageGroup && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                setRenameOpen(true);
              }}
            >
              {t("groups.menu.rename")}
            </DropdownMenuItem>
          )}
          {(group.canManageGroup || canLeave) && <DropdownMenuSeparator />}
          {group.canManageGroup && (
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            >
              {t("groups.menu.delete")}
            </DropdownMenuItem>
          )}
          {canLeave && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                setLeaveOpen(true);
              }}
            >
              {t("groups.menu.leave")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {renameOpen && <GroupNameDialog mode="rename" group={group} open onOpenChange={setRenameOpen} returnFocusRef={triggerRef} />}

      {deleteOpen && <DeleteGroupDialog group={group} onOpenChange={setDeleteOpen} returnFocusRef={triggerRef} />}

      <Dialog open={leaveOpen} onOpenChange={setLeaveOpen}>
        <DialogContent onCloseAutoFocus={returnFocusToTrigger}>
          <DialogHeader>
            <DialogTitle>{t("groups.leave.title")}</DialogTitle>
            <DialogDescription>{t("groups.leave.description", { name: group.name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={() => void handleLeave()} disabled={removeMember.isPending || !user}>
              {t("groups.leave.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
