/**
 * #93：查詢（M1 排序、M2 可見性、M4 字面比對、matches、S18 隔離等級與快照、非 ASCII／窗口、回填前只中標題）。函式層——MCP 輸出在
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
    await db.insert(noteShares).values({ noteId: g2n.id, userId: c.id, role: "viewer" }); // 群組筆記上的殘留分享列
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

describe("S18 隔離等級", () => {
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

describe("非 ASCII 與窗口（libc locale）", () => {
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

// ─── #93：bodyOnly 與 keyset 分頁 ───────────────────────────────────────────────

/** 微秒精度直設 updated_at（`at()` 走 JS Date，只有毫秒）。 */
const atUs = (db: Db, id: string, iso: string) => db.execute(sql`update notes set updated_at = ${iso}::timestamptz where id = ${id}::uuid`);
type PageKey = { rank: number; updatedAtKey: string; id: string };
const keyOf = (row: { rank: number; updatedAtKey?: string; id: string }): PageKey => {
  if (row.updatedAtKey === undefined) throw new Error("page 模式的列沒有 updatedAtKey");
  return { rank: row.rank, updatedAtKey: row.updatedAtKey, id: row.id };
};
/** 一頁：回這頁的 id 與下一個 key（沒有下一頁＝null）。 */
async function onePage(db: Db, userId: string, query: string, limit: number, after: PageKey | null, bodyOnly?: boolean) {
  const r = await searchNotesForUser(db, { userId, query, limit, ...(bodyOnly !== undefined ? { bodyOnly } : {}), page: { after } });
  const page = r.rows.slice(0, limit);
  return { ids: page.map(x => x.id), next: r.rows.length > limit ? keyOf(page.at(-1)!) : null };
}
/** 從 after 一路翻到底（每頁取第 limit 列做下一個 key）。 */
async function pageAll(db: Db, userId: string, query: string, limit: number, bodyOnly?: boolean, after: PageKey | null = null): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < 100; i += 1) {
    const p = await onePage(db, userId, query, limit, after, bodyOnly);
    out.push(...p.ids);
    if (p.next === null) return out;
    after = p.next;
  }
  throw new Error("pageAll：翻超過 100 頁");
}
const P = [{ id: "p", text: "nothing here" }];

describe("Q bodyOnly 與 keyset 分頁（#93）", () => {
  it("Q1 bodyOnly：只中標題／兩者／只中內文 → 回後兩篇、both 在前；不帶 → 三篇", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const t = await seedIndexedNote(db, { ownerId: u.id }, "zq1 title", P);
    const both = await seedIndexedNote(db, { ownerId: u.id }, "zq1 both", [{ id: "p", text: "has zq1" }]);
    const body = await seedIndexedNote(db, { ownerId: u.id }, "plain", [{ id: "p", text: "has zq1" }]);
    const r = await searchNotesForUser(db, { userId: u.id, query: "zq1", limit: 20, bodyOnly: true });
    expect(idsOf(r)).toEqual([both.id, body.id]);
    expect(new Set(idsOf(await search(db, u.id, "zq1")))).toEqual(new Set([t.id, both.id, body.id]));
  });

  it("Q2 擠出問題：25 篇只中標題＋1 篇只中內文、limit 20、bodyOnly → 回那 1 篇", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    for (let i = 0; i < 25; i += 1) await seedIndexedNote(db, { ownerId: u.id }, `zq2 t${i}`, P);
    const body = await seedIndexedNote(db, { ownerId: u.id }, "plain", [{ id: "p", text: "zq2 inside" }]);
    const r = await searchNotesForUser(db, { userId: u.id, query: "zq2", limit: 20, bodyOnly: true });
    expect(idsOf(r)).toEqual([body.id]);
  });

  it("Q3 翻頁不重複不漏：3 篇同 rank 同微秒（id 決勝）＋較小 rank＋較大 rank", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    await seedIndexedNote(db, { ownerId: u.id }, "zq3", P); // rank 0
    const ties = [];
    for (let i = 0; i < 3; i += 1) ties.push(await seedIndexedNote(db, { ownerId: u.id }, `a zq3 ${i}`, P)); // rank 2
    await seedIndexedNote(db, { ownerId: u.id }, "plain", [{ id: "p", text: "zq3" }]); // rank 3
    for (const n of ties) await atUs(db, n.id, "2026-01-01T00:00:00.123456Z");
    const all = await pageAll(db, u.id, "zq3", 50);
    expect(all.length).toBe(5);
    const paged = await pageAll(db, u.id, "zq3", 1);
    expect(paged).toEqual(all);
    expect(new Set(paged).size).toBe(5);
  });

  it("Q4 同毫秒不同微秒：兩頁各一篇、都拿得到", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const a = await seedIndexedNote(db, { ownerId: u.id }, "plain a", [{ id: "p", text: "zq4" }]);
    const b = await seedIndexedNote(db, { ownerId: u.id }, "plain b", [{ id: "p", text: "zq4" }]);
    await atUs(db, a.id, "2026-01-01T00:00:00.123456Z");
    await atUs(db, b.id, "2026-01-01T00:00:00.123455Z");
    const first = await onePage(db, u.id, "zq4", 1, null);
    expect(first.ids).toEqual([a.id]);
    expect(first.next?.updatedAtKey).toBe("2026-01-01T00:00:00.123456Z");
    expect(await pageAll(db, u.id, "zq4", 1)).toEqual([a.id, b.id]);
  });

  it("Q5 跨 rank 邊界（bodyOnly）：2 篇 both＋2 篇只中內文、limit 1 翻 4 頁 → 順序同一次取", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    await seedIndexedNote(db, { ownerId: u.id }, "zq5", [{ id: "p", text: "zq5" }]); // rank 0
    await seedIndexedNote(db, { ownerId: u.id }, "x zq5", [{ id: "p", text: "zq5" }]); // rank 2
    await seedIndexedNote(db, { ownerId: u.id }, "plain 1", [{ id: "p", text: "zq5" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "plain 2", [{ id: "p", text: "zq5" }]);
    await seedIndexedNote(db, { ownerId: u.id }, "zq5 title only", P); // bodyOnly 下不出現
    const all = await pageAll(db, u.id, "zq5", 50, true);
    expect(all.length).toBe(4);
    expect(await pageAll(db, u.id, "zq5", 1, true)).toEqual(all);
  });

  it("Q6 與可見性交互：A 的游標給 B；翻頁間撤銷分享；owned／shared／grouped 同 updated_at 各一頁", async () => {
    const { db } = await freshDb();
    const [a, b] = await Promise.all([seedUser(db), seedUser(db)]);
    const body = [{ id: "p", text: "zq6" }];
    const aOwn = await seedIndexedNote(db, { ownerId: a.id }, "a own", body);
    const shared = await seedIndexedNote(db, { ownerId: a.id }, "shared", body);
    const bOld = await seedIndexedNote(db, { ownerId: b.id }, "b old", body);
    await seedShare(db, shared.id, b.id, "viewer");
    await atUs(db, aOwn.id, "2026-03-01T00:00:00.000003Z");
    await atUs(db, shared.id, "2026-03-01T00:00:00.000002Z");
    await atUs(db, bOld.id, "2026-03-01T00:00:00.000001Z");
    // A 的第一頁游標拿給 B：只回 B 看得到、排在 key 之後的列，沒有錯誤。
    const aFirst = await onePage(db, a.id, "zq6", 1, null);
    expect(aFirst.ids).toEqual([aOwn.id]);
    expect(await pageAll(db, b.id, "zq6", 1, undefined, aFirst.next)).toEqual([shared.id, bOld.id]);

    // B 自己翻：第一頁後撤銷還沒拿到的那篇的分享 → 後續頁不含它、其餘照常。
    const bNew = await seedIndexedNote(db, { ownerId: b.id }, "b new", body);
    await atUs(db, bNew.id, "2026-03-01T00:00:00.000009Z");
    const bFirst = await onePage(db, b.id, "zq6", 1, null);
    expect(bFirst.ids).toEqual([bNew.id]);
    await db.delete(noteShares).where(and(eq(noteShares.noteId, shared.id), eq(noteShares.userId, b.id)));
    expect(await pageAll(db, b.id, "zq6", 1, undefined, bFirst.next)).toEqual([bOld.id]);

    // owned／shared／grouped 三支各一篇、updated_at 相同 → 三頁各一篇、無重複。
    const { db: db2 } = await freshDb();
    const [x, y] = await Promise.all([seedUser(db2), seedUser(db2)]);
    const g = await seedGroup(db2, "G", [{ userId: x.id, role: "admin" }, { userId: y.id, role: "member" }]);
    const own = await seedIndexedNote(db2, { ownerId: y.id }, "own", body);
    const sh = await seedIndexedNote(db2, { ownerId: x.id }, "sh", body);
    await seedShare(db2, sh.id, y.id, "editor");
    const gr = await seedIndexedNote(db2, { groupId: g.id }, "gr", body);
    for (const n of [own, sh, gr]) await atUs(db2, n.id, "2026-04-01T00:00:00.000500Z");
    const paged = await pageAll(db2, y.id, "zq6", 1);
    expect(paged).toEqual(await pageAll(db2, y.id, "zq6", 50));
    expect(new Set(paged)).toEqual(new Set([own.id, sh.id, gr.id]));
    expect(paged.length).toBe(3);
  });

  it("Q8 旁觀者：沒命中的最舊筆記從不出現；bodyOnly 下同 rank、較舊的只中標題筆記也不出現", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const both = await seedIndexedNote(db, { ownerId: u.id }, "x zq8 y", [{ id: "p", text: "zq8" }]); // rank 2
    const titleOnly = await seedIndexedNote(db, { ownerId: u.id }, "a zq8 b", P); // rank 2
    const bodyN = await seedIndexedNote(db, { ownerId: u.id }, "plain", [{ id: "p", text: "zq8" }]); // rank 3
    const none = await seedIndexedNote(db, { ownerId: u.id }, "nothing", P); // 沒命中（CASE 落到 3）
    await atUs(db, both.id, "2026-05-01T00:00:00.000005Z");
    await atUs(db, titleOnly.id, "2026-05-01T00:00:00.000004Z");
    await atUs(db, bodyN.id, "2026-05-01T00:00:00.000003Z");
    await atUs(db, none.id, "2026-05-01T00:00:00.000001Z");
    expect(await pageAll(db, u.id, "zq8", 1)).toEqual([both.id, titleOnly.id, bodyN.id]);
    expect(await pageAll(db, u.id, "zq8", 1, true)).toEqual([both.id, bodyN.id]);
  });

  it("Q7 游標的錨點消失或變動：錨點進垃圾桶仍接得上；未拿到的被推到最新 → 漏；已拿到的改名變大 rank → 再出現一次", async () => {
    const body = [{ id: "p", text: "zq7" }];
    // 錨點進垃圾桶：keyset 只看值。
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n3 = await seedIndexedNote(db, { ownerId: u.id }, "p3", body);
    const n2 = await seedIndexedNote(db, { ownerId: u.id }, "p2", body);
    const n1 = await seedIndexedNote(db, { ownerId: u.id }, "p1", body);
    await atUs(db, n3.id, "2026-06-01T00:00:00.000003Z");
    await atUs(db, n2.id, "2026-06-01T00:00:00.000002Z");
    await atUs(db, n1.id, "2026-06-01T00:00:00.000001Z");
    const first = await onePage(db, u.id, "zq7", 1, null);
    expect(first.ids).toEqual([n3.id]);
    await db.execute(sql`update notes set deleted_at = now() where id = ${n3.id}::uuid`);
    expect(await pageAll(db, u.id, "zq7", 1, undefined, first.next)).toEqual([n2.id, n1.id]);

    // 還沒拿到的被推到最新 → 後續頁不會出現（已知會漏，文件寫明；web 不補）。
    const { db: db2 } = await freshDb();
    const v = await seedUser(db2);
    const m3 = await seedIndexedNote(db2, { ownerId: v.id }, "m3", body);
    const m2 = await seedIndexedNote(db2, { ownerId: v.id }, "m2", body);
    const m1 = await seedIndexedNote(db2, { ownerId: v.id }, "m1", body);
    await atUs(db2, m3.id, "2026-06-01T00:00:00.000003Z");
    await atUs(db2, m2.id, "2026-06-01T00:00:00.000002Z");
    await atUs(db2, m1.id, "2026-06-01T00:00:00.000001Z");
    const f2 = await onePage(db2, v.id, "zq7", 1, null);
    expect(f2.ids).toEqual([m3.id]);
    await atUs(db2, m1.id, "2026-06-02T00:00:00.000000Z");
    expect(await pageAll(db2, v.id, "zq7", 1, undefined, f2.next)).toEqual([m2.id]);

    // 已拿到的改名、rank 變大（0 → 3）→ 在後續頁再出現一次（web 端以 id 去重）。
    const { db: db3 } = await freshDb();
    const w = await seedUser(db3);
    const exact = await seedIndexedNote(db3, { ownerId: w.id }, "zq7", body); // rank 0
    const other = await seedIndexedNote(db3, { ownerId: w.id }, "plain", body); // rank 3
    await atUs(db3, exact.id, "2026-06-01T00:00:00.000002Z");
    await atUs(db3, other.id, "2026-06-01T00:00:00.000001Z");
    const f3 = await onePage(db3, w.id, "zq7", 1, null);
    expect(f3.ids).toEqual([exact.id]);
    await db3.update(notes).set({ title: "renamed" }).where(eq(notes.id, exact.id));
    expect(await pageAll(db3, w.id, "zq7", 1, undefined, f3.next)).toEqual([exact.id, other.id]);
  });
});
