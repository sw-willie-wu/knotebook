import { forwardRef, useSyncExternalStore, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { Toast as ToastPrimitive } from "radix-ui";
import { X } from "./icons";
import { cn } from "@/lib/utils";

// 精簡版 shadcn toast：Radix Toast 原語 + 一個模組層級的 pub/sub store 給
// `toast()` 這個 imperative API 用（元件樹任何地方呼叫都能推新 toast），
// 不搬 shadcn 完整版的 reducer/action 那一套——Task 11+ 目前只需要「顯示一則
// 訊息、可帶 variant、會自動消失」。

export type ToastVariant = "default" | "destructive";

export interface ToastItem {
  id: string;
  title?: string;
  description?: string;
  variant?: ToastVariant;
  durationMs?: number;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(toasts);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): ToastItem[] {
  return toasts;
}

export function dismissToast(id: string): void {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

export function toast(item: Omit<ToastItem, "id">): string {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, durationMs: 5000, ...item }];
  emit();
  return id;
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = forwardRef<
  ElementRef<typeof ToastPrimitive.Viewport>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      "fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-[420px]",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: "border-border bg-background text-foreground",
  destructive: "border-destructive bg-destructive text-destructive-foreground",
};

export const ToastRoot = forwardRef<
  ElementRef<typeof ToastPrimitive.Root>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Root> & { variant?: ToastVariant }
>(({ className, variant = "default", ...props }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(
      "pointer-events-auto relative flex w-full items-center justify-between gap-4 overflow-hidden " +
        "rounded-md border p-4 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out " +
        "data-[swipe=end]:animate-out data-[state=closed]:fade-out-80 data-[state=closed]:slide-out-to-right-full " +
        "data-[state=open]:slide-in-from-top-full data-[state=open]:sm:slide-in-from-bottom-full",
      VARIANT_CLASSES[variant],
      className,
    )}
    {...props}
  />
));
ToastRoot.displayName = ToastPrimitive.Root.displayName;

export const ToastTitle = forwardRef<
  ElementRef<typeof ToastPrimitive.Title>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title ref={ref} className={cn("text-sm font-semibold", className)} {...props} />
));
ToastTitle.displayName = ToastPrimitive.Title.displayName;

export const ToastDescription = forwardRef<
  ElementRef<typeof ToastPrimitive.Description>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description ref={ref} className={cn("text-sm opacity-90", className)} {...props} />
));
ToastDescription.displayName = ToastPrimitive.Description.displayName;

export const ToastClose = forwardRef<
  ElementRef<typeof ToastPrimitive.Close>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      "absolute right-2 top-2 rounded-md p-1 text-foreground/50 opacity-0 transition-opacity " +
        "hover:text-foreground focus:opacity-100 focus:outline-none group-hover:opacity-100",
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-4 w-4" />
  </ToastPrimitive.Close>
));
ToastClose.displayName = ToastPrimitive.Close.displayName;

/** 掛在 App 根部一次即可；監聽 toast() store，渲染目前所有存活的 toast。 */
export function Toaster(): ReactNode {
  const items = useToasts();
  return (
    <ToastProvider>
      {items.map(({ id, title, description, variant, durationMs }) => (
        <ToastRoot
          key={id}
          variant={variant}
          duration={durationMs}
          onOpenChange={(open) => {
            if (!open) dismissToast(id);
          }}
        >
          <div className="grid gap-1">
            {title && <ToastTitle>{title}</ToastTitle>}
            {description && <ToastDescription>{description}</ToastDescription>}
          </div>
          <ToastClose />
        </ToastRoot>
      ))}
      <ToastViewport />
    </ToastProvider>
  );
}
