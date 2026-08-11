import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { freshDb } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";
import { BUILTIN_ACTION_IDS, seedAiActions } from "../src/db/seed-ai.js";
import { aiActions } from "../src/db/schema.js";

describe("seedAiActions（內建四動作 idempotent seed，spec §13）", () => {
  it("跑兩次仍是四筆，且四筆 id 皆 ∈ BUILTIN_ACTION_IDS", async () => {
    const { db } = await freshDb(); // freshDb() 內部 runMigrations() 已跑過一次 seed
    await seedAiActions(db); // 第二次

    const rows = await db.select().from(aiActions);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(BUILTIN_ACTION_IDS).toContain(row.id);
  });

  it("name/applyMode 照定案表：Rewrite/Translate 為 direct，Summarize/Continue writing 為 preview", async () => {
    const { db } = await freshDb();
    const rows = await db.select().from(aiActions);
    const byName = new Map(rows.map(r => [r.name, r]));

    expect(byName.get("Rewrite")).toMatchObject({ applyMode: "direct" });
    expect(byName.get("Translate")).toMatchObject({ applyMode: "direct" });
    expect(byName.get("Summarize")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Continue writing")).toMatchObject({ applyMode: "preview" });
    expect(byName.size).toBe(4);
  });

  it("admin 改動（systemPrompt + enabled:false）後重跑 seed 不覆寫、不復活", async () => {
    const { db } = await freshDb();
    const [rewrite] = await db.select().from(aiActions).where(eq(aiActions.name, "Rewrite"));
    expect(rewrite).toBeDefined();

    await db
      .update(aiActions)
      .set({ systemPrompt: "已由 admin 改寫過的 system prompt", enabled: false })
      .where(eq(aiActions.id, rewrite!.id));

    // 重跑 seed（模擬下次啟動的 runMigrations）——ON CONFLICT (id) DO NOTHING 不應覆寫。
    await seedAiActions(db);
    await runMigrations(db); // 連 migrate 整條路徑也重跑一次，確保接縫本身也是 idempotent

    const [afterReseed] = await db.select().from(aiActions).where(eq(aiActions.id, rewrite!.id));
    expect(afterReseed).toMatchObject({ systemPrompt: "已由 admin 改寫過的 system prompt", enabled: false });

    const rows = await db.select().from(aiActions);
    expect(rows).toHaveLength(4);
  });
});
