import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Switch } from "./switch";

/**
 * 開啟態的主題色沒有其他測試守著——`ShareDialog.test.tsx`／`SettingsAiSection.test.tsx`
 * 只斷言 `role="switch"` 與 `aria-checked`，從不檢查樣式。可重驗的事實（非「突變後
 * N 條全綠」這種會隨全套測試數量漂移、換一台機器就對不上的說法）：全樹 `grep -rn
 * 'bg-brand"' src --include="*.test.*"` 只命中這個檔案自己這一行——`bg-brand-soft`／
 * `bg-brand-soft-strong` 那幾個 token 有別的測試守著（`NoteList.test.tsx`／
 * `AppShell.layout.test.tsx`／`AiPanel.test.tsx`），但精確的 `bg-brand` 沒有，
 * 拿掉 `data-[state=checked]:bg-brand` 不會讓任何既有測試變紅。這裡補上：
 * 開啟態必須帶 `data-[state=checked]:bg-brand` 這個 class token（Tailwind 把整個
 * arbitrary-variant 名稱原樣寫進 `class`，CSS 才靠 `[data-state=checked]` 屬性選擇器決定
 * 何時生效——所以類名本身在任何狀態下都在，這裡守的是「這個 token 沒被拿掉」）。
 */
describe("Switch 開啟態主題色（樣式守衛）", () => {
  it("帶 data-[state=checked]:bg-brand class（拿掉就是靜默漂移）", () => {
    // `defaultChecked` 而不是 `checked readOnly`：Radix Switch 沒有 `readOnly` 這個
    // prop，受控寫法要配 `onCheckedChange`。vitest 走 esbuild 會把型別剝掉、測試照樣綠，
    // 只有 `tsc --noEmit` 抓得到——踩過一次。
    render(<Switch defaultChecked />);
    expect(screen.getByRole("switch")).toHaveClass("data-[state=checked]:bg-brand");
  });
});
