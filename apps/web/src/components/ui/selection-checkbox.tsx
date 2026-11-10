import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, type ChangeEvent, type InputHTMLAttributes } from "react";
import type { SelectAllState } from "@/lib/sidebar-selection";
import { cn } from "@/lib/utils";
import { Check, Minus } from "./icons";

/**
 * 選取模式的勾選框：14px、方形小圓角、自己畫。
 * 仍是原生 `<input type="checkbox">`（`appearance-none`）——Shift 範圍讀原生 click 的 `shiftKey`、`<label>` 轉送點擊、
 * 鍵盤與 `getByRole("checkbox")` 都不變；勾與橫線是疊在上面的 svg（`peer-checked:`／`peer-indeterminate:` 顯示），
 * 勾選態＝主色底＋`text-brand-fg`（比照 `checkbox.tsx`）。
 * 只准經 `SelectLazy`／`TrashLazy` 鏈引用（首包不得 import）。
 */
export interface SelectionCheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> {
  /** 半勾。為真時 input 的 checked 一律 false（半勾優先，兩者不會同時畫）。 */
  indeterminate?: boolean;
  /** 套在外層 span（排版用，例如 `mt-0.5`）。 */
  className?: string;
}

export const SelectionCheckbox = forwardRef<HTMLInputElement, SelectionCheckboxProps>(function SelectionCheckbox(
  { indeterminate = false, className, checked, onChange, ...rest },
  ref,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current as HTMLInputElement);
  // indeterminate 只能由 JS 寫。不帶 deps：每次 commit 都重寫，瀏覽器在 click 時清掉的半勾態也會被補回。
  useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  });
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    // 瀏覽器在 click 時把 indeterminate 清掉；上層若沒換狀態就不會重繪，這裡先寫回目前的 prop 值。
    event.currentTarget.indeterminate = indeterminate;
  };
  return (
    <span className={cn("relative inline-flex h-3.5 w-3.5 shrink-0", className)}>
      <input
        {...rest}
        ref={inputRef}
        type="checkbox"
        checked={indeterminate ? false : checked}
        onChange={handleChange}
        className="peer h-3.5 w-3.5 shrink-0 cursor-pointer appearance-none rounded-sm border border-muted-foreground bg-transparent checked:border-brand checked:bg-brand indeterminate:border-brand indeterminate:bg-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
      />
      <Check aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto hidden h-2.5 w-2.5 text-brand-fg peer-checked:block peer-disabled:opacity-50" />
      <Minus aria-hidden="true" strokeWidth={3} className="pointer-events-none absolute inset-0 m-auto hidden h-2.5 w-2.5 text-brand-fg peer-indeterminate:block peer-disabled:opacity-50" />
    </span>
  );
});

/** 三態全選框（一般 tab 與垃圾桶共用）。 */
export function SelectAllCheckbox({
  state,
  disabled,
  onToggle,
  label,
  title,
}: {
  state: SelectAllState;
  disabled?: boolean;
  /** 點下去：state 是 "all" → 呼叫端清空；否則 → 呼叫端全選可見列。 */
  onToggle: () => void;
  label: string;
  title: string;
}) {
  // 外層 24px 也帶同字 title：14px 的框旁邊（這一格裡）滑過也有提示。
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center" title={title}>
      <SelectionCheckbox
        checked={state === "all"}
        indeterminate={state === "some"}
        disabled={disabled}
        aria-label={label}
        title={title}
        onChange={onToggle}
      />
    </span>
  );
}
