import DOMPurify, { type Config } from "dompurify";
import { COLUMN_WIDTH_MAX, COLUMN_WIDTH_MIN, COLUMNS_STYLE } from "@knotebook/shared";

/**
 * #229 簡報投影片的消毒器（承重守衛）。
 *
 * 四層保證：①BlockNote 以 DOM API 產生 HTML，文字一律是文字節點；②`<template>` 解析成 inert
 * fragment；③**這裡**：DOMPurify 私有實例、白名單逐鍵寫死；④唯一的 `innerHTML` 是 mermaid SVG，信任
 * `lib/mermaid.ts` 的鎖定設定、在消毒之後產生（postprocess.ts）。③的 `style` 只在並排的列與欄上、且逐字是正規形時保留
 * ，其他元素照舊剝。
 *
 * - 私有實例：mermaid 11 在 DOMPurify **預設單例**上掛常駐 hook，我們的 hook 若掛單例會反過來
 *   影響 mermaid 的淨化。本檔只准 `DOMPurify(window)`；源碼守衛在 sanitize.test.ts。
 * - hook 在**模組頂層**註冊一次（在函式內 addHook 會每次呼叫疊一層；守衛在 sanitize.hooks.test.ts）。
 * - 元素 hook 先於屬性 hook：input 的去留在 `uponSanitizeElement` 決定。
 * - `ADD_URI_SAFE_ATTR`：白名單 data-* 不是 URL，值不得走 URI 檢查（"Meeting: notes" 會被刪）。
 * - 小寫 `data:` 是 DOMPurify 自己放行（DATA_URI_TAGS）、要由我們擋的那一形。
 */
const ALLOWED_DATA = [
  "data-text-color", "data-background-color", "data-style-type", "data-value",
  "data-text-alignment", "data-inline-content-type", "data-target-note-id", "data-snapshot-title",
  "data-label", "data-anchor-block-id",
  "data-kn-mermaid", "data-kn-media",
  "data-kb-columns", "data-kb-column",
];

/** 欄的正規形 `flex:N`（N 去尾端 0、至多兩位小數）；數值另夾 [0.1, 10]。 */
const COLUMN_FLEX_RE = /^flex:(?:0|[1-9][0-9]?)(?:\.[0-9]{1,2})?$/;

function canonicalColumnsStyle(el: Element, value: string): boolean {
  if (el.nodeName !== "DIV") return false;
  if (el.hasAttribute("data-kb-columns")) return value === COLUMNS_STYLE;
  if (!el.hasAttribute("data-kb-column") || !COLUMN_FLEX_RE.test(value)) return false;
  const width = Number(value.slice("flex:".length));
  return width >= COLUMN_WIDTH_MIN && width <= COLUMN_WIDTH_MAX;
}

const purify = DOMPurify(window);

// 型別寫成 Config＋RETURN_DOM_FRAGMENT（`as const` 的唯讀陣列不能給 Config 的可變陣列，tsc 會擋）。
const CFG: Config & { RETURN_DOM_FRAGMENT: true } = {
  ALLOWED_TAGS: ["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "pre", "code",
    "strong", "b", "em", "i", "u", "s", "del", "span", "a", "br", "table", "colgroup", "col", "thead", "tbody",
    "tr", "th", "td", "figure", "figcaption", "img", "video", "audio", "details", "summary", "input", "div", "#text"],
  ALLOWED_ATTR: ["href", "src", "alt", "width", "type", "checked", "colspan", "rowspan", "start", "open", "style", ...ALLOWED_DATA],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
  ADD_URI_SAFE_ATTR: ALLOWED_DATA,
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  KEEP_CONTENT: true,
  RETURN_DOM_FRAGMENT: true,
};

/** 去掉 ASCII 空白與 C0 控制字元（瀏覽器解析網址時會丟掉它們）後轉小寫。 */
function normalizedScheme(value: string): string {
  return value.replace(/[\u0000-\u0020]/g, "").toLowerCase();
}

purify.addHook("uponSanitizeElement", (node, data) => {
  if (data.tagName !== "input") return;
  const type = ((node as Element).getAttribute("type") ?? "").trim().toLowerCase();
  if (type !== "checkbox") (node as Element).remove();
});

purify.addHook("uponSanitizeAttribute", (node, data) => {
  if (data.attrName === "src") {
    const scheme = normalizedScheme(data.attrValue);
    if (scheme.startsWith("data:") || scheme.startsWith("mailto:")) data.keepAttr = false;
  } else if (data.attrName === "href" && (node as Element).nodeName.toLowerCase() !== "a") {
    data.keepAttr = false;
  } else if (data.attrName === "style" && !canonicalColumnsStyle(node as Element, data.attrValue)) {
    data.keepAttr = false;
  }
});

export function sanitizeSlideFragment(input: string | DocumentFragment): DocumentFragment {
  return purify.sanitize(input, CFG) as unknown as DocumentFragment;
}
