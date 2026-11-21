import { stat } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { LINE_HASH_BYTES, baseHashes, deriveTransferKey, newSalt } from "../../src/transfer/base-hash.js";
import { DIFF_DEPTH_MAX, DIFF_MAX_D, DIFF_WORK_MAX_FACTOR, diffLines, hashAgentLines, type DiffOptions, type LineDiff } from "../../src/transfer/line-diff.js";
import { bodyLines } from "../../src/transfer/normalize.js";
import { yieldToLoop } from "../../src/transfer/yield.js";

// Wraps yieldToLoop in a counting spy (still calls the original) to prove it is really used when no yieldFn is passed.
vi.mock("../../src/transfer/yield.js", async importOriginal => {
  const m = await importOriginal<typeof import("../../src/transfer/yield.js")>();
  return { ...m, yieldToLoop: vi.fn(m.yieldToLoop) };
});

const KEY = deriveTransferKey("line-diff-test-secret");
const SALT = newSalt();
const base = (lines: string[], kinds: number[] = lines.map(() => 0)) => {
  const h = baseHashes(KEY, SALT, { body: lines.join("\n"), title: "t", tags: [], lines, kinds });
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
/** O(NM) LCS length (reference implementation; equivalent = string equality). */
function lcs(a: string[], b: string[]): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
  return dp[a.length]![b.length]!;
}
const uniq = (n: number, p = "line") => Array.from({ length: n }, (_, i) => `${p} ${i}`);
/** Fake clock: advances `step` ms on every read. */
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};

describe("hashAgentLines agrees with baseHashes", () => {
  it("same body, same salt: for kind 0 lines the raw hash = the base's 8 bytes; for kind 1 lines the num hash = the base's 8 bytes", async () => {
    const lines = ["# H", "", "1. a", "2. b  ", "```", "1. code", "```", "tail\u00a0"];
    const kinds = [0, 0, 1, 1, 0, 0, 0, 0];
    const h = baseHashes(KEY, SALT, { body: lines.join("\n"), title: "t", tags: [], lines, kinds });
    const a = await agent(lines);
    for (let i = 0; i < lines.length; i++) {
      const want = h.lineHashes.toString("latin1", i * LINE_HASH_BYTES, (i + 1) * LINE_HASH_BYTES);
      expect(kinds[i] === 1 ? a.num[i] : a.raw[i], `line ${i}`).toBe(want);
    }
  });
});

describe("equivalence", () => {
  it("kind 1 `3. x` matches agent `5. x`; kind 0 (inside code) does not", async () => {
    expect(pairs(await run(["3. x"], ["5. x"], {}, [1]))).toEqual([0]);
    expect(pairs(await run(["3. x"], ["5. x"], {}, [0]))).toEqual([-1]);
    // kind 0 `1. x` against `5. x`: the agent's numbering-normalised hash equals the base's raw hash exactly - only "kind 0 compares raw" blocks it
    expect(pairs(await run(["1. x"], ["5. x"], {}, [0]))).toEqual([-1]);
  });
  it("differences in trailing whitespace / NBSP / U+3000 still match (trimEnd)", async () => {
    expect(pairs(await run(["a", "b", "c"], ["a  ", "b\u00a0", "c\u3000"]))).toEqual([0, 1, 2]);
  });
  it("indented sub-numbering: kind 1 `   2. child` matches `   3. child`; num != raw", async () => {
    expect(pairs(await run(["   2. child"], ["   3. child"], {}, [1]))).toEqual([0]);
    const a = await agent(["   3. child"]);
    expect(a.num[0]).not.toBe(a.raw[0]);
  });
});

describe("diff correctness", () => {
  it.each([
    ["change one line", ["a", "b", "c"], ["a", "B", "c"], [0, -1, 2]],
    ["delete one line", ["a", "b", "c"], ["a", "c"], [0, -1, 1]],
    ["insert one line", ["a", "b"], ["a", "X", "b"], [0, 2]],
    ["delete all", ["a", "b"], [], [-1, -1]],
    ["all new", ["a", "b"], ["x", "y"], [-1, -1]],
    ["empty vs empty", [], [], []],
    ["empty base", [], ["a"], []],
    ["repeated lines a a a -> a a", ["a", "a", "a"], ["a", "a"], [0, 1, -1]],
    ["replace two middle lines", ["a", "b", "c", "d"], ["a", "X", "Y", "d"], [0, -1, -1, 3]],
    ["insert at the start", ["a"], ["X", "a"], [1]],
    ["delete every other line", ["a", "b", "c", "d", "e"], ["a", "c", "e"], [0, -1, 1, -1, 2]],
    ["change two places in the middle", ["a", "b", "c", "d", "e"], ["a", "B", "c", "D", "e"], [0, -1, 2, -1, 4]],
  ])("%s", async (_n, b, a, want) => {
    expect(pairs(await run(b, a))).toEqual(want);
  });
  it("moved block: pair count = LCS, pairs do not cross", async () => {
    const d = await run(["a", "b", "c", "d"], ["c", "d", "a", "b"]);
    expect(matched(d)).toBe(2);
    expect(increasing(d)).toBe(true);
  });
  it("200 random cases (N, M <= 60): pair count = O(NM) LCS, pairs do not cross", async () => {
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

describe("determinism with repeated lines (deletion before insertion)", () => {
  it("[a, b, a] deleting the middle -> base 0->0, 2->1 (settled by stripping prefix/suffix)", async () => {
    expect(pairs(await run(["a", "b", "a"], ["a", "a"]))).toEqual([0, -1, 1]);
  });
  it("prefix/suffix cannot be stripped, several shortest solutions: [b, b, b] -> [a, b, c] takes the first b; [a, a] -> [b, a, c] takes the first a", async () => {
    expect(pairs(await run(["b", "b", "b"], ["a", "b", "c"]))).toEqual([1, -1, -1]);
    expect(pairs(await run(["a", "a"], ["b", "a", "c"]))).toEqual([1, -1]);
  });
  it("running twice gives the same result", async () => {
    const b = ["x", "a", "a", "y", "a"];
    const a = ["a", "z", "a", "a"];
    expect(pairs(await run(b, a))).toEqual(pairs(await run(b, a)));
  });
});

describe("degradation (sub-section without anchors)", () => {
  it("maxD 3, the middle is all repeated lines and the difference > 3 -> overflow, anchored 0, prefix/suffix still matched, only the middle is -1, degradedLines = the middle's base line count", async () => {
    const d = await run(["p", "x", "x", "x", "x", "x", "q"], ["p", "y", "x", "y", "x", "y", "q"], { maxD: 3 });
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBe(0);
    expect(pairs(d)).toEqual([0, -1, -1, -1, -1, -1, 6]);
    expect(d.degradedLines).toBe(5);
  });
});

describe("scale and boundaries", () => {
  const N = 20_000;
  const B = uniq(N);
  it("base of 20 000 lines, agent changes 500 scattered lines (D around 1 000) -> < 2 s, overflow false", async () => {
    const A = B.map((l, i) => (i % 40 === 7 ? `${l} changed` : l));
    const ag = await agent(A);
    const t0 = performance.now();
    const d = await diffLines(base(B), ag);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.overflow).toBe(false);
    expect(matched(d)).toBe(N - 500);
  }, 30_000);
  it("D = 2 000 exactly at the cap -> overflow false; D = 2 001 -> goes through anchors, pair count = the reference without a cap", async () => {
    const A2000 = B.map((l, i) => (i % 20 === 3 ? `${l} changed` : l)); // 1 000 lines replaced: D = 2 000
    const d0 = await run(B, A2000);
    expect(d0.overflow).toBe(false);
    expect(matched(d0)).toBe(N - 1000);
    const A2001 = A2000.filter((_, i) => i !== 10); // one more line deleted: D = 2 001
    const ag = await agent(A2001);
    const d1 = await diffLines(base(B), ag);
    expect(d1.overflow).toBe(true);
    expect(d1.anchored).toBeGreaterThan(0);
    const ref = await diffLines(base(B), ag, { maxD: 1e9 });
    expect(ref.overflow).toBe(false);
    expect(matched(d1)).toBe(matched(ref));
    expect(d1.degradedLines).toBe(0);
  }, 60_000);
  it("base of 20 000 lines all replaced -> no candidate anchors -> degraded, < 500 ms", async () => {
    const ag = await agent(uniq(N, "other"));
    const t0 = performance.now();
    const d = await diffLines(base(B), ag);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBe(0);
    expect(d.degradedLines).toBe(N);
  }, 30_000);
});

describe("anchors keep unchanged lines", () => {
  const B = uniq(200);
  it("30 lines changed at each end (D = 60 > 10 each, degraded), 140 middle lines untouched -> middle matched in place, degradedLines = 60", async () => {
    const A = B.map((l, i) => (i < 30 || i >= 170 ? `${l} changed` : l));
    const d = await run(B, A, { maxD: 10 });
    for (let i = 30; i < 170; i++) expect(d.pair[i], `line ${i}`).toBe(i);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBeGreaterThanOrEqual(140);
    expect(d.degradedLines).toBe(60);
  });
  it("only 3 lines changed at each end (D = 6 <= 10 per end, whole D = 12 > 10) -> middle matched, degradedLines = 0", async () => {
    const A = B.map((l, i) => (i < 3 || i >= 197 ? `${l} changed` : l));
    const d = await run(B, A, { maxD: 10 });
    for (let i = 3; i < 197; i++) expect(d.pair[i], `line ${i}`).toBe(i);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBeGreaterThanOrEqual(140);
    expect(d.degradedLines).toBe(0);
  });
});

describe("recursion and uniqueness inside sub-sections", () => {
  // Top level: m appears twice (not unique), S is unique -> anchor S; inside the sub-sections left and right of S, m appears once each -> anchors of the recursion level; further in, both sides are fully replaced -> degraded.
  const block = (p: string) => [...uniq(6, `${p}a`), "m", ...uniq(6, `${p}b`)];
  const B = [...block("L"), "S", ...block("R")];
  const A = [...block("L").map(l => (l === "m" ? l : `${l}!`)), "S", ...block("R").map(l => (l === "m" ? l : `${l}!`))];
  it("an anchor-delimited sub-section overflows again -> still matched after recursion; depth is bounded", async () => {
    const d = await run(B, A, { maxD: 4 });
    expect(d.pair[13]).toBe(13); // S
    expect(d.pair[6]).toBe(6); // the left m
    expect(d.anchored).toBe(3);
    expect(d.maxDepthSeen).toBe(2);
    expect(d.degradedLines).toBe(24);
  });
  it("m is repeated across the whole file but unique on both sides inside the sub-sections -> both m become anchors at the recursion level", async () => {
    const d = await run(B, A, { maxD: 4 });
    expect(d.pair[6]).toBe(6);
    expect(d.pair[20]).toBe(20);
  });
});

describe("crossing anchors (the agent swapped two blocks)", () => {
  it("LIS keeps only one increasing set of anchors; pair count <= LCS, pairs do not cross", async () => {
    const P = uniq(5, "P");
    const Q = uniq(5, "Q");
    const d = await run([...P, ...Q], [...Q, ...P], { maxD: 2 });
    expect(d.overflow).toBe(true);
    expect(increasing(d)).toBe(true);
    expect(matched(d)).toBe(5);
    expect(matched(d)).toBeLessThanOrEqual(lcs([...P, ...Q], [...Q, ...P]));
  });
});

/** Generator for the depth tests: the anchor c_k of each level is unique only at level k -> forces depth K. */
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

describe("upper bounds for adversarial shapes (split into two shots)", () => {
  it("premise: with the caps fully open, gen(K, 10) really forces K levels", async () => {
    for (const K of [1, 2, 5, 12]) {
      const { X, Y } = gen(K, 10);
      const d = await run(X, Y, { maxD: 10, workFactor: Infinity, maxDepth: Infinity });
      expect(d.maxDepthSeen, `K=${K}`).toBe(K);
      expect(d.capHit, `K=${K}`).toBeUndefined();
    }
  });
  // With the caps fully open gen(20, 10) takes 1 486 steps in total, and the default multiplier 4 gives a cap of 4*180*10 = 7 200 - at each level this generator's Myers costs only
  // O(maxD^2) (no long snakes), so the default cap cannot be reached; this case therefore lowers the multiplier to 0.5 (cap 900) to force the work-cap path.
  it("work cap: gen(20, 10), workFactor 0.5 -> terminates, capHit work, overflow, < 2 s", async () => {
    const { X, Y } = gen(20, 10);
    const free = await run(X, Y, { maxD: 10, workFactor: Infinity, maxDepth: Infinity });
    // premise: the total steps with caps fully open exceed the workFactor 0.5 cap (otherwise this case cannot reach the work cap)
    expect(free.work).toBeGreaterThan(0.5 * (X.length + Y.length) * 10);
    const t0 = performance.now();
    const d = await run(X, Y, { maxD: 10, workFactor: 0.5 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.capHit).toBe("work");
    expect(d.overflow).toBe(true);
    expect(d.maxDepthSeen).toBeLessThan(20);
  });
  it("depth cap: gen(40, 10), workFactor Infinity -> capHit depth, maxDepthSeen = DIFF_DEPTH_MAX, < 2 s", async () => {
    const { X, Y } = gen(40, 10);
    const t0 = performance.now();
    const d = await run(X, Y, { maxD: 10, workFactor: Infinity });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(d.capHit).toBe("depth");
    expect(d.maxDepthSeen).toBe(DIFF_DEPTH_MAX);
    expect(d.overflow).toBe(true);
  });
});

describe("kind hash collision", () => {
  it("the base has both a kind 0 and a kind 1 `1. x`, the agent has a single `1. x` line -> not used as an anchor", async () => {
    const B = ["k0", "1. x", "y0", "y1", "y2", "y3", "1. x", "k1"];
    const kinds = [0, 0, 0, 0, 0, 0, 1, 0];
    const A = ["K0", "Y0", "Y1", "1. x", "Y2", "Y3", "K1"];
    const d = await run(B, A, { maxD: 2 }, kinds);
    expect(d.overflow).toBe(true);
    expect(d.anchored).toBe(0);
    expect(pairs(d)).toEqual(B.map(() => -1));
  });
});

describe("yielding by time budget", () => {
  // 1 000 non-empty sub-sections: the unique u_i are anchors, each with one changed line A_i between them (maxD 1 makes the top level overflow).
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
  it("clock does not advance -> 0 yields", async () => {
    const { yields, d } = await count(0);
    expect(d.checkpoints).toBeGreaterThanOrEqual(1000);
    expect(yields).toBe(0);
  });
  it("advancing 25 ms at every checkpoint (> YIELD_AFTER_MS) -> yields = number of checkpoints", async () => {
    const { yields, d } = await count(25);
    expect(d.checkpoints).toBeGreaterThanOrEqual(1000);
    expect(yields).toBe(d.checkpoints);
  });
  it("advancing 10 ms at every checkpoint -> yields = floor(checkpoints / 2) (+-1)", async () => {
    const { yields, d } = await count(10);
    expect(Math.abs(yields - Math.floor(d.checkpoints / 2))).toBeLessThanOrEqual(1);
  });
});

describe("yielding", () => {
  const B = uniq(20_000);
  const A = B.map((l, i) => (i % 40 === 7 ? `${l} changed` : l));
  it("injected yieldFn counts: the 20 000-line, 500-change input, clock advancing 25 ms per read -> also yields inside the Myers loop (count > 1)", async () => {
    let yields = 0;
    const ag = await agent(A);
    await diffLines(base(B), ag, { now: clock(25), yieldFn: async () => void yields++ });
    expect(yields).toBeGreaterThan(1);
  }, 30_000);
  it("entered from an I/O callback: during the first yield, a setTimeout(0) that already expired runs first", async () => {
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
  it("without yieldFn: hashAgentLines and diffLines both really call yieldToLoop", async () => {
    const spy = vi.mocked(yieldToLoop);
    spy.mockClear();
    await hashAgentLines(KEY, SALT, A.slice(0, 256), { now: clock(25) });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    spy.mockClear();
    await diffLines(base(B.slice(0, 50)), await agent(A.slice(0, 50)), { now: clock(25) });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

describe("constants", () => {
  it("DIFF_MAX_D = 2 000 (see the gen(20, 10) note above), DIFF_WORK_MAX_FACTOR = 4, DIFF_DEPTH_MAX = 32", () => {
    expect(DIFF_MAX_D).toBe(2000);
    expect(DIFF_WORK_MAX_FACTOR).toBe(4);
    expect(DIFF_DEPTH_MAX).toBe(32);
    expect(bodyLines("a\nb")).toEqual(["a", "b"]);
  });
});
