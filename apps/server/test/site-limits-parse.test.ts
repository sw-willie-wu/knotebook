/**
 * #397：解析 worker pool 跟著站台限制改。`buildCollabTestApp({ editing: 自己建的 runtime, editingFollowsSiteLimits: true })` 的 app
 * 訂閱 `siteLimits.onChange`，四項解析設定（含連帶變的自動值）有變就 `configure` 那份 runtime 的 pool；注入的 runtime 不帶旗標時不訂閱；
 * 共用的 `testEditingRuntime` 一律不准訂閱（harness 直接丟錯）。actor 一律是本測試在同一個 DB 建的 admin。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { siteLimits as siteLimitsTable } from "../src/db/schema.js";
import { ParsePool } from "../src/notes/editing/parse-pool.js";
import type { ParseLimits } from "../src/notes/editing/parse-settings.js";
import { createEditingRuntime, type EditingRuntime } from "../src/notes/editing/runtime.js";
import { buildCollabTestApp, buildTestApp, testConfig, testEditingRuntime } from "./helpers.js";

/** 與站台預設相同的記憶體、時限、排隊等待（只有 worker 數不同）：訂閱後的 `configure` 不會因為記憶體不同而把 worker 全部換新。 */
const START: ParseLimits = { workers: 1, workerMemoryMb: 1024, timeoutMs: 10_000, queueWaitMs: 45_000 };

// 整個檔共用一份自己建的 runtime（開一個真的 parse worker 要好幾秒）；每案開頭把 pool 調回 START。
let rt: EditingRuntime;
const pool = (): ParsePool => rt.parser as ParsePool;
beforeAll(() => {
  rt = createEditingRuntime(testConfig, START);
});
afterAll(async () => {
  await rt.close();
});
beforeEach(() => {
  pool().configure(START);
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function appWithAdmin(opts: { editingFollowsSiteLimits?: boolean }) {
  const ctx = await buildCollabTestApp({ editing: rt, ...opts });
  const admin = await ctx.createUser({ email: "admin@example.com", password: "correct-horse-battery", isAdmin: true });
  return { ctx, admin };
}

describe("解析 worker pool 跟著站台限制改", () => {
  it("帶旗標的注入 runtime：parseWorkers 1 → 2，pool 的 worker 數跟著變 2", async () => {
    const { ctx, admin } = await appWithAdmin({ editingFollowsSiteLimits: true });
    expect(pool().stats().workers).toBe(1);
    await ctx.siteLimits.update(admin.id, { parseWorkers: 2 });
    await vi.waitFor(() => expect(pool().stats().workers).toBe(2));
    expect(pool().limits).toMatchObject({ workers: 2, workerMemoryMb: 1024 });
  });

  it("只改時限：排隊等待的自動值連帶變，pool 收到的 queueWaitMs 是 4 × 5000 + 5000", async () => {
    const { ctx, admin } = await appWithAdmin({ editingFollowsSiteLimits: true });
    // 只記引數、不轉給真的 pool：收到的是完整的 parseLimits()，自動的 worker 數在多核機器上可到 4，轉過去會真的多開 1 GiB 的 worker。
    const spy = vi.spyOn(pool(), "configure").mockImplementation(() => {});
    await ctx.siteLimits.update(admin.id, { parseTimeoutMs: 5_000 });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ timeoutMs: 5_000, queueWaitMs: 25_000 });
  });

  it("注入的 runtime 沒帶旗標 → 不訂閱：改 parseWorkers 之後 pool 不變", async () => {
    const { ctx, admin } = await appWithAdmin({});
    const spy = vi.spyOn(pool(), "configure");
    await ctx.siteLimits.update(admin.id, { parseWorkers: 2 });
    expect(ctx.siteLimits.get("parseWorkers")).toBe(2);
    expect(spy).not.toHaveBeenCalled();
    expect(pool().stats().workers).toBe(1);
  });

  it("共用的 testEditingRuntime 加旗標 → harness 丟錯（沒給 editing、明給 testEditingRuntime、buildTestApp 三種）", async () => {
    const message = "testEditingRuntime is shared; pass your own editing runtime to follow site limits";
    // 只比對結果字串：建成功時的 app 物件很大，交給 expect 印出來會把 vitest 的記憶體撐爆（建出來的 app 由 harness 的 onTestFinished 收）。
    const outcome = (p: Promise<unknown>) => p.then(() => "built", (e: unknown) => (e instanceof Error ? e.message : String(e)));
    expect(await outcome(buildCollabTestApp({ editingFollowsSiteLimits: true }))).toBe(message);
    expect(await outcome(buildCollabTestApp({ editing: testEditingRuntime, editingFollowsSiteLimits: true }))).toBe(message);
    expect(await outcome(buildTestApp({ editing: testEditingRuntime, editingFollowsSiteLimits: true }))).toBe(message);
  });

  it("pool 的 configure 丟錯 → update 照樣 resolve、site_limits 已寫；下一次 update 不卡", async () => {
    const { ctx, admin } = await appWithAdmin({ editingFollowsSiteLimits: true });
    const spy = vi.spyOn(pool(), "configure").mockImplementation(() => {
      throw new Error("configure failed");
    });
    await expect(ctx.siteLimits.update(admin.id, { parseWorkers: 2 })).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    const rows = await ctx.db.select({ value: siteLimitsTable.value }).from(siteLimitsTable).where(eq(siteLimitsTable.key, "parseWorkers"));
    expect(rows).toEqual([{ value: 2 }]);
    expect(ctx.siteLimits.get("parseWorkers")).toBe(2);
    await expect(ctx.siteLimits.update(admin.id, { parseWorkers: 3 })).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(ctx.siteLimits.get("parseWorkers")).toBe(3);
  });
});
