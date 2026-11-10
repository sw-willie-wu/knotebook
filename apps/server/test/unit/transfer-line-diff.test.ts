import { stat } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LINE_HASH_BYTES, baseHashes, deriveTransferKey, newSalt } from "../../src/transfer/base-hash.js";
import { DIFF_DEPTH_MAX, DIFF_MAX_D, DIFF_WORK_MAX_FACTOR, diffLines, hashAgentLines, type DiffOptions, type LineDiff } from "../../src/transfer/line-diff.js";
import { bodyLines } from "../../src/transfer/normalize.js";
import { yieldToLoop } from "../../src/transfer/yield.js";

// 把 yieldToLoop 包成計數的 spy（內部仍呼叫原函式），證明不傳 yieldFn 時真的用它。
vi.mock("../../src/transfer/yield.js", async importOriginal => {
  const m = await importOriginal<typeof import("../../src/transfer/yield.js")>();
  return { ...m, yieldToLoop: vi.fn(m.yieldToLoop) };
});

/** bulk transfer 的逐行 diff。 */

const KEY = deriveTransferKey("line-diff-test-secret");
const SALT = newSalt();
const base = (lines: string[], kinds: number[] = lines.map(() => 0)) => {
  const h = baseHashes(KEY, SALT, { body: lines.join("\n"), title: "t", lines, kinds });
  return { hashes: h.lineHashes, kinds: h.lineKinds };
};
const agent = (lines: string[]) => hashAgentLines(KEY, SALT, lines);
const run = async (b: string[], a: string[], opts: DiffOptions = {}, kinds?: number[]): Promise<LineDiff> => diffLines(base(b, kinds), await agent(a), opts);
const pairs = (d: LineDiff) => [...d.pair];
const matched = (d: LineDiff) => d.pair.filter(j => j !== -1).length;
const increasing = (d: LineDiff) => {
  let last = -1;
  for (const j of d.pair) {
    if (j === -1) continue;
    if (j <= last) return false;
    last = j;
  }
  return true;
};
/** O(NM) LCS 長度（參考實作；等價＝字串相等）。 */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}
const uniq = (n: number, p = "line") => Array.from({ length: n }, (_, i) => `${p} ${i}`);
/** 假時鐘：每次讀前進 `step` ms。 */
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};

describe("D1 hashAgentLines 與 baseHashes 一致", () => {
  it("同本文、同鹽：kind 0 的行 raw＝基底 8 bytes；kind 1 的行 num＝基底 8 bytes", async () => {
    const lines = ["# H", "", "1. a", "2. b  ", "```", "1. code", "```", "tail\u00a0"];
    const kinds = [0, 0, 1, 1, 0, 0, 0, 0];
    const h = baseHashes(KEY, SALT, { body: lines.join("\n"), title: "t", lines, kinds });
    const a = await agent(lines);
    for (let i = 0; i < lines.length; i++) {
      const want = h.lineHashes.toString("latin1", i * LINE_HASH_BYTES, (i + 1) * LINE_HASH_BYTES);
      expect(kinds[i] === 1 ? a.num[i] : a.raw[i], `line ${i}`).toBe(want);
    }
  });
});

describe("D2 等價", () => {
  it("kind 1 的 `3. x` 對 agent `5. x` 配得上；kind 0（code 裡）配不上", async () => {
    expect(pairs(await run(["3. x"], ["5. x"], {}, [1]))).toEqual([0]);
    expect(pairs(await run(["3. x"], ["5. x"], {}, [0]))).toEqual([-1]);
    // kind 0 的 `1. x` 對 `5. x`：agent 的編號正規化雜湊恰等於基底原文雜湊——只有「kind 0 比 raw」才擋得下
    expect(pairs(await run(["1. x"], ["5. x"], {}, [0]))).toEqual([-1]);
  });
  it("行尾空白／NBSP／U+3000 差異配得上（trimEnd）", async () => {
    expect(pairs(await run(["a", "b", "c"], ["a  ", "b\u00a0", "c\u3000"]))).toEqual([0, 1, 2]);
  });
  it("D2b 縮排的子編號：kind 1 的 `   2. child` 對 `   3. child` 配得上；num ≠ raw", async () => {
    expect(pairs(await run(["   2. child"], ["   3. child"], {}, [1]))).toEqual([0]);
    const a = await agent(["   3. child"]);
    expect(a.num[0]).not.toBe(a.raw[0]);
  });
});

describe("D3 diff 正確性", () => {
  it.each([
    ["改一行", ["a", "b", "c"], ["a", "B", "c"], [0, -1, 2]],
    ["刪一行", ["a", "b", "c"], ["a", "c"], [0, -1, 1]],
    ["插一行", ["a", "b"], ["a", "X", "b"], [0, 2]],
    ["全刪", ["a", "b"], [], [-1, -1]],
    ["全新", ["a", "b"], ["x", "y"], [-1, -1]],
    ["空對空", [], [], []],
    ["空基底", [], ["a"], []],
    ["重複行 a a a → a a", ["a", "a", "a"], ["a", "a"], [0, 1, -1]],
    ["中間兩行換掉", ["a", "b", "c", "d"], ["a", "X", "Y", "d"], [0, -1, -1, 3]],
    ["開頭插", ["a"], ["X", "a"], [1]],
    ["隔行刪", ["a", "b", "c", "d", "e"], ["a", "c", "e"], [0, -1, 1, -1, 2]],
    ["中間改兩處", ["a", "b", "c", "d", "e"], ["a", "B", "c", "D", "e"], [0, -1, 2, -1, 4]],
  ])("%s", async (_n, b, a, want) => {
    expect(pairs(await run(b, a))).toEqual(want);
  });
  it("整段搬移：配對數＝LCS、配對不交叉", async () => {
    const d = await run(["a", "b", "c", "d"], ["c", "d", "a", "b"]);
    expect(matched(d)).toBe(2);
    expect(increasing(d)).toBe(true);
  });
  it("亂數 200 組（N、M ≤ 60）：配對數＝O(NM) LCS、配對不交叉", async () => {
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 200; t++) {
      const n = Math.floor(rnd() * 61);
      const m = Math.floor(rnd() * 61);
      const alpha = 2 + Math.floor(rnd() * 6);
      const b = Array.from({ length: n }, () => `t${Math.floor(rnd() * alpha)}`);
      const a = Array.from({ length: m }, () => `t${Math.floor(rnd() * alpha)}`);
      const d = await run(b, a);
      expect(matched(d), `case ${t}`).toBe(lcs(b, a));
      expect(increasing(d), `case ${t}`).toBe(true);
      for (let i = 0; i < n; i++) if (d.pair[i] !== -1) expect(a[d.pair[i]!]).toBe(b[i]);
    }
  });
});

describe("D4 重複行的確定性（刪除優先於插入）", () => {
  it("[a, b, a] 刪中間 → 基底 0→0、2→1（剝前後綴就定了）", async () => {
    expect(pairs(await run(["a", "b", "a"], ["a", "a"]))).toEqual([0, -1, 1]);
  });
  it("剝不掉前後綴、多個最短解：[b, b, b] → [a, b, c] 取第一顆 b；[a, a] → [b, a, c] 取第一顆 a", async () => {
    expect(pairs(await run(["b", "b", "b"], ["a", "b", "c"]))).toEqual([1, -1, -1]);
    expect(pairs(await run(["a", "a"], ["b", "a", "c"]))).toEqual([1, -1]);
  });
  it("同輸入跑兩次結果相同", async () => {
    const b = ["x", "a", "a", "y", "a"];
    const a = ["a", "z", "a", "a"];
    expect(pairs(await run(b, a))).toEqual(pairs(await run(b, a)));
  });
});

describe("D5 退化（無錨點的子區段）", () => {
  it("maxD 3、中段全是重複行且差異 > 3 → overflow、anchored 0、前後綴照配、只有中段 -1、degradedLines＝中段基底行數", async () => {
    const d = await run(["p", "x", "x", "x", "x", "x", "q"], ["p", "y", "x", "y", "x", "y", "q"], { maxD: 3 });
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBe(0);
    expect(pairs(d)).toEqual([0, -1, -1, -1, -1, -1, 6]);
    expect(d.degradedLines).toBe(5);
  });
});

describe("D6 規模與邊界", () => {
  const N = 20_000;
  const B = uniq(N);
  it("基底 20 000 行、agent 分散改 500 行（D≈1 000）→ < 2 s、overflow false", async () => {
    const A = B.map((l, i) => (i % 40 === 7 ? `${l} changed` : l));
    const ag = await agent(A);
    const t0 = performance.now();
    const d = await diffLines(base(B), ag);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.overflow).toBe(false);
    expect(matched(d)).toBe(N - 500);
  }, 30_000);
  it("D＝2 000 恰在上限 → overflow false；D＝2 001 → 走錨點、配對數＝不設上限的參考", async () => {
    const A2000 = B.map((l, i) => (i % 20 === 3 ? `${l} changed` : l)); // 1 000 行換掉：D＝2 000
    const d0 = await run(B, A2000);
    expect(d0.overflow).toBe(false);
    expect(matched(d0)).toBe(N - 1000);
    const A2001 = A2000.filter((_, i) => i !== 10); // 再刪一行：D＝2 001
    const ag = await agent(A2001);
    const d1 = await diffLines(base(B), ag);
    expect(d1.overflow).toBe(true);
    expect(d1.anchored).toBeGreaterThan(0);
    const ref = await diffLines(base(B), ag, { maxD: 1e9 });
    expect(ref.overflow).toBe(false);
    expect(matched(d1)).toBe(matched(ref));
    expect(d1.degradedLines).toBe(0);
  }, 60_000);
  it("基底 20 000 行全換 → 沒有候選錨點 → 退化、< 500 ms", async () => {
    const ag = await agent(uniq(N, "other"));
    const t0 = performance.now();
    const d = await diffLines(base(B), ag);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBe(0);
    expect(d.degradedLines).toBe(N);
  }, 30_000);
});

describe("D9 錨點保住沒改的行", () => {
  const B = uniq(200);
  it("D9a 兩端各改 30 行（各自 D＝60 > 10、退化）、中段 140 行沒改 → 中段照原位配、degradedLines＝60", async () => {
    const A = B.map((l, i) => (i < 30 || i >= 170 ? `${l} changed` : l));
    const d = await run(B, A, { maxD: 10 });
    for (let i = 30; i < 170; i++) expect(d.pair[i], `line ${i}`).toBe(i);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBeGreaterThanOrEqual(140);
    expect(d.degradedLines).toBe(60);
  });
  it("D9b 兩端各只改 3 行（每端 D＝6 ≤ 10、整份 D＝12 > 10）→ 中段照配、degradedLines＝0", async () => {
    const A = B.map((l, i) => (i < 3 || i >= 197 ? `${l} changed` : l));
    const d = await run(B, A, { maxD: 10 });
    for (let i = 3; i < 197; i++) expect(d.pair[i], `line ${i}`).toBe(i);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBeGreaterThanOrEqual(140);
    expect(d.degradedLines).toBe(0);
  });
});

describe("D10／D11 遞迴與子區段內的唯一性", () => {
  // 頂層：m 出現兩次（不唯一）、S 唯一 → 錨點 S；S 左右的子區段內 m 各只出現一次 → 遞迴層的錨點；再往內兩邊全換 → 退化。
  const block = (p: string) => [...uniq(6, `${p}a`), "m", ...uniq(6, `${p}b`)];
  const B = [...block("L"), "S", ...block("R")];
  const A = [...block("L").map(l => (l === "m" ? l : `${l}!`)), "S", ...block("R").map(l => (l === "m" ? l : `${l}!`))];
  it("D10 錨點之間的子區段又溢位 → 遞迴後仍配到；深度有界", async () => {
    const d = await run(B, A, { maxD: 4 });
    expect(d.pair[13]).toBe(13); // S
    expect(d.pair[6]).toBe(6); // 左邊的 m
    expect(d.anchored).toBe(3);
    expect(d.maxDepthSeen).toBe(2);
    expect(d.degradedLines).toBe(24);
  });
  it("D11 m 在整份重複、在子區段內兩邊唯一 → 兩個 m 都在遞迴層被當錨點", async () => {
    const d = await run(B, A, { maxD: 4 });
    expect(d.pair[6]).toBe(6);
    expect(d.pair[20]).toBe(20);
  });
});

describe("D12 錨點交叉（agent 把兩段對調）", () => {
  it("LIS 只留一組遞增的錨點；配對數 ≤ LCS、配對不交叉", async () => {
    const P = uniq(5, "P");
    const Q = uniq(5, "Q");
    const d = await run([...P, ...Q], [...Q, ...P], { maxD: 2 });
    expect(d.overflow).toBe(true);
    expect(increasing(d)).toBe(true);
    expect(matched(d)).toBe(5);
    expect(matched(d)).toBeLessThanOrEqual(lcs([...P, ...Q], [...Q, ...P]));
  });
});

/** 深度測試的產生器：每層的錨點 c_k 只在第 k 層唯一 → 逼出深度 K。 */
function gen(K: number, maxD: number): { X: string[]; Y: string[] } {
  let X = Array.from({ length: maxD + 1 }, (_, i) => `bx${i}`);
  let Y = Array.from({ length: maxD + 1 }, (_, i) => `ay${i}`);
  for (let k = 1; k <= K; k++) {
    const tail = k === 1 ? ["c1"] : [`c${k}`, `c${k - 1}`];
    X = [`g${k}`, ...X, ...tail, `tb${k}`];
    Y = [`h${k}`, ...Y, ...tail, `ta${k}`];
  }
  return { X, Y };
}

describe("D14 對抗形的上限（拆兩發）", () => {
  it("前提：上限全開時 gen(K, 10) 真的逼到 K 層", async () => {
    for (const K of [1, 2, 5, 12]) {
      const { X, Y } = gen(K, 10);
      const d = await run(X, Y, { maxD: 10, workFactor: Infinity, maxDepth: Infinity });
      expect(d.maxDepthSeen, `K=${K}`).toBe(K);
      expect(d.capHit, `K=${K}`).toBeUndefined();
    }
  });
  // 實測（T3）：gen(20, 10) 上限全開時總步數 1 486，預設倍數 4 的上限是 4·180·10＝7 200——這個產生器每層的 Myers 只花
  // O(maxD²)（沒有長 snake），預設上限量不到；所以這案把倍數降到 0.5（上限 900）來逼出工作量上限那條路。
  it("D14w 工作量上限：gen(20, 10)、workFactor 0.5 → 會終止、capHit work、overflow、< 2 s", async () => {
    const { X, Y } = gen(20, 10);
    const free = await run(X, Y, { maxD: 10, workFactor: Infinity, maxDepth: Infinity });
    // 前提：上限全開時的總步數大於 workFactor 0.5 的上限（否則這案量不到工作量上限）
    expect(free.work).toBeGreaterThan(0.5 * (X.length + Y.length) * 10);
    const t0 = performance.now();
    const d = await run(X, Y, { maxD: 10, workFactor: 0.5 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.capHit).toBe("work");
    expect(d.overflow).toBe(true);
    expect(d.maxDepthSeen).toBeLessThan(20);
  });
  it("D14d 深度上限：gen(40, 10)、workFactor Infinity → capHit depth、maxDepthSeen＝DIFF_DEPTH_MAX、< 2 s", async () => {
    const { X, Y } = gen(40, 10);
    const t0 = performance.now();
    const d = await run(X, Y, { maxD: 10, workFactor: Infinity });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.capHit).toBe("depth");
    expect(d.maxDepthSeen).toBe(DIFF_DEPTH_MAX);
    expect(d.overflow).toBe(true);
  });
});

describe("D15 kind 撞雜湊", () => {
  it("基底同時有 kind 0 與 kind 1 的 `1. x`、agent 只有一行 `1. x` → 不當錨點", async () => {
    const B = ["k0", "1. x", "y0", "y1", "y2", "y3", "1. x", "k1"];
    const kinds = [0, 0, 0, 0, 0, 0, 1, 0];
    const A = ["K0", "Y0", "Y1", "1. x", "Y2", "Y3", "K1"];
    const d = await run(B, A, { maxD: 2 }, kinds);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBe(0);
    expect(pairs(d)).toEqual(B.map(() => -1));
  });
});

describe("D16 讓出按時間預算", () => {
  // 1 000 個非空子區段：唯一的 u_i 是錨點、之間各夾一行被改的 A_i（maxD 1 讓頂層溢位）。
  const B: string[] = [];
  const A: string[] = [];
  for (let i = 0; i < 1000; i++) {
    B.push(`u${i}`, `A${i}`);
    A.push(`u${i}`, `B${i}`);
  }
  B.push("end");
  A.push("END");
  const count = async (step: number) => {
    let yields = 0;
    const d = await run(B, A, { maxD: 1, now: clock(step), yieldFn: async () => void yields++ });
    return { yields, d };
  };
  it("(a) 時鐘不前進 → 讓出 0 次", async () => {
    const { yields, d } = await count(0);
    expect(d.checkpoints).toBeGreaterThanOrEqual(1000);
    expect(yields).toBe(0);
  });
  it("(b) 每個檢查點前進 25 ms（> YIELD_AFTER_MS）→ 讓出次數＝檢查點數", async () => {
    const { yields, d } = await count(25);
    expect(d.checkpoints).toBeGreaterThanOrEqual(1000);
    expect(yields).toBe(d.checkpoints);
  });
  it("(c) 每個檢查點前進 10 ms → 讓出次數＝⌊檢查點數／2⌋（±1）", async () => {
    const { yields, d } = await count(10);
    expect(Math.abs(yields - Math.floor(d.checkpoints / 2))).toBeLessThanOrEqual(1);
  });
});

describe("D7／D8／D13 讓出", () => {
  const B = uniq(20_000);
  const A = B.map((l, i) => (i % 40 === 7 ? `${l} changed` : l));
  it("D7 注入 yieldFn 計數：D6 第一案、每次讀時鐘前進 25 ms → Myers 迴圈內也讓出（次數 > 1）", async () => {
    let yields = 0;
    const ag = await agent(A);
    await diffLines(base(B), ag, { now: clock(25), yieldFn: async () => void yields++ });
    expect(yields).toBeGreaterThan(1);
  }, 30_000);
  it("D8 從 I/O 回呼進入：第一次讓出期間，事先到期的 setTimeout(0) 先跑", async () => {
    const ag = await agent(A);
    let fired = false;
    let firedAtFirstYield: boolean | undefined;
    await new Promise<void>(r => stat(".", () => r()));
    setTimeout(() => {
      fired = true;
    }, 0);
    const t = performance.now();
    while (performance.now() - t < 5) {
      /* busy */
    }
    await diffLines(base(B), ag, {
      now: clock(25),
      yieldFn: async () => {
        await yieldToLoop();
        firedAtFirstYield ??= fired;
      },
    });
    expect(firedAtFirstYield).toBe(true);
  }, 30_000);
  it("D13 不傳 yieldFn：hashAgentLines 與 diffLines 都真的呼叫 yieldToLoop", async () => {
    const spy = vi.mocked(yieldToLoop);
    spy.mockClear();
    await hashAgentLines(KEY, SALT, A.slice(0, 256), { now: clock(25) });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    spy.mockClear();
    await diffLines(base(B.slice(0, 50)), await agent(A.slice(0, 50)), { now: clock(25) });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("常數", () => {
  it("DIFF_MAX_D＝2 000（T3 量完未調）、DIFF_WORK_MAX_FACTOR＝4、DIFF_DEPTH_MAX＝32", () => {
    expect(DIFF_MAX_D).toBe(2000);
    expect(DIFF_WORK_MAX_FACTOR).toBe(4);
    expect(DIFF_DEPTH_MAX).toBe(32);
    expect(bodyLines("a\nb")).toEqual(["a", "b"]);
  });
});
