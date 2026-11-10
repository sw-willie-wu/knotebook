import { isCustomColor } from "@knotebook/shared";

// #378：筆記裡的自訂色碼（小寫 #rrggbb）沒有預先寫好的 CSS，這裡依實際出現的色碼動態登記規則。
// 規則與 BlockNote 內建色同形、同特異度；每條各自 insertRule，單條被拒絕（例如不支援 :has）不影響其他。

export type CustomColorKind = "inline" | "block";
export type CustomColorProp = "textColor" | "backgroundColor";

export const CUSTOM_COLORS_STYLE_ID = "kb-custom-colors";

const ATTR: Record<CustomColorProp, string> = {
  textColor: "data-text-color",
  backgroundColor: "data-background-color",
};
const DECL: Record<CustomColorProp, string> = {
  textColor: "color",
  backgroundColor: "background-color",
};

/** 該組色碼要插的選擇器；呼叫端須先確認 hex 是正規形。 */
export function customColorSelectors(kind: CustomColorKind, prop: CustomColorProp, hex: string): string[] {
  if (kind === "inline") {
    const sel = `[data-style-type="${prop}"][data-value="${hex}"]`;
    return [sel, `.kn-present ${sel}`];
  }
  const attr = ATTR[prop];
  // 兩條 `.kn-present` 規則與 present.css 的內建色規則同形，當保險保留；
  // 簡報畫面由 e2e 46 的案例 7 涵蓋。
  return [
    `[${attr}="${hex}"]`,
    `.bn-block:has(> .bn-block-content[${attr}="${hex}"])`,
    `.kn-present [${attr}="${hex}"]`,
  ];
}

const registered = new Set<string>();

function getSheet(): CSSStyleSheet | null {
  let el = document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_COLORS_STYLE_ID;
    document.head.appendChild(el);
  }
  return el.sheet;
}

export function ensureCustomColor(kind: CustomColorKind, prop: CustomColorProp, hex: string): void {
  if (!isCustomColor(hex)) return;
  // prop 會被拼進選擇器；型別之外的值（來自 any／外部資料）一律不登記。
  if (prop !== "textColor" && prop !== "backgroundColor") return;
  const key = `${kind}|${prop}|${hex}`;
  if (registered.has(key)) return;
  registered.add(key);
  const sheet = getSheet();
  if (!sheet) return;
  for (const sel of customColorSelectors(kind, prop, hex)) {
    try {
      sheet.insertRule(`${sel} { ${DECL[prop]}: ${hex}; }`, sheet.cssRules.length);
    } catch {
      // 瀏覽器不認得這個選擇器（例如舊版沒有 :has）：略過這一條，其餘照登記。
    }
  }
}

export function resetCustomColorsForTest(): void {
  registered.clear();
  document.getElementById(CUSTOM_COLORS_STYLE_ID)?.remove();
}
