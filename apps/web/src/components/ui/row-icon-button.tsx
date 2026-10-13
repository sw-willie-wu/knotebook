import { forwardRef, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import { ROW_ICON_BUTTON, ROW_ICON_DANGER } from "@/components/management/row-actions";
import { cn } from "@/lib/utils";
import { Button } from "./button";

type ButtonProps = ComponentPropsWithoutRef<typeof Button>;

export type RowIconButtonProps = Omit<ButtonProps, "variant" | "size" | "children" | "aria-label" | "title" | "asChild" | "aria-disabled"> & {
  /** 可及名稱，同時當 `title`（spec §4.9：列內 icon 鈕必帶 title 與 aria-label）。 */
  label: string;
  icon: ReactNode;
  /** `destructive`＝紅色線條（解除連結、移除成員、撤銷、刪除）；**不是** `destructive` 變體——列內不出現實心紅鈕（§4.8）。 */
  tone?: "default" | "destructive";
  /**
   * 不可用但仍要讓人看得到原因（例如最後一位管理員不能移除）：`aria-disabled`（class 常數的 `aria-disabled:opacity-40`）、`title` 換成
   * `softDisabledReason`，點了不觸發。不用原生 `disabled`：`disabled:pointer-events-none` 會讓 `title` 永遠浮不出來。
   * 對 `DialogTrigger asChild`，`handleClick` 的兩道各自都擋得住開啟：不轉呼叫注入的 `onClick`；或 `preventDefault()`
   * （Radix 的 `composeEventHandlers` 見 `defaultPrevented` 就不呼叫 `onOpenToggle`）。`preventDefault()` 另外擋
   * `type="submit"` 在 form 裡的送出；一般 `onClick` 則只靠不轉呼叫。只攔 click：`onPointerDown`／`onKeyDown` 照樣轉傳，
   * 所以不適合當 `DropdownMenuTrigger`。
   */
  softDisabled?: boolean;
  softDisabledReason?: string;
};

/**
 * 表格列與角色卡上的動作鈕（#247 spec §4.9，W20／W21）：`ghost`＋`size="icon"`（32px），圖示由呼叫端給
 * （`h-4 w-4`）。鉛筆＝編輯、插頭＝測試連線、紅垃圾桶（`tone="destructive"`）＝危險動作。
 */
export const RowIconButton = forwardRef<HTMLButtonElement, RowIconButtonProps>(
  ({ label, icon, tone = "default", softDisabled = false, softDisabledReason, className, onClick, ...props }, ref) => {
    function handleClick(event: MouseEvent<HTMLButtonElement>): void {
      if (softDisabled) {
        event.preventDefault();
        return;
      }
      onClick?.(event);
    }
    return (
      <Button
        ref={ref}
        type="button"
        {...props}
        variant="ghost"
        size="icon"
        aria-label={label}
        title={softDisabled && softDisabledReason !== undefined ? softDisabledReason : label}
        aria-disabled={softDisabled || undefined}
        className={cn(
          "shrink-0",
          tone === "destructive" ? ROW_ICON_DANGER : cn(ROW_ICON_BUTTON, "aria-disabled:opacity-40"),
          softDisabled && "cursor-not-allowed",
          className,
        )}
        onClick={handleClick}
      >
        {icon}
      </Button>
    );
  },
);
RowIconButton.displayName = "RowIconButton";
