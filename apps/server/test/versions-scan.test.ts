// #272 待切與掃描器（spec 2026-10-13-version-autosave-idle-design.md §6.3、§7.2–§7.3；§12.1 案 7、10–18、20、22（markPending 的空間述詞）；
// Review Focus RF2、RF3、RF5）。服務直接建（fakeHost、不起 Hocuspocus）；待切一律以 `markPending` 寫入，不經 noteStored（Task 3 才接線）。
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import {
  VERSION_AUTO_SCAN_BACKOFF_MS, VERSION_AUTO_SCAN_BATCH, clearPendingIfDue, createVersionService, markPending,
  type VersionService, type VersionServiceDeps,
} from "../src/collab/versions.js";
import { groups, notes, siteSettings } from "../src/db/schema.js";
import { VACUUM_VERSION_FINGERPRINT, versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { seedGroup, seedNote, seedUser } from "./group-helpers.js";
import { freshDb } from "./helpers.js";
import { NO_PENDING, editPara, fakeHost, paraDoc, pendingOf, versionsOf } from "./version-helpers.js";

// 案 14 的「指紋算不出來」：版本指紋本身刻意不丟例外（`version-fingerprint.ts` 檔頭 (3)），所以只對含哨兵字串的文件讓它丟錯；
// 其他文件照原本的實作算（含本檔的 `vfp`）。
vi.mock("../src/notes/version-fingerprint.js", async importOriginal => {
  const real = await importOriginal<typeof import("../src/notes/version-fingerprint.js")>();
  return {
    ...real,
    versionFingerprint: (f: Y.XmlFragment) => {
      if (f.toString().includes("指紋炸彈")) throw new Error("指紋炸彈（測試）");
      return real.versionFingerprint(f);
    },
  };
});

const vfp = (d: Y.Doc) => versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));
const T0 = Date.parse("2026-10-14T00:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (ms: number) => new Date(T0 + ms);

async function setup(deps: Partial<VersionServiceDeps> = {}) {
  const { db } = await freshDb();
  const u = await seedUser(db);
  const note = await seedNote(db, { ownerId: u.id });
  const host = fakeHost();
  const warns: Array<{ obj: object; msg: string }> = [];
  const mk = (extra: Partial<VersionServiceDeps> = {}): VersionService => {
    const svc = createVersionService({ db, log: { warn: (obj, msg) => warns.push({ obj, msg }) }, ...deps, ...extra });
    svc.bind(host);
    return svc;
  };
  const svc = mk();
  const space = `u:${u.id}`;
  const me = { user_id: u.id, agent_label: null };
  /** 沒載入的筆記：把 note_states 設成這份內容（掃描器以 `docFor` 讀它）。每篇只能呼叫一次（seedDoc 是 INSERT）。 */
  const store = async (noteId: string, texts: string[]) => {
    const d = paraDoc(texts);
    await seedDoc(db, noteId, d);
    return d;
  };
  /** 寫一段待切（時刻 `when`、編輯者 `who`、無基底時的參考指紋 `ref`、空間鍵 `sp`）。 */
  const pend = (noteId: string, when: Date, who: Array<{ user_id: string; agent_label: string | null }> = [me], ref: string | null = null, sp = space) =>
    markPending(db, { noteId, at: when, add: who, ref, spaceKey: sp });
  const warnsWith = (needle: string) => warns.filter(w => w.msg.includes(needle)).length;
  return { db, u, note, host, warns, warnsWith, svc, mk, space, me, store, pend };
}

describe("markPending／clearPendingIfDue（§6.3、§7.3）", () => {
  it("案 7：沒有基底時 ref 只在待切開始寫、同段不覆寫；清掉再開一段才換；有基底時 ref 一律 NULL；編輯者先到先排、去重", async () => {
    const s = await setup();
    const claude = { user_id: s.u.id, agent_label: "Claude" };
    expect(await s.pend(s.note.id, at(0), [s.me], "ref-1")).toBe(1);
    expect(await s.pend(s.note.id, at(1000), [claude, s.me], "ref-2")).toBe(1);
    expect(await pendingOf(s.db, s.note.id)).toEqual({ at: at(1000), editors: [s.me, claude], ref: "ref-1" });
    expect(await clearPendingIfDue(s.db, s.note.id, at(1000))).toBe(1);
    await s.pend(s.note.id, at(2000), [s.me], "ref-3");
    expect((await pendingOf(s.db, s.note.id)).ref).toBe("ref-3");
    const based = await seedNote(s.db, { ownerId: s.u.id });
    await s.db.update(notes).set({ versionBaseSeq: 1, versionBaseFingerprint: "fp" }).where(eq(notes.id, based.id));
    await s.pend(based.id, at(0), [s.me], "ref-x");
    expect((await pendingOf(s.db, based.id)).ref).toBeNull();
  });

  it("案 13：clearPendingIfDue 只清「仍到期」的那一段，不清較新的", async () => {
    const s = await setup();
    await s.pend(s.note.id, at(5 * MIN));
    expect(await clearPendingIfDue(s.db, s.note.id, at(5 * MIN - 1))).toBe(0);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(5 * MIN));
    expect(await clearPendingIfDue(s.db, s.note.id, at(5 * MIN))).toBe(1);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("案 22（空間述詞）：空間鍵對不上（搬家／轉移後才落地的舊落盤）→ 0 列；不是 u:／g: 形 → 0 列", async () => {
    const s = await setup();
    const g = await seedGroup(s.db, "G", [{ userId: s.u.id, role: "admin" }]);
    expect(await s.pend(s.note.id, at(0), [s.me], null, `g:${g.id}`)).toBe(0);
    expect(await s.pend(s.note.id, at(0), [s.me], null, "")).toBe(0);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(await s.pend(s.note.id, at(0))).toBe(1);
  });

  it("RF3：agent 名稱含雙引號、反斜線、emoji、CJK，同一人不同 agent → 去重逐字正確；切出的那一版 editors 與名單一致", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const list = [`Cl"aude \\ 🤖`, "助手（測試）", "a'b"].map(l => ({ user_id: s.u.id, agent_label: l }));
    await s.store(s.note.id, ["特殊字元名單"]);
    await s.pend(s.note.id, at(0), [list[0]!, list[1]!, list[0]!], VACUUM_VERSION_FINGERPRINT);
    await s.pend(s.note.id, at(1), [list[1]!, s.me, list[2]!]);
    expect((await pendingOf(s.db, s.note.id)).editors).toEqual([list[0], list[1], s.me, list[2]]);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.editors)).toEqual([[list[0], list[1], s.me, list[2]]]);
  });
});

describe("掃描器 scanDue（§7.2–§7.3）", () => {
  it("案 10：未到期不切；到期且 dirty → 1 版、editors＝待切編輯者、待切同交易清空", async () => {
    const s = await setup({ autoWaitMs: 5 * MIN });
    const claude = { user_id: s.u.id, agent_label: "Claude" };
    await s.store(s.note.id, ["掃描切的內容"]);
    await s.pend(s.note.id, at(0), [s.me, claude], VACUUM_VERSION_FINGERPRINT);
    expect(await s.svc.scanDue(at(5 * MIN - 1))).toBe(0);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(await s.svc.scanDue(at(5 * MIN))).toBe(1);
    expect((await versionsOf(s.db, s.note.id)).map(v => [v.seq, v.kind, v.editors])).toEqual([[1, "auto", [s.me, claude]]]);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("案 11：改了又改回（內容＝參考指紋）→ 0 版、清待切", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const d = await s.store(s.note.id, ["原文"]);
    await s.pend(s.note.id, at(0), [s.me], vfp(d));
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("案 12：掃描查詢之後、交易之前又有新的落盤（afterMetaRead）→ not-due、0 版、新的待切保留；新的那段到期後照切", async () => {
    let inserted = false;
    const s = await setup();
    const svc = s.mk({
      autoWaitMs: 0,
      testHooks: {
        afterMetaRead: async id => {
          if (inserted) return;
          inserted = true;
          await markPending(s.db, { noteId: id, at: at(10 * MIN), add: [s.me], ref: null, spaceKey: s.space });
        },
      },
    });
    await s.store(s.note.id, ["內容"]);
    await s.pend(s.note.id, at(0));
    expect(await svc.scanDue(at(1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(10 * MIN));
    expect(await svc.scanDue(at(10 * MIN))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("案 14：套用中 → 留著（套用結束後切）；自動關閉 → 清、0 版；指紋算不出來 → 清＋warn；筆記已刪 → 略過、不 warn", async () => {
    const s = await setup({ autoWaitMs: 0 });
    await s.store(s.note.id, ["套用中"]);
    await s.pend(s.note.id, at(0));
    s.svc.beginApply(s.note.id);
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(0));
    s.svc.endApply(s.note.id);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);

    const g = await seedGroup(s.db, "關", [{ userId: s.u.id, role: "admin" }]);
    const off = await seedNote(s.db, { groupId: g.id });
    await s.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, g.id));
    await s.store(off.id, ["空間關了"]);
    await s.pend(off.id, at(0), [s.me], null, `g:${g.id}`);
    expect(await s.svc.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, off.id)).toEqual([]);
    expect(await pendingOf(s.db, off.id)).toEqual(NO_PENDING);

    const bomb = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(bomb.id, ["指紋炸彈"]);
    await s.pend(bomb.id, at(0));
    expect(await s.svc.scanDue(at(4))).toBe(1);
    expect(await versionsOf(s.db, bomb.id)).toEqual([]);
    expect(await pendingOf(s.db, bomb.id)).toEqual(NO_PENDING);
    expect(s.warnsWith("版本指紋算不出來")).toBe(1);

    const gone = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(gone.id, ["會被刪"]);
    await s.pend(gone.id, at(0));
    const svc = s.mk({ autoWaitMs: 0, testHooks: { beforeCutDue: async id => { await s.db.delete(notes).where(eq(notes.id, id)); } } });
    const before = s.warns.length;
    expect(await svc.scanDue(at(5))).toBe(1);
    expect(await versionsOf(s.db, gone.id)).toEqual([]);
    expect(s.warns.length).toBe(before);
  });

  it("案 15：載入中與未載入都切；新的服務實例（模擬重啟、記憶體全空）照切", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const live = paraDoc(["載入中"]);
    s.host.docs.set(s.note.id, live);
    await s.svc.noteLoaded(s.note.id, live);
    const loaded = vfp(live);
    editPara(live, 0, t => t.insert(0, "改"));
    await s.pend(s.note.id, at(0), [s.me], loaded);
    expect(await s.svc.scanDue(at(1))).toBe(1);
    const [v] = await versionsOf(s.db, s.note.id);
    const snap = new Y.Doc();
    Y.applyUpdate(snap, v!.ydoc);
    expect(vfp(snap)).toBe(vfp(live));

    const cold = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(cold.id, ["沒載入"]);
    await s.pend(cold.id, at(0));
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, cold.id)).toHaveLength(1);

    const later = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(later.id, ["重啟後"]);
    await s.pend(later.id, at(0));
    const restarted = s.mk({ autoWaitMs: 0 });
    expect(await restarted.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, later.id)).toHaveLength(1);
  });

  it("案 16：X 在掃描當下讀站台現值（改了立刻作用在已待切筆記）；site_settings 沒有列 → 預設 5 分鐘；deps.autoWaitMs 覆寫 DB；overrideAutoWaitMs 再優先", async () => {
    const s = await setup();
    await s.store(s.note.id, ["等多久"]);
    await s.pend(s.note.id, at(0));
    expect(await s.svc.scanDue(at(3 * MIN))).toBe(0);
    await s.db.update(siteSettings).set({ versionAutoWaitMinutes: 2 });
    expect(await s.svc.scanDue(at(3 * MIN))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);

    const n2 = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(n2.id, ["deps 覆寫"]);
    await s.pend(n2.id, at(0));
    const svc = s.mk({ autoWaitMs: 10 * MIN });
    expect(await svc.scanDue(at(3 * MIN))).toBe(0);
    svc.overrideAutoWaitMs(1000);
    expect(await svc.scanDue(at(3 * MIN))).toBe(1);
    expect(await versionsOf(s.db, n2.id)).toHaveLength(1);
    svc.overrideAutoWaitMs(null);

    const n3 = await seedNote(s.db, { ownerId: s.u.id });
    await s.store(n3.id, ["沒有站台設定列"]);
    await s.pend(n3.id, at(0));
    await s.db.delete(siteSettings);
    expect(await s.svc.scanDue(at(5 * MIN - 1))).toBe(0);
    expect(await s.svc.scanDue(at(5 * MIN))).toBe(1);
    expect(await versionsOf(s.db, n3.id)).toHaveLength(1);
  });

  it("案 17：每輪至多 100 篇、先舊後新；並發兩次 scanDue 第二次回 0；stopScan 在篇與篇之間停、剩下的待切保留、之後恆回 0", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const ids: string[] = [];
    for (let i = 0; i <= VERSION_AUTO_SCAN_BATCH; i += 1) {
      const n = await seedNote(s.db, { ownerId: s.u.id });
      await s.store(n.id, [`第 ${i} 篇`]);
      await s.pend(n.id, at(i * 1000));
      ids.push(n.id);
    }
    const [first, second] = await Promise.all([s.svc.scanDue(at(HOUR)), s.svc.scanDue(at(HOUR))]);
    expect([first, second]).toEqual([VERSION_AUTO_SCAN_BATCH, 0]);
    expect(await versionsOf(s.db, ids[0]!)).toHaveLength(1);
    expect(await versionsOf(s.db, ids[VERSION_AUTO_SCAN_BATCH]!)).toEqual([]);
    expect((await pendingOf(s.db, ids[VERSION_AUTO_SCAN_BATCH]!)).at).toEqual(at(VERSION_AUTO_SCAN_BATCH * 1000));
    expect(await s.svc.scanDue(at(HOUR))).toBe(1);

    const t = await setup({ autoWaitMs: 0 });
    const three: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const n = await seedNote(t.db, { ownerId: t.u.id });
      await t.store(n.id, [`停 ${i}`]);
      await t.pend(n.id, at(i * 1000));
      three.push(n.id);
    }
    const holder: { svc?: VersionService } = {};
    holder.svc = t.mk({ testHooks: { beforeCutDue: async () => { void holder.svc!.stopScan(); } } });
    expect(await holder.svc.scanDue(at(HOUR))).toBe(3);
    const counts = await Promise.all(three.map(async id => (await versionsOf(t.db, id)).length));
    expect(counts).toEqual([1, 0, 0]);
    expect((await pendingOf(t.db, three[1]!)).at).toEqual(at(1000));
    expect(await holder.svc.scanDue(at(HOUR))).toBe(0);
    await expect(holder.svc.stopScan()).resolves.toBeUndefined();
  });

  it("案 18：單篇一直丟錯 → 10 分鐘內只 warn 一次、不再進批次；到期重試再失敗再 warn 一次；成功後不再被選到", async () => {
    let failing = true;
    const s = await setup();
    const good = await seedNote(s.db, { ownerId: s.u.id });
    const svc = s.mk({
      autoWaitMs: 0,
      testHooks: { beforeCutDue: async id => { if (failing && id === s.note.id) throw new Error("docFor 壞了（測試）"); } },
    });
    await s.store(s.note.id, ["壞的那篇"]);
    await s.store(good.id, ["好的那篇"]);
    await s.pend(s.note.id, at(0));
    await s.pend(good.id, at(1));
    const FAIL = "自動切版：單篇失敗，10 分鐘後再試";
    expect(await svc.scanDue(at(HOUR))).toBe(2);
    expect(s.warnsWith(FAIL)).toBe(1);
    expect(await versionsOf(s.db, good.id)).toHaveLength(1);
    expect(await svc.scanDue(at(HOUR + MIN))).toBe(0);
    expect(s.warnsWith(FAIL)).toBe(1);
    expect(await svc.scanDue(at(HOUR + VERSION_AUTO_SCAN_BACKOFF_MS))).toBe(1);
    expect(s.warnsWith(FAIL)).toBe(2);
    failing = false;
    expect(await svc.scanDue(at(HOUR + 2 * VERSION_AUTO_SCAN_BACKOFF_MS))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
    expect(await svc.scanDue(at(HOUR + 2 * VERSION_AUTO_SCAN_BACKOFF_MS + MIN))).toBe(0);
    expect(s.warnsWith(FAIL)).toBe(2);
  });

  it("RF2：文件已載入但版本狀態沒初始化（Map 沒條目）→ 每輪略過、待切保留、只 warn 一次；卸載後下一輪照切", async () => {
    const s = await setup({ autoWaitMs: 0 });
    await s.store(s.note.id, ["載入了但沒初始化"]);
    await s.pend(s.note.id, at(0));
    s.host.docs.set(s.note.id, paraDoc(["載入了但沒初始化"]));
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(0));
    expect(s.warnsWith("版本狀態尚未初始化")).toBe(1);
    s.host.docs.delete(s.note.id);
    expect(await s.svc.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });

  it("RF2（真實形）：noteLoaded 讀 DB 失敗留下 initialized:false 條目 → 每輪略過、待切保留、只 warn 一次；forget＋卸載後下一輪照切", async () => {
    const s = await setup({ autoWaitMs: 0 });
    await s.store(s.note.id, ["條目沒初始化"]);
    await s.pend(s.note.id, at(0));
    s.host.docs.set(s.note.id, paraDoc(["條目沒初始化"]));
    // noteLoaded 讀 DB 失敗時 Map 裡留下的就是這種條目（entryFor 先建、沒走到 initialized:true）；以 noteChanged 建同一形。
    s.svc.noteChanged(s.note.id, { userId: s.u.id, agentLabel: null });
    expect(s.svc.debugState(s.note.id)?.initialized).toBe(false);
    expect(await s.svc.scanDue(at(1))).toBe(1);
    expect(await s.svc.scanDue(at(2))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toEqual([]);
    expect((await pendingOf(s.db, s.note.id)).at).toEqual(at(0));
    expect(s.warnsWith("版本狀態尚未初始化")).toBe(1);
    s.svc.forget(s.note.id);
    s.host.docs.delete(s.note.id);
    expect(await s.svc.scanDue(at(3))).toBe(1);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });
});

describe("交易內併待切編輯者（§4.3「待切中手動儲存」、§7.3）", () => {
  it("案 20：手動儲存 → editors＝待切 ∪ 記憶體緩衝 ∪ 存檔人（去重、先到先排）、同交易清待切；升級分支也清待切、升級列 editors 不變", async () => {
    const s = await setup();
    const other = await seedUser(s.db);
    const doc = paraDoc(["a"]);
    s.host.docs.set(s.note.id, doc);
    await s.svc.noteLoaded(s.note.id, doc);
    await s.pend(s.note.id, at(0), [{ user_id: other.id, agent_label: "Claude" }]);
    editPara(doc, 0, t => t.insert(0, "x"));
    s.svc.noteChanged(s.note.id, { userId: other.id, agentLabel: null });
    const expected = [{ user_id: other.id, agent_label: "Claude" }, { user_id: other.id, agent_label: null }, s.me];
    const out = await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "里程碑", extraEditors: [{ userId: s.u.id, agentLabel: null }] });
    expect(out).toMatchObject({ upgraded: false, row: { seq: 1, kind: "manual", editors: expected } });
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    await s.pend(s.note.id, at(1), [{ user_id: s.u.id, agent_label: "X" }]);
    const up = await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: null, extraEditors: [{ userId: s.u.id, agentLabel: null }] });
    expect(up).toMatchObject({ upgraded: true, row: { seq: 1, editors: expected } });
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
  });

  it("RF5：沒人開著的筆記在待切中被手動儲存（暫時狀態）→ 待切編輯者併進新版、清待切；之後的掃描不再多切", async () => {
    const s = await setup({ autoWaitMs: 0 });
    const claude = { user_id: s.u.id, agent_label: "Claude" };
    await s.store(s.note.id, ["沒人開著時 AI 寫的"]);
    await s.pend(s.note.id, at(0), [claude], VACUUM_VERSION_FINGERPRINT);
    const { doc, transient } = await s.svc.docFor(s.note.id);
    const out = await s.svc.cutIfDirty(s.note.id, doc, { kind: "manual", name: "手存", extraEditors: [{ userId: s.u.id, agentLabel: null }], transient });
    expect(out).toMatchObject({ upgraded: false, row: { seq: 1, editors: [claude, s.me] } });
    expect(await pendingOf(s.db, s.note.id)).toEqual(NO_PENDING);
    expect(await s.svc.scanDue(at(HOUR))).toBe(0);
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
  });
});
