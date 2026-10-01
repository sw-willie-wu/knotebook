/**
 * #175 §6.1／§6.4／Q22：NoteDto 新形、by-path 兩形的查找序（現行 → 轉址 → prev）、四種 404 逐位元組相同、
 * RF1（大寫 group id）、RF3（migration 後的舊形 legacy 網址）。PR1 沒有寫轉址的生產路徑——轉址列用 seedRedirect 直插。
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { noteRedirects, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { recordRedirectsInTx } from "../src/notes/tx/redirects.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRedirect, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const NOT_FOUND = { error: { code: "not_found", message: "找不到此筆記" } };
/** 內建一般成員（can_read＋can_edit）在群組筆記上的旗標（§5.2）。 */
const MEMBER_PERMS = { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };
/** 只讀自訂角色（can_read）。 */
const READER_PERMS = { read: true, edit: false, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };

async function get(app: FastifyInstance, url: string, userId: string) {
  return app.inject({ method: "GET", url, cookies: await cookieOf(userId) });
}

async function scene(db: Db) {
  const [admin, member, reader, blind, outsider] = await Promise.all(Array.from({ length: 5 }, () => seedUser(db)));
  const g = await seedGroup(db, "Team", [
    { userId: admin.id, role: "admin" }, { userId: member.id, role: "member" },
    { userId: reader.id, role: "member" }, { userId: blind.id, role: "member" },
  ]);
  await setMemberRole(db, g.id, reader.id, await seedRole(db, g.id, "Reader", { canRead: true }));
  await setMemberRole(db, g.id, blind.id, await seedRole(db, g.id, "Nothing", { canManageMembers: true }));
  return { admin, member, reader, blind, outsider, g };
}

describe("#175 NoteDto 新形（§6.1）", () => {
  it("GET /api/notes：群組筆記 ownerId/ownerHandle null、groupId 與 group 有值、permissions 依角色；個人筆記 owner 全真；鍵集合", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const gn = await seedNote(db, { groupId: s.g.id }, { title: "GN" });
    const mine = await seedNote(db, { ownerId: s.member.id }, { title: "Mine" });
    const res = await get(app, "/api/notes", s.member.id);
    expect(res.statusCode).toBe(200);
    const byId = new Map(res.json().map((n: { id: string }) => [n.id, n]));
    expect(byId.get(gn.id)).toMatchObject({
      ownerId: null, ownerHandle: null, groupId: s.g.id, group: { id: s.g.id, name: "Team" }, role: "editor",
      permissions: { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false },
    });
    expect(byId.get(mine.id)).toMatchObject({ ownerId: s.member.id, groupId: null, group: null, role: "owner",
      permissions: { read: true, edit: true, delete: true, manageShares: true, managePublicLink: true, changeSlug: true, moveToGroup: true } });
    expect(Object.keys(byId.get(gn.id) as object).sort()).toEqual([
      "createdAt", "group", "groupId", "id", "lastEdited", "ownerHandle", "ownerId", "permissions", "prevSlug", "role", "slug", "slugIsCustom", "title", "updatedAt",
    ]);
    const adminRow = (await get(app, "/api/notes", s.admin.id)).json().find((n: { id: string }) => n.id === gn.id);
    expect(adminRow.permissions).toMatchObject({ delete: true, managePublicLink: true, changeSlug: true, manageShares: false, moveToGroup: false });
  });
});

describe("#175 by-path 兩形（§6.4）", () => {
  it("/g/：現行 slug 200；轉址（未過期）200 回目標；轉址已過期 404 且該列被刪；prev_slug 200；活網址勝轉址；轉址勝 prev", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const live = await seedNote(db, { groupId: s.g.id }, { slug: "live" });
    const target = await seedNote(db, { groupId: s.g.id }, { slug: "target" });
    const other = await seedNote(db, { groupId: s.g.id }, { slug: "other", prevSlug: "both" });
    await seedNote(db, { groupId: s.g.id }, { slug: "prev-holder", prevSlug: "old-prev" });
    await seedRedirect(db, `/g/${s.g.id}/moved`, target.id);
    await seedRedirect(db, `/g/${s.g.id}/stale`, target.id, { expired: true });
    await seedRedirect(db, `/g/${s.g.id}/live`, target.id); // 活網址同鍵
    await seedRedirect(db, `/g/${s.g.id}/both`, target.id); // 轉址與 prev 同鍵：轉址勝（B4 查找序）
    const base = `/api/notes/by-group-path/${s.g.id}`;
    expect((await get(app, `${base}/live`, s.member.id)).json().id).toBe(live.id);
    expect((await get(app, `${base}/moved`, s.member.id)).json()).toMatchObject({
      id: target.id, slug: "target", groupId: s.g.id, group: { id: s.g.id, name: "Team" }, role: "editor", permissions: MEMBER_PERMS,
    });
    const stale = await get(app, `${base}/stale`, s.member.id);
    expect(stale.statusCode).toBe(404);
    expect(await db.select().from(noteRedirects).where(eq(noteRedirects.oldPath, `/g/${s.g.id}/stale`))).toEqual([]);
    expect((await get(app, `${base}/old-prev`, s.member.id)).json().slug).toBe("prev-holder");
    expect((await get(app, `${base}/both`, s.member.id)).json().id).toBe(target.id);
    expect(other.id).not.toBe(target.id);
  });

  it("/n/：同一套順序（精確 → 轉址 → prev）；轉址到我沒權限的筆記 → 404；轉址到群組筆記回 groupId（web 據此 replaceState 到 /g/）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const owner = await seedUser(db);
    const personal = await seedNote(db, { ownerId: owner.id }, { slug: "p", prevSlug: "p-old" });
    const gn = await seedNote(db, { groupId: s.g.id }, { slug: "gn" });
    await seedRedirect(db, `/n/${owner.handle}/went-to-group`, gn.id);
    await seedRedirect(db, `/n/${owner.handle}/p-old`, gn.id); // 轉址勝 prev
    expect((await get(app, `/api/notes/by-path/${owner.handle}/p`, owner.id)).json().id).toBe(personal.id);
    expect((await get(app, `/api/notes/by-path/${owner.handle}/went-to-group`, s.member.id)).json()).toMatchObject({
      id: gn.id, groupId: s.g.id, ownerHandle: null, ownerId: null, group: { id: s.g.id, name: "Team" }, role: "editor", permissions: MEMBER_PERMS,
    });
    // 轉址鍵用**正規化後**的 handle（比照 RF1）：大寫 handle 的網址也命中轉址
    expect((await get(app, `/api/notes/by-path/${owner.handle.toUpperCase()}/went-to-group`, s.member.id)).json().id).toBe(gn.id);
    expect((await get(app, `/api/notes/by-path/${owner.handle}/p-old`, s.member.id)).json().id).toBe(gn.id);
    // owner 不是群組成員：轉址解得到 id，但授權 none → 同一條 404
    const denied = await get(app, `/api/notes/by-path/${owner.handle}/went-to-group`, owner.id);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(NOT_FOUND);
  });

  it("四種 404 逐位元組相同：/g/<非 UUID>、群組不存在、非成員、成員但角色無閱讀旗標", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    await seedNote(db, { groupId: s.g.id }, { slug: "x" });
    const bodies = [
      await get(app, `/api/notes/by-group-path/not-a-uuid/x`, s.member.id),
      await get(app, `/api/notes/by-group-path/00000000-0000-4000-8000-00000000dead/x`, s.member.id),
      await get(app, `/api/notes/by-group-path/${s.g.id}/x`, s.outsider.id),
      await get(app, `/api/notes/by-group-path/${s.g.id}/x`, s.blind.id),
    ];
    for (const r of bodies) expect(r.statusCode).toBe(404);
    expect(new Set(bodies.map(r => r.body)).size).toBe(1);
    expect(bodies[0]!.json()).toEqual(NOT_FOUND);
  });

  it("RF1：/g/<大寫 UUID>/<slug> 與小寫同樣 200；轉址鍵以小寫比對（大寫網址也命中轉址）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const n = await seedNote(db, { groupId: s.g.id }, { slug: "case" });
    await seedRedirect(db, `/g/${s.g.id}/old-case`, n.id);
    const upper = s.g.id.toUpperCase();
    expect((await get(app, `/api/notes/by-group-path/${upper}/case`, s.member.id)).json().id).toBe(n.id);
    expect((await get(app, `/api/notes/by-group-path/${upper}/old-case`, s.member.id)).json().id).toBe(n.id);
  });

  it("RF3：migration 後群組筆記的舊形 /notes/<legacy_slug>——成員 200 且 groupId 有值；已不是成員的原 owner 404（Q5）", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const formerOwner = await seedUser(db);
    const n = await seedNote(db, { groupId: s.g.id }, { slug: "plan", legacySlug: "legacy-plan-x" });
    const ok = await get(app, `/api/notes/legacy-plan-x`, s.reader.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      id: n.id, groupId: s.g.id, ownerId: null, ownerHandle: null, role: "viewer", group: { id: s.g.id, name: "Team" }, permissions: READER_PERMS,
    });
    expect((await get(app, `/api/notes/legacy-plan-x`, formerOwner.id)).json()).toEqual(NOT_FOUND);
  });
});

describe("#175 Q22：授權與取列之間歸屬變了（PR2 的移動；這裡以 SQL 模擬）", () => {
  it(":ref——移進 owner 也是成員的群組 → 重讀後 200 且帶群組；移進 owner 不是成員的群組 → 404", async () => {
    const s = { hookNote: "", moveTo: "" };
    const built = await buildTestApp({
      groupTestHook: async (point, ctx) => {
        if (point !== "ref-authorized" || ctx.noteId !== s.hookNote) return;
        await built.db.update(notes).set({ ownerId: null, groupId: s.moveTo }).where(eq(notes.id, s.hookNote));
      },
    });
    const { app, db } = built;
    const owner = await seedUser(db);
    const joined = await seedGroup(db, "Joined", [{ userId: owner.id, role: "member" }]);
    const foreign = await seedGroup(db, "Foreign", [{ userId: (await seedUser(db)).id, role: "admin" }]);
    const a = await seedNote(db, { ownerId: owner.id });
    Object.assign(s, { hookNote: a.id, moveTo: joined.id });
    expect((await get(app, `/api/notes/${a.id}`, owner.id)).json()).toMatchObject({
      id: a.id, role: "editor", groupId: joined.id, ownerId: null, ownerHandle: null, group: { id: joined.id, name: "Joined" }, permissions: MEMBER_PERMS,
    });
    const b = await seedNote(db, { ownerId: owner.id });
    Object.assign(s, { hookNote: b.id, moveTo: foreign.id });
    expect((await get(app, `/api/notes/${b.id}`, owner.id)).json()).toEqual(NOT_FOUND);
  });
});

describe("#175 recordRedirectsInTx（§4.3；PR2／PR4 的寫入 helper）", () => {
  it("先清過期列、再 upsert：同鍵改指新筆記並續命；其他未過期列不動", async () => {
    const { db } = await buildTestApp();
    const u = await seedUser(db);
    const [a, b, c] = await Promise.all([seedNote(db, { ownerId: u.id }), seedNote(db, { ownerId: u.id }), seedNote(db, { ownerId: u.id })]);
    await seedRedirect(db, "/n/x/expired", a.id, { expired: true });
    await seedRedirect(db, "/n/x/keep", a.id);
    await seedRedirect(db, "/n/x/same", a.id);
    await db.transaction(tx => recordRedirectsInTx(tx, ["/n/x/same", "/n/x/new"], b.id));
    const rows = await db.select({ p: noteRedirects.oldPath, n: noteRedirects.noteId }).from(noteRedirects);
    expect(rows.sort((x, y) => x.p.localeCompare(y.p))).toEqual([
      { p: "/n/x/keep", n: a.id }, { p: "/n/x/new", n: b.id }, { p: "/n/x/same", n: b.id },
    ]);
    expect(c.id).toBeTruthy();
  });
});

describe("#175 PR2：by-path「取列後、授權前」被真的移動（path-resolved；PR1 Task 4 review M-1）", () => {
  it("/n/ 形——owner 自己開、取列後被移進他是成員的群組 → 200 且帶新群組（authorizeRow 的重讀段承重）", async () => {
    const s = { fire: undefined as undefined | (() => Promise<unknown>) };
    const built = await buildTestApp({
      groupTestHook: async point => {
        if (point === "path-resolved" && s.fire) {
          const f = s.fire;
          s.fire = undefined;
          await f();
        }
      },
    });
    const { app, db } = built;
    const owner = await seedUser(db);
    const g = await seedGroup(db, "Joined", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "p" });
    let moveStatus: number | undefined;
    s.fire = async () => {
      const r = await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies: await cookieOf(owner.id), payload: { groupId: g.id } });
      moveStatus = r.statusCode;
    };
    const res = await get(app, `/api/notes/by-path/${owner.handle}/p`, owner.id);
    expect(moveStatus).toBe(200);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: n.id, groupId: g.id, ownerId: null, ownerHandle: null, role: "editor", group: { id: g.id, name: "Joined" }, permissions: MEMBER_PERMS,
    });
  });

  it("/n/ 形——逐人分享的 editor 開、取列後 owner 把它移進他不在的群組 → 404（與不存在逐位元組相同）", async () => {
    const s = { fire: undefined as undefined | (() => Promise<unknown>) };
    const built = await buildTestApp({
      groupTestHook: async point => {
        if (point === "path-resolved" && s.fire) {
          const f = s.fire;
          s.fire = undefined;
          await f();
        }
      },
    });
    const { app, db } = built;
    const [owner, ed] = await Promise.all([seedUser(db), seedUser(db)]);
    const g = await seedGroup(db, "OwnersOnly", [{ userId: owner.id, role: "member" }]);
    const n = await seedNote(db, { ownerId: owner.id }, { slug: "p" });
    await seedShare(db, n.id, ed.id, "editor");
    // 前提：移動前 editor 開得到。
    expect((await get(app, `/api/notes/by-path/${owner.handle}/p`, ed.id)).json()).toMatchObject({ id: n.id, role: "editor", groupId: null });
    let moveStatus: number | undefined;
    s.fire = async () => {
      const r = await app.inject({ method: "POST", url: `/api/notes/${n.id}/move`, cookies: await cookieOf(owner.id), payload: { groupId: g.id } });
      moveStatus = r.statusCode;
    };
    const res = await get(app, `/api/notes/by-path/${owner.handle}/p`, ed.id);
    expect(moveStatus).toBe(200);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
    expect(res.body).toBe((await get(app, `/api/notes/by-path/${owner.handle}/no-such-note`, ed.id)).body);
  });
});

describe("#175 PR2：by-path /g/ 形「取列後、授權前」被移到別的群組（path-resolved；SQL 模擬——PR2 沒有群組間移動的生產路徑）", () => {
  function hookApp(fire: { f?: () => Promise<unknown> }) {
    return buildTestApp({
      groupTestHook: async point => {
        if (point === "path-resolved" && fire.f) {
          const f = fire.f;
          fire.f = undefined;
          await f();
        }
      },
    });
  }
  it("/g/ 形——取列後被移到呼叫者也是成員的另一群組 → 200 帶新群組", async () => {
    const fire: { f?: () => Promise<unknown> } = {};
    const { app, db } = await hookApp(fire);
    const u = await seedUser(db);
    const g1 = await seedGroup(db, "G1", [{ userId: u.id, role: "member" }]);
    const g2 = await seedGroup(db, "G2", [{ userId: u.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g1.id }, { slug: "p" });
    fire.f = async () => db.update(notes).set({ groupId: g2.id }).where(eq(notes.id, n.id));
    const res = await get(app, `/api/notes/by-group-path/${g1.id}/p`, u.id);
    expect(fire.f).toBeUndefined();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: n.id, groupId: g2.id, group: { id: g2.id, name: "G2" }, role: "editor", permissions: MEMBER_PERMS });
  });
  it("/g/ 形——取列後被移到呼叫者不在的群組 → 404（與不存在逐位元組相同）、不含新群組名", async () => {
    const fire: { f?: () => Promise<unknown> } = {};
    const { app, db } = await hookApp(fire);
    const [u, other] = await Promise.all([seedUser(db), seedUser(db)]);
    const g1 = await seedGroup(db, "G1", [{ userId: u.id, role: "member" }]);
    const g2 = await seedGroup(db, "HiddenG2", [{ userId: other.id, role: "member" }]);
    const n = await seedNote(db, { groupId: g1.id }, { slug: "p" });
    fire.f = async () => db.update(notes).set({ groupId: g2.id }).where(eq(notes.id, n.id));
    const res = await get(app, `/api/notes/by-group-path/${g1.id}/p`, u.id);
    expect(fire.f).toBeUndefined();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual(NOT_FOUND);
    expect(res.body).not.toContain("HiddenG2");
    expect(res.body).toBe((await get(app, `/api/notes/by-group-path/${g1.id}/no-such-note`, u.id)).body);
  });
});
