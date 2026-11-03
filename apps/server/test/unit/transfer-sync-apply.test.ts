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

/** bulk transfer spec §9.4-4、§9.5 第 6 步；plan PR-2 T7（AP1–AP9）。合併用記憶體 `Y.applyUpdate`（同 spike）。 */

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

describe("AP2 改寫三形", () => {
  it("applied：在第一個倖存者的位置插入、移除倖存者", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(marks(r)).toEqual(["rewrite:applied"]);
    expect(texts(live)).toEqual(["A", "B2", "C"]);
    expect(topOf(live).map(x => x.id)).not.toContain(b.ids[1]);
    expect(r.applied.perRegion[0]!.beforeBlocks.map(x => x.id)).toEqual([b.ids[1]]);
    expect(r.applied.perRegion[0]!.afterIds).toEqual([topOf(live)[1]!.id]);
  });
  it("conflict（人改了同一段）：取 agent 的", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => ed.updateBlock(ids[1]!, { content: "human" }));
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(marks(r)).toEqual(["rewrite:conflict"]);
    expect(texts(live)).toEqual(["A", "B2", "C"]);
  });
  it("倖存者全不見（人刪了）：插在 P 之後", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(marks(r)).toEqual(["rewrite:conflict"]);
    expect(texts(live)).toEqual(["A", "B2", "C"]);
  });
});

describe("AP3 刪除區 anchor", () => {
  it("前有段 → P after", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")]);
    const r = await applyInMemory(rt, b, "A\n\nC", live);
    expect(texts(live)).toEqual(["A", "C"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: b.ids[0], position: "after" });
    expect(r.applied.anchorIds).toEqual([b.ids[0]]);
  });
  it("在開頭 → N before", async () => {
    const { b, live } = await scene([P("A"), P("B")]);
    const r = await applyInMemory(rt, b, "B", live);
    expect(texts(live)).toEqual(["B"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: b.ids[1], position: "before" });
  });
  it("刪光現況（人刪了 B、agent 刪 A）→ 空段落＋anchor before", async () => {
    const { b, live } = await scene([P("A"), P("B")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    const r = await applyInMemory(rt, b, "B", live);
    const top = topOf(live);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ type: "paragraph", text: "" });
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: top[0]!.id, position: "before" });
  });
  it("P、N 都不可用、只剩外來段 F → anchor＝F（紀錄列 anchor 非空、after 為空：過 anchor_chk）", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => {
      ed.insertBlocks([{ type: "paragraph", content: "F" }], ids[0]!, "after");
      ed.removeBlocks([ids[0]!, ids[2]!]);
    });
    const r = await applyInMemory(rt, b, "A\n\nC", live);
    const top = topOf(live);
    expect(top.map(x => x.text)).toEqual(["F"]);
    expect(r.applied.perRegion[0]).toMatchObject({ anchor: { block_id: top[0]!.id, position: "after" }, afterIds: [] });
  });
  it("(e) 反例一：人刪 A、C；agent 刪 B、在 C 後加 X → 結果恰 [X]、B 那列的 anchor＝X after", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => ed.removeBlocks([ids[0]!, ids[2]!]));
    const r = await applyInMemory(rt, b, "A\n\nC\n\nX", live);
    expect(marks(r)).toEqual(["delete:applied", "insert:applied"]);
    const top = topOf(live);
    expect(top.map(x => x.text)).toEqual(["X"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: top[0]!.id, position: "after" });
  });
  it("(f) 反例二：人刪 B；agent 刪 A 與 C → 結果恰一顆空段落、兩列 anchor 都是它且在最終文件裡", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    const r = await applyInMemory(rt, b, "B", live);
    expect(marks(r)).toEqual(["delete:applied", "delete:applied"]);
    const top = topOf(live);
    expect(top).toHaveLength(1);
    expect(top[0]).toMatchObject({ type: "paragraph", text: "" });
    for (const pr of r.applied.perRegion) expect(pr.anchor).toEqual({ block_id: top[0]!.id, position: "before" });
    expect(r.applied.perRegion.map(pr => pr.beforeBlocks.map(x => x.id))).toEqual([[b.ids[0]], [b.ids[2]]]);
  });
});

describe("AP3(g) 倖存者區間內的外來 block 當 anchor（審查 m1）", () => {
  it("人刪 C、在 A、B 之間插 F；agent 刪 A、B → 結果恰 [F]、anchor＝F（不多一顆空段落）", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => {
      ed.insertBlocks([{ type: "paragraph", content: "F" }], ids[0]!, "after");
      ed.removeBlocks([ids[2]!]);
    });
    const r = await applyInMemory(rt, b, "C", live);
    expect(marks(r)).toEqual(["delete:applied"]);
    const top = topOf(live);
    expect(top.map(x => x.text)).toEqual(["F"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: top[0]!.id, position: "before" });
  });
});

describe("AP3(h) 延後錨點：本次插入的 block 落在倖存者區間內（複審 m1-b）", () => {
  it("基底 [B1, B2, U, R]；人刪 U、把 R 拖到 B1、B2 之間；agent 刪 B1、B2、改 R → 結果恰 [R2]", async () => {
    const { b, live } = await scene([P("B1"), P("B2"), P("U"), P("R")], (ed, ids) => {
      const r = ed.getBlock(ids[3]!)!;
      ed.removeBlocks([ids[2]!, ids[3]!]);
      ed.insertBlocks([r], ids[0]!, "after");
    });
    const r = await applyInMemory(rt, b, "U\n\nR2", live);
    expect(r.plan.decisions.map(d => `${d.kind}:${d.mark}:${typeof d.anchor === "string" ? d.anchor : d.anchor ? "anchor" : "-"}`)).toEqual(["delete:applied:deferred", "rewrite:applied:-"]);
    const top = topOf(live);
    expect(top.map(x => x.text)).toEqual(["R2"]);
    expect(r.applied.perRegion[0]!.anchor).toEqual({ block_id: top[0]!.id, position: "before" });
  });
});

describe("E2 stripStart 的前一顆是接續鏈上前一區的最後一顆（複審 m）", () => {
  it("P＝numbered a；區 1 插段落 x、區 2 插「5. y」（同一個 P）→ y 的 start 5 不被丟掉、順序 [a, x, y, W]", async () => {
    const { b, live } = await scene([{ type: "numberedListItem", content: "a" }, P("U"), P("W")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    const r = await applyInMemory(rt, b, "1. a\n\nx\n\nU\n\n5. y\n\nW", live);
    expect(r.plan.decisions.map(d => [d.kind, d.mark, d.place, d.stripStart])).toEqual([
      ["insert", "applied", { ref: b.ids[0], where: "after" }, false],
      ["insert", "applied", { ref: b.ids[0], where: "after" }, false],
    ]);
    expect((r.plan.parsed[1]![0]!.props as Record<string, unknown>).start).toBe(5);
    expect(texts(live)).toEqual(["a", "x", "y", "W"]);
  });
  it("F5 區 1 有多顆（「1. m」＋段落 x）→ 前一顆是區 1 的**最後**一顆（段落）→ 區 2 的 start 5 保留", async () => {
    const { b, live } = await scene([{ type: "numberedListItem", content: "a" }, P("U"), P("W")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    const r = await applyInMemory(rt, b, "1. a\n\n1. m\n\nx\n\nU\n\n5. y\n\nW", live);
    expect(r.plan.decisions.map(d => [d.kind, d.mark, d.stripStart])).toEqual([
      ["insert", "applied", true],
      ["insert", "applied", false],
    ]);
    expect((r.plan.parsed[1]![0]!.props as Record<string, unknown>).start).toBe(5);
    expect(texts(live)).toEqual(["a", "m", "x", "y", "W"]);
  });
  it("對照：區 1 也是 numbered → 區 2 的 start 照拿掉（E18）", async () => {
    const { b, live } = await scene([{ type: "numberedListItem", content: "a" }, P("U"), P("W")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    const r = await applyInMemory(rt, b, "1. a\n2. x\n\nU\n\n5. y\n\nW", live);
    expect(r.plan.decisions.map(d => d.stripStart)).toEqual([true, true]);
  });
});

describe("R19 判 same 的區把接續鏈尾設成吸收到的外來 block 末顆（複審 F1／F2）", () => {
  it("S2 基底 [A,U,W]；人刪 U、在 A 後插 x；agent 寫 A/x/U/y/W → [A, x, y, W]", async () => {
    const { b, live } = await scene([P("A"), P("U"), P("W")], (ed, ids) => {
      ed.insertBlocks([P("x")], ids[0]!, "after");
      ed.removeBlocks([ids[1]!]);
    });
    const r = await applyInMemory(rt, b, "A\n\nx\n\nU\n\ny\n\nW", live);
    expect(marks(r)).toEqual(["insert:same", "insert:applied"]);
    const xId = topOf(live).find(t => t.text === "x")!.id;
    expect(r.plan.decisions[0]!.sameTail).toBe(xId);
    expect(r.applied.anchorIds).toContain(xId);
    expect(texts(live)).toEqual(["A", "x", "y", "W"]);
  });
  it("S3 外來 block 不相鄰（人在 A 後插 F、x、G）→ y 接在比中的 x 之後：[A, F, x, y, G, W]", async () => {
    const { b, live } = await scene([P("A"), P("U"), P("W")], (ed, ids) => {
      ed.insertBlocks([P("F"), P("x"), P("G")], ids[0]!, "after");
      ed.removeBlocks([ids[1]!]);
    });
    const r = await applyInMemory(rt, b, "A\n\nx\n\nU\n\ny\n\nW", live);
    expect(marks(r)).toEqual(["insert:same", "insert:applied"]);
    expect(texts(live)).toEqual(["A", "F", "x", "y", "G", "W"]);
  });
  it("S5 部分重送（x 已在、y／z 是新的）A/x/U/y/z/W → [A, x, y, z, W]", async () => {
    const { b, live } = await scene([P("A"), P("U"), P("W")], (ed, ids) => {
      ed.insertBlocks([P("x")], ids[0]!, "after");
      ed.removeBlocks([ids[1]!]);
    });
    const r = await applyInMemory(rt, b, "A\n\nx\n\nU\n\ny\n\nz\n\nW", live);
    expect(marks(r)).toEqual(["insert:same", "insert:applied"]);
    expect(texts(live)).toEqual(["A", "x", "y", "z", "W"]);
  });
  // ⚠ 總管指示寫的是「start 5 要保留」，但接上 sameTail 之後 y 真正的前一顆是 numbered 的 x，spec §9.4-2（E18）
  // 「插入點前一顆是 numbered 就拿掉 start」要求拿掉。這裡照 spec 釘：順序 [A, x, y]、stripStart true。要改需回 spec。
  it("S1 P＝段落 A；區 1「1. x」判 same（人已插 numbered x）；區 2「5. y」→ 順序 [A, x, y, W]；y 接在 numbered x 之後 → 依 E18 拿掉 start", async () => {
    const { b, live } = await scene([P("A"), P("U"), P("W")], (ed, ids) => {
      ed.insertBlocks([{ type: "numberedListItem", content: "x" }], ids[0]!, "after");
      ed.removeBlocks([ids[1]!]);
    });
    const r = await applyInMemory(rt, b, "A\n\n1. x\n\nU\n\n5. y\n\nW", live);
    expect(r.plan.decisions.map(d => [d.kind, d.mark, d.stripStart])).toEqual([
      ["insert", "same", false],
      ["insert", "applied", true],
    ]);
    expect(texts(live)).toEqual(["A", "x", "y", "W"]);
  });
});

describe("AP2b／AP2c 同一接點的多區保住文件順序", () => {
  it("AP2b 都插在文件開頭（人刪光基底、只剩外來 F）：agent 改 A、C → [A2, C2, F]", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => {
      ed.insertBlocks([{ type: "paragraph", content: "F" }], ids[2]!, "after");
      ed.removeBlocks([ids[0]!, ids[1]!, ids[2]!]);
    });
    const r = await applyInMemory(rt, b, "A2\n\nB\n\nC2", live);
    expect(marks(r)).toEqual(["rewrite:conflict", "rewrite:conflict"]);
    expect(texts(live)).toEqual(["A2", "C2", "F"]);
  });
  it("AP2c 兩區的 P 是同一顆（人刪了 A、U、C）：agent 改 A、C → [X, A2, C2]", async () => {
    const { b, live } = await scene([P("X"), P("A"), P("U"), P("C")], (ed, ids) => ed.removeBlocks([ids[1]!, ids[2]!, ids[3]!]));
    const r = await applyInMemory(rt, b, "X\n\nA2\n\nU\n\nC2", live);
    expect(r.plan.decisions.map(d => d.place)).toEqual([
      { ref: b.ids[0], where: "after" },
      { ref: b.ids[0], where: "after" },
    ]);
    expect(texts(live)).toEqual(["X", "A2", "C2"]);
  });
});

describe("AP8b／防守（審查 Important 2）", () => {
  it("AP8b 現況 0 顆、基底 3 段、agent 改 A 與 C（2 區）→ 結果恰 [A2, C2]、沒有多餘空段落", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = new Y.Doc();
    const r = await applyInMemory(rt, b, "A2\n\nB\n\nC2", live);
    expect(marks(r)).toEqual(["rewrite:conflict", "rewrite:conflict"]);
    expect(texts(live)).toEqual(["A2", "C2"]);
    const top = topOf(live).map(x => x.id);
    expect(r.applied.perRegion.flatMap(p => p.afterIds)).toEqual(top);
  });
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

describe("AP4／AP6／AP7", () => {
  it("AP4 外來 block 留原位", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => ed.insertBlocks([{ type: "paragraph", content: "F" }], ids[0]!, "after"));
    await applyInMemory(rt, b, "A\n\nB2\n\nC", live);
    expect(texts(live)).toEqual(["A", "F", "B2", "C"]);
  });
  it("AP6 survivorsExpect 的 fp 等於 cur 的", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D")], (ed, ids) => ed.updateBlock(ids[3]!, { content: "D!" }));
    const r = await applyInMemory(rt, b, "A\n\nB2\n\nC\n\nD2", live);
    const want = r.plan.decisions.flatMap(d => d.survivors).map(id => ({ id, fp: r.cur.fps[r.cur.ids.indexOf(id)]! }));
    expect(r.applied.survivorsExpect).toEqual(want);
    expect(want.map(w => w.id)).toEqual([b.ids[1], b.ids[3]]);
  });
  it("AP7 結果頂層永不為空（刪光 → 一顆空段落）", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C")], (ed, ids) => ed.removeBlocks([ids[1]!]));
    await applyInMemory(rt, b, "B", live);
    expect(topOf(live).length).toBeGreaterThan(0);
  });
});

describe("AP5／AP9 讓出", () => {
  it("AP5 3 區 → mount 之後一次＋區與區之間各一次", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D"), P("E")]);
    let yields = 0;
    const r = await applyInMemory(rt, b, "A2\n\nB\n\nC2\n\nD\n\nE2", live, { now: clock(25), applyYieldFn: async () => void yields++ });
    expect(r.plan.regions).toHaveLength(3);
    expect(yields).toBe(1 + 3);
  });
  it("AP5b 刪除區之間也各讓一次；空筆記的取代分支同樣讓出", async () => {
    const { b, live } = await scene([P("A"), P("B"), P("C"), P("D"), P("E")]);
    let yields = 0;
    const r = await applyInMemory(rt, b, "A\n\nC\n\nE", live, { now: clock(25), applyYieldFn: async () => void yields++ });
    expect(marks(r)).toEqual(["delete:applied", "delete:applied"]);
    expect(yields).toBe(1 + 2);
    const empty = new Y.Doc();
    const be = await makeBaseInMemory(rt, empty);
    let ey = 0;
    await applyInMemory(rt, be, "P1", forkOf(empty), { now: clock(25), applyYieldFn: async () => void ey++ });
    expect(ey).toBe(1 + 1);
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
});

describe("紀錄列（fileSyncRows；R1 的列數前提）", () => {
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

describe("AP8 空筆記（gate r1 I5）", () => {
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
