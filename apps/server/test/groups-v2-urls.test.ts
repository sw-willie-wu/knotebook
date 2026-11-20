/** Redirect rows are inserted with seedRedirect: the only production path that writes redirects is move. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type pino from "pino";
import { backfillHandleRegistry } from "../src/auth/handle.js";
import { noteRedirects, notes } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { recordRedirectsInTx } from "../src/notes/tx/redirects.js";
import { buildTestApp } from "./helpers.js";
import { cookieOf, seedGroup, seedNote, seedRedirect, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";

const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };
const MEMBER_PERMS = { read: true, edit: true, delete: false, manageShares: false, managePublicLink: false, changeSlug: false, moveToGroup: false };
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

describe("#175 NoteDto new shape", () => {
  it("GET /api/notes: group notes have ownerId/ownerHandle null, groupId and group set, permissions from the role; personal notes have all owner permissions; key set", async () => {
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
      "createdAt", "folderId", "group", "groupId", "id", "lastEdited", "ownerHandle", "ownerId", "permissions", "prevSlug", "role", "sizeBytes", "slug", "slugIsCustom", "tags", "title", "updatedAt",
    ]);
    const adminRow = (await get(app, "/api/notes", s.admin.id)).json().find((n: { id: string }) => n.id === gn.id);
    expect(adminRow.permissions).toMatchObject({ delete: true, managePublicLink: true, changeSlug: true, manageShares: false, moveToGroup: false });
  });
});

describe("#175 by-path shapes", () => {
  it("/g/: live slug 200; unexpired redirect 200 to the target; expired redirect 404 and the row is deleted; prev_slug 200; live URL wins over redirect; redirect wins over prev", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const live = await seedNote(db, { groupId: s.g.id }, { slug: "live" });
    const target = await seedNote(db, { groupId: s.g.id }, { slug: "target" });
    const other = await seedNote(db, { groupId: s.g.id }, { slug: "other", prevSlug: "both" });
    await seedNote(db, { groupId: s.g.id }, { slug: "prev-holder", prevSlug: "old-prev" });
    await seedRedirect(db, `/g/${s.g.id}/moved`, target.id);
    await seedRedirect(db, `/g/${s.g.id}/stale`, target.id, { expired: true });
    await seedRedirect(db, `/g/${s.g.id}/live`, target.id); // same key as a live URL
    await seedRedirect(db, `/g/${s.g.id}/both`, target.id); // redirect and prev share a key: redirect wins (lookup order)
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

  it("/n/: same order (exact -> redirect -> prev); redirect to a note I can't access -> 404; redirect to a group note returns groupId (the web uses it to replaceState to /g/)", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const owner = await seedUser(db);
    const personal = await seedNote(db, { ownerId: owner.id }, { slug: "p", prevSlug: "p-old" });
    const gn = await seedNote(db, { groupId: s.g.id }, { slug: "gn" });
    await seedRedirect(db, `/n/${owner.handle}/went-to-group`, gn.id);
    await seedRedirect(db, `/n/${owner.handle}/p-old`, gn.id); // redirect wins over prev
    expect((await get(app, `/api/notes/by-path/${owner.handle}/p`, owner.id)).json().id).toBe(personal.id);
    expect((await get(app, `/api/notes/by-path/${owner.handle}/went-to-group`, s.member.id)).json()).toMatchObject({
      id: gn.id, groupId: s.g.id, ownerHandle: null, ownerId: null, group: { id: s.g.id, name: "Team" }, role: "editor", permissions: MEMBER_PERMS,
    });
    // Redirect keys use the normalized handle: a URL with an uppercase handle also hits the redirect.
    expect((await get(app, `/api/notes/by-path/${owner.handle.toUpperCase()}/went-to-group`, s.member.id)).json().id).toBe(gn.id);
    expect((await get(app, `/api/notes/by-path/${owner.handle}/p-old`, s.member.id)).json().id).toBe(gn.id);
    // Owner isn't a group member: the redirect resolves to the id but authorization is none -> the same 404.
    const denied = await get(app, `/api/notes/by-path/${owner.handle}/went-to-group`, owner.id);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual(NOT_FOUND);
  });

  it("#291: /n/<old name>/<slug> after the old name was taken by someone else - the old redirect still leads to the original note if the new owner has no such slug; if they do, the exact match hits their note", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const x = await seedUser(db);
    const y = await seedUser(db);
    await backfillHandleRegistry(db, { warn: () => {}, info: () => {} } as unknown as pino.Logger);
    const gn = await seedNote(db, { groupId: s.g.id }, { slug: "gn" });
    await seedRedirect(db, `/n/${x.handle}/moved`, gn.id);
    const old = x.handle;
    const patch = async (userId: string, handle: string) =>
      app.inject({ method: "PATCH", url: "/api/auth/profile", payload: { handle }, cookies: await cookieOf(userId) });
    expect((await patch(x.id, `${old}-new`)).statusCode).toBe(200);
    expect((await get(app, `/api/notes/by-path/${old}/moved`, s.member.id)).json().id).toBe(gn.id);
    expect((await patch(y.id, old)).statusCode).toBe(200);
    expect((await get(app, `/api/notes/by-path/${old}/moved`, s.member.id)).json().id).toBe(gn.id);
    const yn = await seedNote(db, { ownerId: y.id }, { slug: "moved" });
    expect((await get(app, `/api/notes/by-path/${old}/moved`, y.id)).json().id).toBe(yn.id);
    // Group member can't read Y's note: 404, doesn't leak the old redirect.
    const masked = await get(app, `/api/notes/by-path/${old}/moved`, s.member.id);
    expect(masked.statusCode).toBe(404);
    expect(masked.json()).toEqual(NOT_FOUND);
  });

  it("four 404s are byte-identical: /g/<non-UUID>, missing group, non-member, member whose role lacks the read flag", async () => {
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

  it("/g/<uppercase UUID>/<slug> gives 200 like lowercase; redirect keys are matched in lowercase (an uppercase URL also hits the redirect)", async () => {
    const { app, db } = await buildTestApp();
    const s = await scene(db);
    const n = await seedNote(db, { groupId: s.g.id }, { slug: "case" });
    await seedRedirect(db, `/g/${s.g.id}/old-case`, n.id);
    const upper = s.g.id.toUpperCase();
    expect((await get(app, `/api/notes/by-group-path/${upper}/case`, s.member.id)).json().id).toBe(n.id);
    expect((await get(app, `/api/notes/by-group-path/${upper}/old-case`, s.member.id)).json().id).toBe(n.id);
  });

  it("old-shape /notes/<legacy_slug> of a group note after migration: member 200 with groupId set; the former owner, no longer a member, 404", async () => {
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

describe("#175: ownership changes between authorization and row fetch (move, simulated with SQL here)", () => {
  it(":ref - moved into a group the owner is also a member of -> 200 with the group after the re-read; moved into a group the owner is not in -> 404", async () => {
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

describe("#175 recordRedirectsInTx (write helper for group-delete transfer)", () => {
  it("clears expired rows first, then upserts: the same key is re-pointed to the new note and renewed; other unexpired rows untouched", async () => {
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

describe("#175: by-path really moved between row fetch and authorization (path-resolved)", () => {
  it("/n/ shape - owner opens it, it is moved into a group they belong to after the row fetch -> 200 with the new group (the re-read in authorizeRow is load-bearing)", async () => {
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

  it("/n/ shape - a per-user editor opens it, the owner moves it into a group they're not in after the row fetch -> 404 (byte-identical to missing)", async () => {
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

describe("#175: by-path /g/ shape moved to another group between row fetch and authorization (path-resolved; simulated with SQL, no production path moves between groups)", () => {
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
  it("/g/ shape - moved after the row fetch to another group the caller also belongs to -> 200 with the new group", async () => {
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
  it("/g/ shape - moved after the row fetch to a group the caller isn't in -> 404 (byte-identical to missing), without the new group name", async () => {
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
