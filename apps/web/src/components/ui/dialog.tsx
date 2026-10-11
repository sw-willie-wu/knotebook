import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "./icons";
import { cn } from "@/lib/utils";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogPortal = DialogPrimitive.Portal;
export const DialogClose = DialogPrimitive.Close;

export const DialogOverlay = forwardRef<
  ElementRef<typeof DialogPrimitive.Overlay>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      "fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out " +
        "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

/** `size="default"`＝既有的單欄表單 dialog 尺寸（NoteList/ShareDialog 既有用法，
 * 未傳 `size` 時行為零變）；`lg` 已於 #247 刪除：再用會直接型別錯誤，比照 `button.tsx` 刪 `secondary`
 * 的做法，不靠 grep 測試；`size="panel"`＝三個管理面板（`components/management/ManagementShell.tsx`，#247 §4.1／§4.6）：
 * 外框本身透明無邊、不投影，托盤與兩張卡由 ManagementShell 自己畫；窄視窗 `96vw × 92vh`，
 * `md:` 以上 `92vw × 88vh` 夾在 896×672～1360×896 之間。`panel` 時**不渲染內建 Close**——
 * 面板在右卡自己放一顆帶 i18n 名稱的 ✕（§4.5），這裡再放就會有兩顆 Close。 */
const dialogContentVariants = cva(
  "fixed left-1/2 top-1/2 z-50 grid w-full -translate-x-1/2 -translate-y-1/2 gap-4 " +
    "rounded-lg border border-border bg-popover text-popover-foreground shadow-lg duration-200 " +
    "data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 " +
    "data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
  {
    variants: {
      size: {
        default: "max-w-lg p-6",
        panel:
          "p-0 bg-transparent border-0 shadow-none overflow-visible w-[96vw] h-[92vh] " +
          "md:w-[clamp(min(56rem,96vw),92vw,85rem)] md:h-[clamp(min(42rem,92vh),88vh,56rem)]",
      },
    },
    defaultVariants: { size: "default" },
  },
);

/**
 * `dismissOnOutside`（預設 `true`＝Radix 預設行為，零變）：設為 `false` 時，**只**擋「點對話框外面」
 * （Radix `onInteractOutside`＝pointerDownOutside＋focusOutside，含焦點移出）。Esc、右上 X、
 * 取消鈕照常關閉。
 *
 * 表單型對話框（有使用者可輸入的欄位、由此對話框送出）一律傳 `false`：誤點周圍就丟掉已填內容。
 * 刻意不做「有填過才擋」的 dirty 判斷——各表單的 dirty 條件（預設值、trim、select 回到初值…）
 * 很容易判錯，一律擋最簡單也最不會漏。純確認型／唯讀型對話框維持預設。
 *
 * 呼叫端自己傳的 `onInteractOutside` 會先被呼叫，再套這個守衛（不吞呼叫端 handler）；
 * 呼叫端另傳的 `onPointerDownOutside`／`onFocusOutside` 由 Radix 先於 `onInteractOutside` 觸發，不受影響。
 */
export const DialogContent = forwardRef<
  ElementRef<typeof DialogPrimitive.Content>,
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content> &
    VariantProps<typeof dialogContentVariants> & { dismissOnOutside?: boolean }
>(({ className, children, size, dismissOnOutside = true, onInteractOutside, ...props }, ref) => {
  // #247 §4.1：panel 由 ManagementShell 在右卡放自己的 ✕；這裡只決定要不要渲染，不新增 prop。
  const renderBuiltInClose = size !== "panel";
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(dialogContentVariants({ size }), className)}
        {...props}
        onInteractOutside={(event) => {
          onInteractOutside?.(event);
          if (!dismissOnOutside) event.preventDefault();
        }}
      >
        {children}
        {renderBuiltInClose && (
          <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none">
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
