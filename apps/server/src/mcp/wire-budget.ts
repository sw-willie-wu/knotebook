/**
 * 資料夾 PR-3d（spec §5.12「回應大小」）：清單類工具（list_notes／list_trash／list_folders）依 wire 成本截頁的共用計價。
 * `search_notes` 的 `assembleSearchPayload` 也用同一支 `wireCost`。
 */
import { MCP_LIST_WIRE_BUDGET } from "./limits.js";

/** 一個值在 wire 上的成本：structuredContent 一份＋鏡像 text 一份（再逃脫一次，`tool-result.ts`）。自 search-notes.ts 原樣搬來。 */
export function wireCost(v: unknown): number {
  const j = JSON.stringify(v);
  return j.length + JSON.stringify(j).length;
}

/** `,"pageCutShort":true` 兩份 42，取 64。 */
export const PAGE_CUT_RESERVE = 64;

/**
 * 依序加入，第 i 項的成本＝costs[i]＋2（兩份逗號，上界）；加下一項會讓 base＋累計 > budget 就停。**至少回 1**（單項的上界由逐欄上限保證，
 * 遠小於 budget）；costs 為空回 0。純函式。
 */
export function countWithinWireBudget(costs: readonly number[], base: number, budget: number = MCP_LIST_WIRE_BUDGET): number {
  let total = base;
  let n = 0;
  for (const cost of costs) {
    const add = cost + 2;
    if (n > 0 && total + add > budget) break;
    total += add;
    n += 1;
  }
  return n;
}
