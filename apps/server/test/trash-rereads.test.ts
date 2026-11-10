/**
 * #181：交易內存活重讀（表前五列的循序案）。在「授權之後、交易之前」的測試縫裡以
 * `trashNotesInTx` 把筆記移入垃圾桶——繞過路由授權——再讓操作跑完：回該處原本的 not_found，筆記沒被改到。
 * 每案配一個對照：同一縫裡不移入 → 操作照常成功（縫本身沒弄壞流程）。
 * T5（後半）：改標題、公開連結五支、切版（`cutVersionInTx`）、掃描（`scanDue`）、連結轉換（含 backfill 群組分支照記）。
 */
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import * as Y from "yjs";
import { createVersionService, markPending } from "../src/collab/versions.js";
import type { Db } from "../src/db/index.js";
import { noteLinkConversion, noteLinks, noteRedirects, noteStates, notes, uploads } from "../src/db/schema.js";
import type { GroupRacePoint, GroupTestHook } from "../src/groups/test-hook.js";
import { LINK_CONVERSION_VERSION_NAME, runLinkConversion } from "../src/notes/link-conversion.js";
import { renameNoteTitle } from "../src/notes/rename-note.js";
import { resolveNoteAccess } from "../src/notes/service.js";
import type { SlugPatchTestHook } from "../src/notes/tx/patch-slug.js";
import { trashNotesInTx, type TrashNotesOutcome } from "../src/notes/tx/trash.js";
import { VersionCutAbort, cutVersionInTx, spaceKeyOf, type CutVersionInput } from "../src/notes/tx/versions.js";
import { VACUUM_VERSION_FINGERPRINT } from "../src/notes/version-fingerprint.js";
import { buildCollabTestApp, buildTestApp, freshDb, testConfig } from "./helpers.js";
import { seedDoc, wikilinkDoc } from "./copy-helpers.js";
import { cookieOf, noteState, seedGroup, seedNote, seedShare, seedUser, sharesOf } from "./group-helpers.js";
import { filesIn, upload } from "./storage-helpers.js";
import { markRestored, trashCols } from "./trash-helpers.js";
import { NO_PENDING, fakeHost, paraDoc, pendingOf, seedOldNote, versionsOf } from "./version-helpers.js";

const NOT_FOUND = { error: { code: "not_found", message: "No note with that id." } };

/** 縫的狀態：`target` 有值時，縫第一次觸發就把那篇移入垃圾桶（新交易，commit 後才放行操作）。 */
interface Seam {
  db?: Db;
  target?: { id: string; by: string };
  hits: number;
  ctxNoteId?: string;
  trashed?: TrashNotesOutcome;
}

async function fireSeam(s: Seam, noteId: string | undefined): Promise<void> {
  s.hits++;
  s.ctxNoteId = noteId;
  if (s.target && s.hits === 1) {
    const t = s.target;
    s.trashed = await s.db!.transaction(tx => trashNotesInTx(tx, { ids: [t.id], by: t.by }));
  }
}

const groupSeam = (point: GroupRacePoint, s: Seam): GroupTestHook => async (p, ctx) => {
  if (p === point) await fireSeam(s, ctx.noteId);
};
const slugSeam = (s: Seam): SlugPatchTestHook => async (p, ctx) => {
  if (p === "authorized") await fireSeam(s, ctx.noteId);
};

/** 縫恰觸發一次、ctx 是本篇；有移入的話，移入成功。 */
function expectSeam(s: Seam, noteId: string, trashed: boolean): void {
  expect(s.hits).toBe(1);
  expect(s.ctxNoteId).toBe(noteId);
  if (trashed) expect(s.trashed).toEqual({ trashed: [noteId], notFound: [], forbidden: [] });
}

const noteCount = async (db: Db) => (await db.select({ n: sql<number>`count(*)::int` }).from(notes))[0]!.n;
const req = async (app: FastifyInstance, method: "POST" | "PUT" | "PATCH" | "DELETE", url: string, userId: string, payload?: unknown) =>
  app.inject({ method, url, cookies: await cookieOf(userId), payload: payload as Record<string, unknown> });

describe("#181 交易內存活重讀：授權之後被移入垃圾桶", () => {
  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，筆記沒被搬、分享與公開欄位不變" : "對照：縫裡不移入 → 200 照常搬移";
    it(`RR-MV 搬移（note-move-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("note-move-authorized", s) });
      s.db = built.db;
      const { app, db } = built;
      const [owner, friend] = await Promise.all([seedUser(db), seedUser(db)]);
      const g = await seedGroup(db, "G", [{ userId: owner.id, role: "member" }]);
      const n = await seedNote(db, { ownerId: owner.id }, { slug: "plan", publicToken: "m".repeat(43), publicSlug: "alias-mv" });
      await seedShare(db, n.id, friend.id, "editor");
      const before = await noteState(db.$client, n.id);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "POST", `/api/notes/${n.id}/move`, owner.id, { groupId: g.id });

      expectSeam(s, n.id, trash);
      if (trash) {
        // 狀態碼不承重：commit 後 authorizeRow 也回 404，rollback 靠下面的狀態斷言守，精簡時勿拿掉
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await noteState(db.$client, n.id)).toEqual(before);
        expect(await sharesOf(db, n.id)).toEqual([{ userId: friend.id, role: "editor" }]);
        expect(await db.select().from(noteRedirects)).toEqual([]);
        expect((await trashCols(db.$client, n.id))?.deleted_at).not.toBeNull();
      } else {
        expect(res.statusCode).toBe(200);
        expect(await noteState(db.$client, n.id)).toMatchObject({ owner_id: null, group_id: g.id, public_token: null, public_slug: null });
        expect(await sharesOf(db, n.id)).toEqual([]);
      }
    });
  }

  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，uploads 0 列、磁碟不多檔" : "對照：縫裡不移入 → 201，uploads 1 列、磁碟多一檔";
    it(`RR-UP 上傳（upload-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("upload-authorized", s) });
      s.db = built.db;
      const { app, db, uploadsDir } = built;
      const owner = await seedUser(db);
      const n = await seedNote(db, { ownerId: owner.id });
      const filesBefore = await filesIn(uploadsDir);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await upload(app, n.id, owner.id, 8);

      expectSeam(s, n.id, trash);
      const rows = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.noteId, n.id));
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(rows).toEqual([]);
        expect(await filesIn(uploadsDir)).toEqual(filesBefore);
      } else {
        expect(res.statusCode).toBe(201);
        expect(rows).toHaveLength(1);
        expect(await filesIn(uploadsDir)).toHaveLength(filesBefore.length + 1);
      }
    });
  }

  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，notes 總數不變" : "對照：縫裡不移入 → 201，notes 多一篇";
    it(`RR-CP 複製（note-copy-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("note-copy-authorized", s) });
      s.db = built.db;
      const { app, db } = built;
      const owner = await seedUser(db);
      const n = await seedNote(db, { ownerId: owner.id });
      const countBefore = await noteCount(db);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "POST", `/api/notes/${n.id}/copy`, owner.id, {});

      expectSeam(s, n.id, trash);
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await noteCount(db)).toBe(countBefore);
      } else {
        expect(res.statusCode).toBe(201);
        expect(await noteCount(db)).toBe(countBefore + 1);
      }
    });
  }

  for (const trash of [true, false]) {
    const tag = trash ? "授權後移入 → 404 not_found，分享不變" : "對照：縫裡不移入 → 200，多一筆分享";
    it(`RR-SH 分享（share-authorized）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ groupTestHook: groupSeam("share-authorized", s) });
      s.db = built.db;
      const { app, db } = built;
      const [owner, friend, other] = await Promise.all([seedUser(db), seedUser(db), seedUser(db)]);
      const n = await seedNote(db, { ownerId: owner.id });
      await seedShare(db, n.id, other.id, "viewer");
      const before = await sharesOf(db, n.id);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "PUT", `/api/notes/${n.id}/shares`, owner.id, { email: friend.email, role: "editor" });

      expectSeam(s, n.id, trash);
      if (trash) {
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await sharesOf(db, n.id)).toEqual(before);
      } else {
        expect(res.statusCode).toBe(200);
        expect(await sharesOf(db, n.id)).toEqual(
          [...before, { userId: friend.id, role: "editor" }].sort((a, b) => (a.userId < b.userId ? -1 : 1)),
        );
      }
    });
  }

  const cells: Array<[string, { slug: string | null }, string | null]> = [["格 1 自訂 slug", { slug: "x-new" }, "x-new"], ["格 4 slug:null", { slug: null }, null]];
  for (const [cell, body, wantSlug] of cells) {
    for (const trash of [true, false]) {
      const tag = trash ? "授權後移入 → 404 not_found（不是 409），slug／prev_slug／updated_at 不變" : "對照：縫裡不移入 → 200，slug 改了";
      it(`RR-PS 改網址 ${cell}（slugPatchTestHook authorized）：${tag}`, async () => {
        const s: Seam = { hits: 0 };
        const built = await buildTestApp({ slugPatchTestHook: slugSeam(s) });
        s.db = built.db;
        const { app, db } = built;
        const owner = await seedUser(db);
        const n = await seedNote(db, { ownerId: owner.id }, { title: "Hello World", slug: "old-custom", slugIsCustom: true });
        const before = await noteState(db.$client, n.id);
        if (trash) s.target = { id: n.id, by: owner.id };

        const res = await req(app, "PATCH", `/api/notes/${n.id}`, owner.id, body);

        expectSeam(s, n.id, trash);
        if (trash) {
          expect(res.statusCode).toBe(404);
          expect(res.json()).toEqual(NOT_FOUND);
          expect(await noteState(db.$client, n.id)).toEqual(before);
        } else {
          expect(res.statusCode).toBe(200);
          const after = (await noteState(db.$client, n.id)).slug;
          if (wantSlug) expect(after).toBe(wantSlug);
          else expect(after).not.toBe("old-custom");
        }
      });
    }
  }
});

async function trashNow(db: Db, id: string, by: string): Promise<void> {
  expect(await db.transaction(tx => trashNotesInTx(tx, { ids: [id], by }))).toEqual({ trashed: [id], notFound: [], forbidden: [] });
}
const titleOf = async (db: Db, id: string) => (await db.select({ title: notes.title }).from(notes).where(eq(notes.id, id)))[0]!.title;
const publicCols = async (db: Db, id: string) =>
  (await db.select({ token: notes.publicToken, slug: notes.publicSlug, width: notes.publicWidth }).from(notes).where(eq(notes.id, id)))[0]!;
const ydocOf = async (db: Db, id: string) => (await db.select({ y: noteStates.ydoc }).from(noteStates).where(eq(noteStates.noteId, id)))[0]!.y;
const conversionOf = async (db: Db, id: string) =>
  (await db.select({ status: noteLinkConversion.status, attempts: noteLinkConversion.attempts }).from(noteLinkConversion).where(eq(noteLinkConversion.noteId, id)))[0];
const linkTargetsOf = async (db: Db, id: string) =>
  (await db.select({ t: noteLinks.targetNoteId }).from(noteLinks).where(eq(noteLinks.sourceNoteId, id))).map(r => r.t).sort();

describe("#181 交易內存活重讀（下）：改標題、公開連結、切版、掃描、連結轉換", () => {
  for (const trash of [true, false]) {
    const tag = trash ? "UPDATE 前移入 → 404 not_found（不是 409），title／slug／updated_at 不變" : "對照：縫裡不移入 → 200，標題改了";
    it(`RR-RN 改標題 REST（slugUpdateTestHook）：${tag}`, async () => {
      const s: Seam = { hits: 0 };
      const built = await buildTestApp({ slugUpdateTestHook: () => fireSeam(s, undefined) });
      s.db = built.db;
      const { app, db } = built;
      const owner = await seedUser(db);
      const n = await seedNote(db, { ownerId: owner.id }, { title: "舊", slug: "old-title" });
      const before = await noteState(db.$client, n.id);
      if (trash) s.target = { id: n.id, by: owner.id };

      const res = await req(app, "PATCH", `/api/notes/${n.id}`, owner.id, { title: "新" });

      expect(s.hits).toBe(1);
      if (trash) {
        expect(s.trashed).toEqual({ trashed: [n.id], notFound: [], forbidden: [] });
        expect(res.statusCode).toBe(404);
        expect(res.json()).toEqual(NOT_FOUND);
        expect(await titleOf(db, n.id)).toBe("舊");
        expect(await noteState(db.$client, n.id)).toEqual(before);
      } else {
        expect(res.statusCode).toBe(200);
        expect(await titleOf(db, n.id)).toBe("新");
      }
    });
  }

  it("RR-RN 改標題直呼 renameNoteTitle：pre-read 之前已移入 → gone，hook 沒被呼叫（pre-read 就短路，不進探測迴圈）", async () => {
    const { db } = await freshDb();
    const owner = await seedUser(db);
    const n = await seedNote(db, { ownerId: owner.id }, { title: "舊" });
    const access = await resolveNoteAccess(db, owner.id, n.id);
    expect(access.role).toBe("owner");
    const before = await noteState(db.$client, n.id);
    await trashNow(db, n.id, owner.id);
    const hook = vi.fn();

    expect(await renameNoteTitle(db, { noteId: n.id, access, title: "新" }, hook)).toEqual({ kind: "gone" });

    expect(hook).not.toHaveBeenCalled();
    expect(await titleOf(db, n.id)).toBe("舊");
    expect(await noteState(db.$client, n.id)).toEqual(before);
  });

  const SLUG_400 = { error: { code: "invalid_body", message: "Can't set a public URL: the note has no public link, is a group note, or changed owner after you sent this." } };
  type Pub = Awaited<ReturnType<typeof publicCols>>;
  const plCases: Array<{
    id: string; what: string; method: "PUT" | "DELETE"; path: string; body?: unknown;
    seed: { publicToken?: string; publicSlug?: string };
    trashed: { status: number; json?: unknown };
    control: { status: number; cols: (c: Pub) => void };
  }> = [
    {
      id: "RR-PL1", what: "token PUT", method: "PUT", path: "public-link", seed: {},
      trashed: { status: 404, json: NOT_FOUND },
      control: { status: 200, cols: c => expect(c.token).not.toBeNull() },
    },
    {
      id: "RR-PL2", what: "token DELETE", method: "DELETE", path: "public-link", seed: { publicToken: "d".repeat(43), publicSlug: "alias-pl2" },
      trashed: { status: 404, json: NOT_FOUND },
      control: { status: 204, cols: c => expect([c.token, c.slug]).toEqual([null, null]) },
    },
    {
      id: "RR-PL3", what: "寬度 PUT", method: "PUT", path: "public-width", body: { width: "wide" }, seed: {},
      trashed: { status: 404, json: NOT_FOUND },
      control: { status: 200, cols: c => expect(c.width).toBe("wide") },
    },
    {
      id: "RR-PS2", what: "別名 PUT", method: "PUT", path: "public-link/slug", body: { slug: "alias-new" }, seed: { publicToken: "s".repeat(43) },
      trashed: { status: 400, json: SLUG_400 },
      control: { status: 200, cols: c => expect(c.slug).toBe("alias-new") },
    },
    {
      id: "RR-PS3", what: "別名 DELETE", method: "DELETE", path: "public-link/slug", seed: { publicToken: "x".repeat(43), publicSlug: "alias-ps3" },
      trashed: { status: 204 },
      control: { status: 204, cols: c => expect(c.slug).toBeNull() },
    },
  ];
  for (const c of plCases) {
    for (const trash of [true, false]) {
      const tag = trash ? `授權後移入 → ${c.trashed.status}（原落空路徑），公開欄位不變` : `對照：縫裡不移入 → ${c.control.status}`;
      it(`${c.id} ${c.what}（public-link-authorized）：${tag}`, async () => {
        const s: Seam = { hits: 0 };
        const built = await buildTestApp({ groupTestHook: groupSeam("public-link-authorized", s) });
        s.db = built.db;
        const { app, db } = built;
        const owner = await seedUser(db);
        const n = await seedNote(db, { ownerId: owner.id }, c.seed);
        const before = await publicCols(db, n.id);
        if (trash) s.target = { id: n.id, by: owner.id };

        const res = await req(app, c.method, `/api/notes/${n.id}/${c.path}`, owner.id, c.body);

        expectSeam(s, n.id, trash);
        if (trash) {
          expect(res.statusCode).toBe(c.trashed.status);
          if (c.trashed.json !== undefined) expect(res.json()).toEqual(c.trashed.json);
          expect(await publicCols(db, n.id)).toEqual(before);
        } else {
          expect(res.statusCode).toBe(c.control.status);
          c.control.cols(await publicCols(db, n.id));
        }
      });
    }
  }

  for (const trash of [true, false]) {
    const tag = trash ? "移入後 → VersionCutAbort note-deleted，note_versions 0 新列" : "對照：活筆記 → 切出 1 版";
    it(`RR-CV 切版 cutVersionInTx：${tag}`, async () => {
      const { db } = await freshDb();
      const owner = await seedUser(db);
      const n = await seedNote(db, { ownerId: owner.id });
      const [row] = await db
        .select({ ownerId: notes.ownerId, groupId: notes.groupId, base: notes.versionBaseFingerprint })
        .from(notes)
        .where(eq(notes.id, n.id));
      const doc = paraDoc(["切版內容"]);
      const input: CutVersionInput = {
        noteId: n.id, kind: "manual", name: null, editors: [{ user_id: owner.id, agent_label: null }],
        expectBaseFingerprint: row!.base, expectSpaceKey: spaceKeyOf(row!),
        loadFingerprint: null, vacuumFingerprint: VACUUM_VERSION_FINGERPRINT,
        capture: () => ({ fp: "fp-rr-cv", ydoc: Y.encodeStateAsUpdate(doc) }), keepExistingName: false,
      };
      if (trash) await trashNow(db, n.id, owner.id);

      const out = await db.transaction(tx => cutVersionInTx(tx, input)).then(r => r, (e: unknown) => e);

      if (trash) {
        expect(out).toBeInstanceOf(VersionCutAbort);
        expect((out as VersionCutAbort).reason).toEqual({ kind: "note-deleted" });
        expect(await versionsOf(db, n.id)).toEqual([]);
      } else {
        expect(out).toMatchObject({ upgraded: false, fp: "fp-rr-cv" });
        expect((await versionsOf(db, n.id)).map(v => v.seq)).toEqual([1]);
      }
    });
  }

  it("RR-SC 掃描 scanDue：兩篇到期、其一在垃圾桶 → 回 1、只切活的；垃圾桶那篇待切仍在；還原後下一輪切出來", async () => {
    const { db } = await freshDb();
    const owner = await seedUser(db);
    const live = await seedNote(db, { ownerId: owner.id });
    const binned = await seedNote(db, { ownerId: owner.id });
    const svc = createVersionService({ db, log: { warn: () => {} }, autoWaitMs: 0 });
    svc.bind(fakeHost());
    const t0 = Date.parse("2026-10-14T00:00:00.000Z");
    const at = (ms: number) => new Date(t0 + ms);
    const me = { user_id: owner.id, agent_label: null };
    for (const id of [live.id, binned.id]) {
      await seedDoc(db, id, paraDoc([`掃描 ${id}`]));
      expect(await markPending(db, { noteId: id, at: at(0), add: [me], ref: VACUUM_VERSION_FINGERPRINT, spaceKey: `u:${owner.id}` })).toBe(1);
    }
    await trashNow(db, binned.id, owner.id);

    expect(await svc.scanDue(at(1))).toBe(1);
    expect((await versionsOf(db, live.id)).map(v => v.kind)).toEqual(["auto"]);
    expect(await pendingOf(db, live.id)).toEqual(NO_PENDING);
    expect(await versionsOf(db, binned.id)).toEqual([]);
    expect((await pendingOf(db, binned.id)).at).toEqual(at(0));

    await markRestored(db.$client, binned.id);
    expect(await svc.scanDue(at(2))).toBe(1);
    expect((await versionsOf(db, binned.id)).map(v => v.kind)).toEqual(["auto"]);
    expect(await pendingOf(db, binned.id)).toEqual(NO_PENDING);
  });

  for (const trash of [true, false]) {
    const tag = trash
      ? "移入後 → 列仍 pending、attempts 不變、內容未改、沒有「連結轉換前」版本（含站內網址、只有 wikilink 兩形）"
      : "對照：活筆記 → 兩篇標 done，含網址那篇轉成 wikilink";
    it(`RR-LC 連結轉換：${tag}`, async () => {
      const ctx = await buildCollabTestApp();
      const owner = await seedUser(ctx.db);
      const a = await seedNote(ctx.db, { ownerId: owner.id }, { title: "A" });
      const host = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Host" });
      const plain = await seedNote(ctx.db, { ownerId: owner.id }, { title: "Plain" });
      await seedOldNote(ctx.db, host.id, `see [A](${testConfig.publicUrl.origin}/notes/${a.id})`);
      await seedDoc(ctx.db, plain.id, wikilinkDoc([a.id]));
      for (const id of [host.id, plain.id]) await ctx.db.insert(noteLinkConversion).values({ noteId: id, status: "pending" });
      const hostBefore = await ydocOf(ctx.db, host.id);
      const plainBefore = await ydocOf(ctx.db, plain.id);
      if (trash) for (const id of [host.id, plain.id]) await trashNow(ctx.db, id, owner.id);

      await runLinkConversion(ctx.app.linkConversion.deps!, { signal: new AbortController().signal, batchSize: 50 });

      const manualNames = async (id: string) => (await versionsOf(ctx.db, id)).filter(v => v.kind === "manual").map(v => v.name);
      if (trash) {
        for (const id of [host.id, plain.id]) expect(await conversionOf(ctx.db, id)).toEqual({ status: "pending", attempts: 0 });
        expect(await ydocOf(ctx.db, host.id)).toEqual(hostBefore);
        expect(await ydocOf(ctx.db, plain.id)).toEqual(plainBefore);
        expect(await manualNames(host.id)).toEqual([]);
        expect(await linkTargetsOf(ctx.db, plain.id)).toEqual([]);
      } else {
        for (const id of [host.id, plain.id]) expect(await conversionOf(ctx.db, id)).toEqual({ status: "done", attempts: 0 });
        expect(await ydocOf(ctx.db, host.id)).not.toEqual(hostBefore);
        expect(await manualNames(host.id)).toEqual([LINK_CONVERSION_VERSION_NAME]);
        expect(await linkTargetsOf(ctx.db, plain.id)).toEqual([a.id]);
      }
    });
  }

  it("RR-LC2 backfill 群組分支照記：群組筆記 S 的 wikilink 指向同群組垃圾桶筆記 T → note_links 有 (S,T)、S 標 done", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await seedUser(ctx.db);
    const g = await seedGroup(ctx.db, "G", [{ userId: owner.id, role: "admin" }]);
    const t = await seedNote(ctx.db, { groupId: g.id }, { title: "T" });
    const src = await seedNote(ctx.db, { groupId: g.id }, { title: "S" });
    await seedDoc(ctx.db, src.id, wikilinkDoc([t.id]));
    await ctx.db.insert(noteLinkConversion).values({ noteId: src.id, status: "pending" });
    await trashNow(ctx.db, t.id, owner.id);

    await runLinkConversion(ctx.app.linkConversion.deps!, { signal: new AbortController().signal, batchSize: 50 });

    expect(await conversionOf(ctx.db, src.id)).toEqual({ status: "done", attempts: 0 });
    expect(await linkTargetsOf(ctx.db, src.id)).toEqual([t.id]);
  });
});
