import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * 開關（toggle，Radix Switch）——用在**立即生效**的設定（分享面板的匿名連結、
 * AI 設定的 provider/model/action enabled）。表單欄位那種「按下送出才生效」的
 * 布林設定請用同目錄的 `Checkbox`，不要用這顆——語意不同，見兩檔案各自的
 * JSDoc（`settings/SettingsAiSection.tsx` 的 isDefault vs enabled 分野）。
 *
 * ⚠ **可及性角色是 `role="switch"`，不是 `role="checkbox"`**——原生
 * `<input type="checkbox">` 換成這顆之後，任何用 `getByRole("checkbox", …)` 找它
 * 的測試都要改成 `getByRole("switch", …)`（2026-09-17 全站 checkbox 換 toggle
 * 那次改動，`ShareDialog.test.tsx`／`SettingsAiSection.test.tsx` 踩過這個雷）。
 *
 * 尺寸：軌道 28×16px（`h-4 w-7`），比 `button.tsx` 定的 32px 控制項高度矮——這是
 * 刻意的，toggle 本體視覺上本來就該比方塊按鈕小一號；但**點擊目標**就是 Radix
 * 渲染的那顆 `<button>` 本身，不會因為軌道矮而縮小，不必額外撐 hit box。
 *
 * 開啟態用主題色 `bg-brand`（跟著使用者選的莫蘭迪主題色走）、關閉態 `bg-input`
 * （與其他控制項的邊框色同語彙）。focus 樣式比照 `button.tsx`：
 * `focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2`。
 */
export const Switch = forwardRef<
  ElementRef<typeof SwitchPrimitive.Root>,
  ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      "peer inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full border border-transparent " +
        "transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 " +
        "data-[state=checked]:bg-brand data-[state=unchecked]:bg-input",
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className="pointer-events-none block h-3 w-3 rounded-full bg-background shadow-sm ring-0 transition-transform data-[state=checked]:translate-x-3.5 data-[state=unchecked]:translate-x-0.5"
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;
