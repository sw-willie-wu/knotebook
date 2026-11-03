import { stat } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { yieldToLoop } from "../../src/transfer/yield.js";
import { SHAPE_LINK_TARGET, SHAPE_TITLES } from "./fixtures/transfer-shapes.js";
import { docWith, forkOf, makeBaseInMemory, planInMemory, withEditor } from "./fixtures/transfer-sync.js";

/** bulk transfer spec §9.3-6、§9.4、§9.5 第 1–4 步；plan PR-2 T6（P1–P7）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const CANDIDATES = [{ id: SHAPE_LINK_TARGET, title: "Other note", slug: "other-note", groupId: null, ownerHandle: "owner" }];
const P = (t: string) => ({ type: "paragraph", content: t });
const NL = (t: string) => ({ type: "numberedListItem", content: t });
const clock = (step: number) => {
  let t = 0;
  return () => (t += step);
};
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(`not ok: ${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
};
const marks = (r: { plan: { decisions: Array<{ kind: string; mark: string }> } }) => r.plan.decisions.map(d => `${d.kind}:${d.mark}`);

describe("P1 一次 scratch session、持 lease 期間零 DB", () => {
  it("mounts 差 1（含邊界 parse）、結束後 inFlight 0、讓出時 inFlight 1", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    const m0 = rt.mounts;
    const inFlightAtYield: number[] = [];
    // `C` 之前貼一行 `X`（不空行）→ C 的邊界要在同一個 scratch session 裡 parse 一次
    const r = ok(
      await planInMemory(rt, b, "A\n\nB2\n\nX\nC", live, {
        now: clock(25),
        yieldFn: async () => {
          inFlightAtYield.push(rt.inFlight);
        },
      }),
    );
    expect(rt.mounts - m0).toBe(1);
    expect(rt.inFlight).toBe(0);
    expect(inFlightAtYield.length).toBeGreaterThan(0);
    expect(inFlightAtYield.every(n => n === 1)).toBe(true);
    expect(r.plan.boundaryChecks).toBe(1);
    expect(marks(r)).toEqual(["rewrite:applied"]);
  });
});

describe("P2／P3 parse 失敗 → 整篇不寫", () => {
  it("P2 改寫區 parse 失敗（unsupported_color）→ { ok: false }", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(rt, b, 'A\n\nx <span style="color:#ff6600">orange-ish</span>', forkOf(doc))).toMatchObject({ ok: false, code: "unsupported_color" });
  });
  it("P3 未閉合 `<!--` 貼在沒改的段上方 → empty_content；改寫一段並在前一行加未閉合 `<!--` → empty_content", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(rt, b, "A\n\n<!--\nB", forkOf(doc))).toMatchObject({ ok: false, code: "empty_content" });
    expect(await planInMemory(rt, b, "A\n\n<!--\nB2", forkOf(doc))).toMatchObject({ ok: false, code: "empty_content" });
  });
});

describe("P3b 檔案層級未閉合的 code fence → 整篇不寫（審查 m3）", () => {
  it("0 行分隔清單上方加一行未閉合 ``` → { ok: false, code: unclosed_fence }、只 mount 一次、lease 已還", async () => {
    const doc = await docWith(rt, [P("Z"), { type: "bulletListItem", content: "a" }, { type: "bulletListItem", content: "b" }]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(rt, b, "Z\n\n```\n* a\n* b", forkOf(doc))).toMatchObject({ ok: false, code: "unclosed_fence" });
    expect(rt.inFlight).toBe(0);
  });
});

describe("P4 same 判準（§25.2 的 4 案＋倖存者全不見）", () => {
  /** 基底 → fork 上「人」做了修改 → agent 的檔做同樣修改（＝把人改完那顆的匯出寫進 agent 的檔）。 */
  async function scene(blocks: unknown[], idx: number, edit: (ed: Parameters<Parameters<typeof withEditor>[2]>[0], id: string) => void, opts: { browser?: boolean } = {}) {
    const doc = await docWith(rt, blocks);
    if (opts.browser) {
      doc.transact(() => {
        for (const c of topLevelContainers(doc.getXmlFragment(YDOC_FRAGMENT))) {
          const content = c.get(0);
          if (content instanceof Y.XmlElement && content.nodeName === "numberedListItem") content.removeAttribute("start");
        }
      });
    }
    const b = await makeBaseInMemory(rt, doc, SHAPE_TITLES);
    const live = forkOf(doc);
    const id = b.ids[idx]!;
    await withEditor(rt, live, ed => edit(ed, id));
    const after = await makeBaseInMemory(rt, forkOf(live), SHAPE_TITLES);
    return { b, live, agentBody: normalizeBody(after.body) };
  }
  const WL = (tail: string) => [{ type: "wikilink", props: { targetNoteId: SHAPE_LINK_TARGET, snapshotTitle: "Other" } }, { type: "text", text: tail, styles: {} }];
  it.each([
    ["numbered 中間項（server 建）", () => scene([NL("a"), NL("b"), NL("c")], 1, (ed, id) => ed.updateBlock(id, { content: "b2" }))],
    ["numbered 中間項（瀏覽器形）", () => scene([NL("a"), NL("b"), NL("c")], 1, (ed, id) => ed.updateBlock(id, { content: "b2" }), { browser: true })],
    ["帶 wikilink 的 bullet", () => scene([P("x"), { type: "bulletListItem", content: WL(" tail") }], 1, (ed, id) => ed.updateBlock(id, { content: WL(" tail2") } as never))],
    ["image 改說明", () => scene([P("x"), { type: "image", props: { url: "/api/uploads/u1", caption: "cap" } }], 1, (ed, id) => ed.updateBlock(id, { props: { caption: "cap2" } } as never))],
  ])("%s → same（id 不換、不存版）", async (_n, make) => {
    const { b, live, agentBody } = await make();
    const r = ok(await planInMemory(rt, b, agentBody, live, { candidates: CANDIDATES }));
    expect(marks(r)).toEqual(["rewrite:same"]);
  });
  it("倖存者全不見＋錨點間外來 block 相同 → same（合併已落盤、紀錄失敗後同檔重送的形）", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    await withEditor(rt, live, ed => ed.replaceBlocks([b.ids[1]!], [{ type: "paragraph", content: "B2" }]));
    const r = ok(await planInMemory(rt, b, "A\n\nB2\n\nC", live));
    expect(r.plan.decisions[0]).toMatchObject({ kind: "rewrite", mark: "same", preferForeignSame: true });
  });
  it("對照：倖存者全不見、外來 block 不同 → conflict", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const live = forkOf(doc);
    await withEditor(rt, live, ed => ed.replaceBlocks([b.ids[1]!], [{ type: "paragraph", content: "human" }]));
    expect(marks(ok(await planInMemory(rt, b, "A\n\nB2\n\nC", live)))).toEqual(["rewrite:conflict"]);
  });
  it("沒有人改、agent 只換寫法（`*` → `-`）→ same（非衝突的區也先判 same，id 不換）", async () => {
    const doc = await docWith(rt, [P("A"), { type: "bulletListItem", content: "item" }, P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(normalizeBody(b.body)).toBe("A\n\n* item\n\nC");
    expect(marks(ok(await planInMemory(rt, b, "A\n\n- item\n\nC", forkOf(doc))))).toEqual(["rewrite:same"]);
  });
  it("對照：同內容的區沒有人改 → applied（不是 same 就會換 id）", async () => {
    const doc = await docWith(rt, [P("A"), P("B"), P("C")]);
    const b = await makeBaseInMemory(rt, doc);
    const r = ok(await planInMemory(rt, b, "A\n\nB2\n\nC", forkOf(doc)));
    expect(marks(r)).toEqual(["rewrite:applied"]);
  });
});

describe("P5 預解析 numbered 在清單中間的改寫 → start 被拿掉（E18）", () => {
  it("改第 2 項 → stripStart、預解析沒有 start；清單第一項 → 保留", async () => {
    const doc = await docWith(rt, [NL("a"), NL("b"), NL("c")]);
    const b = await makeBaseInMemory(rt, doc);
    const mid = ok(await planInMemory(rt, b, "1. a\n2. b2\n3. c", forkOf(doc)));
    expect(mid.plan.decisions[0]).toMatchObject({ mark: "applied", stripStart: true });
    expect((mid.plan.parsed[0]![0]!.props as Record<string, unknown>).start).toBeUndefined();
    const doc5 = await docWith(rt, [{ type: "numberedListItem", content: "a", props: { start: 5 } }, NL("b")]);
    const b5 = await makeBaseInMemory(rt, doc5);
    const first = ok(await planInMemory(rt, b5, "5. a2\n6. b", forkOf(doc5)));
    expect(first.plan.decisions[0]).toMatchObject({ mark: "applied", stripStart: false });
    expect((first.plan.parsed[0]![0]!.props as Record<string, unknown>).start).toBe(5);
  });
});

describe("P6／P7 讓出", () => {
  it("P6 5 區 → yields ≥ 5（時間預算：每次讀時鐘前進 25 ms）", async () => {
    const doc = await docWith(rt, Array.from({ length: 10 }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const body = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    let yields = 0;
    const r = ok(await planInMemory(rt, b, body, forkOf(doc), { now: clock(25), yieldFn: async () => void yields++ }));
    expect(r.plan.regions).toHaveLength(5);
    expect(yields).toBeGreaterThanOrEqual(5);
  });
  it("P6c 確定性：每次讀時鐘前進 25 ms → open 之後 1 次＋每區 parse 之後 1 次＋每區寫進 scratch 之後 1 次（複審：取代牆鐘門檻）", async () => {
    const doc = await docWith(rt, Array.from({ length: 10 }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const body = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    let yields = 0;
    const r = ok(await planInMemory(rt, b, body, forkOf(doc), { now: clock(25), yieldFn: async () => void yields++ }));
    expect(r.plan.regions).toHaveLength(5);
    expect(r.plan.boundaryChecks).toBe(0);
    expect(yields).toBe(1 + 5 + 5);
  });
  it("P6 對照：時鐘不前進 → 只有 open 之後那一次無條件讓出", async () => {
    const doc = await docWith(rt, Array.from({ length: 10 }, (_, i) => P(`p${i}`)));
    const b = await makeBaseInMemory(rt, doc);
    const body = Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? `p${i} changed` : `p${i}`)).join("\n\n");
    let yields = 0;
    ok(await planInMemory(rt, b, body, forkOf(doc), { now: clock(0), yieldFn: async () => void yields++ }));
    expect(yields).toBe(1);
  });
  it("P7 從 I/O 回呼進入（預設 yieldFn）：第一區 parse（第一次讀 candidates）之前 timer 已跑", async () => {
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    let fired = false;
    let firedAtFirstRead: boolean | undefined;
    const candidates = new Proxy([] as typeof CANDIDATES, {
      get(t, k, r) {
        firedAtFirstRead ??= fired;
        return Reflect.get(t, k, r);
      },
    });
    await new Promise<void>(r => stat(".", () => r()));
    setTimeout(() => {
      fired = true;
    }, 0);
    const t = performance.now();
    while (performance.now() - t < 5) {
      /* busy */
    }
    ok(await planInMemory(rt, b, "A\n\nB2", forkOf(doc), { candidates }));
    expect(firedAtFirstRead).toBe(true);
    void yieldToLoop;
  });
});
