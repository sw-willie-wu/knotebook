// §10.2 清除（DELETE 的並發保險、切版後清除、背景掃描 ≥ 250 篇）、病態文件（5000 層）、§13 的量測（只回報、不斷言上限）。
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { createVersionService } from "../src/collab/versions.js";
import { selectVersionsToDelete } from "../src/collab/version-policy.js";
import { noteVersions, notes } from "../src/db/schema.js";
import { EditorSession } from "../src/notes/editing/session.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { cookieOf, seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { buildTestApp, testEditingRuntime } from "./helpers.js";
import { deepDoc, paraDoc, versionsOf } from "./version-helpers.js";

const NOW = new Date("2026-10-09T12:00:00Z");
/** 在 note 上插 N 列自動版本：createdAt 依序是 days 陣列（距 NOW 的天數，可帶小數）。seq 1..N；基底指向最後一列。 */
async function seedAutos(db: Awaited<ReturnType<typeof buildTestApp>>["db"], noteId: string, days: number[]): Promise<void> {
  for (let i = 0; i < days.length; i += 1) {
    await db.insert(noteVersions).values({ noteId, seq: i + 1, ydoc: Buffer.from([0]), kind: "auto", createdAt: new Date(NOW.getTime() - days[i]! * 86_400_000) });
  }
  await db.update(notes).set({ versionCounter: days.length, versionBaseSeq: days.length, versionBaseFingerprint: "fp" }).where(eq(notes.id, noteId));
}

describe("pruneNote 的並發保險（DELETE 當下重判）", () => {
  it("讀完到刪之前：某一列被改名成手動、基底被套用換成某一列 → 兩列都留", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    // 天數越小越新：seq 1 最舊（70.4 天前）、seq 4 最新（70.1 天前），四列同一 UTC 日（2026-07-31 週五）→ 同週，留 seq 4、刪 1–3。
    // （gate r1 I-2：原稿方向寫反，seq 1 反而最新、doomed 變成 [2,3,4]）
    await seedAutos(db, n.id, [70.4, 70.3, 70.2, 70.1, 0.5]);
    const svc = createVersionService({
      db, log: { warn: () => {} },
      testHooks: {
        afterPruneRead: async (_id, doomed) => {
          expect(doomed).toEqual([1, 2, 3]);
          await db.update(noteVersions).set({ kind: "manual" }).where(sql`note_versions.note_id = ${n.id} and note_versions.seq = 1`);
          await db.update(notes).set({ versionBaseSeq: 2 }).where(eq(notes.id, n.id));
        },
      },
    });
    expect(await svc.pruneNote(n.id, NOW)).toBe(1);
    expect((await versionsOf(db, n.id)).map(v => v.seq)).toEqual([1, 2, 4, 5]);
  });
});

describe("切版後清除（§5.3 第 5 步）", () => {
  it("手動存一版之後，舊的自動版本依 policy 被清：結果＝policy 對同一組列的輸出", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, paraDoc(["新內容"]));
    // 以 DB 的現在為準造列（切版內呼叫 pruneNote 用的是真實時鐘）：遠離區間邊界 ±0.4 天以上。
    for (const [i, d] of [10.5, 10.52, 70.1, 70.12, 3.5].entries()) {
      await db.execute(sql`insert into note_versions (note_id, seq, ydoc, kind, created_at) values (${n.id}, ${i + 1}, '\\x00'::bytea, 'auto', now() - make_interval(secs => ${d * 86400}))`);
    }
    await db.update(notes).set({ versionCounter: 5, versionBaseSeq: 5, versionBaseFingerprint: "stale" }).where(eq(notes.id, n.id));
    const before = await versionsOf(db, n.id);
    const r = await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies: await cookieOf(u.id), payload: {} });
    expect(r.statusCode).toBe(201);
    const expectDoomed = selectVersionsToDelete([...before, { seq: 6, kind: "manual", createdAt: new Date() }], { now: new Date(), keepAllDays: 7, dailyUntilDays: 30, baseSeq: 6 });
    expect((await versionsOf(db, n.id)).map(v => v.seq)).toEqual([1, 2, 3, 4, 5, 6].filter(s => !expectDoomed.includes(s)));
    expect(expectDoomed.length).toBeGreaterThan(0); // 前提：這組資料真的有東西可刪
  });
});

describe("sweep 規模（§11.2：連續三輪涵蓋 ≥ 250 篇中的每一篇）", () => {
  it("250 篇各有一列該刪：三輪（100／100／50）後每篇都清乾淨；第四輪 0 並歸零", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    await db.execute(sql`insert into notes (owner_id, slug) select ${u.id}, 'sw-' || g from generate_series(1, 250) g`);
    await db.execute(sql`
      insert into note_versions (note_id, seq, ydoc, kind, created_at)
      select n.id, s.seq, '\\x00'::bytea, 'auto', ${NOW}::timestamptz - make_interval(days => s.days, hours => s.seq)
      from notes n cross join (values (1, 70), (2, 70), (3, 0)) as s(seq, days)
      where n.slug like 'sw-%'`);
    await db.execute(sql`update notes set version_counter = 3, version_base_seq = 3, version_base_fingerprint = 'fp' where slug like 'sw-%'`);
    const svc = createVersionService({ db, log: { warn: () => {} } });
    expect([await svc.sweep(NOW), await svc.sweep(NOW), await svc.sweep(NOW)]).toEqual([100, 100, 50]);
    const left = await db.execute(sql`select count(*)::int as n from note_versions`);
    expect(left.rows[0]).toEqual({ n: 500 }); // 每篇剩 2（同週較新的那列＋最新）
    expect(await svc.sweep(NOW)).toBe(0);
  });
});

describe("病態文件（§11.2 深巢狀、§13-9 的 500 範圍）", () => {
  it("5000 層：GET /versions 不 500、手動存 201、GET 快照 200、搬到群組成功", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, deepDoc(5000));
    const cookies = await cookieOf(u.id);
    expect((await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies, payload: {} })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions/1`, cookies })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies, payload: { groupId: g.id } })).statusCode).toBe(200);
  });
});

describe("量測（只回報；數字抄進回報與 PR body）", () => {
  it("§13-10：刪群組・轉移 50 篇（每篇 3 版）耗時", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    for (let i = 0; i < 50; i += 1) {
      const n = await seedNote(db, { groupId: g.id });
      for (let s = 1; s <= 3; s += 1) await db.insert(noteVersions).values({ noteId: n.id, seq: s, ydoc: Buffer.from([0]), kind: "auto" });
    }
    const t0 = performance.now();
    const r = await app.inject({ method: "DELETE", url: `/api/groups/${g.id}`, cookies: await cookieOf(u.id), payload: { mode: "transfer", transferTo: u.id } });
    console.log(`MEASURE §13-10 transfer 50 notes: ${Math.round(performance.now() - t0)} ms`);
    expect(r.statusCode).toBe(204);
  });

  it("§13-9（server 代理）：缺 isToggleable 的舊 heading 被 mount 後會不會回寫屬性、版本指紋變不變", async () => {
    const doc = new Y.Doc();
    const g = new Y.XmlElement("blockGroup");
    doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
    const c = new Y.XmlElement("blockContainer");
    c.setAttribute("id", "h1");
    const h = new Y.XmlElement("heading");
    for (const [k, v] of Object.entries({ level: 1, backgroundColor: "default", textColor: "default", textAlignment: "left" })) h.setAttribute(k, v as string);
    const t = new Y.XmlText();
    h.insert(0, [t]);
    c.insert(0, [h]);
    g.insert(0, [c]);
    t.insert(0, "舊標題");
    const fpBefore = versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT));
    const sv = Y.encodeStateVector(doc);
    const s = await EditorSession.open(testEditingRuntime, doc);
    s.close();
    const wrote = Y.encodeStateAsUpdate(doc, sv).length > 2;
    const fpChanged = versionFingerprint(doc.getXmlFragment(YDOC_FRAGMENT)) !== fpBefore;
    console.log(`MEASURE §13-9 mount writeback: wrote=${wrote} fpChanged=${fpChanged} attrs=${JSON.stringify(h.getAttributes())}`);
    expect(fpBefore).toMatch(/^[0-9a-f]{16}$/);
    expect(wrote || !fpChanged).toBe(true); // 沒寫回就不該指紋變（指紋只看 Yjs 結構）
  });

  it("§13-5（server 側）：2000 區塊筆記的手動存與 GET 快照耗時", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedDoc(db, n.id, paraDoc(Array.from({ length: 2000 }, (_, i) => `第 ${i} 段的一些文字內容`)));
    const cookies = await cookieOf(u.id);
    let t0 = performance.now();
    expect((await app.inject({ method: "POST", url: `/api/notes/${n.id}/versions`, cookies, payload: {} })).statusCode).toBe(201);
    const saveMs = Math.round(performance.now() - t0);
    t0 = performance.now();
    const snap = await app.inject({ method: "GET", url: `/api/notes/${n.id}/versions/1`, cookies });
    console.log(`MEASURE §13-5 server 2000 blocks: save=${saveMs} ms snapshot=${Math.round(performance.now() - t0)} ms bytes=${snap.body.length}`);
    expect(snap.statusCode).toBe(200);
  });
});
