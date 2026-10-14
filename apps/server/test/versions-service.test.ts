import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { clearVersionBase, createVersionService, setVersionBase, type VersionService } from "../src/collab/versions.js";
import { resetNoteVersionsInTx } from "../src/notes/tx/versions.js";
import { groups, noteVersions, notes, siteSettings, users } from "../src/db/schema.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { NO_PENDING, baseVersionIdOf, editPara, fakeHost, noteBase, paraDoc, pendingOf, versionsOf } from "./version-helpers.js";

const vfp = (d: Y.Doc) => versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));

const T0 = Date.parse("2026-10-14T00:00:00.000Z");

async function setup(opts: { group?: boolean; autoWaitMs?: number } = {}) {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const owner = opts.group ? { groupId: (await seedGroup(db, "G", [{ userId: u.id, role: "admin" }])).id } : { ownerId: u.id };
  const note = await seedNote(db, owner);
  const host = fakeHost();
  const warns: Array<{ obj: object; msg: string }> = [];
  let nowMs = T0;
  const svc: VersionService = createVersionService({
    db,
    log: { warn: (obj, msg) => warns.push({ obj, msg }) },
    now: () => new Date(nowMs),
    ...(opts.autoWaitMs !== undefined ? { autoWaitMs: opts.autoWaitMs } : {}),
  });
  svc.bind(host);
  /** 把 doc 當成「載入中」：放進 host 並跑 noteLoaded。 */
  const load = async (doc: Y.Doc) => {
    host.docs.set(note.id, doc);
    await svc.noteLoaded(note.id, doc);
  };
  const setNow = (ms: number) => {
    nowMs = ms;
  };
  return { db, u, note, host, warns, svc, load, setNow };
}

describe("noteLoaded（§4.5）", () => {
  it("先同步抓 loadFingerprint 再讀 DB：await 期間文件被改，loadFingerprint 仍是呼叫當下那份", async () => {
    const s = await setup();
    const doc = paraDoc(["原文"]);
    const before = vfp(doc);
    s.host.docs.set(s.note.id, doc);
    const p = s.svc.noteLoaded(s.note.id, doc);
    editPara(doc, 0, t => t.insert(0, "改"));
    await p;
    expect(s.svc.debugState(s.note.id)).toMatchObject({ initialized: true, loadFingerprint: before, baseFingerprint: null, autoEnabled: true });
  });

  it("讀基底、空間鍵與 A13 開關：個人 u:<owner>；群組 g:<group>；站台關或空間關 → autoEnabled false", async () => {
    const s = await setup();
    await s.db.update(notes).set({ versionBaseSeq: 3, versionBaseFingerprint: "abc" }).where(eq(notes.id, s.note.id));
    await s.load(paraDoc(["x"]));
    expect(s.svc.debugState(s.note.id)).toMatchObject({ baseFingerprint: "abc", spaceKey: `u:${s.u.id}`, autoEnabled: true });
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    s.svc.forget(s.note.id);
    await s.load(paraDoc(["x"]));
    expect(s.svc.debugState(s.note.id)!.autoEnabled).toBe(false);

    const g = await setup({ group: true });
    await g.load(paraDoc(["x"]));
    const [row] = await g.db.select({ groupId: notes.groupId }).from(notes).where(eq(notes.id, g.note.id));
    expect(g.svc.debugState(g.note.id)!.spaceKey).toBe(`g:${row!.groupId}`);
    await g.db.update(siteSettings).set({ autoVersionsEnabled: false });
    g.svc.forget(g.note.id);
    await g.load(paraDoc(["x"]));
    expect(g.svc.debugState(g.note.id)!.autoEnabled).toBe(false);
    await g.db.update(siteSettings).set({ autoVersionsEnabled: true });
    await g.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, row!.groupId!));
    g.svc.forget(g.note.id);
    await g.load(paraDoc(["x"]));
    expect(g.svc.debugState(g.note.id)!.autoEnabled).toBe(false);
  });

  it("從 onLoadDocument 進來時 await 期間被 forget → 重來並初始化；rerun 模式則丟棄", async () => {
    const s = await setup();
    const doc = paraDoc(["x"]);
    s.host.docs.set(s.note.id, doc);
    const p = s.svc.noteLoaded(s.note.id, doc);
    s.svc.forget(s.note.id);
    await p;
    expect(s.svc.debugState(s.note.id)?.initialized).toBe(true);

    s.svc.forget(s.note.id);
    const r = s.svc.noteLoaded(s.note.id, doc, { rerun: true });
    s.svc.forget(s.note.id);
    await r;
    expect(s.svc.debugState(s.note.id)).toBeUndefined();
  });

  it("未初始化時 noteChanged 照記；初始化把結果併入同一個條目（editors 保留）", async () => {
    const s = await setup();
    const doc = paraDoc(["x"]);
    s.host.docs.set(s.note.id, doc);
    const p = s.svc.noteLoaded(s.note.id, doc);
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await p;
    expect(s.svc.debugState(s.note.id)).toMatchObject({ initialized: true, editors: [{ userId: s.u.id, agentLabel: null }] });
  });

  it("筆記已刪：條目標成已初始化但不自動切（auto-disabled、不 warn）", async () => {
    const s = await setup();
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    await s.load(paraDoc(["x"]));
    expect(await s.svc.cutIfDirty(s.note.id, s.host.docs.get(s.note.id)!, { kind: "auto" })).toEqual({ skipped: "auto-disabled" });
    expect(s.warns).toEqual([]);
  });
});

describe("noteChanged（§5.2）", () => {
  it("依 (userId, agentLabel) 去重、保留首次出現順序", async () => {
    const s = await setup();
    await s.load(paraDoc(["x"]));
    const u2 = "00000000-0000-4000-8000-000000000002";
    for (const who of [
      { userId: s.u.id, agentLabel: null }, { userId: u2, agentLabel: "Claude" }, { userId: s.u.id, agentLabel: null }, { userId: u2, agentLabel: null },
    ]) s.svc.noteChanged(s.note.id, who);
    expect(s.svc.debugState(s.note.id)!.editors).toEqual([
      { userId: s.u.id, agentLabel: null }, { userId: u2, agentLabel: "Claude" }, { userId: u2, agentLabel: null },
    ]);
  });
});

describe("cutIfDirty／isDirty（§5.3）", () => {
  it("未初始化 → { skipped: uninitialized }、isDirty true（Map 有條目但 noteLoaded 沒跑完）", async () => {
    const s = await setup();
    const doc = paraDoc(["x"]);
    s.host.docs.set(s.note.id, doc);
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null }); // 建出 initialized:false 條目
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toEqual({ skipped: "uninitialized" });
    expect(await s.svc.isDirty(s.note.id, doc)).toBe(true);
  });

  it("沒有基底：沒改 → null；打一字再刪 → null；改了 → 切 v1（editors＝待記名單 ∪ extra）且狀態更新", async () => {
    const s = await setup();
    const doc = paraDoc(["舊內容"]);
    await s.load(doc);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
    editPara(doc, 0, t => t.insert(0, "x"));
    editPara(doc, 0, t => t.delete(0, 1));
    expect(await s.svc.isDirty(s.note.id, doc)).toBe(false);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
    editPara(doc, 0, t => t.insert(0, "新"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    const out = await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto", extraEditors: [{ userId: s.u.id, agentLabel: "AI" }] });
    expect(out).toMatchObject({ upgraded: false, row: { seq: 1, kind: "auto", baseSeq: null, editors: [{ user_id: s.u.id, agent_label: null }, { user_id: s.u.id, agent_label: "AI" }] } });
    expect(await noteBase(s.db, s.note.id)).toEqual({ counter: 1, baseSeq: 1, baseFingerprint: vfp(doc) });
    expect(s.svc.debugState(s.note.id)).toMatchObject({ baseFingerprint: vfp(doc), editors: [] });
    const [v1] = await versionsOf(s.db, s.note.id);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, v1!.ydoc);
    expect(vfp(restored)).toBe(vfp(doc));
  });

  it("沒有基底且真空：自動不切；loadFingerprint 為 null（套用 reset 後）時非真空就算有改", async () => {
    const s = await setup();
    const vacuum = new Y.Doc();
    await s.load(vacuum);
    expect(vfp(vacuum)).toBe(VACUUM_VERSION_FINGERPRINT);
    expect(await s.svc.cutIfDirty(s.note.id, vacuum, { kind: "auto" })).toBeNull();

    const t = await setup();
    const doc = paraDoc(["內容"]);
    await t.load(doc);
    t.svc.endApply(t.note.id, { reset: true });
    expect(t.svc.debugState(t.note.id)!.loadFingerprint).toBeNull();
    expect(await t.svc.isDirty(t.note.id, doc)).toBe(true);
    expect(await t.svc.cutIfDirty(t.note.id, doc, { kind: "auto" })).toMatchObject({ row: { seq: 1 } });
  });

  it("暫時狀態（文件沒載入）：沒有基底時恆不 dirty、自動不切；手動照建；不進 Map", async () => {
    const s = await setup();
    const doc = paraDoc(["沒載入"]);
    expect(await s.svc.isDirty(s.note.id, doc, doc)).toBe(false);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto", transient: doc })).toBeNull();
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "里程碑", transient: doc })).toMatchObject({ upgraded: false, row: { seq: 1, kind: "manual", name: "里程碑" } });
    expect(s.svc.debugState(s.note.id)).toBeUndefined();
    expect(await s.svc.isDirty(s.note.id, doc, doc)).toBe(false); // 有基底了，與基底相同
  });

  it("base_seq 四況：首版 null；基底＝最新 → null；基底≠最新（套用舊版後）→ 填基底；之後回到 null", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const cut = async (text: string) => {
      editPara(doc, 0, t => t.insert(0, text));
      return s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    };
    expect(await cut("1")).toMatchObject({ row: { seq: 1, baseSeq: null } });
    expect(await cut("2")).toMatchObject({ row: { seq: 2, baseSeq: null } });
    const [v1] = await versionsOf(s.db, s.note.id);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1!.ydoc);
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: vfp(v1doc) }).where(eq(notes.id, s.note.id));
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) }); // 模擬套用 v1 後（內容細節由 Task 8 驗）
    expect(await cut("3")).toMatchObject({ row: { seq: 3, baseSeq: 1 } });
    expect(await cut("4")).toMatchObject({ row: { seq: 4, baseSeq: null } });
  });

  it("#272 案 23：新列 base_version_id 與 base_seq 同填／同 NULL；notes.version_base_version_id 跟著切版、setVersionBase、clearVersionBase、reset", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const cut = async (text: string) => {
      editPara(doc, 0, t => t.insert(0, text));
      return s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    };
    await cut("1");
    await cut("2");
    const [v1, v2] = await versionsOf(s.db, s.note.id);
    expect([v1!.baseVersionId, v2!.baseVersionId]).toEqual([null, null]);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(v2!.id);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1!.ydoc);
    expect(await setVersionBase(s.db, s.note.id, 1, vfp(v1doc), v1!.id)).toBe(true);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(v1!.id);
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) }); // 模擬套用 v1 後
    await cut("3");
    const v3 = (await versionsOf(s.db, s.note.id))[2]!;
    expect([v3.baseSeq, v3.baseVersionId]).toEqual([1, v1!.id]);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBe(v3.id);
    // 切版當下基底列已不存在 → base_seq 與 base_version_id 都不填（Task 14b 規則，spec §15-2）
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: vfp(v1doc), versionBaseVersionId: v1!.id }).where(eq(notes.id, s.note.id));
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) });
    await s.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`);
    await cut("4");
    const v4 = (await versionsOf(s.db, s.note.id)).at(-1)!;
    expect([v4.seq, v4.baseSeq, v4.baseVersionId]).toEqual([4, null, null]);
    await clearVersionBase(s.db, s.note.id);
    expect(await baseVersionIdOf(s.db, s.note.id)).toBeNull();
    await s.db.update(notes).set({ versionBaseSeq: 4, versionBaseFingerprint: "x", versionBaseVersionId: v4.id }).where(eq(notes.id, s.note.id));
    await s.db.transaction(tx => resetNoteVersionsInTx(tx, { noteId: s.note.id }));
    expect(await baseVersionIdOf(s.db, s.note.id)).toBeNull();
  });

  it("RF5：刪掉最新的非基底版後再切——依剩下的最新判斷，配號不重用", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2", "3"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    const [v1] = await versionsOf(s.db, s.note.id);
    const v1doc = new Y.Doc();
    Y.applyUpdate(v1doc, v1!.ydoc);
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: vfp(v1doc) }).where(eq(notes.id, s.note.id));
    s.svc.endApply(s.note.id, { seq: 1, fingerprint: vfp(v1doc) });
    await s.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq in (2, 3)`);
    editPara(doc, 0, t => t.insert(0, "4"));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toMatchObject({ row: { seq: 4, baseSeq: null } });
  });

  it("交易內基底指紋或空間鍵與記憶體不同 → null、不建列、以交易內的值回寫狀態", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.db.update(notes).set({ versionBaseSeq: 9, versionBaseFingerprint: "other" }).where(eq(notes.id, s.note.id));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull();
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(s.svc.debugState(s.note.id)!.baseFingerprint).toBe("other");

    const g = await seedGroup(s.db, "H", [{ userId: s.u.id, role: "admin" }]);
    await s.db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, s.note.id));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toBeNull();
    expect(s.svc.debugState(s.note.id)!.spaceKey).toBe(`g:${g.id}`);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
  });

  it("手動且內容與基底相同 → upgraded:true，基底那版轉手動、套名稱，不新增列；名稱 null 保留原名", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "定稿" })).toMatchObject({ upgraded: true, row: { seq: 1, kind: "manual", name: "定稿" } });
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: null })).toMatchObject({ upgraded: true, row: { seq: 1, name: "定稿" } });
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toBeNull(); // 自動遇到相同 → null
  });

  it("applying／auto-disabled 只擋自動；isDirty 不看 applying", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.beginApply(s.note.id);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toEqual({ skipped: "applying" });
    expect(await s.svc.isDirty(s.note.id, doc)).toBe(true);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toMatchObject({ row: { seq: 1 } });
    s.svc.endApply(s.note.id);
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    s.svc.forget(s.note.id);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "y"));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" })).toEqual({ skipped: "auto-disabled" });
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toMatchObject({ row: { seq: 2 } });
  });

  it("beginApply 在載入前就記下：noteLoaded 取 applyingSet 的值", async () => {
    const s = await setup();
    s.svc.beginApply(s.note.id);
    await s.load(paraDoc(["a"]));
    expect(s.svc.debugState(s.note.id)!.applying).toBe(true);
    s.svc.endApply(s.note.id);
    expect(s.svc.debugState(s.note.id)!.applying).toBe(false);
  });

  it("筆記已刪（暫時狀態與 Map 狀態兩形）→ { skipped: note-deleted }", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual" })).toEqual({ skipped: "note-deleted" });
    s.svc.forget(s.note.id);
    s.host.docs.delete(s.note.id);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", transient: doc })).toEqual({ skipped: "note-deleted" });
  });

  it("文件已載入但 Map 沒條目（§9 空窗期）→ uninitialized，即使帶了 transient", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    s.host.docs.set(s.note.id, doc);
    expect(await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", transient: doc })).toEqual({ skipped: "uninitialized" });
  });
});

describe("relocated／forget（§9）", () => {
  it("relocated：載入中的筆記立刻有 initialized:false 條目，重跑 noteLoaded 後以新空間初始化；沒載入的只清掉", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    const g = await seedGroup(s.db, "H", [{ userId: s.u.id, role: "admin" }]);
    await s.db.update(notes).set({ ownerId: null, groupId: g.id }).where(eq(notes.id, s.note.id));
    s.svc.relocated([s.note.id]);
    expect(s.svc.debugState(s.note.id)).toMatchObject({ initialized: false, editors: [] });
    await expect.poll(() => s.svc.debugState(s.note.id)?.initialized).toBe(true);
    expect(s.svc.debugState(s.note.id)!.spaceKey).toBe(`g:${g.id}`);
    s.host.docs.delete(s.note.id);
    s.svc.relocated([s.note.id]);
    expect(s.svc.debugState(s.note.id)).toBeUndefined();
  });
});

describe("docFor／currentOf", () => {
  it("沒載入：讀 note_states 當暫時文件；current 帶 baseSeq、nextSeq、dirty、autoEnabled（讀 DB）", async () => {
    const s = await setup();
    const stored = paraDoc(["DB 裡的"]);
    await seedDoc(s.db, s.note.id, stored);
    const { doc, transient } = await s.svc.docFor(s.note.id);
    expect(transient).toBe(doc);
    expect(vfp(doc)).toBe(vfp(stored));
    expect(await s.svc.currentOf(s.note.id)).toEqual({ baseSeq: null, dirty: false, nextSeq: 1, autoEnabled: true });
  });

  it("載入中：用活文件；autoEnabled 取這個載入週期的值（A13：DB 改了不影響）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    expect((await s.svc.docFor(s.note.id)).doc).toBe(doc);
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    expect(await s.svc.currentOf(s.note.id)).toEqual({ baseSeq: null, dirty: false, nextSeq: 1, autoEnabled: true });
    editPara(doc, 0, t => t.insert(0, "x"));
    expect((await s.svc.currentOf(s.note.id))!.dirty).toBe(true);
  });

  it("筆記不存在 → currentOf null", async () => {
    const s = await setup();
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    expect(await s.svc.currentOf(s.note.id)).toBeNull();
  });
});

describe("pruneNote／sweep（§10.2）", () => {
  it("切版後清除：依 F／D 刪自動版本，留手動、基底、最新；改名成手動的不刪", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2", "3", "4"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    // 把 v1–v3 推到 60 天前的同一週；v2 改名成手動。
    await s.db.execute(sql`update note_versions set created_at = timestamptz '2026-08-01T10:00:00Z' + (seq || ' minutes')::interval where note_id = ${s.note.id} and seq <= 3`);
    await s.db.update(noteVersions).set({ kind: "manual", name: "留" }).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 2`);
    expect(await s.svc.pruneNote(s.note.id, new Date("2026-10-09T12:00:00Z"))).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2, 3, 4]); // v1 與 v3 同週、v3 較新
  });

  it("sweep：游標續掃、一輪 0 筆就歸零（批次 100；250 篇的版本由 Task 13 驗）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    for (const ch of ["1", "2", "3"]) {
      editPara(doc, 0, t => t.insert(0, ch));
      await s.svc.cutIfDirty(s.note.id, doc, { kind: "auto" });
    }
    await s.db.execute(sql`update note_versions set created_at = timestamptz '2026-08-01T10:00:00Z' + (seq || ' minutes')::interval where note_id = ${s.note.id} and seq <= 2`);
    const now = new Date("2026-10-09T12:00:00Z");
    expect(await s.svc.sweep(now)).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
    expect(await s.svc.sweep(now)).toBe(0); // 游標在這篇之後 → 0 筆 → 游標歸零
    // 歸零後重掃：v2 仍是「自動且早於界線」，所以這篇又被掃到（回 1＝掃到幾篇，不是刪幾列）；v2 是它那週唯一的候選，不刪。
    expect(await s.svc.sweep(now)).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
  });
});

describe("#272 待切寫入（noteStored，spec §6）", () => {
  const human = (userId: string) => ({ userId });
  const asJson = (userId: string, agentLabel: string | null = null) => ({ user_id: userId, agent_label: agentLabel });
  const direct = (source: "ai-edit" | "version-apply", userId: string, agentLabel: string | null, applied: boolean) =>
    ({ source, userId, tokenId: null, agentLabel, applied });

  it("案 1：人落盤、指紋改變 → version_pending_at＝注入的 now、editors＝[人]、ref＝載入時指紋、緩衝清空、不出版", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const loaded = vfp(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toEqual({ at: new Date(T0), editors: [asJson(s.u.id)], ref: loaded });
    expect(s.svc.debugState(s.note.id)).toMatchObject({ editors: [], lastStoredFingerprint: vfp(doc) });
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
  });

  it("案 2：同指紋再落盤 → version_pending_at 不變（零 DB）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    s.setNow(T0 + 60_000);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });

  it("案 3：兩次落盤不同編輯者 → 先到先排、去重；跨 forget＋noteLoaded 同一人不重複", async () => {
    const s = await setup();
    const u2 = await seedUser(s.db);
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "1"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    editPara(doc, 0, t => t.insert(0, "2"));
    s.svc.noteChanged(s.note.id, { userId: u2.id, agentLabel: null });
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    s.setNow(T0 + 1000);
    await s.svc.noteStored(s.note.id, doc, human(u2.id));
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([asJson(s.u.id), asJson(u2.id)]);
    s.svc.forget(s.note.id);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "3"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    s.setNow(T0 + 2000);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toMatchObject({ at: new Date(T0 + 2000), editors: [asJson(s.u.id), asJson(u2.id)] });
  });

  it("案 4：ai-edit applied → 待切 editors 含 {userId, agentLabel}、不出版；applied=false 同人的落盤（寫入者不進名單，起草裁定 22）", async () => {
    const s = await setup();
    const u2 = await seedUser(s.db);
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "AI"));
    await s.svc.noteStored(s.note.id, doc, direct("ai-edit", s.u.id, "Claude", true));
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([asJson(s.u.id, "Claude")]);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    editPara(doc, 0, t => t.insert(0, "人"));
    s.svc.noteChanged(s.note.id, { userId: u2.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, direct("ai-edit", s.u.id, "被拒的", false));
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([asJson(s.u.id, "Claude"), asJson(u2.id)]);
  });

  it("案 5：version-apply applied → 清待切、套用後的內容不算一次變動；被拒（applied=false）同人的落盤", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
    editPara(doc, 0, t => t.insert(0, "套"));
    await s.svc.noteStored(s.note.id, doc, direct("version-apply", s.u.id, null, true));
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(s.svc.debugState(s.note.id)!.lastStoredFingerprint).toBe(vfp(doc));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    editPara(doc, 0, t => t.insert(0, "y"));
    await s.svc.noteStored(s.note.id, doc, direct("version-apply", s.u.id, null, false));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });

  it("案 5（reset 子案）：beginApply → endApply(id, {reset}) 之後、外層 endApply(id) 之前，到期的待切 → skipped: applying、0 版；外層 endApply(id) 之後才切", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    s.svc.beginApply(s.note.id);
    s.svc.endApply(s.note.id, { reset: true });
    expect(s.svc.debugState(s.note.id)!.applying).toBe(true);
    expect(await s.svc.scanDue(new Date(T0 + 1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
    s.svc.endApply(s.note.id);
    expect(s.svc.debugState(s.note.id)!.applying).toBe(false);
    expect(await s.svc.scanDue(new Date(T0 + 2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("案 6：自動關閉 → 不待切、緩衝保留（留給手動儲存）；未初始化 → 不待切", async () => {
    const s = await setup();
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(s.svc.debugState(s.note.id)!.editors).toEqual([{ userId: s.u.id, agentLabel: null }]);

    const t = await setup();
    const d2 = paraDoc(["b"]);
    t.host.docs.set(t.note.id, d2);
    t.svc.noteChanged(t.note.id, { userId: t.u.id, agentLabel: null }); // 建出 initialized:false 條目
    editPara(d2, 0, x => x.insert(0, "y"));
    await t.svc.noteStored(t.note.id, d2, human(t.u.id));
    expect(await pendingOf(t.db, t.note.id)).toEqual(NO_PENDING);
  });

  it("案 8：markPending 丟錯 → noteStored 往上拋（server.ts 吞掉只 warn）、lastStoredFingerprint 不前進 → 下一次落盤補寫", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    const loaded = vfp(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    const spy = vi.spyOn(s.db, "execute").mockRejectedValueOnce(new Error("pg 斷線（測試）"));
    await expect(s.svc.noteStored(s.note.id, doc, human(s.u.id))).rejects.toThrow("pg 斷線（測試）");
    spy.mockRestore();
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(s.svc.debugState(s.note.id)!.lastStoredFingerprint).toBe(loaded);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id));
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });

  it("案 9：relocated 重跑的空窗內落盤 → 下一次落盤算成變動（lastStoredFingerprint 取自 await 之前）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    s.svc.relocated([s.note.id]); // 同步：forget＋空白條目＋重跑 noteLoaded（同步段已取好 actual）
    editPara(doc, 0, t => t.insert(0, "x")); // 空窗內的修改
    await s.svc.noteStored(s.note.id, doc, human(s.u.id)); // 條目未初始化 → 不寫
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    await expect.poll(() => s.svc.debugState(s.note.id)?.initialized).toBe(true);
    await s.svc.noteStored(s.note.id, doc, human(s.u.id)); // 沒有新修改，但空窗那次沒被記到
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(new Date(T0));
  });
});
