/**
 * #108 §8.1「回應大小上限表」的**唯一**落點（M16）。三個數字只在這裡出現一次。
 *
 * `N ＝ 262 144`（一次 wire 回應的上限）**不在這裡**：它是**哨兵不是目標值**——破了代表
 * 下面某條逐欄上限漏接，而不是「該調大 N」。它的落點是 `test/mcp-size.test.ts`（Task 5）。
 * ⚠ 量的對象是 **wire 回應**不是 payload：D11 的鏡像讓同一份 payload 在回應裡出現兩次
 * （第二次還被 JSON 逃脫），`wire ≈ 2.1 × payload`——改量 payload 會讓這筆成本消失在哨兵眼前。
 */

/**
 * 任何回給模型的 `heading`／`title`／群組 `owner.name` 的上限——以 **JSON 逃脫後**的長度計
 * （UTF-16 code unit，不含兩端引號；#177）。不需要逃脫的文字＝原長度，所以一般文字照舊是 200。
 */
export const MCP_TEXT_MAX = 200;
/** 任何 outline／sections 陣列一次最多幾筆；也是 `list_notes` 的每頁上限。 */
export const MCP_PAGE_MAX = 100;
/** `read_note_section` 的 `markdown` 一次最多幾個 code unit（D15）。 */
export const MCP_SECTION_CHARS = 4000;

/**
 * 一個 UTF-16 code unit 被 `JSON.stringify` 寫成幾個 code unit（不含引號）。與 ES2019 起的
 * well-formed `JSON.stringify` 逐位相同（`test/unit/mcp-limits.test.ts` 對 0x0000–0xFFFF 全掃）：
 * `\b \t \n \f \r` 與 `"`、`\` → 2；其餘 C0（U+0000–U+001F）→ 6（`\u0001`）；孤立代理 → 6。
 * 配對好的代理對不在這裡算（由 {@link truncateText} 整對算 2）。C1、DEL、U+2028／2029 **不**逃脫（→ 1）。
 */
function escapedUnitCost(code: number): number {
  if (code < 0x20) return code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
  if (code === 0x22 || code === 0x5c) return 2;
  if (code >= 0xd800 && code <= 0xdfff) return 6;
  return 1;
}

/**
 * 截到「**JSON 逃脫後**最多 `max` 個 code unit」（#177）——`JSON.stringify(text).length - 2 ≤ max` 是這支的
 * 不變量。**切的是原字串**，預算算的是逃脫後的成本：一個字元要嘛整個留下、要嘛整個不留，不會切出半個
 * `\u0001`。為什麼是逃脫後：wire 回應裡同一欄出現兩次（structuredContent ＋ 鏡像 text，見檔頭），C0
 * 一個字在 wire 上佔 13（`\u0001` ＋ `\\u0001`）、`"`／`\` 佔 6，按原長度截的話合規內容就推得破 N。
 * 不需要逃脫的文字成本＝原長度，行為與 #177 之前逐位相同（純 ASCII 恰好 200 個照樣不截）。
 *
 * **代理對（surrogate pair）整對算、整對留或整對丟**——切半會回給模型一個孤立代理，序列化不報錯、只是
 * 安靜地送出一個壞字元。
 * 回傳 `truncated` 而不是讓呼叫端自己比長度：DTO 的 `*Truncated` 旗標一律由它決定
 * （`exactOptionalPropertyTypes` 沒開，型別擋不住塞 `undefined`，這一支是唯一的紀律點）。
 *
 * ⚠ 只給短欄位（標題、heading、群組名）用。`read_note_section` 的 `markdown` 走 {@link truncateCodeUnits}：
 * markdown 每一行的換行都要逃脫，改按逃脫後計會讓幾乎每一頁都短於 4000（`instructions` 與文件說的是
 * 4000 characters），而它在 wire 上本來就遠在 N 之內（一個 code unit 兩份逃脫合計最多 13——C0 或孤立代理——4000 個 ≈ 52 000 ＋ 固定開銷）。
 */
export function truncateText(s: string, max: number = MCP_TEXT_MAX): { text: string; truncated: boolean } {
  let cost = 0;
  let i = 0;
  while (i < s.length) {
    const code = s.charCodeAt(i);
    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
    const isPair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    const w = isPair ? 2 : escapedUnitCost(code);
    if (cost + w > max) return { text: s.slice(0, i), truncated: true };
    cost += w;
    i += isPair ? 2 : 1;
  }
  return { text: s, truncated: false };
}

/**
 * 截到 `max` 個 UTF-16 code unit（**原長度**，不計逃脫）。**切點落在代理對中間時退一格**——理由同
 * {@link truncateText}。只給 `read_note_section` 的分頁用（為什麼不按逃脫後計見上）；`nextOffset` 依賴
 * 「回傳的是原字串的前綴、長度就是推進量」。
 */
export function truncateCodeUnits(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const code = s.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return { text: s.slice(0, cut), truncated: true };
}
