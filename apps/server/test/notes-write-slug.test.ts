/**
 * #175 §6.9：`writeSlugInTx`（交易內寫 slug 的 savepoint helper）與 `insertNoteWithAutoSlug` 的 `inTx` 模式。
 * 「搶先寫入」以 `beforeWrite`／`beforeInsert` 縫在探測後、寫入前用**另一條連線**（`db`，已 commit）插同名列造出。
 */
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { uniqueViolationConstraint } from "../src/db/pg-errors.js";
import { noteRedirects, notes } from "../src/db/schema.js";
import { writeSlugInTx } from "../src/notes/tx/write-slug.js";
import { insertNoteWithAutoSlug } from "../src/notes/create.js";
import { buildTestApp } from "./helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";

describe("#175 writeSlugInTx（§6.9）", () => {
  it("群組 scope 撞名 → -2、寫入後該列屬於目標群組", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id }, { slug: "dup" });
    const mine = await seedNote(db, { ownerId: u.id }, { slug: "dup" }); // 本列原本在個人範圍、同名 dup；scope 判定由下一案守
    const slug = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "dup" }, async s => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: s }).where(eq(notes.id, mine.id));
      }, { excludeNoteId: mine.id }),
    );
    expect(slug).toBe("dup-2");
    const [row] = await db.select().from(notes).where(eq(notes.id, mine.id));
    expect(row).toMatchObject({ groupId: g.id, ownerId: null, slug: "dup-2" });
  });

  it("scope 只看目標群組：別的 owner 的個人筆記同名不算撞 → 回基底本身", async () => {
    const { db } = await buildTestApp();
    const [u, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await seedNote(db, { ownerId: other.id }, { slug: "solo" }); // 群組外、別人的個人範圍
    const mine = await seedNote(db, { ownerId: u.id });
    const slug = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "solo" }, async s => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: s }).where(eq(notes.id, mine.id));
      }, { excludeNoteId: mine.id }),
    );
    expect(slug).toBe("solo");
  });

  it("本列已在目標 scope、slug 同基底 → 排除本列、回原 slug（不把自己判成占用）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: g.id }, { slug: "same" });
    const slug = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "same" }, async s => {
        await tx.update(notes).set({ slug: s }).where(eq(notes.id, n.id));
      }, { excludeNoteId: n.id }),
    );
    expect(slug).toBe("same");
  });

  it("探測後被別人搶先寫入同名（beforeWrite 縫）→ savepoint 回滾、重探測成功，外層交易之後的語句仍可用（不是 25P02）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "race" });
    const seen: string[] = [];
    const out = await db.transaction(async tx => {
      const s = await writeSlugInTx(tx, { groupId: g.id }, { base: "race" }, async c => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: c }).where(eq(notes.id, n.id));
      }, {
        excludeNoteId: n.id,
        beforeWrite: async c => {
          seen.push(c);
          if (seen.length === 1) await seedNote(db, { groupId: g.id }, { slug: c }); // 另一條連線、已 commit
        },
      });
      const [again] = await tx.select({ slug: notes.slug }).from(notes).where(eq(notes.id, n.id)); // 外層交易仍可用
      return { s, again: again!.slug };
    });
    expect(seen).toEqual(["race", "race-2"]);
    expect(out).toEqual({ s: "race-2", again: "race-2" });
  });

  it("重試耗盡 → fallbackAutoSlug（untitled-<8 hex>）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id }, { slug: "x" });
    const seen: string[] = [];
    const s = await db.transaction(tx =>
      writeSlugInTx(tx, { groupId: g.id }, { base: "x" }, async c => {
        await tx.update(notes).set({ ownerId: null, groupId: g.id, slug: c }).where(eq(notes.id, n.id));
      }, { excludeNoteId: n.id, beforeWrite: async c => { seen.push(c); if (!c.startsWith("untitled-")) await seedNote(db, { groupId: g.id }, { slug: c }); } }),
    );
    expect(s).toMatch(/^untitled-[0-9a-f]{8}$/);
    // 重試輪數釘死：5 輪探測（x、x-2…x-5）全被搶先，第 6 輪才退位 fallback（M8：門檻 `>` 改 `>=` 會少一輪）
    expect(seen.slice(0, 5)).toEqual(["x", "x-2", "x-3", "x-4", "x-5"]);
    expect(seen).toHaveLength(6);
    expect(seen[5]).toMatch(/^untitled-/);
  });

  it("非 slug 的 23505 原樣拋出、不重試（constraint 名分流）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    let calls = 0;
    // drizzle 0.44 把 pg 錯誤包成 DrizzleQueryError（原始錯誤在 `.cause`）——以 `db/pg-errors.ts` 的判定取 constraint 名。
    const err = await db
      .transaction(tx =>
        writeSlugInTx(tx, { ownerId: u.id }, { base: "y" }, async () => {
          calls++;
          await tx.insert(noteRedirects).values([
            { oldPath: "/n/z/dup-pk", noteId: n.id, expiresAt: new Date(Date.now() + 1e6) },
            { oldPath: "/n/z/dup-pk", noteId: n.id, expiresAt: new Date(Date.now() + 1e6) },
          ]);
        }),
      )
      .then(() => null, (e: unknown) => e);
    expect(uniqueViolationConstraint(err)).toBe("note_redirects_pkey");
    expect(calls).toBe(1);
  });
});

describe("#175 insertNoteWithAutoSlug 的 inTx 模式（§6.5 (4)）", () => {
  it("交易內撞名 → savepoint 重試成功、同交易之後還能寫；回傳的列屬於該群組", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    await seedNote(db, { groupId: g.id }, { slug: "plan" });
    let first = true;
    const row = await db.transaction(async tx => {
      const created = await insertNoteWithAutoSlug(tx, { groupId: g.id }, "Plan", {
        beforeInsert: async c => { if (first) { first = false; await seedNote(db, { groupId: g.id }, { slug: c }); } },
      }, { inTx: true });
      await tx.update(notes).set({ title: "Plan!" }).where(eq(notes.id, created.id));
      return created;
    });
    expect(row.groupId).toBe(g.id);
    expect(row.slug).toBe("plan-3"); // plan 被 seed、plan-2 被 beforeInsert 搶走
    const [after] = await db.select({ title: notes.title }).from(notes).where(and(eq(notes.id, row.id)));
    expect(after!.title).toBe("Plan!");
  });
});
