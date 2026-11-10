/**
 * bulk transfer：整包匯出 `GET /api/transfer/export`。一律走真 HTTP（`exportRaw`）。
 */
import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { ERROR_CODES } from "@knotebook/shared";
import { groupMembers, notes, transferBases, users } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { EXPORT_BUSY_MESSAGE, RANGE_GONE_MESSAGE, TOO_MANY_NOTES_MESSAGE } from "../src/routes/transfer.js";
import { EXPORT_BUSY_RETRY_AFTER_S, TRANSFER_EXPORT_MAX_NOTES, type ExportOutcome, type ExportTestHooks } from "../src/transfer/export-stream.js";
import { presenceClientId } from "../src/notes/editing/presence.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../src/http/body-limits.js";
import { buildCollabTestApp, testConfig } from "./helpers.js";
import { seedContent, seedTokenForUser } from "./editing-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { seedFolder, seedManyNotesInFolder, seedPlacement, setNoteFolder } from "./folder-helpers.js";
import { readTarGz, type TarEntry } from "./tar-read.js";
import type { BulkRange } from "../src/auth/transfer-token.js";
import { basesOf, exportRaw, gate, issueBulkDirect, parseNoteFile, seedMd } from "./bulk-transfer-helpers.js";

type Ctx = Awaited<ReturnType<typeof buildCollabTestApp>>;
const PASSWORD = "correct horse battery staple";
const manifestOf = (entries: TarEntry[]) => JSON.parse(entries.find(e => e.path === ".knotebook/manifest.json")!.data.toString("utf8"));
const filesOf = (entries: TarEntry[]) => entries.filter(e => e.type === "file" && e.path !== ".knotebook/manifest.json");

/** 一位使用者＋唯讀 PAT＋（預設 all 範圍的）bulk 權杖。 */
async function userWithBulk(ctx: Ctx, range?: BulkRange) {
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read");
  const b = await issueBulkDirect(ctx.db, pat.tokenId, range ? { range } : {});
  return { u, pat, b };
}
async function tokenFor(ctx: Ctx, userId: string, range?: BulkRange) {
  const pat = await seedTokenForUser(ctx.db, userId, "notes:read");
  return (await issueBulkDirect(ctx.db, pat.tokenId, range ? { range } : {})).token;
}
async function manyOwned(ctx: Ctx, ownerId: string, n: number): Promise<string[]> {
  const f = await seedFolder(ctx.db, { personal: ownerId }, { name: "many" });
  return seedManyNotesInFolder(ctx.db.$client, { ownerId }, f.id, n);
}

describe("E1–E4：包的形", () => {
  it("E1 基本形：目錄 → 筆記（完整路徑 code unit 序）→ manifest 最後；frontmatter 8 行、base 各自不同且各對到一列基底；manifest 各欄", async () => {
    const ctx = await buildCollabTestApp();
    const { u, b } = await userWithBulk(ctx);
    const other = await seedUser(ctx.db);
    const f1 = await seedFolder(ctx.db, { personal: u.id }, { name: "專案" });
    const f1b = await seedFolder(ctx.db, { personal: u.id }, { name: "子", parentId: f1.id });
    const empty = await seedFolder(ctx.db, { personal: u.id }, { name: "空的" });
    const n1 = await seedNote(ctx.db, { ownerId: u.id }, { title: "頂層" });
    await seedMd(ctx.db, n1.id, "hello top");
    const n2 = await seedNote(ctx.db, { ownerId: u.id }, { title: "深" });
    await setNoteFolder(ctx.db.$client, n2.id, f1b.id);
    await seedMd(ctx.db, n2.id, "# H\n\ndeep");
    const sh = await seedNote(ctx.db, { ownerId: other.id }, { title: "分享的" });
    await seedShare(ctx.db, sh.id, u.id, "viewer");
    const sf = await seedFolder(ctx.db, { shared: u.id }, { name: "我放的" });
    await seedPlacement(ctx.db.$client, u.id, sh.id, sf.id);
    const g = await seedGroup(ctx.db, "團隊", [{ userId: u.id, role: "member" }]);
    const gn = await seedNote(ctx.db, { groupId: g.id }, { title: "群組筆記" });

    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(r.status).toBe(200);
    expect(r.complete).toBe(true);
    const entries = readTarGz(r.body);
    const dirs = entries.filter(e => e.type === "dir").map(e => e.path);
    const files = filesOf(entries).map(e => e.path);
    expect(entries.at(-1)!.path).toBe(".knotebook/manifest.json");
    const firstFile = entries.findIndex(e => e.type === "file");
    expect(entries.slice(0, firstFile).every(e => e.type === "dir")).toBe(true);
    expect(dirs).toEqual([...dirs].sort());
    expect(files).toEqual([...files].sort());
    expect(dirs).toEqual(["Groups", "Groups/團隊", "My notes", "My notes/專案", "My notes/專案/子", "My notes/空的", "Shared with me", "Shared with me/我放的"]);
    expect(files).toEqual(["Groups/團隊/群組筆記.md", "My notes/專案/子/深.md", "My notes/頂層.md", "Shared with me/我放的/分享的.md"]);
    const bases = new Set<string>();
    for (const e of filesOf(entries)) {
      const f = parseNoteFile(e.data.toString("utf8"));
      expect(f.keys).toEqual(["knotebook", "id", "title", "role", "base", "url"]);
      bases.add(f.fm.base!);
      const [row] = await ctx.db.select().from(transferBases).where(eq(transferBases.key, f.fm.base!));
      expect(row?.noteId, e.path).toBe(f.fm.id);
      expect(row?.userId, e.path).toBe(u.id);
    }
    expect(bases.size).toBe(4);
    const m = manifestOf(entries);
    expect(Object.keys(m)).toEqual(["knotebook", "exportedAt", "site", "range", "folders", "notes", "skipped"]);
    expect(m.knotebook).toBe(1);
    expect(m.site).toBe(new URL(testConfig.publicUrl).origin);
    expect(m.range).toEqual({ kind: "all" });
    expect(m.skipped).toEqual([]);
    expect(m.folders).toContainEqual({ path: "My notes", id: null, space: null });
    expect(m.folders).toContainEqual({ path: "Groups/團隊", id: null, space: { kind: "group", groupId: g.id } });
    expect(m.folders).toContainEqual({ path: "My notes/空的", id: empty.id, space: { kind: "personal" } });
    expect(m.notes).toContainEqual({ path: "Groups/團隊/群組筆記.md", id: gn.id, role: "editor" });
    expect(m.notes).toContainEqual({ path: "Shared with me/我放的/分享的.md", id: sh.id, role: "viewer" });
    expect((await basesOf(ctx.db, { userId: u.id })).length).toBe(4);
  });

  it("E2 可見性矩陣：owner、分享 viewer／editor、群組 editor／viewer／create-only（role viewer）在；垃圾桶、非成員群組、canRead:false 角色不在", async () => {
    const ctx = await buildCollabTestApp();
    const { u, b } = await userWithBulk(ctx);
    const o = await seedUser(ctx.db);
    const mine = await seedNote(ctx.db, { ownerId: u.id }, { title: "mine" });
    const trashed = await seedNote(ctx.db, { ownerId: u.id }, { title: "trashed" });
    await ctx.db.update(notes).set({ deletedAt: sql`now()` }).where(eq(notes.id, trashed.id));
    const sv = await seedNote(ctx.db, { ownerId: o.id }, { title: "sv" });
    await seedShare(ctx.db, sv.id, u.id, "viewer");
    const se = await seedNote(ctx.db, { ownerId: o.id }, { title: "se" });
    await seedShare(ctx.db, se.id, u.id, "editor");
    const gE = await seedGroup(ctx.db, "gE", [{ userId: u.id, role: "member" }]);
    const gV = await seedGroup(ctx.db, "gV", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, gV.id, u.id, await seedRole(ctx.db, gV.id, "v", { canRead: true }));
    const gC = await seedGroup(ctx.db, "gC", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, gC.id, u.id, await seedRole(ctx.db, gC.id, "c", { canRead: true, canCreate: true }));
    const gN = await seedGroup(ctx.db, "gN", [{ userId: o.id, role: "admin" }]);
    const gB = await seedGroup(ctx.db, "gB", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, gB.id, u.id, await seedRole(ctx.db, gB.id, "blind", { canRead: false }));
    const ne = await seedNote(ctx.db, { groupId: gE.id }, { title: "ne" });
    const nv = await seedNote(ctx.db, { groupId: gV.id }, { title: "nv" });
    const nc = await seedNote(ctx.db, { groupId: gC.id }, { title: "nc" });
    const nn = await seedNote(ctx.db, { groupId: gN.id }, { title: "nn" });
    const nb = await seedNote(ctx.db, { groupId: gB.id }, { title: "nb" });
    const m = manifestOf(readTarGz((await exportRaw(ctx.baseUrl, b.token)).body));
    const roles = Object.fromEntries((m.notes as Array<{ id: string; role: string }>).map(n => [n.id, n.role]));
    expect(roles).toEqual({ [mine.id]: "owner", [sv.id]: "viewer", [se.id]: "editor", [ne.id]: "editor", [nv.id]: "viewer", [nc.id]: "viewer" });
    for (const id of [trashed.id, nn.id, nb.id]) expect(roles[id]).toBeUndefined();
    expect((m.folders as Array<{ path: string }>).map(f => f.path)).not.toContain("Groups/gB");
  });

  it("E3 四種範圍：personal／shared／group／folder（只有子樹、路徑前綴完整），shared 空間資料夾（placement）", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const o = await seedUser(ctx.db);
    const p1 = await seedFolder(ctx.db, { personal: u.id }, { name: "P1" });
    const p2 = await seedFolder(ctx.db, { personal: u.id }, { name: "P2", parentId: p1.id });
    const inP2 = await seedNote(ctx.db, { ownerId: u.id }, { title: "inP2" });
    await setNoteFolder(ctx.db.$client, inP2.id, p2.id);
    const top = await seedNote(ctx.db, { ownerId: u.id }, { title: "top" });
    const sh = await seedNote(ctx.db, { ownerId: o.id }, { title: "sh" });
    await seedShare(ctx.db, sh.id, u.id, "viewer");
    const sf = await seedFolder(ctx.db, { shared: u.id }, { name: "SF" });
    await seedPlacement(ctx.db.$client, u.id, sh.id, sf.id);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const gn = await seedNote(ctx.db, { groupId: g.id }, { title: "gn" });
    const filesFor = async (range: BulkRange) => filesOf(readTarGz((await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id, range))).body)).map(e => e.path);
    expect(await filesFor({ kind: "personal" })).toEqual(["My notes/P1/P2/inP2.md", "My notes/top.md"]);
    expect(await filesFor({ kind: "shared" })).toEqual(["Shared with me/SF/sh.md"]);
    expect(await filesFor({ kind: "group", groupId: g.id })).toEqual(["Groups/G/gn.md"]);
    expect(await filesFor({ kind: "folder", folderId: p2.id })).toEqual(["My notes/P1/P2/inP2.md"]);
    expect(await filesFor({ kind: "folder", folderId: sf.id })).toEqual(["Shared with me/SF/sh.md"]);
    void top;
    void gn;
  });

  it("E3b 範圍縮小時路徑照完整集合命名：同層資料夾 a:b／a_b 清洗後撞名，對第二個簽 folder 權杖 → 路徑同 all 範圍（a_b (2)）", async () => {
    const ctx = await buildCollabTestApp();
    const u = await seedUser(ctx.db);
    const f1 = await seedFolder(ctx.db, { personal: u.id }, { name: "a:b" });
    const f2 = await seedFolder(ctx.db, { personal: u.id }, { name: "a_b" });
    await ctx.db.execute(sql`update folders set created_at = now() - interval '1 hour' where id = ${f1.id}`);
    const n1 = await seedNote(ctx.db, { ownerId: u.id }, { title: "one" });
    await setNoteFolder(ctx.db.$client, n1.id, f1.id);
    const n2 = await seedNote(ctx.db, { ownerId: u.id }, { title: "two" });
    await setNoteFolder(ctx.db.$client, n2.id, f2.id);
    const all = filesOf(readTarGz((await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id))).body)).map(e => e.path);
    expect(all).toEqual(["My notes/a_b (2)/two.md", "My notes/a_b/one.md"]);
    const sub = readTarGz((await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id, { kind: "folder", folderId: f2.id }))).body);
    expect(filesOf(sub).map(e => e.path)).toEqual(["My notes/a_b (2)/two.md"]);
    expect(sub.filter(e => e.type === "dir").map(e => e.path)).toEqual(["My notes", "My notes/a_b (2)"]);
  });

  it("E4 檔名：A／a 重名、非法字元、空標題 Untitled", async () => {
    const ctx = await buildCollabTestApp();
    const { u, b } = await userWithBulk(ctx);
    const a1 = await seedNote(ctx.db, { ownerId: u.id }, { title: "A" });
    await ctx.db.update(notes).set({ createdAt: sql`now() - interval '1 hour'` }).where(eq(notes.id, a1.id));
    await seedNote(ctx.db, { ownerId: u.id }, { title: "a" });
    await seedNote(ctx.db, { ownerId: u.id }, { title: "x:y?" });
    await seedNote(ctx.db, { ownerId: u.id }, { title: "" });
    const files = filesOf(readTarGz((await exportRaw(ctx.baseUrl, b.token)).body)).map(e => e.path);
    expect(files.sort()).toEqual(["My notes/A.md", "My notes/Untitled.md", "My notes/a (2).md", "My notes/x_y_.md"].sort());
  });
});

describe("E5–E7b、E18：413、全站 1 個、桶", () => {
  it("E5 413：範圍內 3 001 篇 → 413 JSON too_many_notes＋TOO_MANY_NOTES_MESSAGE、未 hijack；之後同一 app 的小範圍權杖立刻 200（slot 已放）", async () => {
    const ctx = await buildCollabTestApp();
    const { u, b } = await userWithBulk(ctx);
    await manyOwned(ctx, u.id, TRANSFER_EXPORT_MAX_NOTES + 1);
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(r.status).toBe(413);
    expect(r.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(r.body.toString("utf8")).error).toEqual({ code: "too_many_notes", message: TOO_MANY_NOTES_MESSAGE });
    const small = await seedFolder(ctx.db, { personal: u.id }, { name: "small" });
    const ok = await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id, { kind: "folder", folderId: small.id }));
    expect(ok.status).toBe(200);
  }, 120_000);

  it("E6 全站 1 個：A 停在 beforeBatch(0)；B → 429＋Retry-After 30；放行 A 後 B → 200", async () => {
    const g = gate();
    let first = true;
    const hooks: ExportTestHooks = {
      beforeBatch: async () => {
        if (first) {
          first = false;
          await g.wait;
        }
      },
    };
    const ctx = await buildCollabTestApp({ transferTestHooks: hooks });
    const A = await userWithBulk(ctx);
    await seedNote(ctx.db, { ownerId: A.u.id });
    const B = await userWithBulk(ctx);
    await seedNote(ctx.db, { ownerId: B.u.id });
    const pa = exportRaw(ctx.baseUrl, A.b.token);
    await vi.waitFor(() => expect(first).toBe(false));
    const rb = await exportRaw(ctx.baseUrl, B.b.token);
    expect(rb.status).toBe(429);
    expect(rb.headers["retry-after"]).toBe(String(EXPORT_BUSY_RETRY_AFTER_S));
    expect(JSON.parse(rb.body.toString("utf8")).error).toEqual({ code: "too_many_requests", message: EXPORT_BUSY_MESSAGE });
    g.open();
    expect((await pa).status).toBe(200);
    expect((await exportRaw(ctx.baseUrl, B.b.token)).status).toBe(200);
  });

  it("E7 transferExport limit 1 → 第二發 429＋Retry-After ≥ 1", async () => {
    const ctx = await buildCollabTestApp({ limiters: { transferExport: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } });
    const { b } = await userWithBulk(ctx);
    expect((await exportRaw(ctx.baseUrl, b.token)).status).toBe(200);
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(r.status).toBe(429);
    expect(String(r.headers["retry-after"])).toMatch(/^[1-9]\d*$/);
  });

  it("E7b 忙碌不扣桶：limit 2；A 停住時 B 連打 3 發都 429（Retry-After 30）；放行後 B → 200", async () => {
    const g = gate();
    let first = true;
    const hooks: ExportTestHooks = { beforeBatch: async () => { if (first) { first = false; await g.wait; } } };
    const ctx = await buildCollabTestApp({ transferTestHooks: hooks, limiters: { transferExport: new FixedWindowLimiter({ limit: 2, windowMs: 3_600_000 }) } });
    const A = await userWithBulk(ctx);
    await seedNote(ctx.db, { ownerId: A.u.id });
    const B = await userWithBulk(ctx);
    const pa = exportRaw(ctx.baseUrl, A.b.token);
    await vi.waitFor(() => expect(first).toBe(false));
    for (let i = 0; i < 3; i++) {
      const r = await exportRaw(ctx.baseUrl, B.b.token);
      expect(r.status, `#${i}`).toBe(429);
      expect(r.headers["retry-after"]).toBe("30");
    }
    g.open();
    expect((await pa).status).toBe(200);
    expect((await exportRaw(ctx.baseUrl, B.b.token)).status).toBe(200);
    expect((await exportRaw(ctx.baseUrl, B.b.token)).status).toBe(200);
  });

  it("E18 範圍物件已看不到（group 權杖、已退群）→ 403 RANGE_GONE、未扣桶；另一位使用者的匯出占著 slot 時仍回 403 不是 429（gone 在拿 slot 之前判）", async () => {
    const g = gate();
    let held = false;
    const hooks: ExportTestHooks = {
      beforeBatch: async () => {
        if (!held) {
          held = true;
          await g.wait;
        }
      },
    };
    const ctx = await buildCollabTestApp({ transferTestHooks: hooks, limiters: { transferExport: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } });
    const u = await seedUser(ctx.db);
    const grp = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const t = await tokenFor(ctx, u.id, { kind: "group", groupId: grp.id });
    await ctx.db.delete(groupMembers).where(eq(groupMembers.userId, u.id));
    // 另一位使用者的匯出停在 slot 內
    const v = await seedUser(ctx.db);
    await seedNote(ctx.db, { ownerId: v.id });
    const pv = exportRaw(ctx.baseUrl, await tokenFor(ctx, v.id));
    await vi.waitFor(() => expect(held).toBe(true));
    let r: Awaited<ReturnType<typeof exportRaw>>;
    try {
      r = await exportRaw(ctx.baseUrl, t);
    } finally {
      g.open(); // 斷言失敗時也放行，免得另一發卡到逾時
    }
    expect(r.status).toBe(403);
    expect(JSON.parse(r.body.toString("utf8")).error).toEqual({ code: "forbidden", message: RANGE_GONE_MESSAGE });
    expect((await pv).status).toBe(200);
    // 桶沒扣：同一位使用者的 all 權杖仍能匯出一次（limit 1）
    expect((await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id))).status).toBe(200);
  });

  it("E22 串流本體在 writeHead 之前丟錯 → 斷線、slot 仍放；照樣記一行 info（鍵集合同 E21、outcome aborted）、onExportEnd(aborted)", async () => {
    let boom = true;
    let called = false;
    const chunks: string[] = [];
    const ends: ExportOutcome[] = [];
    const ctx = await buildCollabTestApp({
      logger: { level: "debug", stream: { write: (s: string) => void chunks.push(s) } },
      transferTestHooks: {
        onExportEnd: o => void ends.push(o),
        beforeStream: () => {
          called = true;
          if (boom) {
            boom = false;
            throw new Error("boom before writeHead");
          }
        },
      },
    });
    const { b } = await userWithBulk(ctx);
    const first = await exportRaw(ctx.baseUrl, b.token).then(
      r => ({ ok: true as const, r }),
      e => ({ ok: false as const, e }),
    );
    expect(called).toBe(true);
    // 沒送出任何標頭就斷線：用戶端拿到連線錯誤（或不完整回應）
    if (first.ok) expect(first.r.complete).toBe(false);
    await vi.waitFor(() => expect(ends).toEqual(["aborted"]));
    const infos = chunks.map(c => JSON.parse(c) as Record<string, unknown>).filter(o => o.msg === "bulk transfer export");
    expect(infos).toHaveLength(1);
    expect(Object.keys(infos[0]!).sort()).toEqual(["bytes", "hostname", "level", "ms", "msg", "notMergeable", "notes", "outcome", "pid", "range", "reqId", "skipped", "time", "tokenId", "userId"]);
    expect(infos[0]).toMatchObject({ outcome: "aborted", notes: 0, skipped: 0, notMergeable: 0, bytes: 0, range: { kind: "all" } });
    expect(chunks.join("")).not.toContain("boom before writeHead");
    const v = await seedUser(ctx.db);
    expect((await exportRaw(ctx.baseUrl, await tokenFor(ctx, v.id))).status).toBe(200);
  });

  it("E23 HEAD /api/transfer/export → 404、不扣桶、不拿 slot（exposeHeadRoute: false）", async () => {
    const ctx = await buildCollabTestApp({ limiters: { transferExport: new FixedWindowLimiter({ limit: 1, windowMs: 3_600_000 }) } });
    const { b } = await userWithBulk(ctx);
    const h = await ctx.app.inject({ method: "HEAD", url: "/api/transfer/export", headers: { authorization: `Bearer ${b.token}` } });
    expect(h.statusCode).toBe(404);
    expect((await exportRaw(ctx.baseUrl, b.token)).status).toBe(200);
  });

  it("E19 ERROR_CODES 含 too_many_notes", () => {
    expect(ERROR_CODES).toContain("too_many_notes");
  });
});

describe("E8–E13：途中變化、檢查點、中止、基底", () => {
  it("E8 途中變化（beforeBatch(1)）：退出 B-team、第 1 批裡一篇 My notes 進垃圾桶 → skipped gone、不在檔案；第 0 批全在", async () => {
    let atBatch1: (() => Promise<void>) | null = null;
    const hooks: ExportTestHooks = { beforeBatch: async i => { if (i === 1 && atBatch1) await atBatch1(); } };
    const ctx = await buildCollabTestApp({ transferTestHooks: hooks });
    const { u, b } = await userWithBulk(ctx);
    const gA = await seedGroup(ctx.db, "A-team", [{ userId: u.id, role: "member" }]);
    const gB = await seedGroup(ctx.db, "B-team", [{ userId: u.id, role: "member" }]);
    const aNotes: string[] = [];
    for (let i = 0; i < 50; i++) aNotes.push((await seedNote(ctx.db, { groupId: gA.id }, { title: `a${String(i).padStart(2, "0")}` })).id);
    const bNotes: string[] = [];
    for (let i = 0; i < 5; i++) bNotes.push((await seedNote(ctx.db, { groupId: gB.id }, { title: `b${i}` })).id);
    const mNotes: string[] = [];
    for (let i = 0; i < 10; i++) mNotes.push((await seedNote(ctx.db, { ownerId: u.id }, { title: `m${i}` })).id);
    atBatch1 = async () => {
      await ctx.db.delete(groupMembers).where(eq(groupMembers.groupId, gB.id));
      await ctx.db.update(notes).set({ deletedAt: sql`now()` }).where(eq(notes.id, mNotes[0]!));
    };
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(r.complete).toBe(true);
    const entries = readTarGz(r.body);
    const m = manifestOf(entries);
    const files = filesOf(entries).map(e => e.path);
    // 前提：B-team 與 m0 排在第 50 位之後（第 1 批）
    expect(files.filter(p => p.startsWith("Groups/A-team/"))).toHaveLength(50);
    expect(new Set((m.skipped as Array<{ id: string; reason: string }>).map(s => `${s.id}:${s.reason}`))).toEqual(new Set([...bNotes, mNotes[0]!].map(id => `${id}:gone`)));
    expect(files.some(p => p.startsWith("Groups/B-team/"))).toBe(false);
    expect(files).not.toContain("My notes/m0.md");
    expect(files).toContain("My notes/m1.md");
    void aNotes;
  });

  async function fiftyOne(ctx: Ctx, userId: string) {
    return manyOwned(ctx, userId, 51);
  }

  it("E9 途中到期（beforeBatch(1) 讓權杖過期）→ 照常完成（≥ 51 篇、beforeBatch(1) 確實被呼叫）", async () => {
    let onB1: (() => Promise<void>) | null = null;
    let called1 = false;
    const ctx = await buildCollabTestApp({ transferTestHooks: { beforeBatch: async i => { if (i === 1) { called1 = true; await onB1?.(); } } } });
    const { u, b } = await userWithBulk(ctx);
    await fiftyOne(ctx, u.id);
    onB1 = async () => {
      await ctx.db.execute(sql`update transfer_tokens set created_at = now() - interval '40 minutes', expires_at = now() - interval '1 minute' where id = ${b.id}`);
    };
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(called1).toBe(true);
    expect(r.complete).toBe(true);
    expect(filesOf(readTarGz(r.body))).toHaveLength(51);
  });

  it("E10 途中撤銷（beforeBatch(1) 刪權杖列）→ complete false、讀不出完整包、onExportEnd(aborted)；之後新權杖可再匯出", async () => {
    let onB1: (() => Promise<void>) | null = null;
    let called1 = false;
    const ends: ExportOutcome[] = [];
    const ctx = await buildCollabTestApp({ transferTestHooks: { beforeBatch: async i => { if (i === 1) { called1 = true; await onB1?.(); } }, onExportEnd: o => void ends.push(o) } });
    const { u, b } = await userWithBulk(ctx);
    await fiftyOne(ctx, u.id);
    onB1 = async () => {
      await ctx.db.execute(sql`delete from transfer_tokens where id = ${b.id}`);
    };
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(called1).toBe(true);
    expect(r.status).toBe(200);
    expect(r.complete).toBe(false);
    expect(() => readTarGz(r.body)).toThrow();
    await vi.waitFor(() => expect(ends).toEqual(["aborted"]));
    onB1 = null;
    expect((await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id))).complete).toBe(true);
  });

  it("E11 途中停權 → 同 E10（aborted）", async () => {
    let onB1: (() => Promise<void>) | null = null;
    let called1 = false;
    const ends: ExportOutcome[] = [];
    const ctx = await buildCollabTestApp({ transferTestHooks: { beforeBatch: async i => { if (i === 1) { called1 = true; await onB1?.(); } }, onExportEnd: o => void ends.push(o) } });
    const { u, b } = await userWithBulk(ctx);
    await fiftyOne(ctx, u.id);
    onB1 = async () => {
      await ctx.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
      ctx.gate.invalidate(u.id);
    };
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(called1).toBe(true);
    expect(r.complete).toBe(false);
    expect(() => readTarGz(r.body)).toThrow();
    await vi.waitFor(() => expect(ends).toEqual(["aborted"]));
  });

  it("E12 用戶端斷線（不靠時序）：第 1 篇之後停住；用戶端 destroy；server 觀察到 close 再放行 → client_closed、afterNote 次數 < 總篇數；slot 已放", async () => {
    const g = gate();
    let after = 0;
    let closed = false;
    const ends: ExportOutcome[] = [];
    const ctx = await buildCollabTestApp({
      transferTestHooks: {
        afterNote: async () => {
          after++;
          if (after === 1) await g.wait;
        },
        onClientClose: () => {
          closed = true;
        },
        onExportEnd: o => void ends.push(o),
      },
    });
    const { u, b } = await userWithBulk(ctx);
    await manyOwned(ctx, u.id, 5);
    await new Promise<void>((resolve, reject) => {
      const req = http.get(`${ctx.baseUrl}/api/transfer/export`, { headers: { authorization: `Bearer ${b.token}` } }, res => {
        res.once("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("no first chunk")), 10_000);
    });
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
    g.open();
    await vi.waitFor(() => expect(ends).toEqual(["client_closed"]), { timeout: 5_000 });
    expect(after).toBeLessThan(5);
    const v = await seedUser(ctx.db);
    expect((await exportRaw(ctx.baseUrl, await tokenFor(ctx, v.id))).status).toBe(200);
  });

  it("E13 基底：完成後列數＝檔案數；第 1 批的 INSERT 失敗 → aborted、afterNote 恰 100、第 0 批 50 列在 DB", async () => {
    let onB1: (() => Promise<void>) | null = null;
    let after = 0;
    const ends: ExportOutcome[] = [];
    const ctx = await buildCollabTestApp({
      transferTestHooks: { beforeBatch: async i => { if (i === 1) await onB1?.(); }, afterNote: async () => void after++, onExportEnd: o => void ends.push(o) },
    });
    const { u, b } = await userWithBulk(ctx);
    await manyOwned(ctx, u.id, 101);
    const done = await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id));
    expect(done.complete).toBe(true);
    expect((await basesOf(ctx.db, { userId: u.id })).length).toBe(filesOf(readTarGz(done.body)).length);
    await ctx.db.execute(sql`delete from transfer_bases`);
    after = 0;
    ends.length = 0;
    const pool = ctx.db.$client;
    onB1 = async () => {
      await pool.query(`create or replace function wb1_e13_fail() returns trigger language plpgsql as $$ begin raise exception 'e13 boom'; end $$`);
      await pool.query(`create trigger wb1_e13_trg before insert on transfer_bases for each row execute function wb1_e13_fail()`);
    };
    try {
      const r = await exportRaw(ctx.baseUrl, b.token);
      expect(r.complete).toBe(false);
      await vi.waitFor(() => expect(ends).toEqual(["aborted"]));
      expect(after).toBe(100);
    } finally {
      await pool.query("drop trigger if exists wb1_e13_trg on transfer_bases");
      await pool.query("drop function if exists wb1_e13_fail()");
    }
    expect((await basesOf(ctx.db, { userId: u.id })).length).toBe(50);
  });
});

describe("E14–E17：not mergeable、標頭、presence、live", () => {
  it("E14 forceUnmergeable 一篇 → manifest 該項 mergeable:false、基底 segments NULL、檔照樣在；其他項沒有 mergeable 鍵", async () => {
    let target = "";
    const ctx = await buildCollabTestApp({ transferTestHooks: { forceUnmergeable: id => id === target } });
    const { u, b } = await userWithBulk(ctx);
    const n1 = await seedNote(ctx.db, { ownerId: u.id }, { title: "n1" });
    const n2 = await seedNote(ctx.db, { ownerId: u.id }, { title: "n2" });
    await seedMd(ctx.db, n1.id, "one");
    await seedMd(ctx.db, n2.id, "two");
    target = n1.id;
    const entries = readTarGz((await exportRaw(ctx.baseUrl, b.token)).body);
    const m = manifestOf(entries);
    expect(m.notes).toContainEqual({ path: "My notes/n1.md", id: n1.id, role: "owner", mergeable: false });
    expect(m.notes).toContainEqual({ path: "My notes/n2.md", id: n2.id, role: "owner" });
    expect(filesOf(entries).map(e => e.path)).toContain("My notes/n1.md");
    const [b1] = await basesOf(ctx.db, { noteId: n1.id });
    const [b2] = await basesOf(ctx.db, { noteId: n2.id });
    expect(b1!.segments).toBeNull();
    expect(b2!.segments).not.toBeNull();
  });

  it("E14b（門檻 256 KiB）檔案超過寫回上限 → manifest 該項 tooLargeToSend:true；剛好在上限內的與一般檔沒有這個鍵", async () => {
    const ctx = await buildCollabTestApp();
    const { u, b } = await userWithBulk(ctx);
    const big = await seedNote(ctx.db, { ownerId: u.id }, { title: "big" });
    const near = await seedNote(ctx.db, { ownerId: u.id }, { title: "near" });
    const small = await seedNote(ctx.db, { ownerId: u.id }, { title: "small" });
    // big ≈ 280 KB（超過 256 KiB、遠低於舊的 1 MiB）；near ≈ 240 KB（在 256 KiB 內）
    await seedMd(ctx.db, big.id, Array.from({ length: 70 }, (_, i) => `p${i} ${"x".repeat(4000)}`).join("\n\n"));
    await seedMd(ctx.db, near.id, Array.from({ length: 60 }, (_, i) => `p${i} ${"x".repeat(4000)}`).join("\n\n"));
    await seedMd(ctx.db, small.id, "small body");
    const entries = readTarGz((await exportRaw(ctx.baseUrl, b.token)).body);
    const m = manifestOf(entries);
    const sizeOf = (p: string) => filesOf(entries).find(e => e.path === p)!.data.length;
    expect(sizeOf("My notes/big.md")).toBeGreaterThan(TRANSFER_WRITE_BODY_LIMIT);
    expect(sizeOf("My notes/big.md")).toBeLessThan(1_048_576);
    expect(sizeOf("My notes/near.md")).toBeLessThanOrEqual(TRANSFER_WRITE_BODY_LIMIT);
    expect(m.notes).toContainEqual({ path: "My notes/big.md", id: big.id, role: "owner", tooLargeToSend: true });
    expect(m.notes).toContainEqual({ path: "My notes/near.md", id: near.id, role: "owner" });
    expect(m.notes).toContainEqual({ path: "My notes/small.md", id: small.id, role: "owner" });
  });

  it("E15 標頭：application/gzip、content-disposition、nosniff", async () => {
    const ctx = await buildCollabTestApp();
    const { b } = await userWithBulk(ctx);
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(r.headers["content-type"]).toBe("application/gzip");
    expect(r.headers["content-disposition"]).toMatch(/^attachment; filename="knotebook-\d{8}-\d{6}\.tar\.gz"$/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("E16／E17 live 內容、不 touch presence", async () => {
    const ctx = await buildCollabTestApp();
    const email = `o-${randomUUID()}@example.com`;
    const owner = await ctx.createUser({ email, password: PASSWORD });
    const n = await ctx.createNote(owner.id);
    const client = await seedContent(ctx, await ctx.loginAs(email, PASSWORD), n.id, "live export sentinel-e17");
    const pat = await seedTokenForUser(ctx.db, owner.id, "notes:read");
    const b = await issueBulkDirect(ctx.db, pat.tokenId);
    const live = ctx.collab.hocuspocus.documents.get(n.id)!;
    const before = [...live.awareness.getStates().keys()].sort();
    const entries = readTarGz((await exportRaw(ctx.baseUrl, b.token)).body);
    expect(filesOf(entries)[0]!.data.toString("utf8")).toContain("sentinel-e17");
    expect(live.awareness.getStates().get(presenceClientId(n.id, pat.tokenId))).toBeUndefined();
    expect([...live.awareness.getStates().keys()].sort()).toEqual(before);
    client.disconnect();
  });
});

describe("E20：背壓中斷線（真 HTTP、用戶端 pause）", () => {
  it("8 篇 × 2 MiB base64：用戶端不讀 → server 卡住（afterNote 連續 ≥ 2 s 不增加且 ≤ N−2）；destroy → 5 s 內 client_closed、slot 已放", async () => {
    const N = 8;
    let after = 0;
    let closed = false;
    const ends: ExportOutcome[] = [];
    const ctx = await buildCollabTestApp({
      transferTestHooks: { afterNote: async () => void after++, onClientClose: () => void (closed = true), onExportEnd: o => void ends.push(o) },
    });
    const { u, b } = await userWithBulk(ctx);
    for (let i = 0; i < N; i++) {
      const n = await seedNote(ctx.db, { ownerId: u.id }, { title: `big${i}` });
      await seedMd(ctx.db, n.id, randomBytes(Math.round(1.5 * 1024 * 1024)).toString("base64"));
    }
    let req!: http.ClientRequest;
    await new Promise<void>((resolve, reject) => {
      req = http.get(`${ctx.baseUrl}/api/transfer/export`, { headers: { authorization: `Bearer ${b.token}` } }, res => {
        res.pause();
        resolve();
      });
      req.on("error", () => {});
      setTimeout(() => reject(new Error("no response")), 30_000);
    });
    // 判卡：afterNote 連續 ≥ 2 s 沒增加
    let last = -1;
    let since = Date.now();
    const t0 = Date.now();
    while (Date.now() - t0 < 60_000) {
      await new Promise(r => setTimeout(r, 100));
      if (after !== last) {
        last = after;
        since = Date.now();
      } else if (Date.now() - since >= 2_000) break;
    }
    expect(Date.now() - since, "前提：afterNote 連續 ≥ 2 s 沒增加").toBeGreaterThanOrEqual(2_000);
    expect(after, "前提：卡在中途（≤ N−2）").toBeLessThanOrEqual(N - 2);
    expect(ends, "前提：還沒結束").toEqual([]);
    req.destroy();
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5_000 });
    await vi.waitFor(() => expect(ends).toEqual(["client_closed"]), { timeout: 5_000 });
    const v = await seedUser(ctx.db);
    expect((await exportRaw(ctx.baseUrl, await tokenFor(ctx, v.id))).status).toBe(200);
  }, 180_000);
});

describe("E21：log 不洩內容", () => {
  it("整包（含 unmergeable 與 failed）＋單篇＋中止（trigger 形）：log 不含任何標記；整包 info 行鍵集合恰為規定的鍵＋pino 自帶欄", async () => {
    const chunks: string[] = [];
    let unm = "";
    let fail = "";
    const BODY_MARK = "BODYMARK-" + randomUUID().slice(0, 8);
    let onB1: (() => Promise<void>) | null = null;
    const ctx = await buildCollabTestApp({
      logger: { level: "debug", stream: { write: (s: string) => void chunks.push(s) } },
      transferTestHooks: {
        forceUnmergeable: id => id === unm,
        forceFailNote: id => (id === fail ? BODY_MARK : undefined),
        beforeBatch: async i => { if (i === 1) await onB1?.(); },
      },
    });
    const { u, b } = await userWithBulk(ctx);
    const FOLDER_MARK = "FOLDERMARK-" + randomUUID().slice(0, 8);
    const f = await seedFolder(ctx.db, { personal: u.id }, { name: FOLDER_MARK });
    const titles: string[] = [];
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const t = `TITLEMARK-${i}-${randomUUID().slice(0, 8)}`;
      titles.push(t);
      const n = await seedNote(ctx.db, { ownerId: u.id }, { title: t });
      await setNoteFolder(ctx.db.$client, n.id, f.id);
      await seedMd(ctx.db, n.id, `${BODY_MARK} body ${i}`);
      ids.push(n.id);
    }
    unm = ids[0]!;
    fail = ids[1]!;
    const r = await exportRaw(ctx.baseUrl, b.token);
    expect(r.complete).toBe(true);
    expect((await ctx.app.inject({ method: "GET", url: `/api/transfer/notes/${ids[2]}`, headers: { authorization: `Bearer ${b.token}` } })).statusCode).toBe(200);
    // 中止：≥ 51 篇、第 1 批前建 trigger，raise 的訊息裡放標記
    await manyOwned(ctx, u.id, 51);
    const TRIG_MARK = "TRIGMARK-" + randomUUID().slice(0, 8);
    const pool = ctx.db.$client;
    onB1 = async () => {
      await pool.query(`create or replace function wb1_e21_fail() returns trigger language plpgsql as $$ begin raise exception '${TRIG_MARK}'; end $$`);
      await pool.query(`create trigger wb1_e21_trg before insert on transfer_bases for each row execute function wb1_e21_fail()`);
    };
    try {
      const ab = await exportRaw(ctx.baseUrl, await tokenFor(ctx, u.id));
      expect(ab.complete).toBe(false);
    } finally {
      await pool.query("drop trigger if exists wb1_e21_trg on transfer_bases");
      await pool.query("drop function if exists wb1_e21_fail()");
    }
    await new Promise(r2 => setTimeout(r2, 200));
    const all = chunks.join("");
    for (const mark of [...titles, BODY_MARK, FOLDER_MARK, TRIG_MARK, "knbt_", b.token]) expect(all, mark).not.toContain(mark);
    const infos = chunks.map(c => JSON.parse(c) as Record<string, unknown>).filter(o => o.msg === "bulk transfer export");
    expect(infos.length).toBe(2);
    const first = infos[0]!;
    expect(Object.keys(first).sort()).toEqual(["bytes", "hostname", "level", "ms", "msg", "notMergeable", "notes", "outcome", "pid", "range", "reqId", "skipped", "time", "tokenId", "userId"]);
    expect(first).toMatchObject({ notMergeable: 1, skipped: 1, notes: 2, outcome: "done", userId: u.id });
    expect(infos[1]).toMatchObject({ outcome: "aborted" });
    // 報告用：貼一行原文（UTF-8 讀回由呼叫端做）
    console.log("[E21 info line] " + JSON.stringify(first));
  }, 120_000);
});
