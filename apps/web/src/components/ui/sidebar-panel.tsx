import { useRef, type ReactNode, type RefObject } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { PANEL_PLACEMENT, PANEL_ROW_WIDTH, PANEL_SURFACE, SIDEBAR_PANEL_ANCHOR_ATTR } from "@/components/ui/panel-shell";
import { cn } from "@/lib/utils";

export interface SidebarPanelProps {
  /** The button that opened the panel: focus returns to it and a click on it toggles instead of close-then-reopen. */
  triggerRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCloseAutoFocus?: (event: Event) => void;
  "aria-label": string;
  "data-testid"?: string;
  children: ReactNode;
}

export function SidebarPanel({ triggerRef, onClose, onCloseAutoFocus, children, ...rest }: SidebarPanelProps) {
  const rowRef = useRef<HTMLElement | null>(null);
  if (rowRef.current === null) rowRef.current = triggerRef.current?.closest<HTMLElement>(`[${SIDEBAR_PANEL_ANCHOR_ATTR}]`) ?? null;
  const row = rowRef.current;
  const anchorRef = row !== null ? rowRef : triggerRef;
  return (
    <PopoverPrimitive.Root open onOpenChange={(open) => !open && onClose()}>
      <PopoverPrimitive.Anchor virtualRef={anchorRef} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          data-testid={rest["data-testid"]}
          aria-label={rest["aria-label"]}
          side="top"
          {...PANEL_PLACEMENT}
          onCloseAutoFocus={onCloseAutoFocus}
          onInteractOutside={(event) => {
            if (triggerRef.current?.contains(event.target as Node)) event.preventDefault();
          }}
          className={cn(
            PANEL_SURFACE,
            "flex max-h-[min(32rem,var(--radix-popover-content-available-height))] flex-col outline-none",
            PANEL_ROW_WIDTH,
          )}
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
