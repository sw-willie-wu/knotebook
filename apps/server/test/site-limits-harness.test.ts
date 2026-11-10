/**
 * #397：harness 先決定 app 實際用的 `config` 與 `db`，再用這兩樣 `SiteLimits.load` 一份放進 `deps.siteLimits`。
 * 覆寫 `config` 的 env 鎖要進 `siteLimits`（鎖定狀態唯一來源）；覆寫 `db` 時 `siteLimits` 要綁同一個 DB。
 */
import { describe, expect, it } from "vitest";
import { siteLimits as siteLimitsTable } from "../src/db/schema.js";
import { SiteLimits } from "../src/site-limits/store.js";
import { buildCollabTestApp, buildTestApp, freshDb, testConfig } from "./helpers.js";

describe("buildTestApp 的 siteLimits", () => {
  it("覆寫 config 的 limitEnv 會進 siteLimits", async () => {
    const { siteLimits } = await buildTestApp({ config: { ...testConfig, limitEnv: { noteMaxBytes: 2097152 } } });
    expect(siteLimits.envName("noteMaxBytes")).toBe("NOTE_MAX_BYTES");
    expect(siteLimits.get("noteMaxBytes")).toBe(2097152);
  });

  it("覆寫 db 時 siteLimits 綁同一個 DB", async () => {
    const { db } = await freshDb();
    await db.insert(siteLimitsTable).values({ key: "rateEdit", value: 10 });
    const { siteLimits, db: appDb } = await buildTestApp({ db });
    expect(appDb).toBe(db);
    expect(siteLimits.get("rateEdit")).toBe(10);
  });

  it("給了 siteLimits 就照用那一份", async () => {
    const given = SiteLimits.defaults({ machine: testConfig.machine });
    const { siteLimits } = await buildTestApp({ siteLimits: given });
    expect(siteLimits).toBe(given);
  });
});

describe("buildCollabTestApp 的 siteLimits", () => {
  it("覆寫 config 的 limitEnv 會進 siteLimits", async () => {
    const { siteLimits } = await buildCollabTestApp({ config: { ...testConfig, limitEnv: { noteMaxBytes: 2097152 } } });
    expect(siteLimits.envName("noteMaxBytes")).toBe("NOTE_MAX_BYTES");
    expect(siteLimits.get("noteMaxBytes")).toBe(2097152);
  });

  it("覆寫 db 時 siteLimits 綁同一個 DB", async () => {
    const { db } = await freshDb();
    await db.insert(siteLimitsTable).values({ key: "rateEdit", value: 10 });
    const ctx = await buildCollabTestApp({ db });
    expect(ctx.db).toBe(db);
    expect(ctx.siteLimits.get("rateEdit")).toBe(10);
  });

  it("給了 siteLimits 就照用那一份", async () => {
    const given = SiteLimits.defaults({ machine: testConfig.machine });
    const ctx = await buildCollabTestApp({ siteLimits: given });
    expect(ctx.siteLimits).toBe(given);
  });
});
