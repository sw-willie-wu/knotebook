import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Radix Tooltip 薄包裝（#293）。呼叫端的 Trigger 一律另傳 `aria-describedby={undefined}`：
 * Radix 1.2.16 先放 `aria-describedby` 再展開 props（`react-tooltip dist/index.mjs:186-188`），
 * 呼叫端的 `aria-label` 已含全部資訊，不覆寫會重複朗讀（M-g）。
 */
export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof TooltipPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-64 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
