/**
 * #93 §7：查詢（M1 排序、M2 可見性、M4 字面比對、matches、S18 隔離等級與快照、非 ASCII／窗口、回填前只中標題）。函式層——MCP 輸出在
 * `test/mcp-search.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { freshDb } from "./helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { groupMembers, noteShares, notes } from "../src/db/schema.js";
import { backfillSearchIndex } from "../src/notes/search-index.js";
import { runNoteSearchInTx } from "../src/notes/tx/search-query.js";
import { groupMatchesByNote, searchNotesForUser } from "../src/notes/search-query.js";
import { searchDoc } from "./search-doc.js";
import { captureLog, seedIndexedNote, seedNoteState } from "./search-helpers.js";
import type { Db } from "../src/db/index.js";
import type { Tx } from "../src/db/tx.js";

const at = (db: Db, id: string, iso: string) => db.update(notes).set({ updatedAt: new Date(iso) }).where(eq(notes.id, id));
const search = (db: Db, userId: string, query: string, limit = 20) => searchNotesForUser(db, { userId, query, limit });
const idsOf = (r: Awaited<ReturnType<typeof search>>) => r.rows.map(x => x.id);

describe("M1 排序與兩欄", () => {
  it("標題完全相等＞前綴＞包含＞只中內文；同組 updatedAt desc；title_hit／body_hit 三種組合", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const exact = await seedIndexedNote(db, { ownerId: u.id }, "report", [{ id: "p", text: "nothing here" }]);
    const prefix = await seedIndexedNote(db, { ownerId: u.id }, "report of Q3", [{ id: "p", text: "nothing" }]);
    const both = await seedIndexedNote(db, { ownerId: u.id }, "the report draft", [{ id: "p", text: "a report inside too" }]);
    const bodyNew = await seedIndexedNote(db, { ownerId: u.id }, "unrelated new", [{ id: "p", text: "a REPORT inside" }]);
    const bodyOld = await seedIndexedNote(db, { ownerId: u.id }, "unrelated old", [{ id: "p", text: "another report" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "nope", [{ id: "p", text: "no match" }]);
    for (const n of [exact, prefix, both, bodyOld]) await at(db, n.id, "2026-01-01T00:00:00.000Z");
    await at(db, bodyNew.id, "2026-06-01T00:00:00.000Z");
    const r = await search(db, u.id, "Report");
    expect(idsOf(r)).toEqual([exact.id, prefix.id, both.id, bodyNew.id, bodyOld.id]);
    expect(r.rows.map(x => x.rank)).toEqual([0, 1, 2, 3, 3]);
    expect(r.rows.map(x => [x.titleHit, x.bodyHit])).toEqual([[true, false], [true, false], [true, true], [false, true], [false, true]]);
  });

  it("只中內文的同一組內以 updatedAt desc、再 id desc 決勝", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const a = await seedIndexedNote(db, { ownerId: u.id }, "a", [{ id: "p", text: "tie zeta" }]);
    const b = await seedIndexedNote(db, { ownerId: u.id }, "b", [{ id: "p", text: "tie zeta" }]);
    for (const n of [a, b]) await at(db, n.id, "2026-02-02T00:00:00.000Z");
    expect(idsOf(await search(db, u.id, "zeta"))).toEqual([a.id, b.id].sort().reverse());
  });

  it("limit：多取一列判 truncated；matches 只涵蓋前 limit 列", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const t = await seedIndexedNote(db, { ownerId: u.id }, "kappa title", [{ id: "p", text: "x" }]);
    const b = await seedIndexedNote(db, { ownerId: u.id }, "other", [{ id: "p", text: "kappa body" }]);
    const r = await search(db, u.id, "kappa", 1);
    expect(idsOf(r)).toEqual([t.id, b.id]);
    expect(r.matches).toEqual([]);
  });
});

describe("M2 可見性（索引列與權限無關，可見性只來自三支 union）", () => {
  it("私人／分享／撤分享／群組成員／非成員／can_read=false／殘留分享列／個人筆記移入群組／成員被移出", async () => {
    const { db } = await freshDb();
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const Q = "secret-xyz";
    const check = async (userId: string): Promise<string[]> => {
      const r = await search(db, userId, Q);
      const page = new Set(r.rows.map(x => x.id));
      expect(r.matches.every(m => page.has(m.note_id)), "matches 的 id ⊆ 第一句結果").toBe(true);
      return idsOf(r);
    };
    const priv = await seedIndexedNote(db, { ownerId: a.id }, "p", [{ id: "p", text: `has ${Q}` }]);
    expect(await check(b.id)).toEqual([]);
    await seedShare(db, priv.id, b.id, "viewer");
    expect(await check(b.id)).toEqual([priv.id]);
    await db.delete(noteShares).where(and(eq(noteShares.noteId, priv.id), eq(noteShares.userId, b.id)));
    expect(await check(b.id)).toEqual([]);

    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }]);
    const gn = await seedIndexedNote(db, { groupId: g.id }, "g", [{ id: "p", text: `group ${Q}` }]);
    expect(await check(b.id)).toEqual([gn.id]);
    expect(await check(c.id)).toEqual([]);
    await setMemberRole(db, g.id, b.id, await seedRole(db, g.id, "Blind", { canRead: false }));
    expect(await check(b.id)).toEqual([]);

    const g2 = await seedGroup(db, "G2", [{ userId: a.id, role: "admin" }]);
    const g2n = await seedIndexedNote(db, { groupId: g2.id }, "g2", [{ id: "p", text: `g2 ${Q}` }]);
    await db.insert(noteShares).values({ noteId: g2n.id, userId: c.id, role: "viewer" }); // S5 破裂形：群組筆記上的殘留分享列
    expect(await check(c.id)).toEqual([]);

    const moved = await seedIndexedNote(db, { ownerId: a.id }, "m", [{ id: "p", text: `moved ${Q}` }]);
    await seedShare(db, moved.id, c.id, "editor");
    expect(await check(c.id)).toEqual([moved.id]);
    await db.execute(sql`update notes set owner_id = null, group_id = ${g2.id}::uuid where id = ${moved.id}::uuid`);
    expect(await check(c.id)).toEqual([]);

    const g3 = await seedGroup(db, "G3", [{ userId: a.id, role: "admin" }, { userId: c.id, role: "member" }]);
    const g3n = await seedIndexedNote(db, { groupId: g3.id }, "g3", [{ id: "p", text: `g3 ${Q}` }]);
    expect(await check(c.id)).toEqual([g3n.id]);
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g3.id), eq(groupMembers.userId, c.id)));
    expect(await check(c.id)).toEqual([]);
  });

  it("別人的筆記只中標題或只中內文都不出現；群組成員＋殘留分享列恰出現一次；can_read=false／退出群組後消失；陌生人兩句皆空", async () => {
    const { db } = await freshDb();
    const [a, b, c] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
    const Q = "leakprobe";
    await seedIndexedNote(db, { ownerId: a.id }, `title ${Q}`, [{ id: "p", text: "plain" }]);
    await seedIndexedNote(db, { ownerId: a.id }, "plain", [{ id: "p", text: `body ${Q}` }]);
    // B 自己有一篇內文命中——結果非空，第二句（matches）一定會發，才驗得到它沒帶出別人的 id。
    const own = await seedIndexedNote(db, { ownerId: b.id }, "mine", [{ id: "p", text: `own ${Q}` }]);
    let r = await search(db, b.id, Q);
    expect(idsOf(r)).toEqual([own.id]);
    expect(new Set(r.matches.map(m => m.note_id))).toEqual(new Set([own.id]));

    const g = await seedGroup(db, "G", [{ userId: a.id, role: "admin" }, { userId: b.id, role: "member" }]);
    const gn = await seedIndexedNote(db, { groupId: g.id }, `grp ${Q}`, [{ id: "p", text: `grp body ${Q}` }]);
    await db.insert(noteShares).values({ noteId: gn.id, userId: b.id, role: "editor" }); // 殘留分享列：shared 支的 group_id IS NULL 排除
    r = await search(db, b.id, Q);
    expect(idsOf(r).sort()).toEqual([own.id, gn.id].sort()); // 恰一次，union all 沒有重複
    await setMemberRole(db, g.id, b.id, await seedRole(db, g.id, "Blind", { canRead: false }));
    expect(idsOf(await search(db, b.id, Q))).toEqual([own.id]);
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.userId, b.id)));
    expect(idsOf(await search(db, b.id, Q))).toEqual([own.id]);

    r = await search(db, c.id, Q);
    expect(r.rows).toEqual([]);
    expect(r.matches).toEqual([]);
  });
});

describe("M4 字面比對（SQL 層；NUL 在 MCP 的輸入 schema 擋下，見 mcp-notes.test.ts）", () => {
  it("% 與 _ 在內文也是字面", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const under = await seedIndexedNote(db, { ownerId: u.id }, "t1", [{ id: "p", text: "a_b" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "t2", [{ id: "p", text: "axb" }]);
    const pct = await seedIndexedNote(db, { ownerId: u.id }, "t3", [{ id: "p", text: "50%off" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "t4", [{ id: "p", text: "50 off" }]);
    expect(idsOf(await search(db, u.id, "a_b"))).toEqual([under.id]);
    expect(idsOf(await search(db, u.id, "50%"))).toEqual([pct.id]);
  });
});

describe("matches 第二句", () => {
  it("每篇最多 3 個、按 ord；窗口欄位一致", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const blocks = [0, 1, 2, 3, 4].flatMap(i => [{ id: `h${i}`, type: "heading", text: `H${i}` }, { id: `p${i}`, text: `${"w".repeat(50)} zeta ${i}` }]);
    const n = await seedIndexedNote(db, { ownerId: u.id }, "five", blocks);
    const r = await search(db, u.id, "ZETA");
    const m = groupMatchesByNote(r.matches).get(n.id)!;
    expect(m.map(x => [x.section_id, x.ord])).toEqual([["h0", 1], ["h1", 2], ["h2", 3]]);
    for (const x of m) {
      expect(x.win_start).toBe(Math.max(x.p - 40, 1));
      expect(x.win.toLowerCase()).toContain("zeta");
      expect(x.heading).toMatch(/^H\d$/);
    }
  });
  it("整頁都只中標題 → 不發第二句（matches 為空）", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    await seedIndexedNote(db, { ownerId: u.id }, "omega title", [{ id: "p", text: "x" }]);
    expect((await search(db, u.id, "omega")).matches).toEqual([]);
  });
});

describe("S18 隔離等級（I-1、m-A1）", () => {
  it("runNoteSearchInTx 之後同一交易內 transaction_isolation＝repeatable read、read_only＝on", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const res = await db.transaction(async tx => {
      await runNoteSearchInTx(tx, { userId: u.id, query: "x", limit: 5 });
      return tx.execute(sql`select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro`);
    });
    expect(res.rows[0]).toEqual({ iso: "repeatable read", ro: "on" });
  });

  it("第二句釘在第一句的快照上：兩句之間另一條連線刪掉索引列，第二句仍看得到（READ COMMITTED 下會紅）", async () => {
    const { db, url } = await freshDb();
    const other = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const u = await seedUser(db);
      const n = await seedIndexedNote(db, { ownerId: u.id }, "t", [{ id: "p", text: "snapword here" }]);
      const res = await db.transaction(async tx => {
        // 第一句走 select builder（不經 tx.execute）；第二句（matches）是交易內第一個 tx.execute——在它之前插入另一條連線的刪除（autocommit）。
        let wiped = false;
        const proxied = new Proxy(tx, {
          get(target, prop, recv) {
            const v = Reflect.get(target, prop, recv);
            if (prop === "execute" && typeof v === "function") {
              return async (...args: unknown[]) => {
                if (!wiped) {
                  wiped = true;
                  await other.query("delete from note_search_sections where note_id = $1", [n.id]);
                }
                return (v as (...a: unknown[]) => unknown).apply(target, args);
              };
            }
            return typeof v === "function" ? v.bind(target) : v;
          },
        }) as Tx;
        const out = await runNoteSearchInTx(proxied, { userId: u.id, query: "snapword", limit: 5 });
        expect(wiped, "刪除真的落在兩句之間").toBe(true);
        return out;
      });
      expect(res.rows.map(x => x.bodyHit)).toEqual([true]);
      expect(res.matches.length).toBe(1); // REPEATABLE READ：刪除對第二句不可見
      const left = await db.execute<{ n: number }>(sql`select count(*)::int as n from note_search_sections where note_id = ${n.id}::uuid`);
      expect(left.rows[0]!.n).toBe(0); // 刪除確實發生了
    } finally {
      await other.end();
    }
  });
});

describe("非 ASCII 與窗口（libc locale，spec §7.5）", () => {
  it("CJK 子字串；西里爾字母大小寫不敏感；字面的反斜線與引號；emoji 包圍的命中窗口以 code point 計、沒有孤立代理", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const cjk = await seedIndexedNote(db, { ownerId: u.id }, "無關", [{ id: "p", text: "這是全文搜尋的測試內容" }]);
    const cyr = await seedIndexedNote(db, { ownerId: u.id }, "ПРИВЕТ мир", [{ id: "p", text: "x" }]);
    const bs = await seedIndexedNote(db, { ownerId: u.id }, "t", [{ id: "p", text: String.raw`path C:\dir\'q` }]);
    const emo = await seedIndexedNote(db, { ownerId: u.id }, "e", [{ id: "p", text: `${"😀".repeat(60)}NeedLE${"😀".repeat(200)}` }]);
    expect(idsOf(await search(db, u.id, "全文搜尋"))).toEqual([cjk.id]);
    expect(idsOf(await search(db, u.id, "привет"))).toEqual([cyr.id]);
    expect(idsOf(await search(db, u.id, String.raw`\dir\'`))).toEqual([bs.id]);
    const r = await search(db, u.id, "needle");
    expect(idsOf(r)).toEqual([emo.id]);
    const m = r.matches[0]!;
    const cps = [...m.win];
    const lead = m.p - m.win_start;
    expect(cps.slice(lead, lead + 6).join("")).toBe("NeedLE");
    expect(cps.length).toBe(40 + 6 + 160);
    expect(m.win_start).toBe(61 - 40);
    expect(m.body_len).toBe(60 + 6 + 200);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(m.win)).toBe(false);
  });
});

describe("回填前只中標題（description 的 after-an-upgrade 句的守衛）", () => {
  it("有 note_states、沒有索引 → 內文搜不到；回填後搜得到", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id }, { title: "plain" });
    await seedNoteState(db, n.id, searchDoc([{ id: "p", text: "hidden-word" }]), 1);
    expect(idsOf(await search(db, u.id, "hidden-word"))).toEqual([]);
    await backfillSearchIndex(db, captureLog().log);
    const r = await search(db, u.id, "hidden-word");
    expect(idsOf(r)).toEqual([n.id]);
    expect(r.rows[0]!.bodyHit).toBe(true);
  });
});
