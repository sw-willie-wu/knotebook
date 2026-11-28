import { lazy, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/auth/useSession";
import { notificationCountKey, useNotificationCount } from "@/api/notifications";
import { SidebarPanelLazyBoundary } from "@/components/ui/sidebar-panel-lazy-boundary";
import { ICON_28_HIT } from "@/components/ui/hit-area";
import { Bell } from "@/components/ui/icons";
import { useIsPhone } from "@/lib/layout-tiers";
import { cn } from "@/lib/utils";

// The list and its strings load only when the bell is first opened (`NotificationsLazy` is the one entry point).
const NotificationsPanel = lazy(() => import("@/components/notifications/NotificationsLazy").then((m) => ({ default: m.NotificationsPanel })));

const BADGE_MAX = 9;

/**
 * Its own button, never inside the user menu's trigger (a button in a button). The count comes from the cache `useNotificationLive` keeps fresh;
 * the badge is hidden while the panel is open because opening marks everything seen.
 */
export function NotificationBell({ placement }: { placement: "sidebar" | "topBar" }) {
  const { t } = useTranslation();
  const { user } = useSession();
  const userId = user?.id ?? null;
  const queryClient = useQueryClient();
  const phone = useIsPhone();
  const count = useNotificationCount(userId).data?.count ?? 0;
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  if (userId === null) return null;

  const shown = open ? 0 : count;
  function close(): void {
    setOpen(false);
    // The list marks everything seen while it is open; the truth for the badge afterwards comes from the server.
    void queryClient.invalidateQueries({ queryKey: notificationCountKey(userId) });
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-testid="notification-bell"
        aria-label={shown > 0 ? t("notificationBell.unread", { count: shown }) : t("notificationBell.label")}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className={cn(
          "relative flex shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/60 hover:text-foreground",
          placement === "topBar" ? "h-11 w-11" : cn("h-7 w-7", ICON_28_HIT),
        )}
      >
        <Bell aria-hidden="true" className="h-4 w-4" />
        {shown > 0 && (
          <span
            data-testid="notification-badge"
            aria-hidden="true"
            className={cn(
              "absolute flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-brand px-[3px] text-[9px] font-semibold leading-none text-brand-fg",
              placement === "topBar" ? "right-[10px] top-[11px]" : "right-[2px] top-[3px]",
            )}
          >
            {shown > BADGE_MAX ? `${BADGE_MAX}+` : shown}
          </span>
        )}
      </button>
      {open && (
        <SidebarPanelLazyBoundary chunk="notifications">
          <NotificationsPanel anchorRef={buttonRef} phone={phone} userId={userId} onClose={close} />
        </SidebarPanelLazyBoundary>
      )}
    </>
  );
}
