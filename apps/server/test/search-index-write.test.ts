/**
 * #93 §5.1／§5.2：索引寫入交易（S3、S4、S5、S10 一般路徑、S12、RF5）。
 * 被測方一律是真的 `writeSearchIndex`；holder 只扮演「另一方」（DELETE、note_states 改寫）。
 */
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { buildTestApp, freshDb } from "./helpers.js";
import { cookieOf, seedNote, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { noteSearchState } from "../src/db/schema.js";
import { bumpSearchIndexVersion, writeSearchIndex } from "../src/notes/search-index.js";
import { searchDoc } from "./search-doc.js";
import { captureLog, extractOf, indexRows, makeGate, seedNoteState, setNoteState, stateRow } from "./search-helpers.js";

const V1 = [{ id: "p", text: "version one alpha" }];
const V2 = [{ id: "p", text: "version two bravo" }];
const heads = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `h${i}`, type: "heading", text: `h${i}` }));

describe("S3／S4：首建與版本", () => {
  it("S3：同一篇以 Promise.all 同時首建兩次 → 每個 section_id 恰一列、狀態列一列", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const blocks = [{ id: "p", text: "top" }, { id: "h", type: "heading", text: "H" }, { id: "q", text: "body" }];
    await seedNoteState(db, n.id, searchDoc(blocks), 1);
    const ex = extractOf(blocks);
    const out = await Promise.all([writeSearchIndex(db, n.id, 1, ex), writeSearchIndex(db, n.id, 1, ex)]);
    expect(out.sort()).toEqual(["unchanged", "written"]);
    expect((await indexRows(db, n.id)).map(r => r.sectionId)).toEqual(["_top", "h"]);
    expect(await db.select().from(noteSearchState).where(eq(noteSearchState.noteId, n.id))).toHaveLength(1);
  });

  it("S4：以舊 sourceVersion 呼叫 → stale、表不變、首建時沒有殘留狀態列", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V2), 2);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(V1))).toBe("stale");
    expect(await stateRow(db, n.id)).toBeUndefined();
    expect(await indexRows(db, n.id)).toEqual([]);
  });

  it("沒有 note_states 列 → stale；筆記不存在 → gone", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    expect(await writeSearchIndex(db, n.id, 1, extractOf(V1))).toBe("stale");
    expect(await writeSearchIndex(db, "00000000-0000-4000-8000-0000000000aa", 1, extractOf(V1))).toBe("gone");
  });

  it("同內容同版本以外的新版本 → unchanged 只推進 source_version；內容變 → written 替換整篇", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(V1))).toBe("written");
    await setNoteState(db, n.id, searchDoc(V1), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V1))).toBe("unchanged");
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
    await setNoteState(db, n.id, searchDoc(V2), 3);
    expect(await writeSearchIndex(db, n.id, 3, extractOf(V2))).toBe("written");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 3, indexedUnits: "version two bravo".length, capped: false });
  });

  it("RF5：空內容（0 列）→ written、狀態列一列、0 個 section 列、indexed_units 0、不 capped；之後有內容也照寫", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const empty = [{ id: "p" }, { id: "q" }];
    await seedNoteState(db, n.id, searchDoc(empty), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(empty))).toBe("written");
    expect(await indexRows(db, n.id)).toEqual([]);
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 1, indexedUnits: 0, capped: false });
    await setNoteState(db, n.id, searchDoc(V1), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V1))).toBe("written");
    expect(await indexRows(db, n.id)).toHaveLength(1);
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 2, indexedUnits: "version one alpha".length, capped: false });
  });

  it("2001 個 heading → 2000 列（4 句 INSERT）寫得進去、ord 連續、狀態列 capped 且 indexed_units 等於列 body 合計", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    const blocks = heads(2001);
    await seedNoteState(db, n.id, searchDoc(blocks), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(blocks))).toBe("written");
    const rows = await indexRows(db, n.id);
    expect(rows).toHaveLength(2000);
    expect(rows.at(-1)!.ord).toBe(2000);
    const units = rows.reduce((s, r) => s + r.body.length, 0);
    expect(units).toBeGreaterThan(0);
    expect(await stateRow(db, n.id)).toMatchObject({ indexedUnits: units, capped: true });
  });

  it("I-1：rows 不變、只有 capped 翻轉 → written（不是 unchanged），狀態列 capped 跟著變（2000↔2001 段；空筆記→含空 id container）", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(heads(2000)), 1);
    expect(await writeSearchIndex(db, n.id, 1, extractOf(heads(2000)))).toBe("written");
    expect(await stateRow(db, n.id)).toMatchObject({ capped: false });
    await setNoteState(db, n.id, searchDoc(heads(2001)), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(heads(2001)))).toBe("written");
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 2, capped: true });
    await setNoteState(db, n.id, searchDoc(heads(2000)), 3);
    expect(await writeSearchIndex(db, n.id, 3, extractOf(heads(2000)))).toBe("written");
    expect(await stateRow(db, n.id)).toMatchObject({ sourceVersion: 3, capped: false });

    const m = await seedNote(db, { ownerId: u.id });
    const empty = [{ id: "p" }];
    const badId = [{ id: "p" }, { id: "", text: "x" }];
    await seedNoteState(db, m.id, searchDoc(empty), 1);
    expect(await writeSearchIndex(db, m.id, 1, extractOf(empty))).toBe("written");
    await setNoteState(db, m.id, searchDoc(badId), 2);
    expect(await writeSearchIndex(db, m.id, 2, extractOf(badId))).toBe("written");
    expect(await indexRows(db, m.id)).toEqual([]);
    expect(await stateRow(db, m.id)).toMatchObject({ sourceVersion: 2, indexedUnits: 0, capped: true });
  });
});

describe("S5：與刪筆記的鎖序", () => {
  it("索引交易持狀態列鎖期間 DELETE /api/notes/:id → DELETE 卡在 notes 列、放行後 204，兩表無該篇列", async () => {
    const { app, db } = await buildTestApp();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(V1)); // 狀態列已存在：第 2 步的 ON CONFLICT DO NOTHING 不觸發 FK 檢查
    await setNoteState(db, n.id, searchDoc(V2), 2);
    const gate = makeGate();
    // 停在第 3 步之後＝已持 notes KEY SHARE 與狀態列 FOR UPDATE（plan 裁定）：拿掉第 1 步時，本交易持狀態列鎖、DELETE 持 notes 列，
    // DELETE 的 cascade 已鎖住 sections 列、等狀態列；放行後第 5 步刪 sections 列等 DELETE——走到真正的環（突變 M3 實測：40P01，
    // 環閉合在 `delete from note_search_sections`，DELETE 回 500）。停在第 2 步之前也紅得了（不持鎖 → DELETE 不被擋 → "settled"），
    // 但那只證明「沒擋住」，沒走到上面 M3 實測的死結路徑。
    const w = writeSearchIndex(db, n.id, 2, extractOf(V2), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    const del = app.inject({ method: "DELETE", url: `/api/notes/${n.id}`, cookies: await cookieOf(u.id) });
    expect(await waitForBlockedOrSettled(db.$client, del)).toBe("blocked");
    gate.open();
    expect(await w).toBe("written");
    expect((await del).statusCode).toBe(204);
    expect(await indexRows(db, n.id)).toEqual([]);
    expect(await stateRow(db, n.id)).toBeUndefined();
  });

  it("反向：刪除先持 notes 列 → 索引交易卡在第 1 步，刪除提交後回 gone", async () => {
    const { db, url } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    const holder = new pg.Client({ connectionString: url });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("delete from notes where id = $1", [n.id]);
      const w = writeSearchIndex(db, n.id, 1, extractOf(V1));
      expect(await waitForBlockedOrSettled(db.$client, w)).toBe("blocked");
      await holder.query("commit");
      expect(await w).toBe("gone");
    } finally {
      await holder.end();
    }
    expect(await stateRow(db, n.id)).toBeUndefined(); // 佔位列隨 rollback 消失（gone 走例外）
  });
});

describe("S12：回填與即時落盤交錯（兩個具名停點）", () => {
  it("案 A（beforeStateLockForTest）：回填 B 停在拿狀態列鎖之前；即時落盤寫 V+1 並完成索引；放行 B → stale、表內是 V+1；之後同內容的 bump 不改變結果", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    const gate = makeGate();
    const b = writeSearchIndex(db, n.id, 1, extractOf(V1), { hooks: { beforeStateLockForTest: gate.wait } });
    await gate.reached;
    await setNoteState(db, n.id, searchDoc(V2), 2);
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V2))).toBe("written"); // L：B 只持 KEY SHARE，L 不被擋
    gate.open();
    expect(await b).toBe("stale");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    await setNoteState(db, n.id, searchDoc(V2), 3);
    expect(await bumpSearchIndexVersion(db, n.id, 3, extractOf(V2).contentHash)).toBe(1);
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(3);
  });

  it("案 B（afterVersionReadForTest）：B 已持狀態列鎖並讀到 V；即時落盤寫 V+1，其索引交易 L 卡在第 2 步；放行 B → B 寫 V、L 隨後寫 V+1", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    const gate = makeGate();
    const b = writeSearchIndex(db, n.id, 1, extractOf(V1), { hooks: { afterVersionReadForTest: gate.wait } });
    await gate.reached;
    await setNoteState(db, n.id, searchDoc(V2), 2);
    const l = writeSearchIndex(db, n.id, 2, extractOf(V2));
    expect(await waitForBlockedOrSettled(db.$client, l)).toBe("blocked");
    gate.open();
    expect(await b).toBe("written");
    expect(await l).toBe("written");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
  });

  it("案 C（m1）：note_states.version 被往回寫（小於狀態列 source_version）→ 照寫、warn 一行", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 5);
    await writeSearchIndex(db, n.id, 5, extractOf(V1));
    await setNoteState(db, n.id, searchDoc(V2), 2); // 應用以外的手動 SQL（沒照 runbook 刪索引）
    const { log, warns } = captureLog();
    expect(await writeSearchIndex(db, n.id, 2, extractOf(V2), { log })).toBe("written");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version two bravo"]);
    expect(warns).toHaveLength(1);
    expect(warns[0]!.obj).toMatchObject({ noteId: n.id, stateSourceVersion: 5, noteStateVersion: 2 });
  });
});

describe("S10 一般寫入路徑的 rollback（m-X6）", () => {
  it("afterWriteForTest 在 INSERT 與狀態列 UPDATE 之後丟例外 → 例外冒出、舊的索引列與狀態列原樣", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(V1));
    const before = await stateRow(db, n.id);
    await setNoteState(db, n.id, searchDoc(V2), 2);
    const boom = async (): Promise<void> => { throw new Error("after-write boom"); };
    await expect(writeSearchIndex(db, n.id, 2, extractOf(V2), { hooks: { afterWriteForTest: boom } })).rejects.toThrow("after-write boom");
    expect((await indexRows(db, n.id)).map(r => r.body)).toEqual(["version one alpha"]);
    expect(await stateRow(db, n.id)).toEqual(before);
  });
});

describe("bumpSearchIndexVersion（§5.2）", () => {
  it("只在 hash／extractor 相符且 source_version 較小時推進；不符回 0", async () => {
    const { db } = await freshDb();
    const u = await seedUser(db);
    const n = await seedNote(db, { ownerId: u.id });
    await seedNoteState(db, n.id, searchDoc(V1), 1);
    await writeSearchIndex(db, n.id, 1, extractOf(V1));
    const h = extractOf(V1).contentHash;
    expect(await bumpSearchIndexVersion(db, n.id, 2, "deadbeef")).toBe(0);
    expect(await bumpSearchIndexVersion(db, n.id, 1, h)).toBe(0);
    expect(await bumpSearchIndexVersion(db, n.id, 2, h)).toBe(1);
    expect((await stateRow(db, n.id))!.sourceVersion).toBe(2);
    await db.execute(sql`update note_search_state set extractor_version = 0 where note_id = ${n.id}::uuid`);
    expect(await bumpSearchIndexVersion(db, n.id, 3, h)).toBe(0);
  });
});
