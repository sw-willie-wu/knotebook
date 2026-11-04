import { describe, expect, it } from "vitest";
import type { TransferSegment } from "../../src/db/schema.js";
import { anchors, anchorsGone, decide, foreignContains, foreignInRange, type SameMode } from "../../src/transfer/decide.js";
import type { Region } from "../../src/transfer/regions.js";

/** bulk transfer spec §9.4；plan PR-2 §0.1-16、T6（K1–K7、FC1–FC5）。`same` 回呼一律用真的 `foreignContains`＋假 canonical 表（gate r2 I-2）。 */

/** 段：每個名字一段（1 個 id、1 行）；`~名字` ＝ 0 行段。 */
function segsOf(...names: string[]): TransferSegment[] {
  let line = 0;
  return names.map(n => {
    const zero = n.startsWith("~");
    const id = zero ? n.slice(1) : n;
    const s = { ids: [id], fps: [`f:${id}`], start: line, count: zero ? 0 : 1 };
    line += zero ? 0 : 2;
    return s;
  });
}
function region(segs: TransferSegment[], kind: Region["kind"], segIdx: number[], prevSeg: number, nextSeg: number, text = kind === "delete" ? "" : "x"): Region {
  return { kind, segIdx, baseIds: segIdx.flatMap(k => segs[k]!.ids), baseFps: segIdx.flatMap(k => segs[k]!.fps), text, prevSeg, nextSeg };
}
function curOf(ids: string[], opts: { changed?: string[]; types?: Record<string, string> } = {}) {
  return { ids, fps: ids.map(id => (opts.changed?.includes(id) ? `g:${id}` : `f:${id}`)), types: ids.map(id => opts.types?.[id] ?? "paragraph") };
}
/** 假 canonical：id → `c:<id>`（可覆寫）；`pre[ri]`＝區 ri 的預解析序列。回呼裡記下收到的 mode。 */
function sameWith(pre: string[][], canon: Record<string, string> = {}, log: Array<[number, SameMode]> = []) {
  return (ri: number, against: string[], mode: SameMode) => {
    log.push([ri, mode]);
    return foreignContains(pre[ri] ?? [], against.map(id => canon[id] ?? `c:${id}`), mode);
  };
}

describe("FC1–FC5 foreignContains", () => {
  it("FC1 equal：逐項相等 → 0、長度不同 → -1", () => {
    expect(foreignContains(["a", "b"], ["a", "b"], "equal")).toBe(0);
    expect(foreignContains(["a"], ["a", "b"], "equal")).toBe(-1);
    expect(foreignContains([], [], "equal")).toBe(0);
  });
  it("FC2 contiguous：連續子序列（頭、尾、中間）→ 比中的起點", () => {
    expect(foreignContains(["a", "b"], ["a", "b", "c"], "contiguous")).toBe(0);
    expect(foreignContains(["b", "c"], ["a", "b", "c"], "contiguous")).toBe(1);
    expect(foreignContains(["b"], ["a", "b", "c"], "contiguous")).toBe(1);
  });
  it("FC3 只同前半 → false", () => {
    expect(foreignContains(["a", "x"], ["a", "b"], "contiguous")).toBe(-1);
  });
  it("FC4 兩份對一份 → false", () => {
    expect(foreignContains(["a", "a"], ["a"], "contiguous")).toBe(-1);
  });
  it("FC5 不連續（中間夾一顆別的）→ false；contiguous 對空 preparsed → false", () => {
    expect(foreignContains(["a", "c"], ["a", "b", "c"], "contiguous")).toBe(-1);
    expect(foreignContains([], ["a"], "contiguous")).toBe(-1);
  });
});

describe("K1 決策表（§9.4-2 逐列）", () => {
  const S = segsOf("A", "B", "C");
  it("改寫：預解析＝倖存者 → same（不動）", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "B", "C"]), sameWith([["c:B"]]));
    expect(d).toMatchObject({ mark: "same", survivors: ["B"], place: { replaceSurvivors: true } });
  });
  it("改寫：被改、不見皆空 → applied、插在第一個倖存者之前", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "B", "C"]), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B"], changed: [], missing: [], place: { ref: "B", where: "before" } });
  });
  it("改寫：倖存者被改 → conflict", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "B", "C"], { changed: ["B"] }), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "conflict", changed: ["B"], place: { ref: "B", where: "before" } });
  });
  it("改寫：倖存者全不見 → conflict、插在 P 之後", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "C"]), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "conflict", missing: ["B"], place: { ref: "A", where: "after" } });
  });
  it("反例：改寫兩段、一顆不見一顆沒改 → conflict（不是 applied）", () => {
    const S4 = segsOf("A", "B", "C", "D");
    const [d] = decide(S4, [region(S4, "rewrite", [1, 2], 0, 3)], curOf(["A", "C", "D"]), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "conflict", survivors: ["C"], missing: ["B"], place: { ref: "C", where: "before" } });
  });
  it("刪除：倖存者全不見 → same", () => {
    const [d] = decide(S, [region(S, "delete", [1], 0, 2)], curOf(["A", "C"]), sameWith([]));
    expect(d).toMatchObject({ mark: "same" });
    expect(d!.anchor).toBeUndefined();
  });
  it("刪除：被改空 → applied", () => {
    const [d] = decide(S, [region(S, "delete", [1], 0, 2)], curOf(["A", "B", "C"]), sameWith([]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B"] });
  });
  it("刪除：被改非空 → conflict", () => {
    const [d] = decide(S, [region(S, "delete", [1], 0, 2)], curOf(["A", "B", "C"], { changed: ["B"] }), sameWith([]));
    expect(d).toMatchObject({ mark: "conflict", changed: ["B"] });
  });
  it("插入 → applied、插在 P 之後", () => {
    const S2 = segsOf("A", "C");
    const [d] = decide(S2, [region(S2, "insert", [], 0, 1)], curOf(["A", "C"]), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", place: { ref: "A", where: "after" } });
  });
});

describe("K2／K3 外來 block 與倖存者的位置", () => {
  it("K2 外來 block 在倖存者前／間／後：倖存者依現況順序、插在第一個倖存者之前（外來不動）", () => {
    const S = segsOf("A", "B", "C", "D");
    const [d] = decide(S, [region(S, "rewrite", [1, 2], 0, 3)], curOf(["A", "F1", "B", "F2", "C", "F3", "D"]), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B", "C"], place: { ref: "B", where: "before" } });
  });
  it("K3 倖存者被拖走：放在它現在的位置；拖亂順序：集中放在第一個倖存者處、判 applied（不比順序）", () => {
    const S = segsOf("A", "B", "C", "D");
    const [moved] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "C", "D", "B"]), sameWith([["new"]]));
    expect(moved).toMatchObject({ mark: "applied", place: { ref: "B", where: "before" } });
    const [shuffled] = decide(S, [region(S, "rewrite", [1, 2], 0, 3)], curOf(["A", "C", "X", "B", "D"]), sameWith([["new"]]));
    expect(shuffled).toMatchObject({ mark: "applied", survivors: ["C", "B"], place: { ref: "C", where: "before" } });
  });
});

describe("K4 錨點", () => {
  it("P 在 N 之後 → 用 N", () => {
    const S = segsOf("A", "B", "C");
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["C", "A"]), sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: "C", place: { ref: "C", where: "before" } });
  });
  it("P、N 都無 → 文件開頭", () => {
    const S = segsOf("A", "B", "C");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(["X"]), sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: null, place: { start: true } });
  });
  it("P 那段被刪了 → 往前找下一個沒改的段", () => {
    const S = segsOf("A", "B", "C", "D");
    expect(anchors(S, [region(S, "rewrite", [2], 1, 3)], curOf(["A", "C", "D"]))).toEqual([{ P: "A", N: "D" }]);
  });
  it("0 行段不當錨點：「A、結尾空段落」最後加一段 → 新段在空段落之前（P＝A）", () => {
    const S = segsOf("A", "~E");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(["A", "E"]), sameWith([["new"]]));
    expect(d).toMatchObject({ P: "A", N: null, place: { ref: "A", where: "after" } });
  });
  it("0 行段不當錨點：「開頭空段落、A」最前加一段 → 插在 A 之前（開頭的空段落留在最前）", () => {
    const S = segsOf("~Z", "A");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(["Z", "A"]), sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: "A", place: { ref: "A", where: "before" } });
  });
});

describe("K5 stripStart", () => {
  const types = { A: "numberedListItem", B: "numberedListItem", C: "numberedListItem" };
  it("插在 numbered 之後、預解析第一顆是 numbered → true", () => {
    const S = segsOf("A", "B", "C");
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "B", "C"], { types }), sameWith([["new"]]), { firstTypes: ["numberedListItem"] });
    expect(d!.stripStart).toBe(true);
  });
  it("清單第一項 → false", () => {
    const S = segsOf("A", "B", "C");
    const [d] = decide(S, [region(S, "rewrite", [0], -1, 1)], curOf(["A", "B", "C"], { types }), sameWith([["new"]]), { firstTypes: ["numberedListItem"] });
    expect(d!.stripStart).toBe(false);
  });
  it("插在 numbered 之後、但預解析第一顆不是 numbered → false", () => {
    const S = segsOf("A", "B", "C");
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "B", "C"], { types }), sameWith([["new"]]), { firstTypes: ["paragraph"] });
    expect(d!.stripStart).toBe(false);
  });
});

describe("K6 插入區比 P..N 之間的外來 block（plan §0.1-16）", () => {
  const S = segsOf("A", "B");
  const ins = () => [region(S, "insert", [], 0, 1)];
  it("(a) P..N 之間已有逐 block 相同的外來 block → same、不插；回呼收到 contiguous", () => {
    const log: Array<[number, SameMode]> = [];
    const [d] = decide(S, ins(), curOf(["A", "F", "G", "B"]), sameWith([["x", "y"]], { F: "x", G: "y" }, log));
    expect(d).toMatchObject({ mark: "same", preferForeignSame: true, sameForeign: ["F", "G"] });
    expect(log).toEqual([[0, "contiguous"]]);
  });
  it("(a') 比中的是範圍中間那一段 → sameTail＝那一段的最後一顆（不是範圍末顆）", () => {
    const [d] = decide(S, ins(), curOf(["A", "E", "F", "G", "H", "B"]), sameWith([["x", "y"]], { F: "x", G: "y" }), { preLengths: [2] });
    expect(d).toMatchObject({ mark: "same", sameForeign: ["E", "F", "G", "H"], sameTail: "G" });
  });
  it("(b) 外來只相同前半 → applied", () => {
    const [d] = decide(S, ins(), curOf(["A", "F", "B"]), sameWith([["x", "y"]], { F: "x" }));
    expect(d!.mark).toBe("applied");
  });
  it("(c) 預解析兩份相同、外來只有一份 → applied（照插兩份）", () => {
    const [d] = decide(S, ins(), curOf(["A", "F", "B"]), sameWith([["x", "x"]], { F: "x" }));
    expect(d!.mark).toBe("applied");
  });
  it("(d) 相同內容的外來 block 在 P 之前（不在 P..N）→ applied", () => {
    const [d] = decide(S, ins(), curOf(["F", "A", "B"]), sameWith([["x"]], { F: "x" }));
    expect(d!.mark).toBe("applied");
  });
  it("(e) 預解析與 N（基底 block）相同 → applied（N 不是外來）", () => {
    const [d] = decide(S, ins(), curOf(["A", "B"]), sameWith([["x"]], { B: "x" }));
    expect(d!.mark).toBe("applied");
  });
  it("(f) 被拖進 P..N 的其他段的基底 block 與預解析相同 → applied（基底 block 不算外來）", () => {
    const S3 = segsOf("A", "B", "C");
    const [d] = decide(S3, [region(S3, "insert", [], 0, 1)], curOf(["A", "C", "B"]), sameWith([["x"]], { C: "x" }));
    expect(d!.mark).toBe("applied");
  });
  it("改寫區的回呼收到 equal（倖存者還在、全不見兩形）", () => {
    const S3 = segsOf("A", "B", "C");
    const log: Array<[number, SameMode]> = [];
    decide(S3, [region(S3, "rewrite", [1], 0, 2)], curOf(["A", "B", "C"]), sameWith([["new"]], {}, log));
    decide(S3, [region(S3, "rewrite", [1], 0, 2)], curOf(["A", "C"]), sameWith([["new"]], {}, log));
    expect(log).toEqual([
      [0, "equal"],
      [0, "equal"],
    ]);
  });
  it("改寫區倖存者全不見、錨點間外來 block 相同 → same（equal）", () => {
    const S3 = segsOf("A", "B", "C");
    const [d] = decide(S3, [region(S3, "rewrite", [1], 0, 2)], curOf(["A", "B2", "C"]), sameWith([["x"]], { B2: "x" }));
    expect(d).toMatchObject({ mark: "same", preferForeignSame: true, sameForeign: ["B2"] });
  });
  it("foreignInRange：外來＝cur − 基底全部段；範圍照錨點", () => {
    const S3 = segsOf("A", "B", "C");
    expect(foreignInRange(S3, curOf(["X", "A", "Y", "B", "Z", "C", "W"]), "A", "C")).toEqual(["Y", "Z"]);
    expect(foreignInRange(S3, curOf(["X", "A", "Y"]), "A", null)).toEqual(["Y"]);
    expect(foreignInRange(S3, curOf(["X", "C", "Y"]), null, "C")).toEqual(["X"]);
    expect(foreignInRange(S3, curOf(["X", "Y"]), null, null)).toEqual(["X", "Y"]);
  });
});

describe("K8 效能：索引只建一次（審查 Important 1）", () => {
  it("8 000 顆、4 000 區（插入／改寫／刪除交錯）decide < 500 ms", () => {
    const names = Array.from({ length: 8000 }, (_, i) => `b${i}`);
    const S = segsOf(...names);
    const regions: Region[] = [];
    for (let k = 1; k < 8000; k += 2) {
      const kind = (["rewrite", "delete", "rewrite", "insert"] as const)[(k >> 1) % 4]!;
      regions.push(kind === "insert" ? region(S, "insert", [], k - 1, k + 1 < 8000 ? k + 1 : -1) : region(S, kind, [k], k - 1, k + 1 < 8000 ? k + 1 : -1));
    }
    const cur = curOf(names);
    const t0 = performance.now();
    const ds = decide(S, regions, cur, sameWith([]));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(ds).toHaveLength(regions.length);
  });
});

describe("K7 刪除區錨點（gate r2 m-8；rev 4）", () => {
  it("(a) 有 P → P after", () => {
    const S = segsOf("A", "B", "C");
    expect(decide(S, [region(S, "delete", [1], 0, 2)], curOf(["A", "B", "C"]), sameWith([]))[0]!.anchor).toEqual({ block_id: "A", position: "after" });
  });
  it("(b) 只有 N → N before", () => {
    const S = segsOf("A", "B");
    expect(decide(S, [region(S, "delete", [0], -1, 1)], curOf(["A", "B"]), sameWith([]))[0]!.anchor).toEqual({ block_id: "B", position: "before" });
  });
  it("(c) P、N 都不可用、現況有外來段 F 在倖存者之前 → F after", () => {
    const S = segsOf("A", "B", "C");
    expect(decide(S, [region(S, "delete", [1], 0, 2)], curOf(["F", "B"]), sameWith([]))[0]!.anchor).toEqual({ block_id: "F", position: "after" });
  });
  it("(d) 倖存者＝全部頂層、其餘區都是 same／刪除 → replaceWithEmpty", () => {
    const S = segsOf("A", "B", "C");
    expect(decide(S, [region(S, "delete", [1], 0, 2)], curOf(["B"]), sameWith([]))[0]!.anchor).toBe("replaceWithEmpty");
  });
  it("(e) 反例一：人刪 A、C；agent 刪 B、在 C 後加 X → deferred（有插入區，不會變空）", () => {
    const S = segsOf("A", "B", "C");
    const ds = decide(S, [region(S, "delete", [1], 0, 2), region(S, "insert", [], 2, -1)], curOf(["B"]), sameWith([[], ["x"]]));
    expect(ds[0]!.anchor).toBe("deferred");
    expect(ds[1]).toMatchObject({ mark: "applied", place: { start: true } });
  });
  it("(f) 反例二：人刪 B；agent 刪 A 與 C → 兩區都 replaceWithEmpty、候選沒拿對方要刪的 block", () => {
    const S = segsOf("A", "B", "C");
    const ds = decide(S, [region(S, "delete", [0], -1, 1), region(S, "delete", [2], 1, -1)], curOf(["A", "C"]), sameWith([]));
    expect(ds.map(d => d.anchor)).toEqual(["replaceWithEmpty", "replaceWithEmpty"]);
  });
  it("(g) 候選掃描跳過「別的非 same 改寫區的倖存者」→ deferred", () => {
    const S = segsOf("A", "U", "B");
    const ds = decide(S, [region(S, "rewrite", [0], -1, 1), region(S, "delete", [2], 1, -1)], curOf(["A", "B"]), sameWith([["new"]]));
    expect(ds[0]!.mark).toBe("applied");
    expect(ds[1]!.anchor).toBe("deferred");
  });
  it("(h) 往外掃不到 → 倖存者區間內不移除的 block（審查 m1：人刪 C、在 A、B 之間插 F；agent 刪 A、B → anchor＝F）", () => {
    const S = segsOf("A", "B", "C");
    const [d] = decide(S, [region(S, "delete", [0, 1], -1, 2)], curOf(["A", "F", "B"]), sameWith([]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["A", "B"], anchor: { block_id: "F", position: "before" } });
  });
  it("(g') 那個改寫區若是 same（不移除）→ 它的倖存者可以當鄰居", () => {
    const S = segsOf("A", "U", "B");
    const ds = decide(S, [region(S, "rewrite", [0], -1, 1), region(S, "delete", [2], 1, -1)], curOf(["A", "B"]), sameWith([["c:A"]]));
    expect(ds[0]!.mark).toBe("same");
    expect(ds[1]!.anchor).toEqual({ block_id: "A", position: "after" });
  });
});

describe("AG 定位點全消失（Willie 2026-11-04：整篇 409，不退到文件開頭）", () => {
  const S = segsOf("A", "B", "C");
  const gone = (segs: TransferSegment[], regions: Region[], cur: ReturnType<typeof curOf>, pre: string[][] = []) => anchorsGone(segs, regions, decide(segs, regions, cur, sameWith(pre)), cur);
  it("AG1 改寫 B：B、A、C 都換了新 id（edit_note 改寫整段）→ [0]", () => {
    expect(gone(S, [region(S, "rewrite", [1], 0, 2)], curOf(["X", "Y", "Z"]))).toEqual([0]);
  });
  it("AG2 改寫 B：B 不見、A 還在 → [0]（第二輪：改寫區倖存者全不見一律拒絕，不論 P、N）；B 還在 → []", () => {
    expect(gone(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "Z"]))).toEqual([0]);
    expect(gone(S, [region(S, "rewrite", [1], 0, 2)], curOf(["A", "C"]), [["c:B2"]])).toEqual([0]);
    expect(gone(S, [region(S, "rewrite", [1], 0, 2)], curOf(["X", "B", "Z"]))).toEqual([]);
  });
  it("AG3 插入在 C 之後（尾端，本來就沒有 N）：A、B、C 都不見 → [0]；C 在 → []", () => {
    expect(gone(S, [region(S, "insert", [], 2, -1)], curOf(["X"]))).toEqual([0]);
    expect(gone(S, [region(S, "insert", [], 2, -1)], curOf(["X", "C"]))).toEqual([]);
  });
  it("AG4 基底開頭插入（本來就沒有 P）：N（A）還在 → []；A、B、C 都不見 → [0]", () => {
    expect(gone(S, [region(S, "insert", [], -1, 0)], curOf(["A", "B", "C"]))).toEqual([]);
    expect(gone(S, [region(S, "insert", [], -1, 0)], curOf(["X"]))).toEqual([0]);
  });
  it("AG5 空基底（0 段）插入、或基底只剩 0 行段 → []（沒有可錨的段，文件開頭照舊）", () => {
    const E: TransferSegment[] = [];
    expect(gone(E, [region(E, "insert", [], -1, -1)], curOf(["X"]))).toEqual([]);
    const Z = segsOf("~e");
    expect(gone(Z, [region(Z, "insert", [], 0, -1)], curOf(["X"]))).toEqual([]);
  });
  it("AG6 現況 0 顆頂層（AP8／AP8b 那條路）→ []（區本身是會寫入的 conflict，不是 same）", () => {
    const regions = [region(S, "rewrite", [1], 0, 2)];
    const cur = curOf([]);
    const ds = decide(S, regions, cur, sameWith([["c:B2"]]));
    expect(ds[0]).toMatchObject({ mark: "conflict", P: null, N: null, survivors: [] });
    expect(anchorsGone(S, regions, ds, cur)).toEqual([]);
  });
  it("AG9（審查 I1）基底只有 0 行段（空段落）的改寫區照插入區判：空段落被刪、A、B 還在 → []；A、B 也不見 → [0]", () => {
    const E3 = segsOf("A", "~e", "B");
    expect(gone(E3, [region(E3, "rewrite", [1], 0, 2)], curOf(["A", "B"]), [["c:new"]])).toEqual([]);
    expect(gone(E3, [region(E3, "rewrite", [1], 0, 2)], curOf(["X", "Y"]), [["c:new"]])).toEqual([0]);
    // 實際匯出：空段落是一行空行（count 1）→ 靠 blankSegs 認；沒標 blank 的同形 → [0]（倖存者規則）
    const E = segsOf("A", "E", "B");
    const rs = [region(E, "rewrite", [1], 0, 2)];
    const cur = curOf(["A", "B"]);
    const ds = decide(E, rs, cur, sameWith([["c:new"]]));
    expect(anchorsGone(E, rs, ds, cur, [false, true, false])).toEqual([]);
    expect(anchorsGone(E, rs, ds, cur)).toEqual([0]);
  });
  it("AG8 刪除區不算：B 還在、A、C 換了新 id（P、N 都沒有）→ []（有倖存者可刪）", () => {
    expect(gone(S, [region(S, "delete", [1], 0, 2)], curOf(["X", "B", "Z"]))).toEqual([]);
  });
  it("AG7 不算的區：same（倖存者全不見、外來相同）、刪除區 → []；多區裡只要一區全消失就回那一區", () => {
    // 改寫 B、外來 X 與預解析相同 → same
    expect(gone(S, [region(S, "rewrite", [1], 0, 2)], curOf(["X"]), [["c:X"]])).toEqual([]);
    expect(gone(S, [region(S, "delete", [1], 0, 2)], curOf(["X"]))).toEqual([]);
    const S5 = segsOf("A", "B", "C", "D", "E");
    // 區 0 改 A（A 還在）、區 1 插在 E 之後（B..E 全不見；A 在區內不能當錨）→ [1]
    expect(gone(S5, [region(S5, "rewrite", [0], -1, 1), region(S5, "insert", [], 4, -1)], curOf(["A", "X"]))).toEqual([1]);
  });
});
