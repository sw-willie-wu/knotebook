/**
 * #398：`ParsePool` 的排程邏輯（假 worker，不開執行緒；計時器用 vitest 的假時鐘）。真的 worker（BlockNote 在 worker 裡解析、逾時、
 * 記憶體用完、主執行緒不被卡住）在 `parse-pool-worker.test.ts`。
 */
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParserBusyError, TOO_COMPLEX, type ParseRequest } from "../../src/notes/editing/parse-core.js";
import { PARSE_QUEUE_MAX, PER_OWNER_MAX, ParsePool, RECYCLE_AFTER_PARSES, RECYCLE_HEAP_SHARE, type PoolWorker, type WorkerInbound, type WorkerOutbound } from "../../src/notes/editing/parse-pool.js";

class FakeWorker extends EventEmitter implements PoolWorker {
  inbox: WorkerInbound[] = [];
  terminated = false;
  refd = false;
  constructor(readonly memoryMb: number) {
    super();
  }
  postMessage(m: WorkerInbound): void {
    this.inbox.push(m);
  }
  async terminate(): Promise<number> {
    this.terminated = true;
    return 1;
  }
  ref(): void {
    this.refd = true;
  }
  unref(): void {
    this.refd = false;
  }
  send(m: WorkerOutbound): void {
    this.emit("message", m);
  }
  ready(): void {
    this.send({ type: "ready" });
  }
  /** 回覆收到的第 i 則（預設最後一則）。 */
  reply(text: string): void {
    const m = this.inbox[this.inbox.length - 1]!;
    this.send({ type: "result", id: m.id, result: { blocks: [{ type: "paragraph", content: text }], unbound: 0 } as never });
  }
}

let spawned: FakeWorker[] = [];
const spawn = vi.fn(({ workerMemoryMb }: { workerMemoryMb: number }) => {
  const w = new FakeWorker(workerMemoryMb);
  spawned.push(w);
  return w;
});
const req = (owner: string, markdown = "x"): ParseRequest => ({ owner, markdown, candidates: [], siteOrigin: "http://localhost" });
const pools: ParsePool[] = [];
const mk = (o: Partial<{ workers: number; timeoutMs: number; queueWaitMs: number; workerMemoryMb: number }> = {}) => {
  const p = new ParsePool({ baseUrl: "http://localhost/", workers: 2, workerMemoryMb: 512, timeoutMs: 5_000, queueWaitMs: 10_000, spawn, ...o });
  pools.push(p);
  return p;
};
const mdOf = (m: WorkerInbound) => (m.kind === "parse" ? m.markdown : null);
/** 讓 promise 的續體跑完。 */
const flush = () => new Promise<void>(r => setImmediate(r));

beforeEach(() => {
  spawned = [];
  spawn.mockClear();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});
afterEach(async () => {
  for (const p of pools.splice(0)) await p.close();
  vi.useRealTimers();
});

describe("ParsePool（假 worker）", () => {
  it("啟動就開 workers 個；ready 之前排著，ready 後送進去；送出的訊息不帶 owner", async () => {
    const pool = mk({ workers: 2 });
    expect(spawned).toHaveLength(2);
    const r = pool.parse(req("u1", "hello"));
    expect(spawned[0]!.inbox).toHaveLength(0);
    spawned[0]!.ready();
    expect(spawned[0]!.inbox).toHaveLength(1);
    expect(spawned[0]!.inbox[0]).toEqual({ id: expect.any(Number), kind: "parse", markdown: "hello", candidates: [], siteOrigin: "http://localhost" });
    expect(spawned[0]!.refd).toBe(true); // 解析中 ref
    spawned[0]!.reply("hello");
    await expect(r).resolves.toEqual({ blocks: [{ type: "paragraph", content: "hello" }], unbound: 0 });
    expect(spawned[0]!.refd).toBe(false); // 閒置 unref
  });

  it("每個使用者同時至多佔 PER_OWNER_MAX（2）個 worker：第 3 筆排著；空出來的 worker 先給手上沒有工作的人（即使他排在後面）", async () => {
    expect(PER_OWNER_MAX).toBe(2);
    const pool = mk({ workers: 2 });
    for (const w of spawned) w.ready();
    const a1 = pool.parse(req("A", "a1"));
    const a2 = pool.parse(req("A", "a2")); // 那時沒有別人在排：A 的第 2 個
    const a3 = pool.parse(req("A", "a3"));
    const b1 = pool.parse(req("B", "b1"));
    expect(spawned.map(w => w.inbox.map(mdOf))).toEqual([["a1"], ["a2"]]);
    expect(pool.stats()).toMatchObject({ busy: 2, queued: 2 });
    spawned[1]!.reply("a2");
    await a2;
    // worker 1 空了：a3 排在 b1 前面，但 B 手上沒有工作 → b1 先
    expect(spawned[1]!.inbox.map(mdOf)).toEqual(["a2", "b1"]);
    spawned[1]!.reply("b1");
    await b1;
    expect(spawned[1]!.inbox.map(mdOf)).toEqual(["a2", "b1", "a3"]);
    spawned[0]!.reply("a1");
    spawned[1]!.reply("a3");
    await expect(Promise.all([a1, a3])).resolves.toHaveLength(2);
  });

  it("同一人已佔 1 個時，別人的工作優先於他排在前面的第 2 筆（先挑手上沒有工作的人）", async () => {
    const pool = mk({ workers: 3 });
    for (const w of spawned) w.ready();
    for (const [o, m] of [["A", "a1"], ["A", "a2"], ["A", "a3"], ["B", "b1"]] as const) pool.parse(req(o, m)).catch(() => {}); // afterEach 關 pool 時 reject
    // worker 0 ← a1；worker 1 ← a2（那時沒有別人在排）；worker 2 ← b1（A 已佔 2 個，a3 排著）
    expect(spawned.map(w => w.inbox.map(mdOf))).toEqual([["a1"], ["a2"], ["b1"]]);
    expect(pool.stats()).toMatchObject({ busy: 3, queued: 1 });
  });

  it("逾時：terminate 那個 worker、回 too_complex、補開一個；計時從交給 worker 起算（不含排隊）", async () => {
    const pool = mk({ workers: 1, timeoutMs: 1_000 });
    const r = pool.parse(req("u"));
    vi.advanceTimersByTime(5_000); // 還沒 ready：排隊中，不算解析時限
    spawned[0]!.ready();
    vi.advanceTimersByTime(999);
    expect(spawned[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(1);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
    expect(pool.stats()).toMatchObject({ timedOut: 1, workers: 1 });
    // 補開的那個能用
    const r2 = pool.parse(req("u"));
    spawned[1]!.ready();
    spawned[1]!.reply("ok");
    await expect(r2).resolves.toMatchObject({ unbound: 0 });
  });

  it("逾時之後那個 worker 才回的結果被丟掉（不會回給下一筆）", async () => {
    const pool = mk({ workers: 1, timeoutMs: 1_000 });
    spawned[0]!.ready();
    const r = pool.parse(req("u", "slow"));
    vi.advanceTimersByTime(1_000);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
    spawned[0]!.reply("late"); // 被 terminate 的 worker 遲到的訊息
    const r2 = pool.parse(req("u", "next"));
    spawned[1]!.ready();
    spawned[1]!.reply("next");
    await expect(r2).resolves.toEqual({ blocks: [{ type: "paragraph", content: "next" }], unbound: 0 });
  });

  it("解析中 worker 掛掉（記憶體用完：error＋exit）→ too_complex、補開；排隊中的照常做", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    const r = pool.parse(req("A"));
    const q = pool.parse(req("B"));
    spawned[0]!.emit("error", Object.assign(new Error("Worker terminated due to reaching memory limit: JS heap out of memory"), { code: "ERR_WORKER_OUT_OF_MEMORY" }));
    spawned[0]!.emit("exit", 1);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
    expect(pool.stats().crashed).toBe(1);
    expect(spawned).toHaveLength(2);
    spawned[1]!.ready();
    spawned[1]!.reply("b");
    await expect(q).resolves.toMatchObject({ unbound: 0 });
  });

  it("排隊超過 queueWaitMs → ParserBusyError（503）；從佇列移除，之後不會被送進 worker", async () => {
    const pool = mk({ workers: 1, queueWaitMs: 2_000 });
    spawned[0]!.ready();
    const busy = pool.parse(req("A"));
    const waiting = pool.parse(req("B"));
    vi.advanceTimersByTime(2_000);
    await expect(waiting).rejects.toBeInstanceOf(ParserBusyError);
    expect(pool.stats().queued).toBe(0);
    spawned[0]!.reply("a");
    await busy;
    expect(spawned[0]!.inbox).toHaveLength(1);
  });

  it("worker 回 failed（程式錯）→ reject（500），worker 留著繼續用", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    const r = pool.parse(req("u"));
    spawned[0]!.send({ type: "failed", id: spawned[0]!.inbox[0]!.id, name: "TypeError", frames: [] });
    await expect(r).rejects.toThrow("parse worker: TypeError");
    expect(spawned[0]!.terminated).toBe(false);
    expect(pool.stats().workers).toBe(1);
  });

  it(`解析滿 ${RECYCLE_AFTER_PARSES} 筆 → 換新 worker（第 ${RECYCLE_AFTER_PARSES} 筆的結果照回）`, async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    for (let i = 1; i <= RECYCLE_AFTER_PARSES; i++) {
      const r = pool.parse(req("u"));
      spawned[0]!.reply("x");
      await expect(r).resolves.toMatchObject({ unbound: 0 });
      expect(spawned[0]!.terminated).toBe(i === RECYCLE_AFTER_PARSES);
    }
    expect(spawned).toHaveLength(2);
    expect(pool.stats().recycled).toBe(1);
  });

  it("還沒 ready 就掛掉 → 延遲後補開（不原地狂開）", async () => {
    mk({ workers: 1 });
    spawned[0]!.emit("exit", 1);
    expect(spawned).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    expect(spawned).toHaveLength(2);
  });

  it("configure：worker 數調大立即開、調小收閒置的；時限立即生效；記憶體變了就全部換新", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    pool.configure({ workers: 3, workerMemoryMb: 256, timeoutMs: 100 });
    // 記憶體變了：閒置的舊 worker（512）立即收掉，fill() 再用新上限開滿 3 個
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(4);
    expect(spawned.map(w => w.memoryMb)).toEqual([512, 256, 256, 256]);
    expect(pool.limits).toMatchObject({ workers: 3, workerMemoryMb: 256, timeoutMs: 100 });
    for (const w of spawned.slice(1)) w.ready();
    pool.configure({ workers: 1 });
    // 只改 worker 數：留下第一個（spawned[1]），另外兩個閒置的收掉
    expect(spawned.map(w => w.terminated)).toEqual([true, false, true, true]);
    expect(pool.stats().workers).toBe(1);
    const r = pool.parse(req("u"));
    expect(spawned[1]!.inbox).toHaveLength(1);
    vi.advanceTimersByTime(100);
    await expect(r).resolves.toEqual(TOO_COMPLEX);
  });

  it("configure 改記憶體上限 → 閒置的 worker 全部換新，新開的用新上限", () => {
    const pool = mk({ workers: 2, workerMemoryMb: 1024 });
    for (const w of spawned) w.ready();
    pool.configure({ workerMemoryMb: 512 });
    expect(spawned.slice(0, 2).map(w => w.terminated)).toEqual([true, true]);
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(spawned.slice(2).map(w => w.memoryMb)).toEqual([512, 512]);
    expect(pool.stats().workers).toBe(2);
  });

  it("configure 改記憶體上限 → 忙的 worker 做完手上那件才收；閒的立即收；新開的用新上限", async () => {
    const pool = mk({ workers: 2, workerMemoryMb: 1024 });
    for (const w of spawned) w.ready();
    const r = pool.parse(req("u", "busy"));
    r.catch(() => {}); // 前面的斷言先紅時，afterEach 的 close() 會 reject 它
    expect(spawned[0]!.inbox.map(mdOf)).toEqual(["busy"]);
    pool.configure({ workerMemoryMb: 512 });
    expect(spawned[0]!.terminated).toBe(false);
    expect(spawned[1]!.terminated).toBe(true);
    expect(spawned.slice(2).map(w => w.memoryMb)).toEqual([512, 512]);
    spawned[0]!.reply("busy");
    await expect(r).resolves.toMatchObject({ blocks: [{ type: "paragraph", content: "busy" }] });
    expect(spawned[0]!.terminated).toBe(true);
    // 新的兩個已經補滿：舊的收掉時不再多開
    expect(spawn).toHaveBeenCalledTimes(4);
    expect(pool.stats()).toMatchObject({ workers: 2, recycled: 0 });
  });

  it("configure 給同樣的記憶體上限 → 不換 worker", () => {
    const pool = mk({ workerMemoryMb: 1024 });
    for (const w of spawned) w.ready();
    pool.configure({ workerMemoryMb: 1024 });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawned.some(w => w.terminated)).toBe(false);
  });

  it("spawn 失敗退避中改記憶體上限 → 活著的舊 worker 立即收掉；退避結束後補開的都用新上限", () => {
    const pool = mk({ workers: 2, workerMemoryMb: 1024 });
    spawned[0]!.ready();
    spawned[1]!.emit("exit", 1); // 還沒 ready 就掛掉：退避計時開始
    pool.configure({ workerMemoryMb: 512 });
    expect(spawned).toHaveLength(2); // 退避中 fill() 不開
    vi.advanceTimersByTime(1_000);
    // spawnSlot 讀的是目前的設定，所以退避後補開的一定是新上限
    expect(spawned.length).toBeGreaterThan(2);
    for (const w of spawned.slice(2)) expect(w.memoryMb).toBe(512);
    // 活著的舊 worker（1024）在 configure 時就被收掉，不會留到 500 件或 heap 過高才換
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(4);
    expect(pool.stats().workers).toBe(2);
  });

  it("configure 換時限與排隊等待：timeoutMs() 立即是新值；之後排進來的工作照新的排隊等待逾時", async () => {
    const pool = mk({ workers: 1, timeoutMs: 10_000, queueWaitMs: 45_000 });
    pool.configure({ timeoutMs: 5_000, queueWaitMs: 25_000 });
    expect(pool.timeoutMs()).toBe(5_000);
    let rejected: unknown = null;
    const waiting = pool.parse(req("u")).catch((e: unknown) => {
      rejected = e;
    });
    vi.advanceTimersByTime(24_999);
    await flush();
    expect(rejected).toBeNull();
    vi.advanceTimersByTime(1);
    await waiting;
    expect(rejected).toBeInstanceOf(ParserBusyError);
  });

  it("未閉合 fence 判斷（openFenceLine）走同一條：送 kind fence、回 fence 的結果；與同一人的解析共用每人的上限；逾時 → \"too_complex\"", async () => {
    const pool = mk({ workers: 2, timeoutMs: 1_000 });
    for (const w of spawned) w.ready();
    const p = pool.parse(req("A", "a1"));
    const f = pool.openFenceLine("A", ["x", "```"]);
    expect(spawned[1]!.inbox).toHaveLength(1); // 同一人的第 2 個（沒有別人在排）
    spawned[0]!.reply("a1");
    await p;
    const w = spawned.find(x => x.inbox.some(m => m.kind === "fence"))!;
    const m = w.inbox.find(x => x.kind === "fence")!;
    expect(m).toEqual({ id: expect.any(Number), kind: "fence", lines: ["x", "```"] });
    w.send({ type: "fence", id: m.id, line: 1 });
    await expect(f).resolves.toBe(1);
    const slow = pool.openFenceLine("B", ["y"]);
    vi.advanceTimersByTime(1_000);
    await expect(slow).resolves.toBe("too_complex");
  });

  it("#398 檔案總預算：時限取單次時限與剩下預算的小者；做完扣掉實際時間；用完之後的解析不送進 worker、直接 too_complex", async () => {
    const pool = mk({ workers: 1, timeoutMs: 5_000 });
    spawned[0]!.ready();
    const budget = { remainingMs: 1_200 };
    const a = pool.parse({ ...req("u", "a"), budget });
    vi.advanceTimersByTime(500);
    spawned[0]!.reply("a");
    await a;
    expect(budget.remainingMs).toBeCloseTo(700, -1);
    const b = pool.parse({ ...req("u", "b"), budget }); // 只剩約 700 ms：700 ms 就逾時（不是 5 秒）
    vi.advanceTimersByTime(699);
    expect(spawned[0]!.terminated).toBe(false);
    vi.advanceTimersByTime(2);
    await expect(b).resolves.toEqual(TOO_COMPLEX);
    expect(budget.remainingMs).toBeLessThanOrEqual(0);
    spawned[1]!.ready();
    const c = pool.parse({ ...req("u", "c"), budget });
    await expect(c).resolves.toEqual(TOO_COMPLEX);
    expect(spawned[1]!.inbox).toHaveLength(0);
    expect(await pool.openFenceLine("u", ["x"], budget)).toBe("too_complex");
    expect(pool.fileBudget()).toEqual({ remainingMs: 15_000 });
  });

  it("#398 排隊上限：佇列滿 PARSE_QUEUE_MAX 筆，再來的直接 ParserBusyError（不等逾時）", async () => {
    const pool = mk({ workers: 1 });
    const queued = Array.from({ length: PARSE_QUEUE_MAX }, (_, i) => pool.parse(req(`u${i}`)));
    await expect(pool.parse(req("late"))).rejects.toBeInstanceOf(ParserBusyError);
    expect(pool.stats().queued).toBe(PARSE_QUEUE_MAX);
    await pool.close();
    await Promise.allSettled(queued);
  });

  it("close：終止全部 worker、排隊與解析中的 reject、之後的 parse reject、不再補開", async () => {
    const pool = mk({ workers: 2 });
    spawned[0]!.ready();
    const running = pool.parse(req("A"));
    const queued = pool.parse(req("A"));
    await pool.close();
    await expect(running).rejects.toThrow("closed");
    await expect(queued).rejects.toThrow("closed");
    expect(spawned.every(w => w.terminated)).toBe(true);
    await expect(pool.parse(req("B"))).rejects.toThrow("closed");
    spawned[0]!.emit("exit", 1);
    vi.advanceTimersByTime(60_000);
    await flush();
    expect(spawned).toHaveLength(2);
  });

  it(`做完一件 heap 用量超過上限的 RECYCLE_HEAP_SHARE（${RECYCLE_HEAP_SHARE}）→ 換新 worker（結果照回）；沒超過不換`, async () => {
    const pool = mk({ workers: 1, workerMemoryMb: 1000 });
    spawned[0]!.ready();
    const a = pool.parse(req("u", "a"));
    let m = spawned[0]!.inbox.at(-1)!;
    spawned[0]!.send({ type: "result", id: m.id, result: { blocks: [], unbound: 0 } as never, heapMb: 500 }); // 剛好一半：不換
    await a;
    expect(pool.stats().recycled).toBe(0);
    const b = pool.parse(req("u", "b"));
    m = spawned[0]!.inbox.at(-1)!;
    spawned[0]!.send({ type: "result", id: m.id, result: { blocks: [], unbound: 0 } as never, heapMb: 501 });
    await expect(b).resolves.toMatchObject({ unbound: 0 });
    expect(pool.stats().recycled).toBe(1);
    expect(spawned[0]!.terminated).toBe(true);
    expect(spawned).toHaveLength(2);
  });

  it("轉換工作（doc）：送 kind doc（state ≥ 64 KiB 且自己佔整個 buffer → transfer）；worker 的 ask 由主執行緒回答給同一個 worker；ask 丟例外 → answer ok:false；結果照回；逾時 → \"too_complex\"", async () => {
    const pool = mk({ workers: 1 });
    spawned[0]!.ready();
    const asked: unknown[] = [];
    const state = new Uint8Array(64 * 1024);
    const r = pool.runDoc("u", { kind: "outline", state }, async q => {
      asked.push(q);
      return [["x", "標題"]];
    }, 5_000);
    const w = spawned[0]!;
    const m = w.inbox.at(-1)!;
    expect(m).toMatchObject({ kind: "doc", op: { kind: "outline" } });
    w.send({ type: "ask", id: m.id, q: { kind: "titles", ids: ["x"] } });
    await flush();
    expect(asked).toEqual([{ kind: "titles", ids: ["x"] }]);
    expect(w.inbox.at(-1)).toEqual({ id: m.id, kind: "answer", ok: true, value: [["x", "標題"]] });
    w.send({ type: "doc", id: m.id, result: { whole: "w" }, heapMb: 1 });
    await expect(r).resolves.toEqual({ whole: "w" });
    const r2 = pool.runDoc("u", { kind: "outline", state: new Uint8Array(1) }, async () => {
      throw new Error("db down");
    }, 5_000);
    const m2 = w.inbox.at(-1)!;
    w.send({ type: "ask", id: m2.id, q: { kind: "titles", ids: ["y"] } });
    await flush();
    expect(w.inbox.at(-1)).toEqual({ id: m2.id, kind: "answer", ok: false });
    w.send({ type: "failed", id: m2.id, name: "Error", frames: [] });
    await expect(r2).rejects.toThrow(/parse worker/);
    const r3 = pool.runDoc("u", { kind: "outline", state: new Uint8Array(1) }, async () => null, 1_000);
    vi.advanceTimersByTime(1_000);
    await expect(r3).resolves.toBe("too_complex");
  });
});
