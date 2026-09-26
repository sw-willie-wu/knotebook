import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, type Location } from "react-router";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteGroup, useRemoveMember } from "@/api/groups";
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
import { toast } from "@/components/ui/toast";
import { GroupNameDialog } from "./GroupNameDialog";

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * 群組段標／設定頁列的 ⋮（spec §8.1）。兩形：admin → 成員與設定、重新命名、—、刪除群組
 * （danger、二次確認）；member → 查看成員、—、退出群組（二次確認；409 `last_admin` toast）。
 *
 * 選單項一律 `onSelect` 三步形（`event.preventDefault()` → 關選單 → 動作），`DropdownMenu`
 * controlled——理由見 `NoteMenu.tsx` 檔頭的 focus trap 規矩。改名對話框在開啟時才掛載
 * （`renameOpen &&`），每次開都是新的預填。
 *
 * 「成員與設定」／「查看成員」都導到 `/settings/groups/:id`，帶目前 location 當
 * `backgroundLocation`（與 `UserMenu` 開設定的做法相同），關閉設定 modal 時回得來。
 *
 * `size`：`"sidebar"`＝側欄段標的 24px（P21 只准側欄段標例外）；`"default"`＝標準 32px
 * `size="icon"`（設定頁列表等其他地方）。
 *
 * 從 ⋮ 開出的三個對話框關閉時焦點還給 ⋮（`triggerRef`）；刪除／退出成功後這個 ⋮ 可能已
 * 隨群組段卸載，所以只在 `isConnected` 時才搶焦點，否則交給 Radix 預設。
 */
export function GroupMenu({ group, size = "default" }: { group: GroupDto; size?: "sidebar" | "default" }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  const deleteGroup = useDeleteGroup();
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

  const isAdmin = group.myRole === "admin";

  function goToSettings(): void {
    // 已經在設定 modal 裡（`/settings/groups` 列表的 ⋮）時要**轉傳**既有的 backgroundLocation，
    // 不能拿 modal 自己的 location 當背景——否則背景層變成 HomePage，關閉時 navigate 回
    // `/settings/groups` 又把 modal 開回來，Esc／✕ 永遠關不掉（gate r1 I3）。
    // 深連結進 `/settings/groups`（沒有 state）時也不能拿 settings 自己當背景（會要按兩次 Esc）。
    const state = location.state as { backgroundLocation?: Location } | null;
    const inSettings = location.pathname.startsWith("/settings/");
    const backgroundLocation = state?.backgroundLocation ?? (inSettings ? undefined : location);
    navigate(`/settings/groups/${encodeURIComponent(group.id)}`, {
      state: backgroundLocation ? { backgroundLocation } : undefined,
    });
  }

  async function handleDelete(): Promise<void> {
    try {
      await deleteGroup.mutateAsync(group.id);
      setDeleteOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      setDeleteOpen(false);
    }
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
            className={size === "sidebar" ? "h-6 w-6 shrink-0" : "shrink-0"}
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
            {isAdmin ? t("groups.menu.manage") : t("groups.menu.viewMembers")}
          </DropdownMenuItem>
          {isAdmin && (
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
          <DropdownMenuSeparator />
          {isAdmin ? (
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
          ) : (
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

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent onCloseAutoFocus={returnFocusToTrigger}>
          <DialogHeader>
            <DialogTitle>{t("groups.delete.title")}</DialogTitle>
            <DialogDescription>{t("groups.delete.description", { name: group.name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="button" variant="destructive" onClick={() => void handleDelete()} disabled={deleteGroup.isPending}>
              {t("groups.delete.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
