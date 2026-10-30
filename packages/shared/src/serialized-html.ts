// 內部模組：`index.ts` 不 re-export（只給 `note-markdown-read.ts` 的 `toBlockHTML` 用）。

const START_TAG = /<[A-Za-z][^\s/>]*(?:\s+[^\s"'>/=]+="[^"]*")*\s*\/?>/g;
// 註解與 raw-text 元素的內容原樣序列化（字面 `<` 不必是標籤開頭），下面的前提不成立。
const UNSAFE = /<!--|<(?:script|style|xmp|iframe|noembed|noframes|noscript|plaintext|textarea|title)\b/i;

/**
 * 屬性值裡的 `&lt;`／`&gt;` 換回字面 `<`／`>`：瀏覽器的新版序列化會跳脫它們（Chromium 151、Firefox 153、WebKit 26.5
 * 實測相同），jsdom 30 不會；server 與 web 的讀出要逐位元組相同（spec §13.1），統一成 jsdom 的形。
 *
 * 前提：輸入是 DOM 序列化（`innerHTML`）的輸出，且不含註解與 raw-text 元素——此時文字裡的 `<` 一律是 `&lt;`，
 * 字面 `<` 必是標籤開頭；屬性值裡的 `"` 一律是 `&quot;`、`&` 一律是 `&amp;`。含註解或 raw-text 元素時原樣回傳。
 */
export function unescapeAttributeAngles(html: string): string {
  if (!html.includes("&lt;") && !html.includes("&gt;")) return html;
  if (UNSAFE.test(html)) return html;
  return html.replace(START_TAG, tag => tag.replace(/="[^"]*"/g, v => v.replaceAll("&lt;", "<").replaceAll("&gt;", ">")));
}
