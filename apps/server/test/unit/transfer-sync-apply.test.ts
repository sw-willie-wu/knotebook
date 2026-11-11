import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { fingerprintsOfGroups } from "../../src/notes/editing/fingerprint.js";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { fileSyncRows } from "../../src/transfer/sync-apply.js";
import { yieldToLoop } from "../../src/transfer/yield.js";
import { applyInMemory, docWith, forkOf, makeBaseInMemory, topOf, withEditor } from "./fixtures/transfer-sync.js";

// AP9：把 yieldToLoop 包成計數的 spy（內部仍呼叫原函式）。
vi.mock("../../src/transfer/yield.js", async importOriginal => {
  const m = await importOriginal<typeof import("../../src/transfer/yield.js")>();
  return { ...m, yieldToLoop: vi.fn(m.yieldToLoop) };
});

/**
 * bulk transfer 套用（AP1–AP9）。合併用記憶體 `Y.applyUpdate`。
 * 筆記動過就 409，`applySync` 只在現況＝基底時被呼叫——「人」先改過現況的案（衝突、外來 block、倖存者不見、
 * 刪光補空段落、same 鏈尾、多區同一接點）已隨合併刪除。
 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const P = (t: string) => ({ type: "paragraph", content: t });
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};
const texts = (doc: Y.Doc) => topOf(doc).map(b => b.text);
/** 基底 doc、下載基底、現況（fork 一份給「人」改）。 */
async function scene(blocks: unknown[], human?: (ed: Parameters<Parameters<typeof withEditor>[2]>[0], ids: string[]) => void) {
  const doc = await docWith(rt, blocks);
  const b = await makeBaseInMemory(rt, doc);
  const live = forkOf(doc);
  if (human) await withEditor(rt, live, ed => human(ed, b.ids));
  return { b, live };
}
const marks = (r: { plan: { decisions: Array<{ kind: string; mark: string }> } }) => r.plan.decisions.map(d => `${d.kind}:${d.mark}`);

describe("AP1 一次 mount", () => {
  it("applySync 只 mount fork 一次（規劃另一次，先後不巢狀）", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const m0 = rt.mounts;
    await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(rt.mounts - m0).toBe(2); // scratch 1＋fork 1
    expect(rt.inFlight).toBe(0);
  });
});

describe("AP2 改寫", () => {
  it("applied：在第一個倖存者的位置插入、移除倖存者", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(marks(r)).toEqual(["rewrite:applied"]);
    expect(texts(live)).toEqual(["A", "B2", "C"]);
    expect(topOf(live).map(x => x.id)).not.toContain(b.ids[1]);
    expect(r.applied.perRegion[0]!.beforeBlocks.map(x => x.id)).toEqual([b.ids[1]]);
    expect(r.applied.perRegion[0]!.afterIds).toEqual([topOf(live)[1]!.id]);
  });
});

describe("AP3 刪除區 anchor", () => {
  it("前有段 → P after", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nC", live);
    expect(texts(live)).toEqual(["A", "C"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: b.ids[0], position: "after" });
  });
  it("在開頭 → N before", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const r = await applyInMemory(rt, b, "B", live);
    expect(texts(live)).toEqual(["B"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: b.ids[1], position: "before" });
  });
});

describe("防守", () => {
  it("插入的 block 不在頂層 → applySync 在 diffSince 之前 throw（什麼都沒合併）", async () => {
    const doc = await docWith(rt, [{ type: "bulletListItem", content: "a", children: [P("child")] }, P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const fork = forkOf(live);
    const sv = Y.encodeStateVector(fork);
    const { planInMemory } = await import("./fixtures/transfer-sync.js");
    const { applySync } = await import("../../src/transfer/sync-apply.js");
    const planned = await planInMemory(rt, b, "* a\n\nchild\n\nB2", fork);
    if (!planned.ok) throw new Error("plan failed");
    // 決策與套用不一致的形：把放置點換成巢狀的子 block（插進去會落在 bullet 的 children 裡）
    const childId = await withEditor(rt, forkOf(fork), ed => (ed.document[0]!.children[0] as { id: string }).id);
    const d = planned.plan.decisions[0]!;
    expect(d.kind).toBe("rewrite");
    d.place = { ref: childId, where: "after" };
    d.survivors = [];
    const before = Y.encodeStateAsUpdate(live);
    await expect(applySync(rt, fork, sv, planned.plan, planned.cur)).rejects.toThrow("不在頂層");
    expect(Buffer.from(Y.encodeStateAsUpdate(live)).equals(Buffer.from(before))).toBe(true);
    expect(rt.inFlight).toBe(0);
  });
});

describe("AP5／AP9 讓出", () => {
  it("AP5 3 區 → mount 之前一次、之後一次＋區與區之間各一次", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D"), P("E")]);
    let yields = 0;
    const r = await applyInMemory(rt, b, "A2\n\nB\n\nC2\n\nD\n\nE2", live, { now: clock(25), applyYieldFn: async () => void yields++ });
    expect(r.plan.regions).toHaveLength(3);
    expect(yields).toBe(2 + 3);
  });
  it("AP5b 刪除區之間也各讓一次；空筆記的取代分支同樣讓出", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D"), P("E")]);
    let yields = 0;
    const r = await applyInMemory(rt, b, "A\n\nC\n\nE", live, { now: clock(25), applyYieldFn: async () => void yields++ });
    expect(marks(r)).toEqual(["delete:applied", "delete:applied"]);
    expect(yields).toBe(2 + 2);
    const empty = new Y.Doc();
    const be = await makeBaseInMemory(rt, empty);
    let ey = 0;
    await applyInMemory(rt, be, "P1", forkOf(empty), { now: clock(25), applyYieldFn: async () => void ey++ });
    expect(ey).toBe(2 + 1);
  });
  it("AP9 不傳 yieldFn → yieldToLoop 被呼叫 ≥ 1 次", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const spy = vi.mocked(yieldToLoop);
    const fork = forkOf(live);
    // 只量 applySync：規劃另跑（注入 noop 讓出），再數 applySync 期間的呼叫
    const { planInMemory } = await import("./fixtures/transfer-sync.js");
    const { applySync } = await import("../../src/transfer/sync-apply.js");
    const sv = Y.encodeStateVector(fork);
    const planned = await planInMemory(rt, b, "A\n\nB2", fork, { yieldFn: async () => {} });
    if (!planned.ok) throw new Error("plan failed");
    spy.mockClear();
    await applySync(rt, fork, sv, planned.plan, planned.cur);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
  it("AP9b mount fork 之前先讓出一次、mount 之後再一次：讓出時記下的 mounts 依序是「mount 前」「mount 後」", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const fork = forkOf(live);
    const { planInMemory } = await import("./fixtures/transfer-sync.js");
    const { applySync } = await import("../../src/transfer/sync-apply.js");
    const sv = Y.encodeStateVector(fork);
    const planned = await planInMemory(rt, b, "A\n\nB2", fork, { yieldFn: async () => {} });
    if (!planned.ok) throw new Error("plan failed");
    const m0 = rt.mounts;
    const seen: number[] = [];
    await applySync(rt, fork, sv, planned.plan, planned.cur, { yieldFn: async () => void seen.push(rt.mounts - m0) });
    expect(seen.slice(0, 2)).toEqual([0, 1]);
  });
});

describe("紀錄列（fileSyncRows 的列數前提）", () => {
  it("same 區不記；改寫列 anchor null＋after 非空；刪除列帶 anchor＋after 空；指紋＝合併後 afterGroups", async () => {
    const { b, live } = await scene([P("A"), { type: "bulletListItem", content: "item" }, P("B"), P("C"), P("X"), P("D"), P("E")]);
    const r = await applyInMemory(rt, b, "A\n\n- item\n\nB\n\nC2\n\nX\n\nE", live);
    expect(marks(r)).toEqual(["rewrite:same", "rewrite:applied", "delete:applied"]);
    const afterFingerprints = fingerprintsOfGroups(live.getXmlFragment(YDOC_FRAGMENT), r.applied.perRegion.map(p => p.afterIds));
    const { rows, regionIdx } = fileSyncRows({ noteId: "n", userId: "u", tokenId: null, agentLabel: null, decisions: r.plan.decisions, perRegion: r.applied.perRegion, afterFingerprints });
    expect(regionIdx).toEqual([1, 2]);
    expect(rows.map(x => ({ op: x.op, anchor: x.anchor, after: x.afterBlockIds, fp: x.afterFingerprint }))).toEqual([
      { op: "file_sync", anchor: null, after: r.applied.perRegion[1]!.afterIds, fp: afterFingerprints[1] },
      { op: "file_sync", anchor: { block_id: b.ids[4], position: "after" }, after: [], fp: null },
    ]);
    expect(afterFingerprints[1]).not.toBeNull();
  });
});

describe("AP8 空筆記", () => {
  it("零顆頂層的 fork＋agent 寫兩段 → 結果恰兩顆（沒有多餘空段落）、紀錄形為插入列", async () => {
    const empty = new Y.Doc();
    const b = await makeBaseInMemory(rt, empty);
    expect(b.base.segments).toEqual([]);
    const live = forkOf(empty);
    const r = await applyInMemory(rt, b, "P1\n\nP2", live);
    expect(marks(r)).toEqual(["insert:applied"]);
    expect(texts(live)).toEqual(["P1", "P2"]);
    expect(r.applied.perRegion[0]).toMatchObject({ beforeBlocks: [], anchor: null });
    expect(r.applied.perRegion[0]!.afterIds).toEqual(topOf(live).map(x => x.id));
  });
});
