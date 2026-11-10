import { lazy, Suspense, useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { isCustomColor } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { readRecentColors } from "@/lib/recent-colors";
import { parseHexInput } from "./hex-input";
import type { PanelRequest } from "./types";

const ColorfulPicker = lazy(() => import("./ColorfulPicker"));

interface CustomColorPanelProps {
  request: PanelRequest;
  onBack(): void;
  onApply(hex: string): void;
  ref?: Ref<HTMLDivElement>;
}

/** 開面板時色碼框的初始值：目前的自訂色，沒有就用上次套用的，再沒有就只放 `#`。 */
function initialHex(current: string): string {
  if (isCustomColor(current)) return current;
  return readRecentColors()[0] ?? "#";
}

/**
 * 根選單 dropdown 裡的自訂色面板：飽和度方塊與色相（lazy 載入）、預覽、色碼框、「套用」、最近用過。
 * 拖曳或輸入只改面板裡的預覽；按「套用」、在色碼框按 Enter、點最近用過的色塊才呼叫 `onApply`。
 * 按鈕都是一般 `<button>`，不是 Menu.Item：Menu.Item 的 tabIndex 是 -1，Tab 走不到。
 */
export function CustomColorPanel({ request, onBack, onApply, ref }: CustomColorPanelProps) {
  const { t } = useTranslation();
  const errorId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => initialHex(request.current));
  const [shown, setShown] = useState<string | undefined>(() => parseHexInput(text) ?? undefined);
  const [recent] = useState(readRecentColors);
  const parsed = parseHexInput(text);
  // 只有 `#` 或空白時是還沒輸入，不標錯；但仍不能套用。
  const invalid = parsed === null && text.trim() !== "" && text.trim() !== "#";

  // 被點的「自訂…」隨項目列表卸載，焦點會掉到 body；根選單把 dropdown 外的 keydown 當成點外面而關閉，
  // 所以掛上時一定把焦點放進面板。滑鼠、觸控板或鍵盤開啟時放到色碼框；觸控時放在面板根，不叫出螢幕鍵盤。
  useLayoutEffect(() => {
    const fine = window.matchMedia?.("(pointer: fine)").matches ?? false;
    const target = fine || request.byKeyboard ? inputRef.current : rootRef.current;
    target?.focus({ preventScroll: true });
    // 只在掛上時決定一次焦點
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 固定的 callback ref：每次 render 換一個新函式，React 會先以 null 再以節點重呼叫一次
  const setRootRef = useCallback(
    (node: HTMLDivElement | null) => {
      rootRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const update = (value: string) => {
    setText(value);
    const hex = parseHexInput(value);
    if (hex) setShown(hex);
  };

  // Mantine 的 MenuDropdown 會對 ArrowUp／ArrowDown preventDefault 並把焦點移到選單項，色碼框的游標就動不了，
  // 所以只擋這兩個鍵。其他鍵（Tab、Escape）一定要放行：stopPropagation 會讓事件到不了 document，
  // 而 dropdown 的 Tab 繞回、工具列的 focus trap 與點外面關選單都掛在 document 上。
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") e.stopPropagation();
  };

  const previewAttr = request.section === "text" ? { "data-text-color": shown } : { "data-background-color": shown };

  return (
    <div
      ref={setRootRef}
      // 寬度＝react-colorful 固定的 200px 加左右 p-1；背景與字色自己吃 BlockNote 選單的變數，不依賴外框
      className="kb-color-panel flex w-[208px] flex-col gap-2 bg-(--bn-colors-menu-background) p-1 text-(--bn-colors-menu-text) outline-none"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <Button type="button" variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <span aria-hidden="true">←</span>
        {t("colors.back")}
      </Button>
      <Suspense fallback={<div data-kb-color-picker-fallback="" className="h-[200px] w-[200px]" />}>
        <ColorfulPicker
          color={shown}
          onChange={update}
          saturationLabel={t("colors.saturation_label")}
          hueLabel={t("colors.hue_label")}
        />
      </Suspense>
      <div className="flex items-center gap-2">
        <span
          {...previewAttr}
          aria-hidden="true"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-input text-sm"
        >
          Aa
        </span>
        <Input
          ref={inputRef}
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            // 輸入法選字時的 Enter 是確認選字，不是套用
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (parsed) onApply(parsed);
          }}
          aria-label={t("colors.hex_label")}
          placeholder={t("colors.hex_placeholder")}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          className={invalid ? "min-w-0 flex-1 border-destructive" : "min-w-0 flex-1"}
        />
      </div>
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {t("colors.hex_invalid")}
        </p>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="border border-input"
        disabled={parsed === null}
        onClick={() => {
          if (parsed) onApply(parsed);
        }}
      >
        {t("colors.apply")}
      </Button>
      {recent.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="px-1 text-xs text-muted-foreground">{t("colors.recent")}</div>
          <div className="flex flex-wrap gap-0.5">
            {recent.map((hex) => (
              <Button key={hex} type="button" variant="ghost" size="icon" aria-label={hex} onClick={() => onApply(hex)}>
                <span data-background-color={hex} className="h-5 w-5 rounded-sm border border-input" />
              </Button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
