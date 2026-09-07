/**
 * #108 §8.1「回應大小上限表」的**唯一**落點（M16）。三個數字只在這裡出現一次。
 *
 * `N ＝ 262 144`（一次 wire 回應的上限）**不在這裡**：它是**哨兵不是目標值**——破了代表
 * 下面某條逐欄上限漏接，而不是「該調大 N」。它的落點是 `test/mcp-size.test.ts`（Task 5）。
 * ⚠ 量的對象是 **wire 回應**不是 payload：D11 的鏡像讓同一份 payload 在回應裡出現兩次
 * （第二次還被 JSON 逃脫），`wire ≈ 2.1 × payload`——改量 payload 會讓這筆成本消失在哨兵眼前。
 */

/** 任何回給模型的 `heading`／`title` 的上限（UTF-16 code unit）。 */
export const MCP_TEXT_MAX = 200;
/** 任何 outline／sections 陣列一次最多幾筆；也是 `list_notes` 的每頁上限。 */
export const MCP_PAGE_MAX = 100;
/** `read_note_section` 的 `markdown` 一次最多幾個 code unit（D15）。 */
export const MCP_SECTION_CHARS = 4000;

/**
 * 截到 `max` 個 UTF-16 code unit。**切點落在代理對（surrogate pair）中間時退一格**——
 * 切半會回給模型一個孤立代理，序列化不報錯、只是安靜地送出一個壞字元。
 * 回傳 `truncated` 而不是讓呼叫端自己比長度：DTO 的 `*Truncated` 旗標一律由它決定
 * （`exactOptionalPropertyTypes` 沒開，型別擋不住塞 `undefined`，這一支是唯一的紀律點）。
 */
export function truncateText(s: string, max: number = MCP_TEXT_MAX): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const code = s.charCodeAt(max - 1);
  const cut = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return { text: s.slice(0, cut), truncated: true };
}
