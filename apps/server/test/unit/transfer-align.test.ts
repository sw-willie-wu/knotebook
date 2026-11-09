import { describe, it, expect } from "vitest";
import { GROUP_EXPORT_CAP, alignSegments, lineKindsOf, listFamily, type AlignSeg } from "../../src/transfer/align.js";

/** bulk transfer spec §6.4-2～-5（E12、E13、E16、E17）；合成的整篇行 W、逐顆行 P、型別，不需編輯器。 */

const P_ = "paragraph";
const BUL = "bulletListItem";
const NUM = "numberedListItem";
const noGroup = (): string[] => {
  throw new Error("groupExport should not be called");
};
const idxOf = (segs: AlignSeg[] | null) => segs?.map(s => s.idx) ?? null;

describe("listFamily", () => {
  it("numbered → num；bullet／check／toggle → star；其他 null", () => {
    expect(["numberedListItem", "bulletListItem", "checkListItem", "toggleListItem", "paragraph", "heading", "table"].map(listFamily)).toEqual([
      "num",
      "star",
      "star",
      "star",
      null,
      null,
      null,
    ]);
    expect(GROUP_EXPORT_CAP).toBe(32);
  });
});

describe("alignSegments", () => {
  it("U-A1 兩段落中間 1 空行；同家族清單相接 0 空行；start／count 精確", () => {
    expect(alignSegments(["a", "", "b"], [["a"], ["b"]], [P_, P_], noGroup).segs).toEqual([
      { idx: [0], start: 0, count: 1 },
      { idx: [1], start: 2, count: 1 },
    ]);
    expect(alignSegments(["* a", "* b"], [["* a"], ["* b"]], [BUL, BUL], noGroup).segs).toEqual([
      { idx: [0], start: 0, count: 1 },
      { idx: [1], start: 1, count: 1 },
    ]);
  });

  it("U-A2 優先序：逐顆與群組都比得上時取逐顆，而且根本不呼叫群組匯出", () => {
    let calls = 0;
    const r = alignSegments(["* a", "* b"], [["* a"], ["* b"]], [BUL, BUL], () => {
      calls++;
      return ["* a", "* b"];
    });
    expect(idxOf(r.segs)).toEqual([[0], [1]]);
    expect(r.stats.groupCalls).toBe(0);
    expect(calls).toBe(0);
  });

  it("U-A3 同一位置先試 1 行分隔再試 0 行（多解時才看得出順序）", () => {
    const r = alignSegments(["A", "", "", "B"], [["A"], [], ["B"]], [P_, P_, P_], noGroup);
    expect(r.segs).toEqual([
      { idx: [0], start: 0, count: 1 },
      { idx: [1], start: 2, count: 1 },
      { idx: [2], start: 3, count: 1 },
    ]);
  });

  it("U-A4 頭尾空段落記 0 行段、不吃空行", () => {
    expect(alignSegments(["A"], [[], ["A"], []], [P_, P_, P_], noGroup).segs).toEqual([
      { idx: [0], start: 0, count: 0 },
      { idx: [1], start: 0, count: 1 },
      { idx: [2], start: 1, count: 0 },
    ]);
    expect(alignSegments([], [[]], [P_], noGroup).segs).toEqual([{ idx: [0], start: 0, count: 0 }]);
  });

  it("U-A5 numbered：剝編號比；編號寬度帶來的子行縮排差（delta）也對得上", () => {
    expect(idxOf(alignSegments(["1. a", "2. b"], [["1. a"], ["1. b"]], [NUM, NUM], noGroup).segs)).toEqual([[0], [1]]);
    expect(alignSegments(["10. n10", "    * child"], [["1. n10", "   * child"]], [NUM], noGroup).segs).toEqual([{ idx: [0], start: 0, count: 2 }]);
    // 非 numbered 型別不剝編號
    expect(alignSegments(["2. b"], [["1. b"]], [P_], noGroup).segs).toBeNull();
  });

  it("U-A6 表格列的填充空白與分隔列 - 數不計；非表格行的空白差照樣對不上", () => {
    const r = alignSegments(["| a    | b |", "| ---- | --- |"], [["| a | b |", "| --- | ----- |"]], ["table"], noGroup);
    expect(r.segs).toEqual([{ idx: [0], start: 0, count: 2 }]);
    expect(alignSegments(["  | a  |"], [["  |a|"]], ["table"], noGroup).segs).not.toBeNull();
    expect(alignSegments(["a  b"], [["a b"]], [P_], noGroup).segs).toBeNull();
  });

  it("行尾空白不計（lineKey）", () => {
    expect(idxOf(alignSegments(["* a ", "\t", "b"], [["* a"], ["b  "]], [BUL, P_], noGroup).segs)).toEqual([[0], [1]]);
  });

  it("U-A7 局部合段最長先試：12 項 numbered 整串成一行 HTML → 一段、1 次群組匯出；只有 (0,5) 比得上時由長到短試 7 次", () => {
    const P = Array.from({ length: 12 }, (_, i) => [`${i + 1}. n${i + 1}`]);
    const types = P.map(() => NUM);
    const html = "<ol><li>n1</li>…<li>n12</li></ol>";
    const calls: string[] = [];
    const r = alignSegments([html], P, types, (i, j) => {
      calls.push(`${i}-${j}`);
      return i === 0 && j === 11 ? [html] : ["nope"];
    });
    expect(r.segs).toEqual([{ idx: Array.from({ length: 12 }, (_, k) => k), start: 0, count: 1 }]);
    expect(r.stats.groupCalls).toBe(1);
    expect(calls).toEqual(["0-11"]);

    const html6 = "<ol><li>n1</li>…<li>n6</li></ol>";
    const W = [html6, ...Array.from({ length: 6 }, (_, k) => `${k + 7}. n${k + 7}`)];
    const calls2: string[] = [];
    const r2 = alignSegments(W, P, types, (i, j) => {
      calls2.push(`${i}-${j}`);
      return i === 0 && j === 5 ? [html6] : ["nope"];
    });
    expect(idxOf(r2.segs)).toEqual([[0, 1, 2, 3, 4, 5], [6], [7], [8], [9], [10], [11]]);
    expect(r2.stats.groupCalls).toBe(7);
    expect(calls2).toEqual(["0-11", "0-10", "0-9", "0-8", "0-7", "0-6", "0-5"]);
  });

  it("U-A8 每個起點至多 cap 次群組匯出；超過就放棄這個起點", () => {
    const P = Array.from({ length: 12 }, (_, i) => [`${i + 1}. n${i + 1}`]);
    const calls: string[] = [];
    const r = alignSegments(["<ol>…</ol>"], P, P.map(() => NUM), (i, j) => {
      calls.push(`${i}-${j}`);
      return ["nope"];
    }, 3);
    expect(r.segs).toBeNull();
    expect(r.stats.capHits).toBeGreaterThanOrEqual(1);
    expect(calls.filter(c => c.startsWith("0-"))).toEqual(["0-11", "0-10", "0-9"]);
  });

  it("U-A9 回溯觸發群組（k13 形）：第 0 顆逐顆比得上、後面接不下去 → 群組 (0,1) 才成", () => {
    const r = alignSegments(["* a", "x", "* b"], [["* a"], ["* b"]], [BUL, BUL], (i, j) => (i === 0 && j === 1 ? ["* a", "x", "* b"] : ["nope"]));
    expect(r.segs).toEqual([{ idx: [0, 1], start: 0, count: 3 }]);
    expect(r.stats.groupUsedWhilePerMatched).toBe(1);
    expect(r.stats.groupCalls).toBe(1);
  });

  it("U-A10 對不上 → null；有剩下的行 → null；零顆：W 空 → []、W 不空 → null", () => {
    expect(alignSegments(["a"], [["b"]], [P_], noGroup).segs).toBeNull();
    expect(alignSegments(["a", "", "b"], [["a"]], [P_], noGroup).segs).toBeNull();
    expect(alignSegments([], [], [], noGroup).segs).toEqual([]);
    expect(alignSegments(["a"], [], [], noGroup).segs).toBeNull();
    // 中間的空段落只吃空行（不吃有字的行）
    expect(alignSegments(["A", "x", "B"], [["A"], [], ["B"]], [P_, P_, P_], noGroup).segs).toBeNull();
  });

  it("失敗記憶化承重：30 個中間空段落、各隔 2 行空行、最後一顆對不上 → null 且 < 500 ms（拿掉記憶化是指數時間）", () => {
    const W = ["A"];
    for (let k = 0; k < 30; k++) W.push("", "");
    W.push("", "Z");
    const P: string[][] = [["A"], ...Array.from({ length: 30 }, () => [] as string[]), ["B"]];
    const t0 = performance.now();
    const r = alignSegments(W, P, P.map(() => P_), noGroup);
    const ms = performance.now() - t0;
    expect(r.segs).toBeNull();
    expect(ms).toBeLessThan(500);
  });

  it("群組匯出以 (i, j) 快取：同一個起點在不同位置被走到時不重複匯出", () => {
    const calls: string[] = [];
    const r = alignSegments(["A", "", "", "x"], [["A"], [], ["* b"], ["* c"]], [P_, P_, BUL, BUL], (i, j) => {
      calls.push(`${i}-${j}`);
      return ["nope"];
    });
    expect(r.segs).toBeNull();
    expect(calls).toEqual(["2-3"]);
    expect(r.stats.groupCalls).toBe(1);
  });

  it("U-A11 20 000 顆段落：成功、不丟 RangeError、< 500 ms；最後一顆對不上 → null，失敗路徑走完整個回溯也不爆", () => {
    const n = 20_000;
    const P = Array.from({ length: n }, (_, i) => [`p${i}`]);
    const W: string[] = [];
    for (let i = 0; i < n; i++) {
      if (i > 0) W.push("");
      W.push(`p${i}`);
    }
    const types = P.map(() => P_);
    const t0 = performance.now();
    const ok = alignSegments(W, P, types, noGroup);
    const ms = performance.now() - t0;
    expect(ok.segs).toHaveLength(n);
    expect(ok.segs![n - 1]).toEqual({ idx: [n - 1], start: 2 * (n - 1), count: 1 });
    expect(ms).toBeLessThan(500);

    const P2 = P.slice();
    P2[n - 1] = ["nomatch"];
    const t1 = performance.now();
    const bad = alignSegments(W, P2, types, noGroup);
    expect(bad.segs).toBeNull();
    expect(performance.now() - t1).toBeLessThan(500);
  });
});

describe("lineKindsOf", () => {
  it("U-A12 含 numbered 的段的行 → 1，其餘 0；segs=null → 全 0", () => {
    const segs: AlignSeg[] = [
      { idx: [0], start: 0, count: 1 },
      { idx: [1, 2], start: 2, count: 2 },
      { idx: [3], start: 4, count: 0 },
      { idx: [4], start: 5, count: 1 },
    ];
    expect(lineKindsOf(segs, [P_, BUL, NUM, P_, NUM], 6)).toEqual([0, 0, 1, 1, 0, 1]);
    expect(lineKindsOf(null, [NUM], 3)).toEqual([0, 0, 0]);
  });
});
