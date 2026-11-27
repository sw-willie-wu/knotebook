import "@/i18n/notifications-strings";
import { useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive, Popover as PopoverPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { SAFE_INSETS } from "@/components/ui/safe-area";
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
            className={cn("fixed inset-0 z-50 flex flex-col bg-card outline-none", SAFE_INSETS)}
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
    <PopoverPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <PopoverPrimitive.Anchor virtualRef={anchorRef} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-testid="notifications-popover"
          aria-label={t("notifications.title")}
          side="right"
          align="end"
          sideOffset={8}
          collisionPadding={8}
          onCloseAutoFocus={restoreFocus}
          // A click on the bell is the toggle: let its own handler close the panel instead of closing here and reopening there.
          onInteractOutside={(event) => {
            if (anchorRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
          className={cn(cardSurface, "z-50 flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-[min(24rem,calc(100vw-1rem))] flex-col overflow-hidden p-0 shadow-lg outline-none")}
        >
          <NotificationList userId={userId} onNavigate={handleNavigate} layout="popover" />
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
