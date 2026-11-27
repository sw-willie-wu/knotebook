import "@/i18n/upload-list-strings";
import { useRef, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Button } from "@/components/ui/button";
import { SAFE_INSETS } from "@/components/ui/safe-area";
import { SidebarPanel } from "@/components/ui/sidebar-panel";
import { cn } from "@/lib/utils";
import { uploadQueueSummary, useUploadQueue } from "@/uploads/upload-queue-store";
import { UploadList } from "./UploadList";

export interface UploadsPanelProps {
  /** The pill: the popover hangs off its row and focus goes back to it. */
  anchorRef: RefObject<HTMLButtonElement | null>;
  phone: boolean;
  onClose: () => void;
}

export function UploadsPanel({ anchorRef, phone, onClose }: UploadsPanelProps) {
  const { t } = useTranslation();
  const items = useUploadQueue();
  const { active } = uploadQueueSummary(items);
  const title = active > 0 ? t("uploadList.uploading", { count: active }) : t("uploadList.title");
  // Opening a note moves focus into the note; pulling it back to the pill would undo that.
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
            data-testid="uploads-sheet"
            data-panel="uploads"
            aria-describedby={undefined}
            onCloseAutoFocus={restoreFocus}
            className={cn("fixed inset-0 z-50 flex flex-col bg-popover text-popover-foreground outline-none", SAFE_INSETS)}
          >
            <header className="flex items-center gap-2 border-b border-border px-3 py-2">
              <Button type="button" variant="ghost" size="sm" className="h-11" aria-label={t("uploadList.back")} onClick={onClose}>
                <span aria-hidden="true">‹</span> {t("uploadList.back")}
              </Button>
              <DialogPrimitive.Title className="text-sm font-semibold">{title}</DialogPrimitive.Title>
            </header>
            <UploadList items={items} onNavigate={handleNavigate} layout="sheet" />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    );
  }

  return (
    <SidebarPanel triggerRef={anchorRef} onClose={onClose} onCloseAutoFocus={restoreFocus} data-testid="uploads-popover" data-panel="uploads" aria-label={title}>
      <h2 className="-mx-1 -mt-1 truncate border-b border-border px-3 py-2 text-sm font-semibold">{title}</h2>
      <UploadList items={items} onNavigate={handleNavigate} layout="popover" />
    </SidebarPanel>
  );
}
