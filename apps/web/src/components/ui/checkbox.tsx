import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { Check } from "./icons";
import { cn } from "@/lib/utils";

/**
 * 勾選框（Radix Checkbox）——用在**表單欄位**的布林設定（按下送出鈕才生效，
 * 例如建立/編輯表單裡的 isDefault、isAdmin）。立即生效的開關請用同目錄的
 * `Switch`，不要用這顆——見該檔 JSDoc。
 *
 * 角色維持 `role="checkbox"`（Radix Checkbox 就渲染這個），`toBeChecked()`
 * 斷言（看 `aria-checked`）不受影響；但它是 `<button>` 不是 `<input>`，用
 * `fireEvent.change(...{target:{checked:true}})` 的舊測試寫法會失效，要改成
 * `fireEvent.click(...)`。
 *
 * 尺寸 16×16px（`h-4 w-4`），跟原生 `<input type="checkbox">` 的既有慣例
 * （`h-4 w-4 rounded border-input`）對齊；**點擊目標**由外層排版（既有的
 * `flex items-center gap-2`）撐大，不靠本體放大。
 *
 * 勾勾用 `components/ui/icons.tsx` 既有的 `Check`；勾選態 `bg-brand`（跟隨主題色）、
 * 未勾選是透明底＋`border-input`（比照原生 checkbox 未勾態）。focus 樣式比照
 * `button.tsx`：`focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`。
 */
export const Checkbox = forwardRef<
  ElementRef<typeof CheckboxPrimitive.Root>,
  ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "peer h-4 w-4 shrink-0 rounded-sm border border-input bg-background shadow-sm transition-colors " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
        "disabled:cursor-not-allowed disabled:opacity-50 " +
        "data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-fg",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator className="flex items-center justify-center text-current">
      <Check className="h-3.5 w-3.5" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));
Checkbox.displayName = CheckboxPrimitive.Root.displayName;
