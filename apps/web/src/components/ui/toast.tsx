import { forwardRef, useSyncExternalStore, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Toast as ToastPrimitive } from "radix-ui";
import { X } from "./icons";
import { cn } from "@/lib/utils";
import { Button } from "./button";

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
  /** 動作鈕（#175 PR2「前往副本」）。點擊先跑 onClick、再由 Radix 關閉該 toast。 */
  action?: { label: string; onClick: () => void; /** 給無法操作 toast 的螢幕閱讀器使用者；未填時用 label。 */ altText?: string };
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

// id 產生器：不用 crypto.randomUUID——非 secure context（LAN plain-http，
// rev 5.6 正當拓撲，如 http://192.168.3.22:8006）不存在該 API，會令每次
// toast() 拋 TypeError；jsdom/Node 有 polyfill 所以測試抓不到。id 只需
// session 內唯一供 dismiss 比對，無安全需求，模組層級遞增計數器即可。
let toastIdSeq = 0;

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

/** 清掉目前所有 toast。store 是模組層級的，測試之間必須自行歸零才不會互相污染。 */
export function dismissAllToasts(): void {
  toasts = [];
  emit();
}

export function toast(item: Omit<ToastItem, "id">): string {
  const id = `toast-${++toastIdSeq}`;
  toasts = [...toasts, { id, durationMs: 5000, ...item }];
  emit();
  return id;
}

export function useToasts(): ToastItem[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ── viewport 的落腳處 ──────────────────────────────────────────────────────────
// 平常 ToastViewport 就渲染在 Toaster 所在處（`#root` 裡）。窄螢幕的側欄抽屜是 modal Radix Dialog：開著時
// `hideOthers` 把抽屜以外全標成 aria-hidden、FocusScope 把焦點鎖在抽屜裡，留在原處的 toast（與它的「Undo」）
// 螢幕閱讀器讀不到、鍵盤也到不了。所以抽屜開著時由 AppShell 登記抽屜內容裡的一個空節點，Toaster 把 viewport
// portal 進去；抽屜關了（節點卸載）就清掉、viewport 回原處。toast 本身的狀態與計時器在 Toaster 底下的 Radix
// Toast 元件裡，viewport 換位置不會重設它們。
// 但 viewport 換位置會讓每則 toast 重新登記成最上層的 DismissableLayer：開抽屜前就在的 toast 會吃掉抽屜裡的第一下
// Esc（關 toast、抽屜不關），與抽屜開著時才跳的 toast 一樣（e2e 38 A2c-7）。

let viewportHost: HTMLElement | null = null;
const viewportHostListeners = new Set<() => void>();

function subscribeViewportHost(listener: () => void): () => void {
  viewportHostListeners.add(listener);
  return () => viewportHostListeners.delete(listener);
}

function getViewportHost(): HTMLElement | null {
  return viewportHost;
}

function setViewportHost(host: HTMLElement | null): void {
  viewportHost = host;
  for (const listener of viewportHostListeners) listener();
}

/**
 * 給 modal 容器（目前只有側欄抽屜）用的 callback ref：掛上就把 toast viewport 搬進這個節點，卸載時搬回原處。
 * 卸載時只清自己登記的那個：別的容器已接手的話不動它。
 *
 * ⚠ viewport 是 `position: fixed`：容器（與它的祖先）不可加 transform／filter／perspective，否則 fixed 會改以
 * 容器為準、toast 跟著跑進抽屜的框裡。
 */
export function toastViewportHostRef(host: HTMLElement | null): (() => void) | undefined {
  if (!host) return undefined;
  setViewportHost(host);
  return () => {
    if (viewportHost === host) setViewportHost(null);
  };
}

export const ToastProvider = ToastPrimitive.Provider;

export const ToastViewport = forwardRef<
  ElementRef<typeof ToastPrimitive.Viewport>,
  ComponentPropsWithoutRef<typeof ToastPrimitive.Viewport>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Viewport
    ref={ref}
    className={cn(
      // `pointer-events-none`（#115）：viewport 空著的時候仍是右下角一塊 fixed 命中
      // 區，會蓋住右下角歷史泡泡的下緣；toast item 自己帶 `pointer-events-auto`（見
      // ToastRoot），互動不受影響。
      "pointer-events-none fixed bottom-0 right-0 z-[100] flex max-h-screen w-full flex-col gap-2 p-4 sm:max-w-[420px]",
      className,
    )}
    {...props}
  />
));
ToastViewport.displayName = ToastPrimitive.Viewport.displayName;

const VARIANT_CLASSES: Record<ToastVariant, string> = {
  default: "border-border bg-popover text-popover-foreground",
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
        "rounded-md border p-4 pr-8 shadow-lg data-[state=open]:animate-in data-[state=closed]:animate-out " +
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
  const host = useSyncExternalStore(subscribeViewportHost, getViewportHost, getViewportHost);
  return (
    <ToastProvider>
      {items.map(({ id, title, description, variant, durationMs, action }) => (
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
          {action && (
            <ToastPrimitive.Action asChild altText={action.altText ?? action.label}>
              <Button type="button" variant="outline" size="sm" onClick={action.onClick}>
                {action.label}
              </Button>
            </ToastPrimitive.Action>
          )}
          <ToastClose />
        </ToastRoot>
      ))}
      {host ? createPortal(<ToastViewport />, host) : <ToastViewport />}
    </ToastProvider>
  );
}
