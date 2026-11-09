import { stat } from "node:fs";
import { describe, expect, it } from "vitest";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { yieldToLoop } from "../../src/transfer/yield.js";
import { docWith, forkOf, makeBaseInMemory, planInMemory } from "./fixtures/transfer-sync.js";

/** bulk transfer spec §9.3-6、§9.4、§9.5 第 1–4 步；plan PR-2 T6（P1–P7）。 */

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
type Candidates = Array<{ id: string; title: string; slug: string; groupId: string | null; ownerHandle: string }>;
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
  // #398：解析（含邊界 parse）在 lease 之外做（生產上在 parse worker 裡），scratch session 只在寫進預解析 block 時開——讓出時 inFlight 0（解析中）或 1（寫進 scratch 時）。
  it("mounts 差 1（含邊界 parse）、結束後 inFlight 0、解析時不持 lease", async () => {
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
    expect(inFlightAtYield.some(n => n === 0)).toBe(true);
    expect(inFlightAtYield.every(n => n <= 1)).toBe(true);
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

describe("P4 same 判準（第三輪：「人先改過、檔案做同樣修改」與「倖存者全不見」的形已隨合併刪除，現況＝基底才會規劃）", () => {
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
    const candidates = new Proxy([] as Candidates, {
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

describe("#398：未閉合 fence 的判斷也經 runtime.parser（生產＝parse worker），不在主執行緒自己剖析", () => {
  it("改過的行像 fence → 呼叫 parser.openFenceLine 一次（帶寫入者）；它說太複雜 → 整篇 unsupported_block／too_complex", async () => {
    const calls: Array<[string, number]> = [];
    const inline = new EditingRuntime({ baseUrl: "http://localhost/" });
    const spyRt = new EditingRuntime({
      baseUrl: "http://localhost/",
      parser: {
        parse: req => inline.parser.parse(req),
        openFenceLine: async (owner, lines) => {
          calls.push([owner, lines.length]);
          return "too_complex";
        },
        fileBudget: () => inline.parser.fileBudget(),
        timeoutMs: () => inline.parser.timeoutMs(),
        close: async () => {},
      },
    });
    const doc = await docWith(rt, [P("A"), P("B")]);
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(spyRt, b, "A\n\n```\n\nB", forkOf(doc))).toMatchObject({ ok: false, code: "unsupported_block", detail: "too_complex" });
    expect(calls).toEqual([["test-user", 5]]);
  });
});

describe("#398 審查 C2：邊界檢查的解析回太複雜 → 整檔太複雜（不把它當「邊界不成立」繼續解析下一段）", () => {
  it("10 段黏在一行下面、每次解析都回 too_complex → planSync 回 unsupported_block／too_complex，解析只做了 1 次", async () => {
    let calls = 0;
    const inline = new EditingRuntime({ baseUrl: "http://localhost/" });
    const spyRt = new EditingRuntime({
      baseUrl: "http://localhost/",
      parser: {
        parse: async () => {
          calls++;
          return { error: "unsupported_block", detail: "too_complex" };
        },
        openFenceLine: async () => null,
        fileBudget: () => inline.parser.fileBudget(),
        timeoutMs: () => inline.parser.timeoutMs(),
        close: async () => {},
      },
    });
    const paras = Array.from({ length: 10 }, (_, k) => `Para ${k}`);
    const doc = await docWith(rt, paras.map(P));
    const b = await makeBaseInMemory(rt, doc);
    expect(await planInMemory(spyRt, b, "X\n" + paras.join("\n"), forkOf(doc))).toMatchObject({ ok: false, code: "unsupported_block", detail: "too_complex" });
    expect(calls).toBe(1);
  });
});
