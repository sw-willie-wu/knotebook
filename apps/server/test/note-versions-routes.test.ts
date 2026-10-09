// 版本歷史 REST（spec 2026-10-09 §6、§11.2「REST 矩陣」「手動儲存」「PATCH／DELETE」、Review Focus RF1／RF2）。
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteStates, noteVersions, notes } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { versionFingerprint } from "../src/notes/version-fingerprint.js";
import { seedDoc } from "./copy-helpers.js";
import { bearer, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp, freshLimiters } from "./helpers.js";
import { noteBase, paraDoc, versionsOf } from "./version-helpers.js";

type Who = string | null;
async function call(app: FastifyInstance, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, who: Who, payload?: unknown) {
  return app.inject({ method, url, ...(who ? { cookies: await cookieOf(who) } : {}), ...(payload !== undefined ? { payload: payload as object } : {}) });
}
const hasCjk = (s: string) => /[一-鿿]/.test(s);

async function restSetup(over: Parameters<typeof buildTestApp>[0] = {}) {
  const built = await buildTestApp(over);
  const { app, db } = built;
  const owner = await seedUser(db);
  const note = await seedNote(db, { ownerId: owner.id });
  await seedDoc(db, note.id, paraDoc(["版本一的內容"]));
  /** 換掉 note_states（模擬「文件沒載入時內容變了」），回新內容的版本指紋。 */
  const setContent = async (text: string) => {
    const d = paraDoc([text]);
    await db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(d)) }).where(eq(noteStates.noteId, note.id));
    return versionFingerprint(d.getXmlFragment(YDOC_FRAGMENT));
  };
  const base = `/api/notes/${note.id}/versions`;
  return { app, db, owner, note, setContent, base };
}

describe("權限矩陣（§6 開頭、§9）", () => {
  it("owner／editor／群組 editor 可讀可寫；viewer 403；看不到 404；未登入 401；PAT 401", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201); // 先有 v1
    const editor = await seedUser(s.db);
    const viewer = await seedUser(s.db);
    const stranger = await seedUser(s.db);
    await seedShare(s.db, s.note.id, editor.id, "editor");
    await seedShare(s.db, s.note.id, viewer.id, "viewer");
    for (const who of [s.owner.id, editor.id]) {
      expect((await call(s.app, "GET", s.base, who)).statusCode, who).toBe(200);
      expect((await call(s.app, "GET", `${s.base}/1`, who)).statusCode).toBe(200);
      expect((await call(s.app, "PATCH", `${s.base}/1`, who, { name: "n" })).statusCode).toBe(200);
    }
    for (const [method, url, body] of [["GET", s.base, undefined], ["GET", `${s.base}/1`, undefined], ["POST", s.base, {}], ["PATCH", `${s.base}/1`, { name: "x" }], ["DELETE", `${s.base}/1`, undefined]] as const) {
      const v = await call(s.app, method, url, viewer.id, body);
      expect(v.statusCode, `${method} ${url} viewer`).toBe(403);
      expect(v.json().error).toEqual({ code: "forbidden", message: "沒有編輯權限" });
      expect((await call(s.app, method, url, stranger.id, body)).statusCode, `${method} ${url} none`).toBe(404);
      expect((await call(s.app, method, url, null, body)).statusCode, `${method} ${url} anon`).toBe(401);
    }
    const { token } = await seedTokenForUser(s.db, s.owner.id);
    expect((await s.app.inject({ method: "GET", url: s.base, headers: bearer(token) })).statusCode).toBe(401);
    expect((await s.app.inject({ method: "POST", url: s.base, headers: bearer(token), payload: {} })).statusCode).toBe(401);

    const g = await seedGroup(s.db, "G", [{ userId: s.owner.id, role: "admin" }, { userId: editor.id, role: "member" }]);
    const gnote = await seedNote(s.db, { groupId: g.id });
    expect((await call(s.app, "POST", `/api/notes/${gnote.id}/versions`, editor.id, {})).statusCode).toBe(201);
  });

  it("沒有 collab 的部署：apply 路由不註冊（404），其餘五支照常", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    const v1 = (await versionsOf(s.db, s.note.id))[0]!;
    expect((await call(s.app, "POST", `${s.base}/1/apply`, s.owner.id, { versionId: v1.id, discardUnsaved: false })).statusCode).toBe(404);
  });

  it("M5：角色檢查排在扣桶之前——viewer 對每支寫入連打 3 次（桶上限 2）每次都是 403 不是 429，且不耗 owner 的桶", async () => {
    const s = await restSetup({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    for (const [method, url, body] of [["POST", s.base, {}], ["PATCH", `${s.base}/1`, { name: "x" }], ["DELETE", `${s.base}/1`, undefined]] as const) {
      const viewer = await seedUser(s.db); // 桶以 userId 為鍵：每支各用一個 viewer，單支路由的對調也抓得到
      await seedShare(s.db, s.note.id, viewer.id, "viewer");
      for (let i = 0; i < 3; i += 1) {
        const r = await call(s.app, method, url, viewer.id, body);
        expect(r.statusCode, `${method} #${i + 1}`).toBe(403);
        expect(r.json().error.code).toBe("forbidden");
      }
    }
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
  });
});

describe("參數驗證（不變量 S）", () => {
  it(":id 非 uuid → 404；:seq 非法 → 404（不是 500）；before／limit 非法 → 400", async () => {
    const s = await restSetup();
    expect((await call(s.app, "GET", "/api/notes/not-a-uuid/versions", s.owner.id)).json().error.code).toBe("not_found");
    for (const seq of ["0", "01", "-1", "1.5", "1e3", "2147483648", "abc", "%00", "１"]) {
      const r = await call(s.app, "GET", `${s.base}/${seq}`, s.owner.id);
      expect(r.statusCode, seq).toBe(404);
      expect((await call(s.app, "DELETE", `${s.base}/${seq}`, s.owner.id)).statusCode, `DELETE ${seq}`).toBe(404);
    }
    for (const q of ["before=0", "before=2147483648", "before=x", "limit=0", "limit=101", "limit=1.5", "limit=01", "limit=-1", "foo=1", "limit=1&limit=2"]) {
      const r = await call(s.app, "GET", `${s.base}?${q}`, s.owner.id);
      expect(r.statusCode, q).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
      expect(hasCjk(r.json().error.message)).toBe(true);
    }
    expect((await call(s.app, "GET", `${s.base}?limit=100&before=2147483647`, s.owner.id)).statusCode).toBe(200);
  });
});

describe("GET 清單與快照（§6.1、§6.2）", () => {
  it("新到舊、游標分頁、nextBefore 恰好在最後一頁為 null；editors 帶 handle（刪除的使用者為空字串）；current", async () => {
    const s = await restSetup();
    const fp = versionFingerprint(paraDoc(["版本一的內容"]).getXmlFragment(YDOC_FRAGMENT));
    const ghost = "00000000-0000-4000-8000-0000000000ff";
    for (let seq = 1; seq <= 5; seq += 1) {
      await s.db.insert(noteVersions).values({
        noteId: s.note.id, seq, ydoc: Buffer.from([0]), kind: seq === 3 ? "manual" : "auto", name: seq === 3 ? "里程碑" : null,
        editors: [{ user_id: s.owner.id, agent_label: null }, { user_id: ghost, agent_label: "Claude" }], baseSeq: seq === 4 ? 2 : null,
      });
    }
    await s.db.update(notes).set({ versionCounter: 5, versionBaseSeq: 5, versionBaseFingerprint: fp }).where(eq(notes.id, s.note.id));
    const p1 = (await call(s.app, "GET", `${s.base}?limit=2`, s.owner.id)).json();
    expect(p1.versions.map((v: { seq: number }) => v.seq)).toEqual([5, 4]);
    expect(p1.nextBefore).toBe(4);
    expect(p1.current).toEqual({ baseSeq: 5, dirty: false, nextSeq: 6, autoEnabled: true });
    expect(p1.versions[1]).toMatchObject({ kind: "auto", name: null, baseSeq: 2, editors: [{ handle: s.owner.handle, agentLabel: null }, { handle: "", agentLabel: "Claude" }] });
    expect(Object.keys(p1.versions[0]).sort()).toEqual(["baseSeq", "createdAt", "editors", "id", "kind", "name", "seq"]);
    const p2 = (await call(s.app, "GET", `${s.base}?limit=2&before=4`, s.owner.id)).json();
    expect(p2.versions.map((v: { seq: number }) => v.seq)).toEqual([3, 2]);
    expect(p2.versions[0]).toMatchObject({ kind: "manual", name: "里程碑" });
    const p3 = (await call(s.app, "GET", `${s.base}?limit=2&before=2`, s.owner.id)).json();
    expect(p3.versions.map((v: { seq: number }) => v.seq)).toEqual([1]);
    expect(p3.nextBefore).toBeNull();
    const exact = (await call(s.app, "GET", `${s.base}?limit=5`, s.owner.id)).json();
    expect(exact.nextBefore).toBeNull(); // 剛好整頁不多給空頁游標（起草裁定 10）
    await s.setContent("內容變了");
    expect((await call(s.app, "GET", s.base, s.owner.id)).json().current.dirty).toBe(true);
  });

  it("快照：{ id, seq, ydoc(base64) }、Cache-Control private, no-store；不存在 → 404", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    const [v1] = await versionsOf(s.db, s.note.id);
    const r = await call(s.app, "GET", `${s.base}/1`, s.owner.id);
    expect(r.headers["cache-control"]).toBe("private, no-store");
    expect(r.json()).toEqual({ id: v1!.id, seq: 1, ydoc: Buffer.from(v1!.ydoc).toString("base64") });
    const r404 = await call(s.app, "GET", `${s.base}/9`, s.owner.id);
    expect(r404.statusCode).toBe(404);
    expect(r404.json().error.code).toBe("not_found");
  });
});

describe("POST 手動儲存（§6.3）", () => {
  it("沒有基底且乾淨 → 201 新版；乾淨且有基底 → 201 upgraded（總數不變）；dirty → 新版", async () => {
    const s = await restSetup();
    const a = await call(s.app, "POST", s.base, s.owner.id, { name: "首版" });
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ seq: 1, kind: "manual", name: "首版", upgraded: false, baseSeq: null, editors: [{ handle: s.owner.handle, agentLabel: null }] });
    const b = await call(s.app, "POST", s.base, s.owner.id, { name: "改名" });
    expect(b.json()).toMatchObject({ seq: 1, name: "改名", upgraded: true });
    expect(await versionsOf(s.db, s.note.id)).toHaveLength(1);
    await s.setContent("第二版");
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).json()).toMatchObject({ seq: 2, upgraded: false, name: null });
  });

  it("沒有基底且真空的空筆記 → 建一版（作者補）", async () => {
    const s = await restSetup();
    const empty = await seedNote(s.db, { ownerId: s.owner.id });
    const r = await call(s.app, "POST", `/api/notes/${empty.id}/versions`, s.owner.id, {});
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ seq: 1, upgraded: false });
  });

  it("RF1：名稱規則——只有空白 → null；120 code point 收、121 拒；NUL／落單代理 400（不是 500）；body 形狀錯 400", async () => {
    const s = await restSetup();
    const smile = String.fromCodePoint(0x1f600);
    expect((await call(s.app, "POST", s.base, s.owner.id, { name: " 　 " })).json().name).toBeNull();
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: smile.repeat(120) })).json().name).toBe(smile.repeat(120));
    for (const bad of [smile.repeat(121), `a${String.fromCodePoint(0)}b`, "a\uD800b"]) {
      for (const [method, url] of [["POST", s.base], ["PATCH", `${s.base}/1`]] as const) {
        const r = await call(s.app, method, url, s.owner.id, { name: bad });
        expect(r.statusCode, `${method} ${JSON.stringify(bad).slice(0, 20)}`).toBe(400);
        expect(r.json().error.code).toBe("invalid_body");
        expect(hasCjk(r.json().error.message)).toBe(true);
      }
    }
    for (const body of [{ name: 5 }, { foo: 1 }, []]) expect((await call(s.app, "POST", s.base, s.owner.id, body)).statusCode).toBe(400);
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, {})).statusCode).toBe(400);
  });

  it("筆記已刪 → 404（走 canEdit 的 none 分支，沒進 saveVersion）", async () => {
    const s = await restSetup();
    await s.db.delete(notes).where(eq(notes.id, s.note.id));
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(404);
  });

  it("寫入端點吃 edit 桶（GET 不吃）：上限 2 → 第三次寫入 429", async () => {
    const s = await restSetup({ limiters: freshLimiters({ edit: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) }) });
    for (let i = 0; i < 5; i += 1) expect((await call(s.app, "GET", s.base, s.owner.id)).statusCode).toBe(200);
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: "a" })).statusCode).toBe(200);
    const r = await call(s.app, "DELETE", `${s.base}/1`, s.owner.id);
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe("too_many_requests");
  });
});

describe("PATCH／DELETE（§6.5、§6.6）", () => {
  it("PATCH 自動版本 → 轉手動；{name:null} 清名稱仍是手動；不存在 → 404", async () => {
    const s = await restSetup();
    await s.db.insert(noteVersions).values({ noteId: s.note.id, seq: 1, ydoc: Buffer.from([0]), kind: "auto" });
    const r = await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: "命名" });
    expect(r.json()).toMatchObject({ seq: 1, kind: "manual", name: "命名" });
    expect((await call(s.app, "PATCH", `${s.base}/1`, s.owner.id, { name: null })).json()).toMatchObject({ kind: "manual", name: null });
    expect((await call(s.app, "PATCH", `${s.base}/7`, s.owner.id, { name: "x" })).statusCode).toBe(404);
  });

  it("DELETE：基底 → 409 version_is_base（中文訊息）；不存在 → 404；非基底 → 204", async () => {
    const s = await restSetup();
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    await s.setContent("第二版");
    expect((await call(s.app, "POST", s.base, s.owner.id, {})).statusCode).toBe(201);
    const base = await call(s.app, "DELETE", `${s.base}/2`, s.owner.id);
    expect(base.statusCode).toBe(409);
    expect(base.json().error).toEqual({ code: "version_is_base", message: "這是目前內容的基底版本，不能刪除" });
    expect((await call(s.app, "DELETE", `${s.base}/9`, s.owner.id)).statusCode).toBe(404);
    expect((await call(s.app, "DELETE", `${s.base}/1`, s.owner.id)).statusCode).toBe(204);
    expect((await versionsOf(s.db, s.note.id)).map(v => v.seq)).toEqual([2]);
  });
});

describe("POST apply（§6.4）× 真 collab", () => {
  async function collabSetup(opts: Parameters<typeof buildCollabTestApp>[0] = {}) {
    const ctx = await buildCollabTestApp(opts);
    const u = await ctx.createUser({ email: "a@example.com", password: "correct-horse-battery" });
    const note = await ctx.createNote(u.id);
    const session = await ctx.loginAs("a@example.com", "correct-horse-battery");
    const base = `/api/notes/${note.id}/versions`;
    const unloaded = () => waitFor("卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
    const setContent = (text: string) => ctx.db.update(noteStates).set({ ydoc: Buffer.from(Y.encodeStateAsUpdate(paraDoc([text]))) }).where(eq(noteStates.noteId, note.id));
    await seedDoc(ctx.db, note.id, paraDoc(["版本一"]));
    const post = (url: string, body: unknown) => session.fetch(url, { method: "POST", body: JSON.stringify(body) });
    expect((await post(base, {})).status).toBe(201);
    await setContent("版本二");
    expect((await post(base, {})).status).toBe(201);
    const [v1, v2] = await versionsOf(ctx.db, note.id);
    return { ctx, u, note, session, base, unloaded, setContent, post, v1: v1!, v2: v2! };
  }

  it("200 { current }；RF2 大寫 versionId 視同同一版；versionId 對不上 409；seq 不存在 404；body 錯 400", async () => {
    const s = await collabSetup();
    const ok = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id.toUpperCase(), discardUnsaved: false });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ current: { baseSeq: 1, dirty: false, nextSeq: 3, autoEnabled: true } });
    const mm = await s.post(`${s.base}/2/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect(mm.status).toBe(409);
    expect((await mm.json()).error).toEqual({ code: "version_mismatch", message: "這一版已經不存在或已被取代，請重新整理" });
    expect((await s.post(`${s.base}/9/apply`, { versionId: s.v1.id, discardUnsaved: false })).status).toBe(404);
    for (const body of [{ versionId: s.v1.id }, { versionId: "x", discardUnsaved: true }, { versionId: s.v1.id, discardUnsaved: "no" }, { versionId: s.v1.id, discardUnsaved: true, x: 1 }]) {
      expect((await s.post(`${s.base}/1/apply`, body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("dirty 且 discardUnsaved=false → 409 version_unsaved_changes（中文）；true → 200", async () => {
    const s = await collabSetup();
    await s.setContent("沒存的第三版");
    const r = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toEqual({ code: "version_unsaved_changes", message: "目前有未儲存的修改" });
    expect((await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: true })).status).toBe(200);
  });

  it("排隊期間被刪的版本、有 WS 連線（文件不卸載）→ 回應 baseSeq null、dirty true；之後全部離開 → unload 依 reset 切一版", async () => {
    let deleteV1: (() => Promise<void>) | null = null;
    const s = await collabSetup({ editingTestHooks: { beforeMerge: async () => { if (deleteV1) await deleteV1(); } } });
    const client = await s.session.connect(s.note.id);
    deleteV1 = async () => { await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`); };
    const r = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect((await r.json()).current).toMatchObject({ baseSeq: null, dirty: true }); // 起草裁定 12：套用完成後的實際 current
    deleteV1 = null;
    client.disconnect();
    await s.unloaded();
    expect((await versionsOf(s.ctx.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
  });

  it("排隊期間被刪的版本、沒有 WS 連線 → disconnect 內就卸載並切出 v3，回應 baseSeq＝3（需回寫 spec §6.4／§11.2）；之後手動儲存 → 201、總數 2、GET dirty=false", async () => {
    let deleteV1: (() => Promise<void>) | null = null;
    const s = await collabSetup({ editingTestHooks: { beforeMerge: async () => { if (deleteV1) await deleteV1(); } } });
    deleteV1 = async () => { await s.ctx.db.delete(noteVersions).where(sql`note_versions.note_id = ${s.note.id} and note_versions.seq = 1`); };
    const r = await s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: false });
    expect((await r.json()).current).toMatchObject({ baseSeq: 3, dirty: false, nextSeq: 4 }); // v3＝unload 依「沒有基底、loadFingerprint=null」切的
    deleteV1 = null;
    await s.unloaded();
    expect((await versionsOf(s.ctx.db, s.note.id)).map(v => v.seq)).toEqual([2, 3]);
    expect((await s.post(s.base, {})).status).toBe(201);
    expect(await versionsOf(s.ctx.db, s.note.id)).toHaveLength(2); // 內容＝v3 → upgraded，總數不變
    expect((await (await s.session.fetch(s.base)).json()).current.dirty).toBe(false);
    expect((await noteBase(s.ctx.db, s.note.id)).baseSeq).toBe(3);
  });

  it("I1：viewer apply → 403 且內容與 version_base_seq 不變；stranger → 404", async () => {
    const s = await collabSetup();
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: "correct-horse-battery" });
    await s.ctx.createUser({ email: "x@example.com", password: "correct-horse-battery" });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const before = await noteBase(s.ctx.db, s.note.id);
    const stateBefore = (await s.ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.note.id)))[0]!.ydoc;
    const body = { versionId: s.v1.id, discardUnsaved: true };
    const vs = await s.ctx.loginAs("v@example.com", "correct-horse-battery");
    const v = await vs.fetch(`${s.base}/1/apply`, { method: "POST", body: JSON.stringify(body) });
    expect(v.status).toBe(403);
    expect((await v.json()).error).toEqual({ code: "forbidden", message: "沒有編輯權限" });
    const xs = await s.ctx.loginAs("x@example.com", "correct-horse-battery");
    expect((await xs.fetch(`${s.base}/1/apply`, { method: "POST", body: JSON.stringify(body) })).status).toBe(404);
    expect(await noteBase(s.ctx.db, s.note.id)).toEqual(before);
    const stateAfter = (await s.ctx.db.select({ ydoc: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, s.note.id)))[0]!.ydoc;
    expect(Buffer.from(stateAfter).equals(Buffer.from(stateBefore))).toBe(true);
  });

  it("I1：viewer 連打 apply 3 次（桶上限 2）→ 每次 403，不是 429", async () => {
    const s = await collabSetup({ limiters: { edit: new FixedWindowLimiter({ limit: 2, windowMs: 60_000 }) } });
    const viewer = await s.ctx.createUser({ email: "v@example.com", password: "correct-horse-battery" });
    await s.ctx.share(s.note.id, viewer.id, "viewer");
    const vs = await s.ctx.loginAs("v@example.com", "correct-horse-battery");
    for (let i = 0; i < 3; i += 1) {
      const r = await vs.fetch(`${s.base}/1/apply`, { method: "POST", body: JSON.stringify({ versionId: s.v1.id, discardUnsaved: true }) });
      expect(r.status, `apply #${i + 1}`).toBe(403);
    }
  });

  it("m1：佇列被套用佔住、等待逾時 → 手動儲存 503 server_busy（中文）；放行後套用 200", async () => {
    let entered: (() => void) | null = null;
    let release: (() => void) | null = null;
    const gate = new Promise<void>(r => { release = r; });
    const inHook = new Promise<void>(r => { entered = r; });
    let armed = false;
    const s = await collabSetup({ editingQueueWaitMs: 300, editingTestHooks: { beforeMerge: async () => { if (armed) { entered!(); await gate; } } } });
    armed = true;
    const applying = s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: true });
    await inHook;
    const busy = await s.post(s.base, { name: "排隊中" });
    expect(busy.status).toBe(503);
    const err = (await busy.json()).error;
    expect(err.code).toBe("server_busy");
    expect(hasCjk(err.message)).toBe(true);
    armed = false;
    release!();
    expect((await applying).status).toBe(200);
  });

  it("手動儲存與套用併發 → 經同一顆佇列序列化，兩支都成功", async () => {
    const s = await collabSetup();
    const [a, b] = await Promise.all([
      s.post(`${s.base}/1/apply`, { versionId: s.v1.id, discardUnsaved: true }),
      s.post(s.base, { name: "併發" }),
    ]);
    expect([a.status, b.status]).toEqual([200, 201]);
    const rows = await versionsOf(s.ctx.db, s.note.id);
    expect(rows.find(v => v.name === "併發")).toBeDefined();
  });
});
