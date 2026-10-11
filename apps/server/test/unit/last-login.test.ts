/** #247 §9.5 Review Focus 5：touchLastLogin 失敗不得擋登入（OIDC callback 的外層 catch 會把任何例外變成 oidc_exchange_failed）。 */
import { describe, expect, it, vi } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import type { Db } from "../../src/db/index.js";
import { touchLastLogin } from "../../src/auth/last-login.js";

describe("touchLastLogin", () => {
  it("UPDATE 拋錯：不往外拋；log.warn 一次，物件形帶 err 與 userId", async () => {
    const boom = new Error("db down");
    const db = { execute: () => Promise.reject(boom) } as unknown as Db;
    const warn = vi.fn();
    await expect(touchLastLogin(db, "u-1", { warn } as unknown as FastifyBaseLogger)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatchObject({ err: boom, userId: "u-1" });
  });

  it("0 列（列被鎖、SKIP LOCKED 跳過）：不拋；log.warn 一次帶 userId；1 列時不 warn", async () => {
    const warn = vi.fn();
    const log = { warn } as unknown as FastifyBaseLogger;
    await expect(touchLastLogin({ execute: () => Promise.resolve({ rowCount: 0 }) } as unknown as Db, "u-2", log)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual([{ userId: "u-2" }, "last_login_at skipped: row locked"]);
    await touchLastLogin({ execute: () => Promise.resolve({ rowCount: 1 }) } as unknown as Db, "u-3", log);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
