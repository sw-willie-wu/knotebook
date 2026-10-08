/**
 * #93 §6：背景回填（S11、S16、RF4）。直接呼叫 backfillSearchIndex（不經 index.ts）；接線的結構守衛在 unit/search-backfill-wiring。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { freshDb } from "./helpers.js";
import { seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { notes, noteStates } from "../src/db/schema.js";
import { backfillSearchIndex, writeSearchIndex } from "../src/notes/search-index.js";
import { searchDoc } from "./search-doc.js";
import { captureLog, extractOf, indexRows, noteStateVersion, seedNoteState, setNoteState, stateRow } from "./search-helpers.js";

const body = (t: string) => [{ id: "p", text: t }];

async function bodies(db: Parameters<typeof indexRows>[0], id: string): Promise<string[]> {
  return (await indexRows(db, id)).map(r => r.body);
}

describe("S11 回填", () => {
  it("三篇無狀態列＋一篇 extractor_version 0＋一篇 source_version 落後 → 一次全對；再跑 0 候選", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const fresh = await Promise.all([0, 1, 2].map(async i => {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, searchDoc(body(`fresh ${i}`)), 1);
      return n.id;
    }));
    const oldVer = (await seedNote(db, { ownerId: u.id })).id;
    await seedNoteState(db, oldVer, searchDoc(body("old extractor")), 1);
    await writeSearchIndex(db, oldVer, 1, extractOf(body("old extractor")));
    await db.execute(sql`update note_search_state set extractor_version = 0 where note_id = ${oldVer}::uuid`);
    const behind = (await seedNote(db, { ownerId: u.id })).id;
    await seedNoteState(db, behind, searchDoc(body("behind v1")), 1);
    await writeSearchIndex(db, behind, 1, extractOf(body("behind v1")));
    await setNoteState(db, behind, searchDoc(body("behind v2")), 2);

    const { log, infos, warns } = captureLog();
    const r = await backfillSearchIndex(db, log);
    expect(r).toMatchObject({ candidates: 5, done: 5, skipped: 0, failed: 0, aborted: false });
    for (const [i, id] of fresh.entries()) expect(await bodies(db, id)).toEqual([`fresh ${i}`]);
    expect(await bodies(db, oldVer)).toEqual(["old extractor"]);
    expect(await bodies(db, behind)).toEqual(["behind v2"]);
    for (const id of [...fresh, oldVer, behind]) {
      expect(await stateRow(db, id)).toMatchObject({ extractorVersion: 1, sourceVersion: await noteStateVersion(db, id) });
    }
    expect(infos.map(i => i.msg)).toEqual(["全文索引回填開始", "全文索引回填完成"]);
    expect(warns).toEqual([]);

    const again = await backfillSearchIndex(db, captureLog().log);
    expect(again).toMatchObject({ candidates: 0, done: 0, skipped: 0, failed: 0 });
  });

  it("從沒開過的筆記（沒有 note_states）不是候選", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    await seedNote(db, { ownerId: u.id });
    expect(await backfillSearchIndex(db, captureLog().log)).toMatchObject({ candidates: 0, done: 0 });
  });

  it("中途 abort → aborted、只做了一部分；再跑只處理剩下的", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    for (let i = 0; i < 6; i += 1) {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, searchDoc(body(`n${i}`)), 1);
    }
    const ac = new AbortController();
    let seen = 0;
    const first = await backfillSearchIndex(db, captureLog().log, { signal: ac.signal, batchSize: 2, afterEachForTest: () => { seen += 1; if (seen === 3) ac.abort(); } });
    expect(first).toMatchObject({ candidates: 6, done: 3, aborted: true });
    const second = await backfillSearchIndex(db, captureLog().log);
    expect(second).toMatchObject({ candidates: 3, done: 3, aborted: false });
  });

  it("壞的 ydoc → warn 一行、failed 1，其餘照做", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const BAD = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expect(() => Y.applyUpdate(new Y.Doc(), BAD), "前提：這組位元組要讓 Y.applyUpdate 丟例外——不丟就換一組再跑").toThrow();
    const bad = await seedNote(db, { ownerId: u.id });
    await db.insert(noteStates).values({ noteId: bad.id, ydoc: BAD, version: 1 });
    const good = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, good.id, searchDoc(body("good one")), 1);
    const { log, warns } = captureLog();
    const r = await backfillSearchIndex(db, log);
    expect(r).toMatchObject({ candidates: 2, done: 1, failed: 1 });
    expect(warns.map(w => w.msg)).toEqual(["全文索引回填：單篇失敗（略過，繼續）"]);
    expect(await bodies(db, good.id)).toEqual(["good one"]);
  });

  it("RF4：回填途中候選筆記被刪 → skipped、不算失敗、不 warn，其餘照做", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, searchDoc(body(`rf4 ${i}`)), 1);
      ids.push(n.id);
    }
    const last = [...ids].sort().at(-1)!; // keyset 依 note_id 遞增，最後處理的是最大的 id
    let deleted = false;
    const { log, warns } = captureLog();
    const r = await backfillSearchIndex(db, log, {
      afterEachForTest: async () => {
        if (!deleted) {
          deleted = true;
          await db.delete(notes).where(eq(notes.id, last)); // 候選頁已取回（含 last），逐篇讀時它已不在
        }
      },
    });
    expect(deleted).toBe(true);
    expect(r).toMatchObject({ candidates: 3, done: 2, skipped: 1, failed: 0 });
    expect(warns).toEqual([]);
  });

  it("RF4（gone 形）：逐篇讀到 note_states 之後才被刪（writeSearchIndex 回 gone）→ 同樣 skipped、不 warn", async () => {
    // 上一案的刪除在逐篇讀之前就提交，走的是「列已不在」分支、到不了 writeSearchIndex；這案讓刪除交易
    // 在逐篇讀時還沒提交（讀得到舊列），writeSearchIndex 第 1 步 KEY SHARE 卡在 DELETE 的列鎖上，提交後回 gone。
    const { db } = await freshDb();
    const u = await seedUser(db);
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const n = await seedNote(db, { ownerId: u.id });
      await seedNoteState(db, n.id, searchDoc(body(`gone ${i}`)), 1);
      ids.push(n.id);
    }
    const [first, last] = [...ids].sort() as [string, string];
    const holder = await db.$client.connect();
    let open = false;
    try {
      let deletedSignal!: () => void;
      const deleted = new Promise<void>(r => (deletedSignal = r));
      const { log, warns } = captureLog();
      const run = backfillSearchIndex(db, log, {
        afterEachForTest: async noteId => {
          if (noteId !== first) return;
          await holder.query("begin");
          open = true;
          await holder.query("delete from notes where id = $1", [last]); // 未提交：持 notes(last) 列鎖
          deletedSignal();
        },
      });
      await deleted;
      expect(await waitForBlockedOrSettled(db.$client, run)).toBe("blocked");
      await holder.query("commit");
      open = false;
      const r = await run;
      expect(r).toMatchObject({ candidates: 2, done: 1, skipped: 1, failed: 0 });
      expect(warns).toEqual([]);
      expect(await bodies(db, first)).toEqual([`gone ${ids.indexOf(first)}`]);
    } finally {
      if (open) await holder.query("rollback");
      holder.release();
    }
  });
});

describe("S16 還原 runbook（spec §5.5）", () => {
  async function restored(variant: { bump: boolean; purge: boolean }) {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(body("before restore")), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(body("before restore")));
    const ydoc = Buffer.from(Y.encodeStateAsUpdate(searchDoc(body("restored content"))));
    await db.transaction(async tx => {
      await tx.execute(sql`update note_states set ydoc = ${ydoc}, version = version + ${variant.bump ? 1 : 0} where note_id = ${n.id}::uuid`);
      if (variant.purge) {
        await tx.execute(sql`delete from note_search_sections where note_id = ${n.id}::uuid`);
        await tx.execute(sql`delete from note_search_state where note_id = ${n.id}::uuid`);
      }
      await tx.execute(sql`update notes set links_clock = 0 where id = ${n.id}::uuid`);
    });
    await backfillSearchIndex(db, captureLog().log);
    return bodies(db, n.id);
  }
  it("版本 +1 且刪兩表（主步驟）→ 回填後是還原版", async () => {
    expect(await restored({ bump: true, purge: true })).toEqual(["restored content"]);
  });
  it("只刪不加版本 → 回填後同樣正確", async () => {
    expect(await restored({ bump: false, purge: true })).toEqual(["restored content"]);
  });
  it("只加版本不刪 → 回填後同樣正確", async () => {
    expect(await restored({ bump: true, purge: false })).toEqual(["restored content"]);
  });
  it("兩者都沒做 → 還原前的文字留在索引裡（docs/backup-restore.md 寫出的後果）", async () => {
    expect(await restored({ bump: false, purge: false })).toEqual(["before restore"]);
  });
});
