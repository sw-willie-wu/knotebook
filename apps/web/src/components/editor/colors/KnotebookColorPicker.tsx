import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { isCustomColor } from "@knotebook/shared";
import { useComponentsContext, useDictionary } from "@blocknote/react";
import { KeepOpenMenuItem } from "./KeepOpenMenuItem";
import type { ColorSection } from "./types";

const NAMED_COLORS = ["default", "gray", "brown", "red", "orange", "yellow", "green", "blue", "purple", "pink"] as const;

export interface ColorSectionProps {
  color: string;
  setColor(c: string): void;
  onCustom(e: MouseEvent): void;
}

interface KnotebookColorPickerProps {
  text?: ColorSectionProps;
  background?: ColorSectionProps;
  /** 「自訂…」的 `data-kb-color-return` 前綴：從面板按「返回」時用它找回要聚焦的項目，同一個 dropdown 內不可重複。 */
  returnPrefix: string;
}

/** 選單項目左側的色塊；`value` 為 undefined 時是空色塊。 */
function ColorSwatch({ section, value }: { section: ColorSection; value: string | undefined }) {
  const attr = section === "text" ? { "data-text-color": value } : { "data-background-color": value };
  return (
    <span {...attr} aria-hidden="true" className="bn-color-icon pointer-events-none h-4 w-4 text-xs leading-4">
      {value === undefined ? null : "A"}
    </span>
  );
}

function Section({ section, props, returnPrefix }: { section: ColorSection; props: ColorSectionProps; returnPrefix: string }) {
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const { t } = useTranslation();
  const { color, setColor, onCustom } = props;
  const custom = isCustomColor(color);
  return (
    <>
      <Components.Generic.Menu.Label>
        {section === "text" ? dict.color_picker.text_title : dict.color_picker.background_title}
      </Components.Generic.Menu.Label>
      {NAMED_COLORS.map((c) => (
        <Components.Generic.Menu.Item
          key={c}
          data-test={`${section}-color-${c}`}
          icon={<ColorSwatch section={section} value={c} />}
          checked={color === c}
          onClick={() => setColor(c)}
        >
          {dict.color_picker.colors[c]}
        </Components.Generic.Menu.Item>
      ))}
      {/* 點了要在同一個 dropdown 換成面板，所以不能像其他項目那樣關選單 */}
      <KeepOpenMenuItem
        data-test={`${section}-color-custom`}
        data-kb-color-return={`${returnPrefix}-${section}`}
        icon={<ColorSwatch section={section} value={custom ? color : undefined} />}
        checked={custom}
        onClick={onCustom}
      >
        {t("colors.custom")}
      </KeepOpenMenuItem>
    </>
  );
}

/**
 * 顏色選單的項目列表：文字色與底色兩段，各是 10 種內建色加一個「自訂…」。內建色的 `data-test` 與打勾規則
 * （目前值與色名完全相同才打勾）沿用 BlockNote 原生選單；「自訂…」只在目前值是正規形色碼時打勾，
 * 非正規形的舊值（例如外部貼上的 `rgb(…)`）哪一項都不勾。
 */
export function KnotebookColorPicker({ text, background, returnPrefix }: KnotebookColorPickerProps) {
  return (
    <>
      {text && <Section section="text" props={text} returnPrefix={returnPrefix} />}
      {background && <Section section="background" props={background} returnPrefix={returnPrefix} />}
    </>
  );
}
