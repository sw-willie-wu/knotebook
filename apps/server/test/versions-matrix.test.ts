// spec 2026-10-09 §11.2：D8 開關矩陣（三切點都不切、手動照常；站台開＋個人關；改設定要重新載入才生效）、
// 指紋情境（r1 I-2）、版號併發、撤回前有人工未存修改。
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as Y from "yjs";
import { YDOC_FRAGMENT, topLevelContainers } from "@knotebook/shared";
import { createVersionService } from "../src/collab/versions.js";
import { groups, siteSettings, users } from "../src/db/schema.js";
import { bearer, docText, seedContent, seedTokenForUser, waitFor } from "./editing-helpers.js";
import { seedGroup, seedNote } from "./group-helpers.js";
import { buildCollabTestApp, type CollabTestCtx, type TestClient } from "./helpers.js";
import { noteBase, paraDoc, versionsOf } from "./version-helpers.js";

const PASSWORD = "correct-horse-battery";
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function setup() {
  const ctx = await buildCollabTestApp({ versionIdleMs: 50 });
  const u = await ctx.createUser({ email: "a@example.com", password: PASSWORD });
  const session = await ctx.loginAs("a@example.com", PASSWORD);
  const { token } = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write", "Claude Code (knotebook)");
  const unloaded = () => waitFor("卸載", 10_000, () => ctx.collab.hocuspocus.documents.size === 0);
  return { ctx, u, session, token, unloaded };
}
type S = Awaited<ReturnType<typeof setup>>;

async function typeFirst(ctx: CollabTestCtx, noteId: string, client: TestClient, fn: (t: Y.XmlText) => void, until: (s: string) => boolean): Promise<void> {
  const p = topLevelContainers(client.doc.getXmlFragment(YDOC_FRAGMENT))[0]!.get(0) as Y.XmlElement;
  client.doc.transact(() => fn(p.get(0) as Y.XmlText));
  await waitFor("server 收到", 5_000, () => until(docText(ctx.collab.hocuspocus.documents.get(noteId)!)));
}

/** 三切點都試一遍（idle 3 秒內、AI 寫入前後、全部離開），最後手動儲存。回 [三切點之後的列數, 手動之後的列數]。 */
async function cutPoints(s: S, noteId: string): Promise<[number, number]> {
  const client = await seedContent(s.ctx, s.session, noteId, "矩陣測試的人工內容");
  await sleep(3_000); // 落盤 debounce 2 s ＋ idle 50 ms
  const ai = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${noteId}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "AI 加的" } });
  expect(ai.statusCode).toBe(201);
  client.disconnect();
  await s.unloaded();
  const afterCuts = (await versionsOf(s.ctx.db, noteId)).length;
  const save = await s.session.fetch(`/api/notes/${noteId}/versions`, { method: "POST", body: JSON.stringify({}) });
  expect(save.status).toBe(201);
  return [afterCuts, (await versionsOf(s.ctx.db, noteId)).length];
}

describe("D8 開關矩陣", () => {
  it("站台總開關關 → 三切點都不切、手動照建", async () => {
    const s = await setup();
    await s.ctx.db.update(siteSettings).set({ autoVersionsEnabled: false });
    const n = await s.ctx.createNote(s.u.id);
    expect(await cutPoints(s, n.id)).toEqual([0, 1]);
  });

  it("個人開關關 → 個人筆記三切點都不切；群組筆記照切（站台開＋個人關）", async () => {
    const s = await setup();
    await s.ctx.db.update(users).set({ autoVersions: false }).where(eq(users.id, s.u.id));
    const personal = await s.ctx.createNote(s.u.id);
    expect(await cutPoints(s, personal.id)).toEqual([0, 1]);
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    const gnote = await seedNote(s.ctx.db, { groupId: g.id });
    const [cuts] = await cutPoints(s, gnote.id);
    expect(cuts).toBeGreaterThanOrEqual(2); // idle 一刀＋AI 後一刀（AI 前已乾淨）；不寫死確切數，見註
  });

  it("群組開關關 → 群組筆記三切點都不切、手動照建", async () => {
    const s = await setup();
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "admin" }]);
    await s.ctx.db.update(groups).set({ autoVersions: false }).where(eq(groups.id, g.id));
    const gnote = await seedNote(s.ctx.db, { groupId: g.id });
    expect(await cutPoints(s, gnote.id)).toEqual([0, 1]);
  });

  it("開關改了之後要重新載入才生效（A13、§13-11）", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "載入時開著");
    const r = await s.session.fetch("/api/auth/profile", { method: "PATCH", body: JSON.stringify({ autoVersions: false }) });
    expect(r.status).toBe(200);
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1); // 這個載入週期仍是開
    const again = await s.session.connect(n.id);
    await typeFirst(s.ctx, n.id, again, t => t.insert(0, "再載入後改"), x => x.includes("再載入後改"));
    again.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1); // 重新載入後關了：不切
  });
});

describe("指紋情境（r1 I-2）", () => {
  it("套用後打一字再刪 → 不 dirty；套用基底那一版本身（同內容）→ dirty=false 且 unload 不多切", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "第一版的文字");
    await s.session.fetch(`/api/notes/${n.id}/versions`, { method: "POST", body: JSON.stringify({}) });
    const [v1] = await versionsOf(s.ctx.db, n.id);
    const apply = await s.session.fetch(`/api/notes/${n.id}/versions/1/apply`, { method: "POST", body: JSON.stringify({ versionId: v1!.id, discardUnsaved: false }) });
    expect((await apply.json()).current.dirty).toBe(false);
    await typeFirst(s.ctx, n.id, client, t => t.insert(0, "Ж"), x => x.includes("Ж"));
    await typeFirst(s.ctx, n.id, client, t => t.delete(0, 1), x => !x.includes("Ж"));
    expect((await (await s.session.fetch(`/api/notes/${n.id}/versions`)).json()).current.dirty).toBe(false);
    client.disconnect();
    await s.unloaded();
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1);
  });
});

describe("版號併發（§11.2）", () => {
  it("同篇同時 10 次手動切版（各自不同內容、文件沒載入）→ 恰一版成功、其餘因基底改變而 null；再循序 9 次 → seq 1..10 連續＝計數", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    // barrier（`testHooks.afterMetaRead`）：10 個呼叫都讀完 meta 才一起放行，全部帶同一份舊基底（null）進交易——
    // 否則冷 pool 下先拿到暖連線的那一個會在其餘讀 meta 之前就 commit，後到者帶新基底再成功一次（實跑恆為 2）。
    let arrived = 0;
    let barrierOn = true;
    let release!: () => void;
    const all = new Promise<void>(r => { release = r; });
    const svc = createVersionService({
      db: s.ctx.db,
      log: s.ctx.app.log,
      testHooks: {
        afterMetaRead: async () => {
          if (!barrierOn) return;
          arrived += 1;
          if (arrived === 10) release();
          await all;
        },
      },
    });
    const docs = Array.from({ length: 10 }, (_, i) => paraDoc([`內容 ${i}`]));
    const results = await Promise.all(docs.map(d => svc.cutIfDirty(n.id, d, { kind: "manual", transient: d })));
    expect(arrived).toBe(10);
    expect(results.filter(r => r !== null && !("skipped" in r))).toHaveLength(1);
    expect(results.filter(r => r === null)).toHaveLength(9);
    barrierOn = false;
    for (let i = 0; i < 9; i += 1) {
      const d = paraDoc([`循序 ${i}`]);
      await svc.cutIfDirty(n.id, d, { kind: "manual", transient: d });
    }
    expect((await versionsOf(s.ctx.db, n.id)).map(v => v.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect((await noteBase(s.ctx.db, n.id)).counter).toBe(10);
  });

  it("載入中、同內容同時 10 次自動切版 → 恰一版；手動與計時器同內容撞版 → 總數恰 +1", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "同一份內容");
    const live = s.ctx.collab.hocuspocus.documents.get(n.id)!;
    await Promise.all(Array.from({ length: 10 }, () => s.ctx.collab.versions.cutIfDirty(n.id, live, { kind: "auto" })));
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(1);
    await typeFirst(s.ctx, n.id, client, t => t.insert(0, "再改"), x => x.includes("再改"));
    await Promise.all([
      s.ctx.collab.versions.cutIfDirty(n.id, live, { kind: "auto" }),
      s.ctx.collab.versions.cutIfDirty(n.id, live, { kind: "manual", name: "手動" }),
    ]);
    expect(await versionsOf(s.ctx.db, n.id)).toHaveLength(2);
    client.disconnect();
  });
});

describe("撤回也切版（§5.4）", () => {
  it("撤回前有人工未存修改 → 增 2 版（撤回前的人工、撤回後的 AI）", async () => {
    const s = await setup();
    const n = await s.ctx.createNote(s.u.id);
    const client = await seedContent(s.ctx, s.session, n.id, "撤回測試原文");
    const ai = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${n.id}/edits`, headers: bearer(s.token), payload: { op: "append", markdown: "AI 這段會被撤回" } });
    const editId = ai.json().editId as string;
    await typeFirst(s.ctx, n.id, client, t => t.insert(0, "人又改"), x => x.includes("人又改"));
    const before = (await versionsOf(s.ctx.db, n.id)).length;
    const rv = await s.ctx.app.inject({ method: "POST", url: `/api/notes/${n.id}/edits/${editId}/revert`, headers: bearer(s.token) });
    expect(rv.statusCode).toBe(201);
    expect((await versionsOf(s.ctx.db, n.id)).length - before).toBe(2);
    client.disconnect();
  });
});
