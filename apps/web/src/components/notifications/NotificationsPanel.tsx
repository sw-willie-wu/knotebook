import "@/i18n/notifications-strings";
import { useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SAFE_INSETS } from "@/components/ui/safe-area";
import { SidebarPanel } from "@/components/ui/sidebar-panel";
import { cn } from "@/lib/utils";
import { NotificationList } from "./NotificationList";

export interface NotificationsPanelProps {
  /** The bell button: the popover hangs off it and focus goes back to it. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  phone: boolean;
  userId: string;
  onClose: () => void;
}

export function NotificationsPanel({ anchorRef, phone, userId, onClose }: NotificationsPanelProps) {
  const { t } = useTranslation();
  // Opening a note moves focus into the note; pulling it back to the bell would undo that.
  const navigatedRef = useRef(false);
  const handleNavigate = () => {
    navigatedRef.current = true;
    onClose();
  };
  const restoreFocus = (event: Event) => {
    event.preventDefault();
    if (!navigatedRef.current) anchorRef.current?.focus();
  };

  if (phone) {
    return (
      <DialogPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Content
            data-testid="notifications-sheet"
            aria-describedby={undefined}
            onCloseAutoFocus={restoreFocus}
            className={cn("fixed inset-0 z-50 flex flex-col bg-popover text-popover-foreground outline-none", SAFE_INSETS)}
          >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Button type="button" variant="ghost" size="sm" className="h-11" aria-label={t("notifications.back")} onClick={onClose}>
                <span aria-hidden="true">‹</span> {t("notifications.back")}
              </Button>
              <DialogPrimitive.Title className="text-sm font-semibold">{t("notifications.title")}</DialogPrimitive.Title>
            </header>
            <NotificationList userId={userId} onNavigate={handleNavigate} layout="sheet" />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <SidebarPanel
      triggerRef={anchorRef}
      onClose={onClose}
      onCloseAutoFocus={restoreFocus}
      data-testid="notifications-popover"
      aria-label={t("notifications.title")}
    >
      <NotificationList userId={userId} onNavigate={handleNavigate} layout="popover" />
    </SidebarPanel>
  );
}
