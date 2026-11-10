import { describe, expect, it } from "vitest";
import type { TransferSegment } from "../../src/db/schema.js";
import { anchors, decide, matchesBase } from "../../src/transfer/decide.js";
import type { Region } from "../../src/transfer/regions.js";

/**
 * bulk transfer 判定（K1、K4、K5、K7、K8）。筆記自下載後動過就 409 `note_changed`，
 * `decide` 只在「現況＝基底」時被呼叫（`matchesBase`，MB）——外來 block、倖存者不見或被改、定位點全消失、衝突那幾組案已隨程式刪除。
 */

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
/** 現況＝基底（前提）：id 與段表同序。 */
function curOf(segs: TransferSegment[], types: Record<string, string> = {}) {
  const ids = segs.flatMap(s => s.ids);
  return { ids, fps: segs.flatMap(s => s.fps), types: ids.map(id => types[id] ?? "paragraph") };
}
/** 假 canonical：id → `c:<id>`（可覆寫）；`pre[ri]`＝區 ri 的預解析序列。記下收到的區號。 */
function sameWith(pre: string[][], canon: Record<string, string> = {}, log: number[] = []) {
  return (ri: number, against: string[]) => {
    log.push(ri);
    const p = pre[ri] ?? [];
    return p.length === against.length && against.every((id, i) => (canon[id] ?? `c:${id}`) === p[i]);
  };
}

describe("MB matchesBase（note_changed 的結構判準）", () => {
  const S = segsOf("A", "B", "~C");
  it("逐顆相同 → true；空段表對空現況 → true", () => {
    expect(matchesBase(S, curOf(S))).toBe(true);
    expect(matchesBase([], { ids: [], fps: [] })).toBe(true);
  });
  it("一顆指紋不同、id 不同、順序不同、多一顆、少一顆 → false", () => {
    const c = curOf(S);
    expect(matchesBase(S, { ids: c.ids, fps: ["f:A", "g:B", "f:C"] })).toBe(false);
    expect(matchesBase(S, { ids: ["A", "B2", "C"], fps: c.fps })).toBe(false);
    expect(matchesBase(S, { ids: ["B", "A", "C"], fps: ["f:B", "f:A", "f:C"] })).toBe(false);
    expect(matchesBase(S, { ids: [...c.ids, "X"], fps: [...c.fps, "f:X"] })).toBe(false);
    expect(matchesBase(S, { ids: c.ids.slice(0, 2), fps: c.fps.slice(0, 2) })).toBe(false);
  });
  it("一段多顆（群組段）攤平後比", () => {
    const G: TransferSegment[] = [{ ids: ["a", "b"], fps: ["f:a", "f:b"], start: 0, count: 2 }];
    expect(matchesBase(G, { ids: ["a", "b"], fps: ["f:a", "f:b"] })).toBe(true);
    expect(matchesBase(G, { ids: ["a"], fps: ["f:a"] })).toBe(false);
  });
});

describe("K1 決策表", () => {
  const S = segsOf("A", "B", "C");
  it("改寫：預解析＝基底那幾顆 → same（不動）", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S), sameWith([["c:B"]]));
    expect(d).toMatchObject({ mark: "same", survivors: ["B"], place: { replaceSurvivors: true } });
  });
  it("改寫：預解析不同 → applied、插在第一顆基底 block 之前", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B"], place: { ref: "B", where: "before" } });
  });
  it("改寫兩段：survivors＝兩顆、放在第一顆之前", () => {
    const S4 = segsOf("A", "B", "C", "D");
    const [d] = decide(S4, [region(S4, "rewrite", [1, 2], 0, 3)], curOf(S4), sameWith([["new"]]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B", "C"], place: { ref: "B", where: "before" } });
  });
  it("刪除 → applied", () => {
    const [d] = decide(S, [region(S, "delete", [1], 0, 2)], curOf(S), sameWith([]));
    expect(d).toMatchObject({ mark: "applied", survivors: ["B"] });
  });
  it("插入 → applied、插在 P 之後；不呼叫 same", () => {
    const S2 = segsOf("A", "C");
    const log: number[] = [];
    const [d] = decide(S2, [region(S2, "insert", [], 0, 1)], curOf(S2), sameWith([["c:A"]], {}, log));
    expect(d).toMatchObject({ mark: "applied", survivors: [], place: { ref: "A", where: "after" } });
    expect(log).toEqual([]);
  });
});

describe("K4 錨點", () => {
  it("P、N 都無（空基底）→ 文件開頭", () => {
    const [d] = decide([], [region([], "insert", [], -1, -1)], { ids: [], types: [] }, sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: null, place: { start: true } });
  });
  it("P 那段也在區裡 → 往前找下一個沒改的段", () => {
    const S = segsOf("A", "B", "C", "D");
    expect(anchors(S, [region(S, "rewrite", [1], 0, 2), region(S, "rewrite", [2], 1, 3)])).toEqual([
      { P: "A", N: "D" },
      { P: "A", N: "D" },
    ]);
  });
  it("0 行段不當錨點：「A、結尾空段落」最後加一段 → 新段在空段落之前（P＝A）", () => {
    const S = segsOf("A", "~E");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(S), sameWith([["new"]]));
    expect(d).toMatchObject({ P: "A", N: null, place: { ref: "A", where: "after" } });
  });
  it("0 行段不當錨點：「開頭空段落、A」最前加一段 → 插在 A 之前（開頭的空段落留在最前）", () => {
    const S = segsOf("~Z", "A");
    const [d] = decide(S, [region(S, "insert", [], 0, 1)], curOf(S), sameWith([["new"]]));
    expect(d).toMatchObject({ P: null, N: "A", place: { ref: "A", where: "before" } });
  });
});

describe("K5 stripStart", () => {
  const S = segsOf("A", "B", "C");
  const types = { A: "numberedListItem", B: "numberedListItem", C: "numberedListItem" };
  it("插在 numbered 之後、預解析第一顆是 numbered → true", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S, types), sameWith([["new"]]), { firstTypes: ["numberedListItem"] });
    expect(d!.stripStart).toBe(true);
  });
  it("清單第一項 → false", () => {
    const [d] = decide(S, [region(S, "rewrite", [0], -1, 1)], curOf(S, types), sameWith([["new"]]), { firstTypes: ["numberedListItem"] });
    expect(d!.stripStart).toBe(false);
  });
  it("插在 numbered 之後、但預解析第一顆不是 numbered → false", () => {
    const [d] = decide(S, [region(S, "rewrite", [1], 0, 2)], curOf(S, types), sameWith([["new"]]), { firstTypes: ["paragraph"] });
    expect(d!.stripStart).toBe(false);
  });
});

describe("K8 效能：索引只建一次", () => {
  it("8 000 顆、4 000 區（插入／改寫／刪除交錯）decide < 500 ms", () => {
    const names = Array.from({ length: 8000 }, (_, i) => `b${i}`);
    const S = segsOf(...names);
    const regions: Region[] = [];
    for (let k = 1; k < 8000; k += 2) {
      const kind = (["rewrite", "delete", "rewrite", "insert"] as const)[(k >> 1) % 4]!;
      regions.push(kind === "insert" ? region(S, "insert", [], k - 1, k + 1 < 8000 ? k + 1 : -1) : region(S, kind, [k], k - 1, k + 1 < 8000 ? k + 1 : -1));
    }
    const cur = curOf(S);
    const t0 = performance.now();
    const ds = decide(S, regions, cur, sameWith([]));
    expect(performance.now() - t0).toBeLessThan(500);
    expect(ds).toHaveLength(regions.length);
  });
});

describe("K7 刪除區錨點", () => {
  it("(a) 有 P → P after", () => {
    const S = segsOf("A", "B", "C");
    expect(decide(S, [region(S, "delete", [1], 0, 2)], curOf(S), sameWith([]))[0]!.anchor).toEqual({ block_id: "A", position: "after" });
  });
  it("(b) 只有 N → N before", () => {
    const S = segsOf("A", "B");
    expect(decide(S, [region(S, "delete", [0], -1, 1)], curOf(S), sameWith([]))[0]!.anchor).toEqual({ block_id: "B", position: "before" });
  });
  it("(c) P、N 都沒有、前面是 0 行段 → 那顆 after（0 行段不當 P，但可當鄰居）", () => {
    const S = segsOf("~Z", "B");
    expect(decide(S, [region(S, "delete", [1], 0, -1)], curOf(S), sameWith([]))[0]!.anchor).toEqual({ block_id: "Z", position: "after" });
  });
  it("(d) 刪光全部頂層、沒有寫入內容的區 → replaceWithEmpty", () => {
    const S = segsOf("A", "B");
    const ds = decide(S, [region(S, "delete", [0, 1], -1, -1)], curOf(S), sameWith([]));
    expect(ds[0]!.anchor).toBe("replaceWithEmpty");
  });
  it("(e) 刪光全部頂層、但另一區要寫入內容 → deferred（不會變空）", () => {
    const S = segsOf("A", "B");
    const ds = decide(S, [region(S, "rewrite", [0], -1, 1), region(S, "delete", [1], 0, -1)], curOf(S), sameWith([["new"]]));
    expect(ds[0]!.mark).toBe("applied");
    expect(ds[1]!.anchor).toBe("deferred");
  });
  it("(g') 那個改寫區若是 same（不移除）→ 它的 block 可以當鄰居", () => {
    const S = segsOf("A", "B");
    const ds = decide(S, [region(S, "rewrite", [0], -1, 1), region(S, "delete", [1], 0, -1)], curOf(S), sameWith([["c:A"]]));
    expect(ds[0]!.mark).toBe("same");
    expect(ds[1]!.anchor).toEqual({ block_id: "A", position: "after" });
  });
});
