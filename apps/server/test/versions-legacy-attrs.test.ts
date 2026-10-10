// 版本歷史 × 舊 schema 筆記（spec 2026-10-09 §13-9 方案二）與「基底列已不在」的手動儲存（Task 14b Step 2b）。
// §13-9：note_states 缺較新 schema 預設屬性的舊筆記，瀏覽器打一字再刪時 y-prosemirror 會把被碰到的段落連預設屬性寫回
// （PR2 Task 15 真瀏覽器實測 MEASURE-13-9 openClose=0 typeDelete=1）。這裡以 WS client 直接 setAttribute 模擬那筆回寫。
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { noteStates } from "../src/db/schema.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { waitFor } from "./editing-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { noteBase, paraDoc, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const PARA_DEFAULTS = { backgroundColor: "default", textAlignment: "left", textColor: "default" } as const;

/** PR2 Task 15 seed 腳本的形：heading 只有 level（number）、paragraph 沒有任何屬性。 */
function legacyDoc(): Y.Doc {
  const doc = new Y.Doc();
  const g = new Y.XmlElement("blockGroup");
  doc.getXmlFragment(YDOC_FRAGMENT).insert(0, [g]);
  const h = new Y.XmlElement("heading");
  h.setAttribute("level", 2 as unknown as string);
  const ht = new Y.XmlText();
  h.insert(0, [ht]);
  const hc = new Y.XmlElement("blockContainer");
  hc.setAttribute("id", "legacy-h");
  hc.insert(0, [h]);
  const p = new Y.XmlElement("paragraph");
  const pt = new Y.XmlText();
  p.insert(0, [pt]);
  const pc = new Y.XmlElement("blockContainer");
  pc.setAttribute("id", "legacy-p");
  pc.insert(0, [p]);
  g.insert(0, [hc, pc]);
  ht.insert(0, "Legacy heading");
  pt.insert(0, "Legacy paragraph");
  return doc;
}

async function legacySetup() {
  const ctx = await buildCollabTestApp();
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const note = await ctx.createNote(u.id);
  await seedDoc(ctx.db, note.id, legacyDoc());
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const unloaded = () => waitFor("落盤並卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, note, session, unloaded };
}

/** 開 WS、在 paragraph（第 2 顆頂層區塊）上一次 transact 寫入三個屬性、不改文字；等 server 收到後回 server 端 isDirty。 */
async function rewriteParagraphAttrs(s: Awaited<ReturnType<typeof legacySetup>>, attrs: Record<string, string>) {
  const c = await s.session.connect(s.note.id);
  await waitFor("版本狀態初始化", 5_000, () => s.ctx.collab.versions.debugState(s.note.id)?.initialized === true);
  const p = topLevelContainers(c.doc.getXmlFragment(YDOC_FRAGMENT))[1]!.get(0) as Y.XmlElement;
  expect(p.nodeName).toBe("paragraph");
  expect(p.getAttributes()).toEqual({});
  c.doc.transact(() => {
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  });
  const serverDoc = s.ctx.collab.hocuspocus.documents.get(s.note.id)!;
  const serverPara = () => topLevelContainers(serverDoc.getXmlFragment(YDOC_FRAGMENT))[1]!.get(0) as Y.XmlElement;
  await waitFor("server 收到屬性回寫", 5_000, () => serverPara().getAttribute("textColor") === attrs.textColor);
  expect(serverPara().getAttributes()).toEqual(attrs);
  expect(serverPara().toString()).toContain("Legacy paragraph");
  const dirty = await s.ctx.collab.versions.isDirty(s.note.id, serverDoc);
  return { c, dirty };
}

describe("§13-9：舊 schema 筆記被回寫預設屬性（方案二）", () => {
  it("paragraph 補上三個預設值、文字不變 → isDirty false；斷線 unload → 總數 0", async () => {
    const s = await legacySetup();
    const { c, dirty } = await rewriteParagraphAttrs(s, { ...PARA_DEFAULTS });
    expect(dirty).toBe(false);
    c.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, s.note.id)).toEqual([]);
  });

  it("對照：同一流程但 textAlignment 是 center（非預設）→ isDirty true；斷線 unload → 總數 1、內容是回寫後", async () => {
    const s = await legacySetup();
    const { c, dirty } = await rewriteParagraphAttrs(s, { ...PARA_DEFAULTS, textAlignment: "center" });
    expect(dirty).toBe(true);
    const after = versionFingerprint(s.ctx.collab.hocuspocus.documents.get(s.note.id)!.getXmlFragment(YDOC_FRAGMENT));
    c.disconnect();
    await s.unloaded();
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.map(r => [r.seq, r.kind])).toEqual([[1, "auto"]]);
    const v1 = new Y.Doc();
    Y.applyUpdate(v1, rows[0]!.ydoc);
    expect(versionFingerprint(v1.getXmlFragment(YDOC_FRAGMENT))).toBe(after);
  });
});

async function call(app: FastifyInstance, url: string, who: string, payload: unknown) {
  return app.inject({ method: "POST", url, cookies: await cookieOf(who), payload: payload as object });
}

describe("手動儲存：基底指向已被刪掉的版本（Task 14b Step 2b）", () => {
  it("建 v1 → SQL 直接刪掉 v1（繞過 version_is_base）→ 內容不改 → POST 手動儲存 → 201 新版 seq 2、upgraded false、基底改指 2", async () => {
    const built = await buildTestApp();
    const owner = await seedUser(built.db);
    const note = await seedNote(built.db, { ownerId: owner.id });
    await seedDoc(built.db, note.id, paraDoc(["基底會被刪掉的內容"]));
    const url = `/api/notes/${note.id}/versions`;
    const first = await call(built.app, url, owner.id, {});
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ seq: 1, upgraded: false });
    const before = await noteBase(built.db, note.id);
    expect(before).toMatchObject({ counter: 1, baseSeq: 1 });
    await built.db.execute(sql`delete from note_versions where note_versions.note_id = ${note.id} and note_versions.seq = 1`);
    expect(await versionsOf(built.db, note.id)).toEqual([]);

    const r = await call(built.app, url, owner.id, { name: "補存" });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seq: 2, kind: "manual", name: "補存", upgraded: false, baseSeq: null });
    const rows = await versionsOf(built.db, note.id);
    expect(rows.map(x => [x.seq, x.kind, x.name, x.baseSeq])).toEqual([[2, "manual", "補存", null]]);
    expect(await noteBase(built.db, note.id)).toEqual({ counter: 2, baseSeq: 2, baseFingerprint: before.baseFingerprint });
  });

  it("建 v1 → SQL 直接刪掉 v1 → 內容有改 → POST 手動儲存 → 201 seq 2、baseSeq null（不指向已刪的 v1）", async () => {
    const built = await buildTestApp();
    const owner = await seedUser(built.db);
    const note = await seedNote(built.db, { ownerId: owner.id });
    await seedDoc(built.db, note.id, paraDoc(["改前的內容"]));
    const url = `/api/notes/${note.id}/versions`;
    expect((await call(built.app, url, owner.id, {})).json()).toMatchObject({ seq: 1, upgraded: false });
    expect(await noteBase(built.db, note.id)).toMatchObject({ counter: 1, baseSeq: 1 });
    await built.db.execute(sql`delete from note_versions where note_versions.note_id = ${note.id} and note_versions.seq = 1`);
    const changed = paraDoc(["改後的內容"]);
    await built.db
      .update(noteStates)
      .set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(changed)) })
      .where(eq(noteStates.noteId, note.id));
    const changedFp = versionFingerprint(changed.getXmlFragment(YDOC_FRAGMENT));

    const r = await call(built.app, url, owner.id, {});
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seq: 2, kind: "manual", upgraded: false, baseSeq: null });
    const rows = await versionsOf(built.db, note.id);
    expect(rows.map(x => [x.seq, x.kind, x.baseSeq])).toEqual([[2, "manual", null]]);
    expect(await noteBase(built.db, note.id)).toEqual({ counter: 2, baseSeq: 2, baseFingerprint: changedFp });
  });
});
