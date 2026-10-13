import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { BUILTIN_ACTION_IDS, INSTRUCT_ACTION_ID } from "@knotebook/shared";
import { freshDb } from "./helpers.js";
import { runMigrations } from "../src/db/migrate.js";
import { seedAiActions } from "../src/db/seed-ai.js";
import { aiActions } from "../src/db/schema.js";

describe("seedAiActions（內建五動作 idempotent seed，spec §13；#263 §4.1）", () => {
  it("跑兩次仍是五筆，且 id 恰為 BUILTIN_ACTION_IDS", async () => {
    const { db } = await freshDb(); // freshDb() 內部 runMigrations() 已跑過一次 seed
    await seedAiActions(db); // 第二次

    const rows = await db.select().from(aiActions);
    expect(rows.map((r) => r.id).sort()).toEqual([...BUILTIN_ACTION_IDS].sort());
    expect(rows).toHaveLength(5);
  });

  it("name/applyMode 照定案表：五個內建動作新安裝一律 preview（#263 後續：Rewrite/Translate 由 direct 改 preview）", async () => {
    const { db } = await freshDb();
    const rows = await db.select().from(aiActions);
    const byName = new Map(rows.map((r) => [r.name, r]));

    expect(byName.get("Rewrite")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Translate")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Summarize")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Continue writing")).toMatchObject({ applyMode: "preview" });
    expect(byName.get("Instruct")).toMatchObject({ applyMode: "preview" });
    expect(byName.size).toBe(5);
  });

  it("#263 Instruct 預設值：system prompt、三佔位符 template（instruction／focus／text 各一行）、preview、sortOrder 4、modelId null、啟用", async () => {
    const { db } = await freshDb();
    const [row] = await db.select().from(aiActions).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    expect(row).toMatchObject({
      name: "Instruct",
      systemPrompt:
        "You are an expert editor working on a note. Follow the user's instruction for the given text, preserving its language and Markdown formatting unless the instruction says otherwise.",
      userTemplate: "{{instruction}}\n{{focus}}\n{{text}}",
      applyMode: "preview",
      sortOrder: 4,
      modelId: null,
      enabled: true,
    });
  });

  it("admin 改動（Rewrite 的 systemPrompt＋停用、Instruct 的 template）後重跑 seed 不覆寫、不復活", async () => {
    const { db } = await freshDb();
    const [rewrite] = await db.select().from(aiActions).where(eq(aiActions.name, "Rewrite"));
    expect(rewrite).toBeDefined();

    // applyMode 也算：既有站台（或 admin）留著的 direct 不會被新預設 preview 蓋掉（升級不改既有站台的值）。
    await db
      .update(aiActions)
      .set({ systemPrompt: "已由 admin 改寫過的 system prompt", enabled: false, applyMode: "direct" })
      .where(eq(aiActions.id, rewrite!.id));
    await db.update(aiActions).set({ userTemplate: "{{text}} / {{instruction}}" }).where(eq(aiActions.id, INSTRUCT_ACTION_ID));

    // 重跑 seed（模擬下次啟動的 runMigrations）——ON CONFLICT (id) DO NOTHING 不應覆寫。
    await seedAiActions(db);
    await runMigrations(db); // 連 migrate 整條路徑也重跑一次，確保接縫本身也是 idempotent

    const [afterRewrite] = await db.select().from(aiActions).where(eq(aiActions.id, rewrite!.id));
    expect(afterRewrite).toMatchObject({ systemPrompt: "已由 admin 改寫過的 system prompt", enabled: false, applyMode: "direct" });
    const [afterInstruct] = await db.select().from(aiActions).where(eq(aiActions.id, INSTRUCT_ACTION_ID));
    expect(afterInstruct?.userTemplate).toBe("{{text}} / {{instruction}}");

    const rows = await db.select().from(aiActions);
    expect(rows).toHaveLength(5);
  });
});
