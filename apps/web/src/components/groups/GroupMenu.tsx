import { lazy, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, type Location } from "react-router";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useRemoveMember } from "@/api/groups";
import { useSession } from "@/auth/useSession";
import { Button } from "@/components/ui/button";
import { ROW_ICON_HIT } from "@/components/ui/hit-area";
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
import { EllipsisVertical, Library, LogOut, Pencil, Trash, Users } from "@/components/ui/icons";
import { hoverReveal } from "@/components/ui/reveal";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { panelEntryState } from "@/lib/panel-return";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";

// Lazy to keep them out of the first bundle; only needed once opened.
const DeleteGroupDialog = lazy(() => import("./DeleteGroupDialog").then((m) => ({ default: m.DeleteGroupDialog })));
const GroupNameDialog = lazy(() => import("./GroupNameDialog").then((m) => ({ default: m.GroupNameDialog })));

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/**
 * Management items depend only on the two `GroupDto` flags, never on the kind of `myRole`; only leave reads `myRole`. Last admin means
 * `myRole.builtin === "admin"` and `memberCount === 1` (`memberCount` counts holders of that role, so on the builtin admin role
 * it is the admin count); the server still answers 409 `last_admin`, so that toast stays as a race fallback.
 * Items use the `onSelect` form (preventDefault, close menu, act) on a controlled menu (focus-trap rule in `NoteMenu.tsx`).
 * The rename dialog mounts only while open, so each open gets a fresh prefill.
 * `size`: `"sidebar"` = 24px, hover-revealed (`ui/reveal.ts`; allowed only in the sidebar); `"default"` = standard 32px
 * icon, always visible (no caller today; kept for a future non-sidebar entry).
 * Dialogs return focus to the trigger only while it is still connected: it may unmount with the group section after delete/leave.
 */
export function GroupMenu({ group, size = "default", indexPath }: { group: GroupDto; size?: "sidebar" | "default"; indexPath?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  const removeMember = useRemoveMember(group.id);
  const [menuOpen, setMenuOpen] = useState(false);
  // One dialog at a time: with a slow chunk, two booleans could stack two modals.
  const [dialog, setDialog] = useState<"rename" | "delete" | null>(null);
  const dialogOpenChange = (kind: "rename" | "delete") => (open: boolean) => setDialog((cur) => (open ? kind : cur === kind ? null : cur));
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
    // Inside a management panel, forward its existing backgroundLocation instead of using the panel's own location,
    // or closing would navigate back to the panel and Esc/close would never work. Same for deep links (no state). Only
    // the sidebar calls this today; the check stays for future callers.
    const state = location.state as { backgroundLocation?: Location } | null;
    const inPanel = /^\/(settings|groups|admin)\//.test(location.pathname);
    const backgroundLocation = state?.backgroundLocation ?? (inPanel ? undefined : location);
    // On phone the list's back chevron reopens this menu after the panel closes (`lib/panel-return.ts`).
    navigate(`/groups/${encodeURIComponent(group.id)}`, { state: panelEntryState(backgroundLocation, () => setMenuOpen(true)) });
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
      <DropdownMenu phoneSheet open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("groups.menu.label", { name: group.name })}
            className={size === "sidebar" ? cn("h-6 w-6 shrink-0", ROW_ICON_HIT, hoverReveal("grouprow")) : "shrink-0"}
          >
            <EllipsisVertical aria-hidden="true" className={size === "sidebar" ? "h-3.5 w-3.5" : "h-4 w-4"} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sheetTitle={group.name}>
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault();
              setMenuOpen(false);
              goToSettings();
            }}
          >
            <Users aria-hidden="true" className="mr-2 h-4 w-4" />
            {group.canManageMembers ? t("groups.menu.manage") : t("groups.menu.viewMembers")}
          </DropdownMenuItem>
          {indexPath !== undefined && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                navigate(indexPath);
              }}
            >
              <Library aria-hidden="true" className="mr-2 h-4 w-4" />
              {t("groups.menu.openIndex")}
            </DropdownMenuItem>
          )}
          {group.canManageGroup && (
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault();
                setMenuOpen(false);
                setDialog("rename");
              }}
            >
              <Pencil aria-hidden="true" className="mr-2 h-4 w-4" />
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
                setDialog("delete");
              }}
            >
              <Trash aria-hidden="true" className="mr-2 h-4 w-4" />
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
              <LogOut aria-hidden="true" className="mr-2 h-4 w-4" />
              {t("groups.menu.leave")}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {dialog === "rename" && (
        <SidebarLazyBoundary chunk="groupDialog" fallback={null} errorClassName="p-2">
          <GroupNameDialog mode="rename" group={group} open onOpenChange={dialogOpenChange("rename")} returnFocusRef={triggerRef} />
        </SidebarLazyBoundary>
      )}

      {dialog === "delete" && (
        <SidebarLazyBoundary chunk="groupDialog" fallback={null} errorClassName="p-2">
          <DeleteGroupDialog group={group} onOpenChange={dialogOpenChange("delete")} returnFocusRef={triggerRef} />
        </SidebarLazyBoundary>
      )}

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
