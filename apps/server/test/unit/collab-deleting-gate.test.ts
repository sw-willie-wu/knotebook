import { describe, expect, it } from "vitest";
import { COLLAB_RESTART_DELAYS_MS, COLLAB_RESTART_JITTER, COLLAB_TOKEN_RETRY_DELAYS_MS } from "@knotebook/shared";
import { DELETING_GATE_TTL_MS } from "../../src/collab/hooks-impl.js";

/**
 * 刪除閘門的 TTL 與 client 重啟退避是一組**跨套件的耦合契約**（issue #35 審查 round 2）。
 *
 * 閘門是 server 唯一能對「刪除當下本來就看得到這篇筆記的人」說出「它被刪掉了」的窗口：
 * 交易一 commit，那一列就查不到，`resolveRole` 只會回 'none'，而那條路對使用者說的是
 * 「你已失去存取權」——正是 #35 要修掉的那句錯話。所以閘門必須活得比「一個正在重連的
 * 分頁下一次回來敲門」還久。
 *
 * 沒有這條測試的話，把 `COLLAB_RESTART_DELAYS_MS` 最後一格調大（或把 TTL 調小）會**靜靜地**
 * 破壞它：沒有任何測試會紅，症狀只是使用者偶爾看到一句錯話。
 */
describe("刪除閘門 TTL vs client 重啟退避（跨套件不變量）", () => {
  const worstRestartDelay = Math.max(...COLLAB_RESTART_DELAYS_MS) * (1 + COLLAB_RESTART_JITTER);

  it("TTL 蓋得過 client 最長的一次重啟退避", () => {
    expect(DELETING_GATE_TTL_MS).toBeGreaterThan(worstRestartDelay);
  });

  it("TTL 還留得下一整輪 token 退避表的餘裕（重連要先取得 token 才會敲門）", () => {
    // 從 shared 取實際的重試表計算（issue #40 順帶：舊版手抄 7_500，正是「數字被抄進
    // 註解後漂移」的形狀）。
    const tokenRetryTail = COLLAB_TOKEN_RETRY_DELAYS_MS.reduce((sum, d) => sum + d, 0);
    expect(DELETING_GATE_TTL_MS).toBeGreaterThan(worstRestartDelay + tokenRetryTail);
  });
});
