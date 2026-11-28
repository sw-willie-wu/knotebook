import { forwardRef, useCallback, useRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "./icons";
import { cn } from "@/lib/utils";
import { SheetViewportVars } from "./sheet-viewport";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

/** Exported for a non-modal dialog that must draw the same backdrop itself (Radix renders its Overlay only in modal mode). */
export const dialogOverlayClass =
  "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out " +
  "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0";

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(dialogOverlayClass, className)}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/**
 * `size="panel"` (management panels, the shortcuts dialog and the file viewer): the frame is transparent with no border or shadow (ManagementShell draws the tray and cards); a bottom sheet on phones.
 * Heights use `dvh`: iOS Safari's `vh` is taller than the visible height. `max-w` leaves each side at least the larger of 2vw and the left/right safe area (landscape edges stay out of the sensor area).
 * No built-in Close is rendered: the panel's right card has its own labelled ✕. The grid track is `minmax(0,1fr)`: an `auto` track grows with tray content and the right card would never scroll. `lg` was removed: using it is a type error.
 */
const dialogContentVariants = cva(
  "fixed left-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 outline-none " +
    "rounded-lg border border-border bg-popover text-popover-foreground shadow-lg duration-200 " +
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 " +
    "data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
  {
    variants: {
      size: {
        default:
          "max-w-lg p-6 " +
          // Phone: bottom sheet. With the keyboard up `--kb-inset` lifts it and `--kb-visible-h` caps its height so the top stays visible when iOS pans the visual viewport; taller content scrolls inside.
          // No transition: with `duration-200` on bottom/max-height the sheet lags the keyboard and wobbles on pan.
          "max-sm:inset-x-0 max-sm:bottom-(--kb-inset,0px) max-sm:top-auto max-sm:translate-x-0 max-sm:translate-y-0 " +
          "max-sm:max-w-none max-sm:max-h-[calc(var(--kb-visible-h,100dvh)*0.9)] max-sm:overflow-y-auto max-sm:transition-none " +
          "max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:pb-[max(1.5rem,env(safe-area-inset-bottom))] kb-sheet",
        panel:
          "p-0 bg-transparent border-0 shadow-none overflow-visible w-[96vw] h-[92dvh] " +
          "max-w-[calc(100vw-2*max(2vw,env(safe-area-inset-left),env(safe-area-inset-right)))] " +
          "grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] " +
          // Phone: full-width, nearly full-height sheet rising from the bottom (`kb-sheet`) with a gap above (at least 28px; safe area + 8px with a notch) so the dimmed page can be tapped to close: any narrower and touch target correction gives the tap to the sheet.
          // Height = visible height (`--kb-visible-h`, else `dvh`) minus the gap. The tray has no padding on phones; cards add their own safe-area padding (`managementCardPhoneInset`/`managementListPaddingPhone` in `management/tray.ts`),
          // and the card's "‹" steps back from the left safe area. No transition, same reason as the default size.
          "max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-(--kb-inset,0px) max-sm:w-full max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 " +
          "max-sm:h-[calc(var(--kb-visible-h,100dvh)_-_max(1.75rem,env(safe-area-inset-top)_+_0.5rem))] max-sm:transition-none " +
          "max-sm:rounded-t-xl max-sm:rounded-b-none max-sm:overflow-hidden max-sm:shadow-lg kb-sheet " +
          "md:w-[clamp(min(56rem,96vw),92vw,85rem)] md:h-[clamp(min(42rem,92dvh),88dvh,56rem)]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * `dismissOnOutside={false}` blocks only clicks/focus outside (`onInteractOutside`); Esc, X and cancel still close. Form dialogs pass false so a stray click doesn't discard input; no dirty-checking, since per-form dirty conditions are easy to get wrong. Confirm-only and read-only dialogs keep the default.
 * The caller's own `onInteractOutside` runs first; its `onPointerDownOutside`/`onFocusOutside` fire before that and are unaffected.
 */
export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof dialogContentVariants> & { dismissOnOutside?: boolean }
>(({ className, children, size, dismissOnOutside = true, onInteractOutside, style, ...props }, ref) => {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      contentRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // panel: ManagementShell puts its own ✕ in the right card; this only decides whether to render, no new prop.
  const renderBuiltInClose = size !== "panel";
  return (
    <DialogPortal>
      <DialogOverlay className="kb-sheet-overlay" />
      <DialogPrimitive.Content
        ref={setRefs}
        style={style}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (!dismissOnOutside) event.preventDefault();
        }}
      >
        <SheetViewportVars target={contentRef} />
        {children}
        {renderBuiltInClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm pointer-coarse:after:absolute pointer-coarse:after:-inset-3.5 pointer-coarse:after:content-[''] opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

export function DialogHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2", className)}
      {...props}
    />
  );
}

export const DialogTitle = forwardRef<
  ElementRef<typeof DialogPrimitive.Title>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn("text-lg font-semibold leading-none tracking-tight", className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

export const DialogDescription = forwardRef<
  ElementRef<typeof DialogPrimitive.Description>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
