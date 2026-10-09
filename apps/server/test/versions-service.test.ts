import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { createVersionService, type VersionService } from "../src/collab/versions.js";
import { groups, noteVersions, notes, siteSettings, users } from "../src/db/schema.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { editPara, fakeHost, manualTimers, noteBase, paraDoc, versionsOf } from "./version-helpers.js";

const vfp = (d: Y.Doc) => versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));

async function setup(opts: { group?: boolean } = {}) {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const owner = opts.group ? { groupId: (await seedGroup(db, "G", [{ userId: u.id, role: "admin" }])).id } : { ownerId: u.id };
  const note = await seedNote(db, owner);
  const host = fakeHost();
  const clock = manualTimers();
  const warns: Array<{ obj: object; msg: string }> = [];
  const svc: VersionService = createVersionService({ db, log: { warn: (obj, msg) => warns.push({ obj, msg }) }, timers: clock.timers, idleMs: 50 });
  svc.bind(host);
  /** 把 doc 當成「載入中」：放進 host 並跑 noteLoaded。 */
  const load = async (doc: Y.Doc) => {
    host.docs.set(note.id, doc);
    await svc.noteLoaded(note.id, doc);
  };
  return { db, u, note, host, clock, warns, svc, load };
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

describe("idle 計時器與 hook 分派（§5.2）", () => {
  const humanCtx = (userId: string) => ({ userId });
  it("人的落盤 → 掛計時器；到期切版；期間再落盤則重設（只剩一顆）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    expect(s.clock.size()).toBe(1);
    s.clock.fire();
    await expect.poll(async () => (await versionsOf(s.db, s.note.id)).length).toBe(1);
  });

  it("autoEnabled=false → 不掛計時器", async () => {
    const s = await setup();
    await s.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const doc = paraDoc(["a"]);
    await s.load(doc);
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    expect(s.clock.size()).toBe(0);
  });

  it("到期時文件已不在 host → 不切", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    s.host.docs.delete(s.note.id);
    s.clock.fire();
    await new Promise(r => setTimeout(r, 50));
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
  });

  it("ai-edit 且 applied → 立即切（editors 含 agentLabel）並清計時器；applied=false 不切、照人的規則掛計時器（起草裁定 22）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    expect(s.clock.size()).toBe(0);
    await s.svc.noteStored(s.note.id, doc, { source: "ai-edit", userId: s.u.id, tokenId: null, agentLabel: "Claude", applied: false });
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(s.clock.size()).toBe(1); // 被拒的 AI 落盤取代了人那批 store：人的修改要靠這顆計時器切
    await s.svc.noteStored(s.note.id, doc, { source: "ai-edit", userId: s.u.id, tokenId: null, agentLabel: "Claude", applied: true });
    expect(s.clock.size()).toBe(0);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.editors)).toEqual([[{ user_id: s.u.id, agent_label: "Claude" }]]);
  });

  it("version-apply：不切；applied 時清計時器；被拒的照人的規則掛計時器（起草裁定 22）", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    expect(s.clock.size()).toBe(0);
    await s.svc.noteStored(s.note.id, doc, { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: false });
    expect(s.clock.size()).toBe(1);
    await s.svc.noteStored(s.note.id, doc, { source: "version-apply", userId: s.u.id, tokenId: null, agentLabel: null, applied: true });
    expect(s.clock.size()).toBe(0);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
  });

  it("beforeUnload：清計時器、有改就切；applying 中不切", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    editPara(doc, 0, t => t.insert(0, "x"));
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    s.svc.beginApply(s.note.id);
    await s.svc.beforeUnload(s.note.id, doc);
    expect(s.clock.size()).toBe(0);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    s.svc.endApply(s.note.id);
    await s.svc.beforeUnload(s.note.id, doc);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("forget 清計時器；close 清全部", async () => {
    const s = await setup();
    const doc = paraDoc(["a"]);
    await s.load(doc);
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    s.svc.forget(s.note.id);
    expect(s.clock.size()).toBe(0);
    await s.load(doc);
    await s.svc.noteStored(s.note.id, doc, humanCtx(s.u.id));
    s.svc.close();
    expect(s.clock.size()).toBe(0);
  });
});
