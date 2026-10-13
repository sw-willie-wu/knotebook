/** #267：LastActiveTracker 的行程內節流、上限與 best-effort（不拋、只 warn）。SQL 條件那層在整合測試 `last-active.test.ts`。 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { LAST_ACTIVE_WRITE_INTERVAL_MS } from "@knotebook/shared";
import type { Db } from "../../src/db/index.js";
import { LastActiveTracker } from "../../src/auth/last-active.js";

function fakeDb(impl: () => Promise<unknown> = () => Promise.resolve({ rowCount: 1 })) {
  const execute = vi.fn(impl);
  return { db: { execute } as unknown as Db, execute };
}
const quietLog = () => ({ warn: vi.fn() }) as unknown as FastifyBaseLogger & { warn: ReturnType<typeof vi.fn> };

describe("LastActiveTracker", () => {
  it("同一使用者在寫入間隔內只打一次 DB；滿間隔後再打；不同使用者各自計", async () => {
    let now = 1_000_000;
    const { db, execute } = fakeDb();
    const t = new LastActiveTracker(db, quietLog(), { now: () => now });
    await t.touch("u-1");
    await t.touch("u-1");
    now += LAST_ACTIVE_WRITE_INTERVAL_MS - 1;
    await t.touch("u-1");
    expect(execute).toHaveBeenCalledTimes(1);
    await t.touch("u-2");
    expect(execute).toHaveBeenCalledTimes(2);
    now += 1;
    await t.touch("u-1");
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("UPDATE 拋錯：不往外拋；log.warn 一次，物件形帶 err 與 userId；0 列不 warn", async () => {
    const boom = new Error("db down");
    const log = quietLog();
    await expect(new LastActiveTracker(fakeDb(() => Promise.reject(boom)).db, log).touch("u-1")).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]![0]).toMatchObject({ err: boom, userId: "u-1" });
    await new LastActiveTracker(fakeDb(() => Promise.resolve({ rowCount: 0 })).db, log).touch("u-2");
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("節流表有上限：滿了先清掉已過間隔的項；仍滿就整張清空——不會無限成長", async () => {
    let now = 0;
    const { db, execute } = fakeDb();
    const t = new LastActiveTracker(db, quietLog(), { now: () => now, maxEntries: 3 });
    await t.touch("a");
    now = LAST_ACTIVE_WRITE_INTERVAL_MS; // a 已過間隔
    await t.touch("b");
    await t.touch("c");
    expect(t.size).toBe(3);
    await t.touch("d"); // 滿 → 清掉過期的 a，剩 b、c，再加 d
    expect(t.size).toBe(3);
    await t.touch("b"); // b 仍在間隔內、還在表裡 → 不打 DB
    expect(execute).toHaveBeenCalledTimes(4);
    await t.touch("e"); // 滿、且沒有過期項 → 清空後加 e
    expect(t.size).toBe(1);
    expect(execute).toHaveBeenCalledTimes(5);
    for (let i = 0; i < 50; i++) await t.touch(`x-${i}`);
    expect(t.size).toBeLessThanOrEqual(3);
  });
});
