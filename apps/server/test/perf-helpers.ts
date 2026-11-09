/**
 * 效能測試共用的量法（審查 r7 m6）：不比絕對毫秒（機器忙、CI 慢就紅），比「規模加倍時變幾倍」與「相對於同一台機器當下的雜訊」。
 * - {@link expectLinear}：同一形量 N/8 與 N，`t(N) / t(N/8) < 24`（線性約 8–16，GC 與快取讓大的那份稍慢；平方約 64：差八倍，審查 r9 m3
 *   ——平方項只要佔 N 處時間的一半以上，比例就超過 24；比量 N/4 對 N 的「4 對 16」鑑別度更高，全套平行跑、機器忙時也不會誤紅）。先空跑一次
 *   N/8 暖機（JIT），再交錯量三輪（N/8、N、N/8、N、N/8、N），兩邊各取最小值（偶發的 GC 停頓、平行跑的其他測試不會每輪都落在同一邊，審查
 *   r8 m3）。`t(N)` 低於 `floorMs`（至少 250 ms）直接算過：這些形平方時都是秒級到幾十秒；另有寬鬆的絕對上限 `maxMs` 擋爆量。
 * - {@link yieldToLoop}：每量一次之前都讓出事件迴圈（setImmediate）。`await` 一個同步的回傳值只讓出 microtask，vitest worker 的 RPC
 *   （onTaskUpdate，60 秒逾時）是 macrotask：一串量測若全程沒讓出，在 2 vCPU 的 CI 上會同步佔住 worker 超過 60 秒，整套以
 *   `Timeout calling "onTaskUpdate"` 判紅（PR #400 的 CI）。每一段同步的工作要控制在約 5 秒內（慢機器上）。
 * - {@link loopStall}／{@link idleStall}／{@link stallLimit}：主執行緒停頓。門檻＝max(下限, 3 × 同一段時間閒置時量到的停頓)：閒置時的
 *   停頓就是這台機器當下的 GC 與排程雜訊；工作跑回主執行緒時停頓是整段轉換的時間（秒級），仍然遠超過。
 */
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect } from "vitest";

/** 讓出事件迴圈一次（setImmediate）：讓 vitest worker 的 RPC 與計時器有機會跑。量測之間、建大文件的各步之間都要呼叫。 */
export const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** 量一次（毫秒）。先讓出事件迴圈（見 {@link yieldToLoop}）。 */
export async function timeIt(f: () => unknown): Promise<number> {
  await yieldToLoop();
  const t = performance.now();
  await f();
  return performance.now() - t;
}

export interface LinearOpts {
  /** `t(2n)` 低於這個值就不看比例（預設、也是下限 250 ms）。 */
  floorMs?: number;
  /** `t(N)` 的絕對上限（預設 30 s，審查 r10 m4：2 倍超額配置的機器上線性的形也會慢到 4–5 倍）：平方回來時仍會超過或比例先紅。 */
  maxMs?: number;
}
/** 量 `run(N/8)` 與 `run(N)`（`run` 回它自己量到的毫秒；N 要能被 8 整除），斷言線性（見檔頭）。回兩個值給呼叫端記錄。 */
export async function expectLinear(name: string, run: (n: number) => Promise<number> | number, N: number, opts: LinearOpts = {}): Promise<[number, number]> {
  if (N % 8 !== 0) throw new Error(`expectLinear: N=${N} 要能被 8 整除`);
  const small = N / 8;
  const floorMs = Math.max(250, opts.floorMs ?? 250);
  const maxMs = opts.maxMs ?? 30_000;
  await yieldToLoop();
  await run(small); // 暖機
  let t1 = Infinity;
  let t2 = Infinity;
  for (let round = 0; round < 3; round++) {
    // 每一次量測之間讓出事件迴圈：整串量測不能同步佔住 vitest worker（見 {@link yieldToLoop}）
    await yieldToLoop();
    t1 = Math.min(t1, await run(small));
    await yieldToLoop();
    t2 = Math.min(t2, await run(N));
    if (t2 > maxMs) break; // 平方回來時不必再跑兩輪
  }
  console.log(`[perf] ${name}: N/8=${small} ${Math.round(t1)} ms, N=${N} ${Math.round(t2)} ms, ratio ${(t2 / Math.max(t1, 0.001)).toFixed(2)}`);
  expect(t2, `${name}: t(N) 的絕對上限`).toBeLessThan(maxMs);
  if (t2 >= floorMs) expect(t2 / t1, `${name}: t(N)/t(N/8)（線性約 8–16、平方約 64）`).toBeLessThan(24);
  return [t1, t2];
}

/** 主執行緒停頓：開始量 → `stop()` 回最大停頓（毫秒）。 */
export function loopStall(): { stop(): number } {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  let last = performance.now();
  let maxGap = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 10);
  return {
    stop(): number {
      clearInterval(iv);
      h.disable();
      return Math.round(Math.max(maxGap, h.max / 1e6));
    },
  };
}

/** 閒置 `ms` 毫秒期間的最大停頓（這台機器當下的雜訊）。 */
export async function idleStall(ms = 500): Promise<number> {
  const m = loopStall();
  await new Promise(r => setTimeout(r, ms));
  return m.stop();
}

/** 停頓門檻：max(下限, 3 × 閒置基準)。 */
export const stallLimit = (baseline: number, floorMs: number): number => Math.max(floorMs, 3 * baseline);
