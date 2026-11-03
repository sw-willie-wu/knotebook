import { describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";
import * as shared from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { sameCanonicalStats } from "../../src/transfer/same-canonical.js";
import { docWith, forkOf, makeBaseInMemory, planInMemory, withEditor } from "./fixtures/transfer-sync.js";

// 不靠時間的守衛：數 `topLevelContainers` 被呼叫幾次（同 sameCanonical 的頂層索引入口；包一層計數、內部仍呼叫原函式）。
vi.mock("@knotebook/shared", async importOriginal => {
  const m = await importOriginal<typeof import("@knotebook/shared")>();
  return { ...m, topLevelContainers: vi.fn(m.topLevelContainers) };
});

/**
 * bulk transfer plan PR-2 T6：規劃尾段的複雜度與停頓（審查 Important 1）。2 000 顆、隔一顆改一顆（1 000 區）時，逐區重建頂層表
 * 是 O(區數×頂層數)（審查實測：最後一次讓出之後同步 7 639 ms，1 000 次 sameCanonicalSeq 佔 6 158 ms）。
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const P = (t: string) => ({ type: "paragraph", content: t });

async function scene(n: number) {
  const doc = await docWith(rt, Array.from({ length: n }, (_, i) => P(`p${i}`)));
  const b = await makeBaseInMemory(rt, doc);
  const body = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
  return { b, live: forkOf(doc), body };
}

describe("規劃尾段", () => {
  // 牆鐘門檻只抓數量級退化（複審：300 ms 在雲端 CI 上兩個方向都可能翻）；「每區之後都讓出」的確定性守衛在
  // transfer-sync-plan.test.ts 的 P6c（步進時鐘），呼叫次數守衛在下面兩案。
  it("1 000 區、2 000 顆：預設讓出下，最長同步間隔（含最後一次讓出到回傳）< 1 500 ms", async () => {
    const { b, live, body } = await scene(2000);
    const stamps: number[] = [];
    const { yieldToLoop } = await import("../../src/transfer/yield.js");
    const t0 = performance.now();
    const r = await planInMemory(rt, b, body, live, {
      yieldFn: async () => {
        stamps.push(performance.now());
        await yieldToLoop();
        stamps.push(performance.now());
      },
    });
    const t1 = performance.now();
    if (!r.ok) throw new Error(r.code);
    expect(r.plan.regions).toHaveLength(1000);
    // 間隔＝上一次讓出回來 → 下一次讓出開始；頭（開始到第一次讓出）與尾（最後一次讓出回來到回傳）都算
    const points = [t0, ...stamps, t1];
    let maxGap = 0;
    for (let i = 0; i + 1 < points.length; i += 2) maxGap = Math.max(maxGap, points[i + 1]! - points[i]!);
    const tail = t1 - stamps[stamps.length - 1]!;
    console.log(`PERF regions=1000 blocks=2000 total=${(t1 - t0).toFixed(0)}ms yields=${stamps.length / 2} maxGap=${maxGap.toFixed(0)}ms tail=${tail.toFixed(0)}ms`);
    expect(tail).toBeLessThan(1500);
    expect(maxGap).toBeLessThan(1500);
  }, 180_000);

  it("topLevelContainers 的呼叫次數與區數無關（每個 fragment 只建一次索引）", async () => {
    const spy = vi.mocked(shared.topLevelContainers);
    const counts: number[] = [];
    for (const n of [20, 200]) {
      const { b, live, body } = await scene(n);
      spy.mockClear();
      const r = await planInMemory(rt, b, body, live, { yieldFn: async () => {} });
      if (!r.ok) throw new Error(r.code);
      counts.push(spy.mock.calls.length);
    }
    console.log(`TOPLEVEL calls: 10 regions=${counts[0]} / 100 regions=${counts[1]}`);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[1]).toBeLessThanOrEqual(4);
  }, 120_000);

  it("scratch 寫入不逐區重讀 editor.document（整份 block JSON；呼叫次數與區數無關）", async () => {
    const spy = vi.spyOn(BlockNoteEditor.prototype, "document", "get");
    const counts: number[] = [];
    try {
      for (const n of [20, 200]) {
        const { b, live, body } = await scene(n);
        spy.mockClear();
        const r = await planInMemory(rt, b, body, live, { yieldFn: async () => {} });
        if (!r.ok) throw new Error(r.code);
        counts.push(spy.mock.calls.length);
      }
    } finally {
      spy.mockRestore();
    }
    console.log(`DOCUMENT getter: 10 regions=${counts[0]} / 100 regions=${counts[1]}`);
    expect(counts[1]).toBe(counts[0]);
  }, 120_000);

  /** 人刪光基底、換成 2 000 顆外來；agent 在 1 000 處各插一段（插入區，比外來 block 用 contiguous）或改 1 000 段（改寫區、倖存者全不見，equal）。 */
  async function foreignScene(mode: "insert" | "rewrite") {
    const n = 1000;
    const doc = await docWith(rt, Array.from({ length: n }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    await withEditor(rt, live, ed => ed.replaceBlocks(ed.document.map(x => x.id), Array.from({ length: 2000 }, (_, i) => P(`foreign${i}`)) as never));
    const body = Array.from({ length: n }, (_, i) => (mode === "insert" ? `p${i}\n\nnew${i}` : i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    return { b, live, body };
  }
  it("canonicalize 次數（不靠牆鐘）：插入區 1 000 個 × 外來 2 000 顆 → 每顆至多一次（快取）；改寫區長度不同 → 不 canonicalize 外來（先比長度）", async () => {
    const ins = await foreignScene("insert");
    sameCanonicalStats.canonicalized = 0;
    const ri = await planInMemory(rt, ins.b, ins.body, ins.live, { yieldFn: async () => {} });
    if (!ri.ok) throw new Error(ri.code);
    expect(ri.plan.regions.filter(r => r.kind === "insert")).toHaveLength(1000);
    const insCount = sameCanonicalStats.canonicalized;
    const rw = await foreignScene("rewrite");
    sameCanonicalStats.canonicalized = 0;
    const rr = await planInMemory(rt, rw.b, rw.body, rw.live, { yieldFn: async () => {} });
    if (!rr.ok) throw new Error(rr.code);
    expect(rr.plan.regions).toHaveLength(500);
    const rwCount = sameCanonicalStats.canonicalized;
    console.log(`CANON insert=${insCount} rewrite=${rwCount}`);
    expect(insCount).toBeLessThanOrEqual(1000 + 2000); // 預解析 1 000＋外來 2 000，各一次
    expect(rwCount).toBeLessThanOrEqual(500); // 只有預解析；外來一顆都沒 canonicalize
  }, 300_000);
});
