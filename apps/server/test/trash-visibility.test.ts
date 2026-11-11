/**
 * #181：「看得到」的單一閘口與讀取面（第 1～6、8 點；「移入前看得到、移入後看不到、還原又看得到」；
 * A2-6 目標在垃圾桶照記連結）。垃圾桶狀態以 `markTrashed`／`markRestored` 直寫（不經 `trashNotesInTx`）。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { and, eq } from "drizzle-orm";
import { NOTE_SCHEMA_VERSION, parseSiteNoteHref, type NoteDto } from "@knotebook/shared";
import type { Db } from "../src/db/index.js";
import { noteLinks } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { visibleNoteTargets, visibleTitlesByIds } from "../src/notes/editing/candidates.js";
import { fetchBacklinks } from "../src/notes/links.js";
import { searchNotesForUser } from "../src/notes/search-query.js";
import { NO_PERMISSIONS, noteIsLive, resolveNoteAccess, resolveTrashedNoteAccess } from "../src/notes/service.js";
import { createSiteLinkResolver, type SiteLinkScope } from "../src/notes/site-link-resolver.js";
import { writeLinksInTx } from "../src/notes/tx/write-links.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp, freshLimiters, testConfig } from "./helpers.js";
import { QUOTA_BOUNDARY, multipartFile, pngOf, seedAttachment } from "./storage-helpers.js";
import { inject, markRestored, markTrashed, sixRoleScene } from "./trash-helpers.js";
import { paraDoc } from "./version-helpers.js";

const NO_ACCESS_SHAPE = { role: "none", ownerId: null, groupId: null, permissions: NO_PERMISSIONS };
const pool = (db: Db) => db.$client;
const listIds = async (app: FastifyInstance, userId: string): Promise<string[]> =>
  ((await inject(app, "GET", "/api/notes", userId)).json() as NoteDto[]).map(n => n.id);
const token = () => randomBytes(32).toString("base64url");

describe("V1 GET /api/notes", () => {
  it("owner 的個人筆記、逐人分享 editor 的視角、群組 admin 的群組筆記：移入後消失、還原後回來；旁觀者全程都在", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const friend = await seedUser(db);
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const a = await seedNote(db, { ownerId: owner.id }, { title: "A" });
    const bystander = await seedNote(db, { ownerId: owner.id }, { title: "Bystander" });
    await seedShare(db, a.id, friend.id, "editor");
    const gn = await seedNote(db, { groupId: g.id }, { title: "GN" });

    const views = async () => ({ owner: await listIds(app, owner.id), friend: await listIds(app, friend.id), admin: await listIds(app, admin.id) });
    let v = await views();
    expect(v.owner).toEqual(expect.arrayContaining([a.id, bystander.id]));
    expect(v.friend).toContain(a.id);
    expect(v.admin).toContain(gn.id);

    await markTrashed(pool(db), a.id, owner.id);
    await markTrashed(pool(db), gn.id, admin.id);
    v = await views();
    expect(v.owner).toEqual([bystander.id]);
    expect(v.friend, "分享視角").not.toContain(a.id);
    expect(v.admin, "群組視角").not.toContain(gn.id);

    await markRestored(pool(db), a.id);
    await markRestored(pool(db), gn.id);
    v = await views();
    expect(v.owner).toEqual(expect.arrayContaining([a.id, bystander.id]));
    expect(v.friend).toContain(a.id);
    expect(v.admin).toContain(gn.id);
  });
});

describe("V2 搜尋", () => {
  it("searchNotesForUser 以標題命中：移入後不在結果、還原後回來（個人與群組各一；旁觀者全程都在）", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "admin" }]);
    const mine = await seedNote(db, { ownerId: u.id }, { title: "trashprobe mine" });
    const grp = await seedNote(db, { groupId: g.id }, { title: "trashprobe group" });
    const bystander = await seedNote(db, { ownerId: u.id }, { title: "trashprobe bystander" });
    const ids = async () => (await searchNotesForUser(db, { userId: u.id, query: "trashprobe", limit: 20 })).rows.map(r => r.id).sort();

    expect(await ids()).toEqual([mine.id, grp.id, bystander.id].sort());
    await markTrashed(pool(db), mine.id, u.id);
    await markTrashed(pool(db), grp.id, u.id);
    expect(await ids()).toEqual([bystander.id]);
    await markRestored(pool(db), mine.id);
    await markRestored(pool(db), grp.id);
    expect(await ids()).toEqual([mine.id, grp.id, bystander.id].sort());
  });
});

describe("V3 單篇讀取三形", () => {
  it("GET /api/notes/:id、/by-path、/by-group-path：移入後 404——有垃圾桶權者 in_trash（帶 noteId）、其他人 not_found（與不存在的 id 逐位元組相同）；還原後 200", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const friend = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "v3-personal" });
    const gn = await seedNote(db, { groupId: g.id }, { slug: "v3-group" });
    await seedShare(db, n.id, friend.id, "editor");
    const personal = [`/api/notes/${n.id}`, `/api/notes/by-path/${owner.handle}/v3-personal`];
    const grouped = [`/api/notes/${gn.id}`, `/api/notes/by-group-path/${g.id}/v3-group`];
    // 有垃圾桶權者（個人＝owner、群組＝admin）看 in_trash；分享 editor 與一般成員（無刪除權）看 not_found。
    const views: Array<[string, string, string, string | null]> = [
      ...personal.map((url): [string, string, string, string | null] => [url, owner.id, "owner", n.id]),
      ...grouped.map((url): [string, string, string, string | null] => [url, owner.id, "admin", gn.id]),
      ...personal.map((url): [string, string, string, string | null] => [url, friend.id, "friend", null]),
      ...grouped.map((url): [string, string, string, string | null] => [url, member.id, "member", null]),
    ];
    const missing = await inject(app, "GET", `/api/notes/${randomUUID()}`, owner.id);
    expect(missing.statusCode).toBe(404);

    for (const [url, userId, who] of views) expect((await inject(app, "GET", url, userId)).statusCode, `${who} ${url}`).toBe(200);
    await markTrashed(pool(db), n.id, owner.id);
    await markTrashed(pool(db), gn.id, owner.id);
    for (const [url, userId, who, trashId] of views) {
      const res = await inject(app, "GET", url, userId);
      expect(res.statusCode, `${who} ${url}`).toBe(404);
      if (trashId) expect(res.json(), `${who} ${url}`).toEqual({ error: { code: "in_trash", message: "This note is in the trash." }, noteId: trashId });
      else expect(res.body, `${who} ${url}`).toBe(missing.body);
    }
    await markRestored(pool(db), n.id);
    await markRestored(pool(db), gn.id);
    for (const [url, userId, who] of views) expect((await inject(app, "GET", url, userId)).statusCode, `${who} ${url}`).toBe(200);
  });
});

describe("V4 公開兩形＋附件", () => {
  it("移入後四支全部 404（body 與 token 不存在逐位元組相同）、記進 miss 桶；還原後 200", async () => {
    const publicMiss = new FixedWindowLimiter({ limit: 4, windowMs: 600_000 });
    const { app, db, uploadsDir } = await buildTestApp({ limiters: freshLimiters({ publicMiss }) });
    const owner = await seedUser(db);
    const tok = token();
    const p = await seedNote(db, { ownerId: owner.id }, { title: "Pub", publicToken: tok, publicSlug: "pub-v4" });
    const up = await seedAttachment(db, uploadsDir, p.id, owner.id, 12);
    const otherTok = token();
    await seedNote(db, { ownerId: owner.id }, { title: "Other", publicToken: otherTok });
    const urls = [
      `/api/public/notes/${tok}`,
      `/api/public/notes/${owner.handle}/pub-v4`,
      `/api/public/notes/${tok}/uploads/${up}`,
      `/api/public/notes/${owner.handle}/pub-v4/uploads/${up}`,
    ];
    const get = (url: string, ip: string) => app.inject({ method: "GET", url, remoteAddress: ip });

    for (const url of urls) expect((await get(url, "10.0.0.1")).statusCode, url).toBe(200);
    const missing = await get(`/api/public/notes/${token()}`, "10.0.0.3");
    expect(missing.statusCode).toBe(404);

    await markTrashed(pool(db), p.id, owner.id);
    // 四形先全部打完再一次比對（不在第一個失敗就停）：任一形漏判，× 訊息會列出是哪一形。
    const trashed: Array<[string, LightMyRequestResponse]> = [];
    for (const url of urls) trashed.push([url, await get(url, "10.0.0.2")]);
    expect(Object.fromEntries(trashed.map(([url, res]) => [url, res.statusCode]))).toEqual(Object.fromEntries(urls.map(url => [url, 404])));
    for (const [url, res] of trashed) expect(res.body, url).toBe(missing.body);
    // 四發都記進 miss 桶（額度 4）：同一 IP 的第五發即使打存在的公開筆記也 429。
    expect((await get(`/api/public/notes/${otherTok}`, "10.0.0.2")).statusCode).toBe(429);

    await markRestored(pool(db), p.id);
    for (const url of urls) expect((await get(url, "10.0.0.4")).statusCode, url).toBe(200);
  });
});

describe("V5 GET /api/uploads/:id", () => {
  it("owner 移入後 403，body 與陌生人對同一 upload 的 403 相同；還原後 200", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const stranger = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 12);
    const url = `/api/uploads/${up}`;

    expect((await inject(app, "GET", url, owner.id)).statusCode).toBe(200);
    const strangerRes = await inject(app, "GET", url, stranger.id);
    expect(strangerRes.statusCode).toBe(403);
    expect(strangerRes.json()).toEqual({ error: { code: "forbidden", message: "You don't have access to this file." } });

    await markTrashed(pool(db), n.id, owner.id);
    const res = await inject(app, "GET", url, owner.id);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(strangerRes.json());

    await markRestored(pool(db), n.id);
    expect((await inject(app, "GET", url, owner.id)).statusCode).toBe(200);
  });
});

describe("V6 反向連結（來源在垃圾桶）", () => {
  it("自己的 A、分享給讀者的 A'、讀者所在群組的 A''：各自移入 → B 的反向連結不含它、還原 → 含；旁觀者 C 全程都在", async () => {
    const { app, db } = await buildTestApp();
    const reader = await seedUser(db);
    const other = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: reader.id, role: "member" }]);
    const b = await seedNote(db, { ownerId: reader.id }, { title: "B" });
    const own = await seedNote(db, { ownerId: reader.id }, { title: "A" });
    const shared = await seedNote(db, { ownerId: other.id }, { title: "A'" });
    await seedShare(db, shared.id, reader.id, "viewer");
    const grouped = await seedNote(db, { groupId: g.id }, { title: "A''" });
    const c = await seedNote(db, { ownerId: reader.id }, { title: "C" });
    for (const src of [own, shared, grouped, c]) await db.insert(noteLinks).values({ sourceNoteId: src.id, targetNoteId: b.id });
    const backIds = async () =>
      ((await inject(app, "GET", `/api/notes/${b.id}/backlinks`, reader.id)).json() as { backlinks: Array<{ id: string }> }).backlinks.map(x => x.id).sort();
    const all = [own.id, shared.id, grouped.id, c.id].sort();

    expect(await backIds()).toEqual(all);
    for (const [label, src, by] of [["自有 A", own, reader.id], ["分享 A'", shared, other.id], ["群組 A''", grouped, reader.id]] as const) {
      await markTrashed(pool(db), src.id, by);
      expect(await backIds(), label).toEqual(all.filter(id => id !== src.id));
      await markRestored(pool(db), src.id);
      expect(await backIds(), label).toEqual(all);
    }
  });
});

describe("V7 A2-6：目標在垃圾桶、連結照記", () => {
  it("B 移入 → writeLinksInTx(A→B) 仍 applied 且 note_links 有 (A,B) → 還原 B → B 的反向連結含 A", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id }, { title: "A" });
    const b = await seedNote(db, { ownerId: owner.id }, { title: "B" });
    await markTrashed(pool(db), b.id, owner.id);
    const out = await db.transaction(tx => writeLinksInTx(tx, { sourceNoteId: a.id, userId: owner.id, targetIds: [b.id], clock: 1 }));
    expect(out).toBe("applied");
    expect(await db.select().from(noteLinks).where(and(eq(noteLinks.sourceNoteId, a.id), eq(noteLinks.targetNoteId, b.id)))).toHaveLength(1);
    await markRestored(pool(db), b.id);
    expect((await fetchBacklinks(db, b.id, owner.id)).map(x => x.id)).toEqual([a.id]);
  });
});

describe("V8 wikilink 候選", () => {
  it("visibleNoteTargets／visibleTitlesByIds：自有、分享、群組三支各一，移入後不含、還原後含", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const other = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: u.id, role: "member" }]);
    const own = await seedNote(db, { ownerId: u.id }, { title: "Own" });
    const shared = await seedNote(db, { ownerId: other.id }, { title: "Shared" });
    await seedShare(db, shared.id, u.id, "viewer");
    const grouped = await seedNote(db, { groupId: g.id }, { title: "Grouped" });
    const bystander = await seedNote(db, { ownerId: u.id }, { title: "Bystander" });
    const three = [["自有", own.id], ["分享", shared.id], ["群組", grouped.id]] as const;
    const targets = async () => (await visibleNoteTargets(db, u.id)).map(t => t.id);
    const byIds = async () => (await visibleTitlesByIds(db, u.id, three.map(([, id]) => id))).map(t => t.id);

    for (const [label, id] of three) {
      expect(await targets(), label).toContain(id);
      expect(await byIds(), label).toContain(id);
    }
    for (const [, id] of three) await markTrashed(pool(db), id, u.id);
    const t = await targets();
    const b = await byIds();
    for (const [label, id] of three) {
      expect(t, label).not.toContain(id);
      expect(b, label).not.toContain(id);
    }
    expect(t).toContain(bystander.id);
    for (const [, id] of three) await markRestored(pool(db), id);
    for (const [label, id] of three) {
      expect(await targets(), label).toContain(id);
      expect(await byIds(), label).toContain(id);
    }
  });
});

describe("V9 站內連結解析", () => {
  const ORIGIN = testConfig.publicUrl.origin;
  const resolveWith = async (db: Db, scope: SiteLinkScope, href: string) => {
    const parsed = parseSiteNoteHref(href, ORIGIN);
    if (!parsed) throw new Error(`parseSiteNoteHref(${href}) 回 null`);
    return createSiteLinkResolver(db, scope).resolve(href, parsed);
  };

  it("群組範圍：垃圾桶筆記的 /g/ 與 /notes/<id> 兩形回 null、活筆記回 {id,title}；使用者範圍也回 null；還原後解得到", async () => {
    const { db } = await buildTestApp();
    const admin = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }]);
    const a = await seedNote(db, { groupId: g.id }, { title: "A", slug: "v9-a" });
    const live = await seedNote(db, { groupId: g.id }, { title: "Live", slug: "v9-live" });
    const group: SiteLinkScope = { kind: "group", groupId: g.id };
    const user: SiteLinkScope = { kind: "user", userId: admin.id };

    expect(await resolveWith(db, group, `/g/${g.id}/v9-a`)).toEqual({ id: a.id, title: "A" });
    await markTrashed(pool(db), a.id, admin.id);
    expect(await resolveWith(db, group, `/g/${g.id}/v9-a`), "群組 /g/").toBeNull();
    expect(await resolveWith(db, group, `/notes/${a.id}`), "群組 /notes/").toBeNull();
    expect(await resolveWith(db, user, `/g/${g.id}/v9-a`), "使用者 /g/").toBeNull();
    expect(await resolveWith(db, user, `/notes/${a.id}`), "使用者 /notes/").toBeNull();
    expect(await resolveWith(db, group, `/g/${g.id}/v9-live`)).toEqual({ id: live.id, title: "Live" });
    await markRestored(pool(db), a.id);
    expect(await resolveWith(db, group, `/g/${g.id}/v9-a`)).toEqual({ id: a.id, title: "A" });
    expect(await resolveWith(db, group, `/notes/${a.id}`)).toEqual({ id: a.id, title: "A" });
  });

  it("查找序不變：活筆記 B 的 prev_slug 等於垃圾桶筆記 A 的現行 slug → 以 A 的 slug 解析回 null（不解到 B）；by-group-path 也 404（admin in_trash 指向 A、一般成員 not_found）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db);
    const member = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: admin.id, role: "admin" }, { userId: member.id, role: "member" }]);
    const a = await seedNote(db, { groupId: g.id }, { title: "A", slug: "v9-shared" });
    await seedNote(db, { groupId: g.id }, { title: "B", slug: "v9-b", prevSlug: "v9-shared" });
    await markTrashed(pool(db), a.id, admin.id);
    expect(await resolveWith(db, { kind: "group", groupId: g.id }, `/g/${g.id}/v9-shared`)).toBeNull();
    // REST 照同一查找序解到垃圾桶裡的 A（不是 B）：admin 有垃圾桶權 → in_trash 帶 A 的 id；一般成員 → not_found。
    const res = await inject(app, "GET", `/api/notes/by-group-path/${g.id}/v9-shared`, admin.id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "in_trash", message: "This note is in the trash." }, noteId: a.id });
    const missing = await inject(app, "GET", `/api/notes/${randomUUID()}`, member.id);
    const byMember = await inject(app, "GET", `/api/notes/by-group-path/${g.id}/v9-shared`, member.id);
    expect(byMember.statusCode).toBe(404);
    expect(byMember.body).toBe(missing.body);
  });
});

describe("V10 公開頁 links", () => {
  it("公開 P 的 wikilink 指向有別名的 T：T 移入 → links 不含 T；還原 → 含", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const pTok = token();
    const p = await seedNote(db, { ownerId: owner.id }, { title: "P", publicToken: pTok });
    const t = await seedNote(db, { ownerId: owner.id }, { title: "T", publicToken: token(), publicSlug: "v10-t" });
    await seedDoc(db, p.id, wikilinkDoc([t.id]));
    const links = async () => (await app.inject({ method: "GET", url: `/api/public/notes/${pTok}` })).json().links as Array<{ id: string }>;

    expect((await links()).map(l => l.id)).toEqual([t.id]);
    await markTrashed(pool(db), t.id, owner.id);
    expect(await links()).toEqual([]);
    await markRestored(pool(db), t.id);
    expect((await links()).map(l => l.id)).toEqual([t.id]);
  });
});

describe("V11 resolveNoteAccess 矩陣", () => {
  it("群組六角色＋非成員、個人 owner／分享 editor／viewer：移入後每一格 none；還原後回原值", async () => {
    const { db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const gn = await seedNote(db, { groupId: s.groupId });
    const owner = await seedUser(db);
    const editor = await seedUser(db);
    const viewer = await seedUser(db);
    const pn = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, pn.id, editor.id, "editor");
    await seedShare(db, pn.id, viewer.id, "viewer");
    const cells: Array<[string, string, string]> = [
      ...(["admin", "member", "editDelete", "deleteOnly", "editOnly", "readOnly", "outsider"] as const).map(
        (k): [string, string, string] => [`群組 ${k}`, s[k].id, gn.id],
      ),
      ["個人 owner", owner.id, pn.id],
      ["個人 editor", editor.id, pn.id],
      ["個人 viewer", viewer.id, pn.id],
    ];
    const snapshot = async () => Promise.all(cells.map(([, u, n]) => resolveNoteAccess(db, u, n)));

    const before = await snapshot();
    expect(before.filter(a => a.role !== "none")).toHaveLength(9); // 非成員以外都有權（前提）
    await markTrashed(pool(db), gn.id, s.admin.id);
    await markTrashed(pool(db), pn.id, owner.id);
    const trashed = await snapshot();
    cells.forEach(([label], i) => expect(trashed[i], label).toEqual(NO_ACCESS_SHAPE));
    await markRestored(pool(db), gn.id);
    await markRestored(pool(db), pn.id);
    const after = await snapshot();
    cells.forEach(([label], i) => expect(after[i], label).toEqual(before[i]));
  });
});

describe("V12 resolveTrashedNoteAccess 矩陣", () => {
  it("群組垃圾桶筆記：admin、editDelete 為 true；member、deleteOnly、editOnly、readOnly、outsider 為 false", async () => {
    const { db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const gn = await seedNote(db, { groupId: s.groupId });
    await markTrashed(pool(db), gn.id, s.admin.id);
    const expected = { admin: true, member: false, editDelete: true, deleteOnly: false, editOnly: false, readOnly: false, outsider: false } as const;
    for (const [k, want] of Object.entries(expected) as Array<[keyof typeof expected, boolean]>) {
      expect(await resolveTrashedNoteAccess(db, s[k].id, gn.id), k).toBe(want);
    }
  });

  it("個人垃圾桶筆記：owner true；分享 editor、陌生人 false", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const editor = await seedUser(db);
    const stranger = await seedUser(db);
    const pn = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, pn.id, editor.id, "editor");
    await markTrashed(pool(db), pn.id, owner.id);
    expect(await resolveTrashedNoteAccess(db, owner.id, pn.id), "owner").toBe(true);
    expect(await resolveTrashedNoteAccess(db, editor.id, pn.id), "分享 editor").toBe(false);
    expect(await resolveTrashedNoteAccess(db, stranger.id, pn.id), "陌生人").toBe(false);
  });

  it("活筆記對 owner false；不存在的 id、非 UUID 一律 false（不 throw）", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const live = await seedNote(db, { ownerId: owner.id });
    expect(await resolveTrashedNoteAccess(db, owner.id, live.id), "活筆記").toBe(false);
    expect(await resolveTrashedNoteAccess(db, owner.id, randomUUID()), "不存在").toBe(false);
    await expect(resolveTrashedNoteAccess(db, owner.id, "not-a-uuid"), "非 UUID").resolves.toBe(false);
  });
});

describe("V13 noteIsLive", () => {
  it("活 true、垃圾桶 false、不存在 false、非 UUID false（不 throw）", async () => {
    const { db } = await buildTestApp();
    const owner = await seedUser(db);
    const live = await seedNote(db, { ownerId: owner.id });
    const trashed = await seedNote(db, { ownerId: owner.id });
    await markTrashed(pool(db), trashed.id, owner.id);
    expect(await noteIsLive(db, live.id), "活").toBe(true);
    expect(await noteIsLive(db, trashed.id), "垃圾桶").toBe(false);
    expect(await noteIsLive(db, randomUUID()), "不存在").toBe(false);
    await expect(noteIsLive(db, "not-a-uuid"), "非 UUID").resolves.toBe(false);
  });
});

describe("V14 容量不排除", () => {
  it("readSpaceUsage（產品碼）：個人與群組空間的用量在移入前後相同（垃圾桶附件照算）", async () => {
    const { db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const g = await seedGroup(db, "G", [{ userId: owner.id, role: "admin" }]);
    const pn = await seedNote(db, { ownerId: owner.id });
    const gn = await seedNote(db, { groupId: g.id });
    await seedAttachment(db, uploadsDir, pn.id, owner.id, 1234, { noFile: true });
    await seedAttachment(db, uploadsDir, gn.id, owner.id, 4321, { noFile: true });
    const used = async () => [
      (await readSpaceUsage(db, { kind: "user", id: owner.id }))?.usedBytes,
      (await readSpaceUsage(db, { kind: "group", id: g.id }))?.usedBytes,
    ];
    expect(await used()).toEqual([1234, 4321]);
    await markTrashed(pool(db), pn.id, owner.id);
    await markTrashed(pool(db), gn.id, owner.id);
    expect(await used()).toEqual([1234, 4321]);
  });
});

// ───────────────────────────── V15／V16：每個單篇授權端點（表驅動） ─────────────────────────────

type Ctx = Awaited<ReturnType<typeof buildCollabTestApp>>;

interface Fixture {
  ownerId: string;
  friendId: string;
  thirdEmail: string;
  noteId: string;
  editId: string;
  seq: number;
  versionId: string;
  groupId: string;
}

/** owner 的個人筆記 n：有內容、一則 AI 修改紀錄、一版、開了 token、分享給 friend、一個附件；owner 是群組 g 的 admin（move 用）。 */
async function fixture(ctx: Ctx): Promise<Fixture> {
  const db = ctx.db;
  const owner = await seedUser(db);
  const friend = await seedUser(db);
  const third = await seedUser(db);
  const g = await seedGroup(db, "Move target", [{ userId: owner.id, role: "admin" }]);
  const n = await seedNote(db, { ownerId: owner.id }, { title: "Fixture" });
  await seedDoc(db, n.id, paraDoc(["內容"]));
  await seedShare(db, n.id, friend.id, "editor");
  await seedAttachment(db, ctx.uploadsDir, n.id, owner.id, 12);
  const edit = await inject(ctx.app, "POST", `/api/notes/${n.id}/edits`, owner.id, { op: "append", markdown: "AI 寫的" });
  expect(edit.statusCode, edit.body).toBe(201);
  const version = await inject(ctx.app, "POST", `/api/notes/${n.id}/versions`, owner.id, {});
  expect(version.statusCode, version.body).toBe(201);
  const pub = await inject(ctx.app, "PUT", `/api/notes/${n.id}/public-link`, owner.id);
  expect(pub.statusCode, pub.body).toBe(200);
  return {
    ownerId: owner.id, friendId: friend.id, thirdEmail: third.email, noteId: n.id,
    editId: edit.json().editId as string, seq: version.json().seq as number, versionId: version.json().id as string, groupId: g.id,
  };
}

interface Row {
  name: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: (f: Fixture) => string;
  payload?: (f: Fixture) => unknown;
  multipart?: true;
}

const ROWS: Row[] = [
  { name: "GET …/content", method: "GET", url: f => `/api/notes/${f.noteId}/content` },
  { name: "POST …/edits", method: "POST", url: f => `/api/notes/${f.noteId}/edits`, payload: () => ({ op: "append", markdown: "more" }) },
  { name: "GET …/edits", method: "GET", url: f => `/api/notes/${f.noteId}/edits` },
  { name: "POST …/edits/:editId/revert", method: "POST", url: f => `/api/notes/${f.noteId}/edits/${f.editId}/revert` },
  { name: "PATCH /api/notes/:id", method: "PATCH", url: f => `/api/notes/${f.noteId}`, payload: () => ({ title: "Renamed" }) },
  { name: "POST …/links", method: "POST", url: f => `/api/notes/${f.noteId}/links`, payload: () => ({ link_target_ids: [] }) },
  { name: "GET …/backlinks", method: "GET", url: f => `/api/notes/${f.noteId}/backlinks` },
  { name: "GET …/shares", method: "GET", url: f => `/api/notes/${f.noteId}/shares` },
  { name: "PUT …/shares", method: "PUT", url: f => `/api/notes/${f.noteId}/shares`, payload: f => ({ email: f.thirdEmail, role: "viewer" }) },
  { name: "DELETE …/shares/:friend", method: "DELETE", url: f => `/api/notes/${f.noteId}/shares/${f.friendId}` },
  { name: "GET …/public-link", method: "GET", url: f => `/api/notes/${f.noteId}/public-link` },
  { name: "PUT …/public-link", method: "PUT", url: f => `/api/notes/${f.noteId}/public-link` },
  { name: "DELETE …/public-link", method: "DELETE", url: f => `/api/notes/${f.noteId}/public-link` },
  { name: "PUT …/public-width", method: "PUT", url: f => `/api/notes/${f.noteId}/public-width`, payload: () => ({ width: "wide" }) },
  { name: "PUT …/public-link/slug", method: "PUT", url: f => `/api/notes/${f.noteId}/public-link/slug`, payload: () => ({ slug: "v15-pub" }) },
  { name: "DELETE …/public-link/slug", method: "DELETE", url: f => `/api/notes/${f.noteId}/public-link/slug` },
  { name: "POST …/move", method: "POST", url: f => `/api/notes/${f.noteId}/move`, payload: f => ({ groupId: f.groupId }) },
  { name: "POST …/copy", method: "POST", url: f => `/api/notes/${f.noteId}/copy`, payload: () => ({}) },
  { name: "POST …/uploads", method: "POST", url: f => `/api/notes/${f.noteId}/uploads`, multipart: true },
  { name: "GET …/versions", method: "GET", url: f => `/api/notes/${f.noteId}/versions` },
  { name: "GET …/versions/:seq", method: "GET", url: f => `/api/notes/${f.noteId}/versions/${f.seq}` },
  { name: "POST …/versions", method: "POST", url: f => `/api/notes/${f.noteId}/versions`, payload: () => ({}) },
  { name: "POST …/versions/:seq/apply", method: "POST", url: f => `/api/notes/${f.noteId}/versions/${f.seq}/apply`, payload: f => ({ versionId: f.versionId, discardUnsaved: true }) },
  { name: "PATCH …/versions/:seq", method: "PATCH", url: f => `/api/notes/${f.noteId}/versions/${f.seq}`, payload: () => ({ name: "v" }) },
  { name: "DELETE …/versions/:seq", method: "DELETE", url: f => `/api/notes/${f.noteId}/versions/${f.seq}` },
  { name: "POST /api/ai", method: "POST", url: () => "/api/ai", payload: f => ({ action_id: randomUUID(), note_id: f.noteId, text: "x" }) },
];

async function send(app: FastifyInstance, row: Row, f: Fixture, userId: string): Promise<LightMyRequestResponse> {
  if (row.multipart) {
    return app.inject({
      method: row.method,
      url: row.url(f),
      payload: multipartFile(pngOf(16)),
      headers: { "content-type": `multipart/form-data; boundary=${QUOTA_BOUNDARY}` },
      cookies: await cookieOf(userId),
    });
  }
  return inject(app, row.method, row.url(f), userId, row.payload?.(f));
}

/** 同一列、同一位使用者，筆記 id 換成隨機 uuid（其餘欄沿用）。 */
const withRandomNote = (f: Fixture): Fixture => ({ ...f, noteId: randomUUID() });

describe("V15 每個單篇授權端點：移入前不是授權 404 → 移入後 404（與隨機 uuid 逐位元組相同）→ 還原後同移入前", () => {
  it.each(ROWS.map(r => [r.name, r] as const))("%s", async (_name, row) => {
    const ctx = await buildCollabTestApp();
    const [f1, f2, f3] = [await fixture(ctx), await fixture(ctx), await fixture(ctx)];

    const before = await send(ctx.app, row, f1, f1.ownerId);
    const missing1 = await send(ctx.app, row, withRandomNote(f1), f1.ownerId);
    expect(missing1.statusCode, `${row.name} 隨機 uuid`).toBe(404);
    expect(before.statusCode !== 404 || before.body !== missing1.body, `${row.name} 移入前：${before.statusCode} ${before.body}`).toBe(true);

    await markTrashed(pool(ctx.db), f2.noteId, f2.ownerId);
    const trashed = await send(ctx.app, row, f2, f2.ownerId);
    const missing2 = await send(ctx.app, row, withRandomNote(f2), f2.ownerId);
    expect(trashed.statusCode, `${row.name} 移入後：${trashed.body}`).toBe(404);
    expect(trashed.body).toBe(missing2.body);

    await markTrashed(pool(ctx.db), f3.noteId, f3.ownerId);
    await markRestored(pool(ctx.db), f3.noteId);
    const restored = await send(ctx.app, row, f3, f3.ownerId);
    expect(restored.statusCode, `${row.name} 還原後：${restored.body}`).toBe(before.statusCode);
  });

  it("POST …/collab-token：移入前 owner → 移入後 none（200，不是 404）→ 還原後 owner", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await seedUser(ctx.db);
    const n = await seedNote(ctx.db, { ownerId: owner.id });
    const role = async () => {
      const res = await inject(ctx.app, "POST", `/api/notes/${n.id}/collab-token`, owner.id, { noteSchemaVersion: NOTE_SCHEMA_VERSION });
      expect(res.statusCode).toBe(200);
      return res.json().role as string;
    };
    expect(await role()).toBe("owner");
    await markTrashed(pool(ctx.db), n.id, owner.id);
    expect(await role()).toBe("none");
    await markRestored(pool(ctx.db), n.id);
    expect(await role()).toBe("owner");
  });
});

describe("V16 對照：同一張表對別人的活筆記（陌生人視角）全部是同一條 404", () => {
  it("每一列：陌生人打 owner 的活筆記 → 404，body 與隨機 uuid 逐位元組相同", async () => {
    const ctx = await buildCollabTestApp();
    const f = await fixture(ctx);
    const stranger = await seedUser(ctx.db);
    for (const row of ROWS) {
      const res = await send(ctx.app, row, f, stranger.id);
      const missing = await send(ctx.app, row, withRandomNote(f), stranger.id);
      expect(res.statusCode, `${row.name}：${res.body}`).toBe(404);
      expect(res.body, row.name).toBe(missing.body);
    }
  });
});
