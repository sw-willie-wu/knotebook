import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyRequest } from "fastify";
import { LOWERCASED_PARAMS, lowercaseUuidParams } from "../../src/http/uuid-params.js";

const run = async (params: Record<string, unknown>) => {
  await lowercaseUuidParams({ params } as unknown as FastifyRequest);
  return params;
};

describe("#240 U-240r：lowercaseUuidParams", () => {
  it("名單恰為 id、userId", () => {
    expect([...LOWERCASED_PARAMS]).toEqual(["id", "userId"]);
  });

  it("id／userId 的大寫與大小寫混雜 UUID 轉小寫", async () => {
    const a = randomUUID();
    const b = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const mixed = "0F8fAd5B-d9Cb-469F-a165-70867728950E"; // 寫死：保證真的大小寫混雜
    expect(await run({ id: a.toUpperCase(), userId: mixed })).toEqual({ id: a, userId: b });
  });

  it("非 UUID 形原樣；名單外的參數即使是 UUID 形也原樣", async () => {
    const u = randomUUID().toUpperCase();
    const p = { id: "NOT-A-UUID", userId: `${u}x`, ref: u, handle: u, slug: u, editId: u, groupId: u };
    expect(await run({ ...p })).toEqual(p);
  });

  it("沒有 params（404 handler 的 `{'*': …}`、無參數路由）不丟錯", async () => {
    expect(await run({ "*": "nope" })).toEqual({ "*": "nope" });
    await expect(lowercaseUuidParams({ params: undefined } as unknown as FastifyRequest)).resolves.toBeUndefined();
  });
});
