import { useLayoutEffect, useRef } from "react";
import { HexColorPicker } from "react-colorful";
import "./panel.css";

interface ColorfulPickerProps {
  color: string | undefined;
  onChange(hex: string): void;
  saturationLabel: string;
  hueLabel: string;
}

/**
 * 飽和度方塊＋色相滑桿。本檔是唯一 import `react-colorful` 的地方，由 `CustomColorPanel` 以 `lazy()` 載入，
 * 套件只進這個 chunk。react-colorful 的兩個 slider 的 `aria-label` 寫死英文，這裡在每次 render 後改成傳進來的字串：
 * React 只在 prop 值變動時才寫回 DOM，而它給的值是常數，所以覆寫會一直留著；不帶 deps 是為了換語言時跟著更新。
 */
export default function ColorfulPicker({ color, onChange, saturationLabel, hueLabel }: ColorfulPickerProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sliders = ref.current?.querySelectorAll('[role="slider"]');
    sliders?.[0]?.setAttribute("aria-label", saturationLabel);
    sliders?.[1]?.setAttribute("aria-label", hueLabel);
  });
  return (
    <div ref={ref}>
      <HexColorPicker color={color} onChange={onChange} />
    </div>
  );
}
