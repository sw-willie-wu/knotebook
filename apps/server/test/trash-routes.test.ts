import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { NoteDto, TrashListDto, TrashPreviewDto, TrashPurgeResultDto, TrashRestoreResultDto } from "@knotebook/shared";
import { EMPTY_YDOC_UPDATE_B64 } from "@knotebook/shared";
import { SITE_SETTINGS_MISSING_MESSAGE } from "../src/auth/tx/admin-site-settings.js";
import { noopCollabHooks } from "../src/collab/hooks.js";
import type { Db } from "../src/db/index.js";
import type { GroupTestHook } from "../src/groups/test-hook.js";
import { DEFAULT_STORAGE_LOCK_TIMEOUT_MS } from "../src/storage/tx/quota.js";
import { readSpaceUsage } from "../src/storage/usage.js";
import { purgeTrashed } from "../src/trash/service.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { uploads } from "../src/db/schema.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedShare, seedUser, spyCollabHooks, type SeededUser } from "./group-helpers.js";
import { expectRangeServing } from "./helpers/upload-serving.js";
import { buildTestApp } from "./helpers.js";
import { captureLogs } from "./helpers/admin-auth.js";
import { giveUserQuota, seedAttachment } from "./storage-helpers.js";
import { inject, sixRoleScene, trashCols, type SixRoleScene } from "./trash-helpers.js";

const INVALID = { error: { code: "invalid_body", message: "Invalid request body: ids must be 1 to 200 note ids." } };
const inTrash = (noteId: string) => ({ error: { code: "in_trash", message: "This note is in the trash." }, noteId });
const DAY_MS = 86_400_000;
const token = () => randomBytes(32).toString("base64url");

const del = (app: FastifyInstance, noteId: string, userId: string) => inject(app, "DELETE", `/api/notes/${noteId}`, userId);
const listOf = async (app: FastifyInstance, userId: string): Promise<TrashListDto> => {
  const res = await inject(app, "GET", "/api/trash", userId);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as TrashListDto;
};
const listIds = async (app: FastifyInstance, userId: string) => (await listOf(app, userId)).items.map(i => i.id);
const restore = (app: FastifyInstance, userId: string, ids: string[]) => inject(app, "POST", "/api/trash/restore", userId, { ids });
const purge = (app: FastifyInstance, userId: string, ids: string[]) => inject(app, "POST", "/api/trash/purge", userId, { ids });
const withId = (body: unknown, from: string, to: string): unknown => JSON.parse(JSON.stringify(body).split(from).join(to));
const noteExists = async (db: Db, id: string) => (await db.$client.query(`select 1 from notes where id = $1`, [id])).rowCount === 1;
const uploadExists = async (db: Db, id: string) => (await db.$client.query(`select 1 from uploads where id = $1`, [id])).rowCount === 1;

async function expect204(res: Promise<LightMyRequestResponse>): Promise<void> {
  const r = await res;
  expect(r.statusCode, r.body).toBe(204);
}

describe("two zones and ordering", () => {
  it("personal a, b and group g moved in order -> items newest deleted_at first (g, b, a); retentionDays 7, truncated false", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const grp = await seedGroup(db, "L1", [{ userId: owner.id, role: "admin" }]);
    const a = await seedNote(db, { ownerId: owner.id });
    const b = await seedNote(db, { ownerId: owner.id });
    const g = await seedNote(db, { groupId: grp.id });
    // Within the same millisecond the order falls back to id, so after each move set the just-moved note's deleted_at to the previous one + 2 ms (order does not rely on microseconds).
    const spaceAfter = (id: string, prev: string) =>
      db.$client.query(`update notes set deleted_at = (select deleted_at from notes where id = $2) + interval '2 milliseconds' where id = $1`, [id, prev]);
    await expect204(del(app, a.id, owner.id));
    await expect204(del(app, b.id, owner.id));
    await spaceAfter(b.id, a.id);
    await expect204(del(app, g.id, owner.id));
    await spaceAfter(g.id, b.id);

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => i.id)).toEqual([g.id, b.id, a.id]);
    expect(body.retentionDays).toBe(7);
    expect(body.truncated).toBe(false);
  });

  it("same deleted_at -> id descending", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    // Six notes: without an id order, the chance of landing in descending id order by luck is 1/720.
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push((await seedNote(db, { ownerId: owner.id })).id);
    // Inside a single UPDATE now() is one value.
    await db.$client.query(`update notes set deleted_at = now(), deleted_by = $2 where id = any($1::uuid[])`, [ids, owner.id]);
    const { rows } = await db.$client.query<{ n: number }>(`select count(distinct deleted_at)::int n from notes where id = any($1::uuid[])`, [ids]);
    expect(rows[0]!.n).toBe(1);

    expect(await listIds(app, owner.id)).toEqual([...ids].sort().reverse());
  });

  it("same millisecond, 1 us apart, us order opposite to id order (the larger us has the smaller id) -> id DESC; the response key set is unchanged", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await seedNote(db, { ownerId: owner.id });
    const y = await seedNote(db, { ownerId: owner.id });
    const [small, large] = [x.id, y.id].sort() as [string, string];
    const ms = "2026-10-01T00:00:00.123Z";
    await db.$client.query(`update notes set deleted_at = $2::timestamptz + interval '501 microseconds', deleted_by = $3 where id = $1`, [small, ms, owner.id]);
    await db.$client.query(`update notes set deleted_at = $2::timestamptz + interval '500 microseconds', deleted_by = $3 where id = $1`, [large, ms, owner.id]);
    const { rows } = await db.$client.query<{ n: number }>(`select count(*)::int n from notes where date_trunc('milliseconds', deleted_at) = $1::timestamptz`, [ms]);
    expect(rows[0]!.n).toBe(2); // precondition: same millisecond

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => i.id)).toEqual([large, small]);
    expect(Object.keys(body)).toEqual(["retentionDays", "items", "truncated"]);
    for (const item of body.items) {
      expect(Object.keys(item)).toEqual(["id", "title", "deletedAt", "purgeAt", "deletedBy", "group", "folderPath"]);
    }
  });
});

describe("DTO fields", () => {
  it("group item has group/deletedBy; personal item has group null; purgeAt = deletedAt + 7 days; retention days NULL -> purgeAt all null", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { displayName: "Deleter L2" });
    const grp = await seedGroup(db, "Group L2", [{ userId: admin.id, role: "admin" }]);
    const gn = await seedNote(db, { groupId: grp.id }, { title: "GN" });
    const pn = await seedNote(db, { ownerId: admin.id }, { title: "PN" });
    await expect204(del(app, gn.id, admin.id));
    await expect204(del(app, pn.id, admin.id));

    const body = await listOf(app, admin.id);
    const gi = body.items.find(i => i.id === gn.id)!;
    const pi = body.items.find(i => i.id === pn.id)!;
    expect(gi).toMatchObject({ title: "GN", group: { id: grp.id, name: "Group L2" }, deletedBy: { handle: admin.handle, displayName: "Deleter L2" } });
    expect(pi).toMatchObject({ title: "PN", group: null, deletedBy: { handle: admin.handle, displayName: "Deleter L2" } });
    for (const item of [gi, pi]) {
      expect(item.deletedAt).toBe(new Date(item.deletedAt).toISOString());
      // "+ 7 days" is exactly 7x24 h only when the session TimeZone has no DST (the test DB is UTC); `make_interval(days)` crosses DST by session time zone.
      expect(item.purgeAt).toBe(new Date(new Date(item.deletedAt).getTime() + 7 * DAY_MS).toISOString());
    }

    await db.$client.query(`update site_settings set trash_retention_days = null`);
    const none = await listOf(app, admin.id);
    expect(none.retentionDays).toBeNull();
    expect(none.items.map(i => i.purgeAt)).toEqual([null, null]);
  });
});

describe("lists only what the caller has trash rights for (the list column)", () => {
  it("group trash: admin and editDelete see it, the rest do not; others' personal trash and live notes never appear", async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const g = await seedNote(db, { groupId: s.groupId });
    await seedNote(db, { groupId: s.groupId });
    await seedNote(db, { ownerId: s.admin.id });
    const other = await seedUser(db);
    const op = await seedNote(db, { ownerId: other.id });
    await expect204(del(app, g.id, s.admin.id));
    await expect204(del(app, op.id, other.id));

    const roles = ["admin", "editDelete", "member", "deleteOnly", "editOnly", "readOnly", "outsider"] as const;
    const got: Record<string, string[]> = {};
    for (const r of roles) got[r] = await listIds(app, s[r].id);
    expect(got).toEqual({ admin: [g.id], editDelete: [g.id], member: [], deleteOnly: [], editOnly: [], readOnly: [], outsider: [] });
    expect(await listIds(app, other.id)).toEqual([op.id]);
  });
});

describe("deleter account deleted", () => {
  it("deletedBy becomes null, still listed", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await seedUser(db);
    const grp = await seedGroup(db, "L4", [{ userId: owner.id, role: "admin" }, { userId: x.id, role: "admin" }]);
    const n = await seedNote(db, { groupId: grp.id });
    await expect204(del(app, n.id, x.id));
    await db.$client.query(`delete from users where id = $1`, [x.id]);

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => [i.id, i.deletedBy])).toEqual([[n.id, null]]);
  });

  it("personal zone: deleted_by is another account (the shape after a group transfer) and that account is deleted -> still listed, deletedBy null", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const x = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    await db.$client.query(`update notes set deleted_by = $2 where id = $1`, [n.id, x.id]);
    expect((await listOf(app, owner.id)).items.map(i => i.deletedBy?.handle)).toEqual([x.handle]);
    await db.$client.query(`delete from users where id = $1`, [x.id]); // notes_deleted_by_fk: SET NULL

    const body = await listOf(app, owner.id);
    expect(body.items.map(i => [i.id, i.deletedBy])).toEqual([[n.id, null]]);
  });
});

describe("unreadable site_settings row", () => {
  it("GET /api/trash -> 500 internal, log { table: 'site_settings' }", async () => {
    const logs = captureLogs();
    const { app, db } = await buildTestApp({}, logs.options);
    const owner = await seedUser(db);
    await db.$client.query(`delete from site_settings`);

    const res = await inject(app, "GET", "/api/trash", owner.id);
    expect([res.statusCode, res.json()]).toEqual([500, { error: { code: "internal", message: "Internal server error." } }]);
    const line = logs.lines.find(l => l.msg === SITE_SETTINGS_MISSING_MESSAGE);
    expect(line?.obj).toEqual({ table: "site_settings" });
  });
});

describe("truncated", () => {
  it("1001 notes -> 1000 items, truncated true; exactly 1000 -> truncated false", async () => {
    const { app, db } = await buildTestApp();
    const big = await seedUser(db);
    const exact = await seedUser(db);
    const seedMany = (u: SeededUser, n: number) => db.$client.query(
      `insert into notes (owner_id, title, slug, deleted_at, deleted_by)
       select $1::uuid, 'T' || g, 'tl5-' || g, now() - make_interval(secs => g), $1::uuid from generate_series(1, $2::int) g`,
      [u.id, n],
    );
    await seedMany(big, 1001);
    await seedMany(exact, 1000);

    const b = await listOf(app, big.id);
    expect([b.items.length, b.truncated]).toEqual([1000, true]);
    const e = await listOf(app, exact.id);
    expect([e.items.length, e.truncated]).toEqual([1000, false]);
  });
});

describe.each(["restore", "purge"] as const)("input validation (%s)", ep => {
  const url = `/api/trash/${ep}`;

  it("empty array, 201 items, non-UUID inside, an extra key -> 400 invalid_body, DB unchanged", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    const before = await trashCols(db.$client, n.id);

    const bodies: Array<[string, unknown]> = [
      ["V1 空陣列", { ids: [] }],
      // The limit counts raw items: 201 items that dedupe to 2 still give 400.
      ["V2 201 個", { ids: [n.id, ...Array<string>(200).fill(randomUUID())] }],
      ["V3 非 UUID", { ids: [n.id, "not-a-uuid"] }],
      ["V4 多一個鍵", { ids: [n.id], x: 1 }],
    ];
    for (const [name, body] of bodies) {
      const res = await inject(app, "POST", url, owner.id, body);
      expect(res.statusCode, name).toBe(400);
      expect(res.json(), name).toEqual(INVALID);
    }
    expect(await trashCols(db.$client, n.id)).toEqual(before);
  });

  it("the same nonexistent id sent in two letter cases -> 200, skipped exactly one entry, id lowercase", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const r = randomUUID();
    const res = await inject(app, "POST", url, owner.id, { ids: [r.toUpperCase(), r] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { skipped: unknown }).skipped).toEqual([{ id: r, reason: "not_found" }]);
  });

  it("200 distinct ids -> 200 (not 400), the trashed notes among them are processed", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));
    const res = await inject(app, "POST", url, owner.id, { ids: [n.id, ...Array.from({ length: 199 }, () => randomUUID())] });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { skipped: unknown[]; restored?: NoteDto[]; purged?: string[] };
    expect(ep === "restore" ? body.restored!.map(x => x.id) : body.purged).toEqual([n.id]);
    expect(body.skipped).toHaveLength(199);
  });
});

describe("restore happy path", () => {
  it("personal note with shares and a public link -> restored[0] is a NoteDto; sharees see it again; both public forms 200; restored even when the space is full", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const friend = await seedUser(db);
    const tok = token();
    const n = await seedNote(db, { ownerId: owner.id }, { title: "R1", publicToken: tok, publicSlug: "r1-pub" });
    await seedShare(db, n.id, friend.id, "editor");
    await seedAttachment(db, uploadsDir, n.id, owner.id, 10);
    await giveUserQuota(db, owner.id, 1); // usage 10 bytes > limit 1 byte (restore does not check capacity)
    const anon = (url: string) => app.inject({ method: "GET", url });
    const friendIds = async () => ((await inject(app, "GET", "/api/notes", friend.id)).json() as NoteDto[]).map(x => x.id);

    await expect204(del(app, n.id, owner.id));
    expect(await friendIds()).not.toContain(n.id);
    expect((await anon(`/api/public/notes/${tok}`)).statusCode).toBe(404);

    const res = await restore(app, owner.id, [n.id]);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as TrashRestoreResultDto;
    expect(body.skipped).toEqual([]);
    expect(body.restored).toHaveLength(1);
    expect(body.restored[0]).toMatchObject({ id: n.id, title: "R1", role: "owner", slug: n.slug, ownerId: owner.id, group: null });
    expect(Object.values(body.restored[0]!.permissions).every(v => v === true)).toBe(true);
    expect(body.restored[0]).toEqual((await inject(app, "GET", `/api/notes/${n.id}`, owner.id)).json());
    expect(await trashCols(db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });

    expect(await friendIds()).toContain(n.id);
    expect((await anon(`/api/public/notes/${tok}`)).statusCode).toBe(200);
    expect((await anon(`/api/public/notes/${owner.handle}/r1-pub`)).statusCode).toBe(200);
  });
});

describe("gate released", () => {
  it("onNotesRestored is called once with [id]; not called when everything is skipped", async () => {
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ collabHooks: hooks });
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, n.id, owner.id));

    expect((await restore(app, owner.id, [n.id])).statusCode).toBe(200);
    expect(hooks.onNotesRestored.mock.calls).toEqual([[[n.id]]]);

    hooks.onNotesRestored.mockClear();
    const res = await restore(app, owner.id, [n.id, randomUUID()]);
    expect((res.json() as TrashRestoreResultDto).restored).toEqual([]);
    expect(hooks.onNotesRestored).not.toHaveBeenCalled();
  });
});

async function mixedScene(app: FastifyInstance, db: Db) {
  const s = await sixRoleScene(db);
  const g = await seedNote(db, { groupId: s.groupId });
  const l = await seedNote(db, { groupId: s.groupId });
  const owner = await seedUser(db);
  const p = await seedNote(db, { ownerId: owner.id });
  await expect204(del(app, g.id, s.admin.id));
  await expect204(del(app, p.id, owner.id));
  return { s, g: g.id, l: l.id, p: p.id, r: randomUUID() };
}

describe("matrix and mixed batches (restore)", () => {
  it("admin sends [r, g, l, p] -> only g is restored; skipped r, l, p in order all not_found; deleteOnly and editOnly on g -> not_found", async () => {
    const { app, db } = await buildTestApp();
    const { s, g, l, p, r } = await mixedScene(app, db);

    const res = await restore(app, s.admin.id, [r, g, l, p]);
    expect(res.statusCode).toBe(200);
    const body = res.json() as TrashRestoreResultDto;
    expect(body.restored.map(x => x.id)).toEqual([g]);
    expect(body.skipped).toEqual([{ id: r, reason: "not_found" }, { id: l, reason: "not_found" }, { id: p, reason: "not_found" }]);
    expect((await trashCols(db.$client, p))?.deleted_at).not.toBeNull();

    await expect204(del(app, g, s.admin.id));
    for (const who of ["deleteOnly", "editOnly"] as const) {
      expect((await restore(app, s[who].id, [g])).json(), who).toEqual({ restored: [], skipped: [{ id: g, reason: "not_found" }] });
    }
    expect((await trashCols(db.$client, g))?.deleted_at).not.toBeNull();
  });
});

describe.each(["restore", "purge"] as const)("in-transaction skips and pre-check skips are merged in input order (%s)", ep => {
  it("g passes the pre-check but is demoted after the lock (not_found inside the transaction), sandwiched between two pre-check skips -> skipped follows input order [p, g, r]", async () => {
    let demote: (() => Promise<void>) | null = null;
    const hook: GroupTestHook = async point => {
      if (demote && (point === "note-restore-locked" || point === "note-purge-locked")) {
        const run = demote;
        demote = null;
        await run();
      }
    };
    const hooks = spyCollabHooks();
    const { app, db } = await buildTestApp({ groupTestHook: hook, collabHooks: hooks });
    const { s, g, p, r } = await mixedScene(app, db);
    // What is locked is the notes row; role rows are not under the lock, another connection can change them and the next statement in the transaction re-judges (READ COMMITTED) and sees it.
    const arm = () => {
      demote = async () => {
        await db.$client.query(
          `update group_roles set can_delete = false where id = (select role_id from group_members where group_id = $1 and user_id = $2)`,
          [s.groupId, s.editDelete.id],
        );
      };
    };

    arm();
    const res = await inject(app, "POST", `/api/trash/${ep}`, s.editDelete.id, { ids: [p, g, r] });
    expect(res.statusCode, res.body).toBe(200);
    expect(demote, "hook 有跑到").toBeNull();
    expect((res.json() as { skipped: unknown }).skipped).toEqual([
      { id: p, reason: "not_found" },
      { id: g, reason: "not_found" },
      { id: r, reason: "not_found" },
    ]);
    expect((await trashCols(db.$client, g))?.deleted_at).not.toBeNull();
    // Entered the transaction but restored nothing -> onNotesRestored is not called (only the ids actually restored are passed).
    expect(hooks.onNotesRestored).not.toHaveBeenCalled();
  });
});

describe("no trash right looks the same as nonexistent, field by field", () => {
  it("outsider's restore/purge of g differs from the response for a random uuid only in the id", async () => {
    const { app, db } = await buildTestApp();
    const { s, g, r } = await mixedScene(app, db);
    for (const call of [restore, purge]) {
      const onG = await call(app, s.outsider.id, [g]);
      const onR = await call(app, s.outsider.id, [r]);
      expect([onG.statusCode, onR.statusCode]).toEqual([200, 200]);
      expect(withId(onG.json(), g, r)).toEqual(onR.json());
    }
    expect((await trashCols(db.$client, g))?.deleted_at).not.toBeNull();
  });
});

describe("permanent delete (releasing)", () => {
  it("trashed note with attachments -> purged [id]; row, uploads rows and disk files are gone; usage decreases; the bystander's trashed note is still there", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const bystander = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 100);
    const bup = await seedAttachment(db, uploadsDir, bystander.id, owner.id, 7);
    await expect204(del(app, n.id, owner.id));
    await expect204(del(app, bystander.id, owner.id));
    const before = (await readSpaceUsage(db, { kind: "user", id: owner.id }))!.usedBytes;

    const res = await purge(app, owner.id, [n.id]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purged: [n.id], skipped: [] } satisfies TrashPurgeResultDto);
    expect(await noteExists(db, n.id)).toBe(false);
    expect(await uploadExists(db, up)).toBe(false);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(false);
    expect((await readSpaceUsage(db, { kind: "user", id: owner.id }))!.usedBytes).toBe(before - 100);

    expect((await trashCols(db.$client, bystander.id))?.deleted_at).not.toBeNull();
    expect(await uploadExists(db, bup)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, bup)), "旁觀者磁碟檔").toBe(true);
  });

  it("uploads rows present, disk file missing -> rows are deleted as usual (REST 200); the service layer logs one entry and does not throw", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id });
    const b = await seedNote(db, { ownerId: owner.id });
    const upA = await seedAttachment(db, uploadsDir, a.id, owner.id, 5, { noFile: true });
    const upB = await seedAttachment(db, uploadsDir, b.id, owner.id, 5, { noFile: true });
    await expect204(del(app, a.id, owner.id));
    await expect204(del(app, b.id, owner.id));

    const res = await purge(app, owner.id, [a.id]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purged: [a.id], skipped: [] });
    expect([await noteExists(db, a.id), await uploadExists(db, upA)]).toEqual([false, false]);

    const log = { error: vi.fn() };
    const out = await purgeTrashed({ db, collabHooks: noopCollabHooks, uploadsDir, storageLockTimeoutMs: DEFAULT_STORAGE_LOCK_TIMEOUT_MS }, { ids: [b.id], by: owner.id }, log);
    expect(out).toEqual({ done: [b.id], skipped: [] });
    expect([await noteExists(db, b.id), await uploadExists(db, upB)]).toEqual([false, false]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]![0]).toMatchObject({ uploadId: upB });
  });
});

describe("live notes are never deleted", () => {
  it("owner purges their own live note -> fails the pre-check, skipped not_found; note and attachments remain", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 9);

    const res = await purge(app, owner.id, [n.id]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ purged: [], skipped: [{ id: n.id, reason: "not_found" }] });
    expect(await trashCols(db.$client, n.id)).toEqual({ deleted_at: null, deleted_by: null });
    expect(await uploadExists(db, up)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, up))).toBe(true);
  });
});

describe("matrix and mixed batches (permanent delete)", () => {
  it("admin sends [r, g, l, p] -> only g is deleted; skipped r, l, p in order all not_found; deleteOnly and editOnly on g2 -> not_found", async () => {
    const { app, db } = await buildTestApp();
    const { s, g, l, p, r } = await mixedScene(app, db);

    const res = await purge(app, s.admin.id, [r, g, l, p]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      purged: [g],
      skipped: [{ id: r, reason: "not_found" }, { id: l, reason: "not_found" }, { id: p, reason: "not_found" }],
    });
    expect([await noteExists(db, g), await noteExists(db, l), await noteExists(db, p)]).toEqual([false, true, true]);

    const g2 = await seedNote(db, { groupId: s.groupId });
    await expect204(del(app, g2.id, s.admin.id));
    for (const who of ["deleteOnly", "editOnly"] as const) {
      expect((await purge(app, s[who].id, [g2.id])).json(), who).toEqual({ purged: [], skipped: [{ id: g2.id, reason: "not_found" }] });
    }
    expect(await noteExists(db, g2.id)).toBe(true);
  });
});

describe("a failing transaction does not delete files first", () => {
  it("BEFORE DELETE ON notes trigger raises for that note -> 500; row, uploads rows and disk files are all still there", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 11);
    await expect204(del(app, n.id, owner.id));
    await db.$client.query(
      `create function t9_boom() returns trigger language plpgsql as $$ begin if old.id = '${n.id}' then raise exception 't9 boom'; end if; return old; end $$`,
    );
    await db.$client.query(`create trigger t9_boom before delete on notes for each row execute function t9_boom()`);
    try {
      const res = await purge(app, owner.id, [n.id]);
      expect(res.statusCode).toBe(500);
    } finally {
      await db.$client.query(`drop trigger t9_boom on notes; drop function t9_boom()`);
    }
    expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
    expect(await uploadExists(db, up)).toBe(true);
    expect(existsSync(uploadFilePath(uploadsDir, up)), "磁碟檔").toBe(true);
  });
});

type Role = keyof Omit<SixRoleScene, "groupId">;
/** Six-role matrix: DELETE status code and whether there is a trash right (list/restore/purge/in_trash, four cells consistent). */
const MATRIX: Array<[Role, number, boolean]> = [
  ["admin", 204, true],
  ["editDelete", 204, true],
  ["deleteOnly", 204, false],
  ["member", 403, false],
  ["editOnly", 403, false],
  ["readOnly", 403, false],
  ["outsider", 404, false],
];

describe.each(MATRIX)("six-role matrix: %s", (role, delStatus, trashRight) => {
  it(`DELETE ${delStatus}; trash right ${trashRight}`, async () => {
    const { app, db } = await buildTestApp();
    const s = await sixRoleScene(db);
    const u = s[role];
    const n = (await seedNote(db, { groupId: s.groupId })).id;

    expect((await del(app, n, u.id)).statusCode).toBe(delStatus);
    if (delStatus !== 204) await expect204(del(app, n, s.admin.id)); // do the move on their behalf, then test the other four columns

    const listed = (await listIds(app, u.id)).includes(n);
    const get = await inject(app, "GET", `/api/notes/${n}`, u.id);
    const preview = await inject(app, "GET", `/api/trash/${n}`, u.id);
    if (trashRight) {
      expect(listed).toBe(true);
      expect([get.statusCode, get.json()]).toEqual([404, inTrash(n)]);
      expect(preview.statusCode).toBe(200);
      expect(preview.headers["cache-control"]).toBe("private, no-store");
      expect((preview.json() as TrashPreviewDto).id).toBe(n);
      expect((preview.json() as TrashPreviewDto).ydoc).toBe(EMPTY_YDOC_UPDATE_B64);
      const res = (await restore(app, u.id, [n])).json() as TrashRestoreResultDto;
      expect([res.restored.map(x => x.id), res.skipped]).toEqual([[n], []]);
      // The restore response's NoteDto equals the later single-note read field by field (a group note's role/permissions/group come from the caller's role).
      expect(res.restored[0]).toEqual((await inject(app, "GET", `/api/notes/${n}`, u.id)).json());
      await expect204(del(app, n, u.id));
      expect((await purge(app, u.id, [n])).json()).toEqual({ purged: [n], skipped: [] });
      expect(await noteExists(db, n)).toBe(false);
    } else {
      const r = randomUUID();
      expect(listed).toBe(false);
      const getR = await inject(app, "GET", `/api/notes/${r}`, u.id);
      expect([get.statusCode, get.body]).toEqual([getR.statusCode, getR.body]);
      const previewR = await inject(app, "GET", `/api/trash/${r}`, u.id);
      expect([preview.statusCode, preview.body]).toEqual([previewR.statusCode, previewR.body]);
      for (const call of [restore, purge]) {
        const onN = await call(app, u.id, [n]);
        const onR = await call(app, u.id, [r]);
        expect([onN.statusCode, onR.statusCode]).toEqual([200, 200]);
        expect(withId(onN.json(), n, r)).toEqual(onR.json());
      }
      expect((await trashCols(db.$client, n))?.deleted_at).not.toBeNull();
    }
  });
});

describe("clear-all semantics", () => {
  it("send all ids on the list -> a note moved afterwards is unaffected", async () => {
    const { app, db } = await buildTestApp();
    const owner = await seedUser(db);
    const a = await seedNote(db, { ownerId: owner.id });
    const b = await seedNote(db, { ownerId: owner.id });
    const c = await seedNote(db, { ownerId: owner.id });
    await expect204(del(app, a.id, owner.id));
    await expect204(del(app, b.id, owner.id));
    const listed = await listIds(app, owner.id);
    await expect204(del(app, c.id, owner.id));

    expect((await purge(app, owner.id, listed)).json()).toEqual({ purged: [b.id, a.id], skipped: [] });
    expect(await listIds(app, owner.id)).toEqual([c.id]);
  });
});

describe("trash preview uploads", () => {
  it("owner can fetch the trashed note's own upload via /api/trash/:id/uploads/:uploadId while cross-note uploads, live notes and sharees get 404", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const friend = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const other = await seedNote(db, { ownerId: owner.id });
    await seedShare(db, n.id, friend.id, "editor");
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 16);
    const otherUp = await seedAttachment(db, uploadsDir, other.id, owner.id, 16);

    // Live note -> 404
    expect((await inject(app, "GET", `/api/trash/${n.id}/uploads/${up}`, owner.id)).statusCode).toBe(404);

    await expect204(del(app, n.id, owner.id));
    const ok = await inject(app, "GET", `/api/trash/${n.id}/uploads/${up}`, owner.id);
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(ok.headers["x-content-type-options"]).toBe("nosniff");
    expect((await inject(app, "GET", `/api/trash/${n.id}/uploads/${otherUp}`, owner.id)).statusCode).toBe(404);
    expect((await inject(app, "GET", `/api/trash/${n.id}/uploads/${up}`, friend.id)).statusCode).toBe(404);
  });

  it("a PDF is served with the upload class headers (framable by this site only) and answers Range, validator and HEAD requests", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const bytes = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(200, 0x20), Buffer.from("\n%%EOF\n")]);
    const [row] = await db.insert(uploads).values({ noteId: n.id, uploaderId: owner.id, mime: "application/pdf", size: bytes.length, fileName: "slides.pdf" }).returning({ id: uploads.id });
    await writeFile(uploadFilePath(uploadsDir, row!.id), bytes);
    await expect204(del(app, n.id, owner.id));
    const url = `/api/trash/${n.id}/uploads/${row!.id}`;
    const cookies = await cookieOf(owner.id);
    await expectRangeServing(opts => app.inject({ method: opts?.method ?? "GET", url, cookies, headers: opts?.headers }), bytes);
    const res = await app.inject({ method: "GET", url, cookies });
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'self'");
    expect(res.headers["content-disposition"]).toBe("inline; filename=\"slides.pdf\"; filename*=UTF-8''slides.pdf");
    expect(res.headers["x-frame-options"]).toBeUndefined();
  });
});

describe("cookie-only", () => {
  it("the trash endpoints called with Bearer (read-write-move) -> 401, trash unchanged", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id });
    const up = await seedAttachment(db, uploadsDir, n.id, owner.id, 8);
    await expect204(del(app, n.id, owner.id));
    const { token: pat } = await seedTokenForUser(db, owner.id, "notes:read notes:write notes:move");
    const calls = [
      app.inject({ method: "GET", url: "/api/trash", headers: bearer(pat) }),
      app.inject({ method: "GET", url: `/api/trash/${n.id}`, headers: bearer(pat) }),
      app.inject({ method: "GET", url: `/api/trash/${n.id}/uploads/${up}`, headers: bearer(pat) }),
      app.inject({ method: "POST", url: "/api/trash/restore", headers: bearer(pat), payload: { ids: [n.id] } }),
      app.inject({ method: "POST", url: "/api/trash/purge", headers: bearer(pat), payload: { ids: [n.id] } }),
    ];
    expect((await Promise.all(calls)).map(r => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
  });
});
