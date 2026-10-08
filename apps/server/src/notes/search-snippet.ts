/**
 * #93 §8.3：摘錄演算法（MCP 與 PR2 的 REST 共用；成本函式由呼叫端給——MCP 用 JSON 逃脫後成本，REST 用 code unit）。
 * 輸入是 SQL 回的窗口（`notes/search-sql.ts`：命中前 40、命中、命中後 160 個 code point）。以 code point 走訪
 * （`Array.from`，與 PG 的 substr 同單位），所以不會切出半個代理對。預算 B＝max−2（預留前後兩個 `…`，U+2026 成本 1）：
 *   1. 命中段先選（逐 code point 加到用完 B）——**命中起點一定在摘錄裡**；命中成本 ≤ B 時整段入選。
 *   2. 剩餘預算的三分之一（向下取整）給前文，從命中點往左加。
 *   3. 剩餘預算全部給後文（含前文沒用完的）；命中段沒選完時不加後文（否則會跳過命中的後半）。
 *   4. 前後文的連續空白（含 \n）壓成一個空格；命中段本身不壓（保持 body 原文）。
 *   5. 摘錄起點之前還有字 → 前綴 `…`；終點之後還有字 → 後綴 `…`。結果成本 ≤ max。
 * 保證只在「lower() 不改變長度」時成立（libc locale；ICU 下窗口可能偏移幾個字元，spec §7.5）——模型面字串只說 near the first hit。
 */
const WS = /\s/u;

export interface SnippetWindow {
  win: string;
  lead: number;
  qlen: number;
  winStart: number;
  bodyLen: number;
}

export function buildSnippet(w: SnippetWindow, max: number, cost: (cp: string) => number): string {
  const cps = Array.from(w.win);
  const budget = max - 2;
  const lead = Math.min(Math.max(w.lead, 0), cps.length);
  const hitEnd = Math.min(lead + w.qlen, cps.length);
  let used = 0;
  let right = lead;
  while (right < hitEnd) {
    const c = cost(cps[right]!);
    if (used + c > budget) break;
    used += c;
    right += 1;
  }
  const hit = cps.slice(lead, right).join("");

  const leftBudget = Math.floor((budget - used) / 3);
  let leftUsed = 0;
  let left = lead;
  const before: string[] = [];
  let prevSpace = false;
  while (left > 0) {
    const ch = cps[left - 1]!;
    const isWs = WS.test(ch);
    if (isWs && prevSpace) {
      left -= 1;
      continue;
    }
    const piece = isWs ? " " : ch;
    const c = cost(piece);
    if (leftUsed + c > leftBudget) break;
    leftUsed += c;
    before.push(piece);
    prevSpace = isWs;
    left -= 1;
  }
  used += leftUsed;

  const after: string[] = [];
  let end = right;
  prevSpace = false;
  if (right === hitEnd) {
    while (end < cps.length) {
      const ch = cps[end]!;
      const isWs = WS.test(ch);
      if (isWs && prevSpace) {
        end += 1;
        continue;
      }
      const piece = isWs ? " " : ch;
      const c = cost(piece);
      if (used + c > budget) break;
      used += c;
      after.push(piece);
      prevSpace = isWs;
      end += 1;
    }
  }
  const head = w.winStart + left > 1 ? "…" : "";
  const tail = w.winStart + end - 1 < w.bodyLen ? "…" : "";
  return head + before.reverse().join("") + hit + after.join("") + tail;
}
