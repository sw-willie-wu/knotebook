/**
 * bulk transfer（CR1–CR13）：沒有 `id` 的檔＝新增筆記、`transfer_creates` 去重、落點。
 */
import { describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { folders, notes, transferCreates } from "../src/db/schema.js";
import { TRANSFER_WRITE_BODY_LIMIT } from "../src/http/body-limits.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import type { BulkRange } from "../src/auth/transfer-token.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../src/folders/messages.js";
import {
  CREATE_IN_SHARED_FORBIDDEN_MESSAGE,
  DEST_NOT_IN_RANGE_MESSAGE,
  GROUP_CREATE_FORBIDDEN_MESSAGE,
  SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE,
} from "../src/transfer/create-file.js";
import { buildCollabTestApp, testConfig, type CollabTestCtx } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { seedGroup, seedNote, seedRole, seedShare, seedUser, setMemberRole } from "./group-helpers.js";
import { bulkPut, issueBulkDirect, liveMarkdown } from "./bulk-transfer-helpers.js";

type Opts = Parameters<typeof buildCollabTestApp>[0];

async function scene(opts: Opts = {}, range: BulkRange = { kind: "all" }) {
  const ctx = await buildCollabTestApp(opts);
  const u = await seedUser(ctx.db);
  const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
  const bulk = await issueBulkDirect(ctx.db, pat.tokenId, { access: "write", range });
  return { ctx, u, pat, bulk };
}
const fileOf = (fm: Record<string, string>, body: string) =>
  `---\nknotebook: 1\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n${body}\n`;
const errOf = (r: { json(): unknown }) => (r.json() as { error: { code: string; message: string } }).error;
const liveNotes = (ctx: CollabTestCtx) => ctx.db.select().from(notes).where(isNull(notes.deletedAt));
const createsOf = (ctx: CollabTestCtx) => ctx.db.select().from(transferCreates);
const noteRow = async (ctx: CollabTestCtx, id: string) => (await ctx.db.select().from(notes).where(eq(notes.id, id)))[0]!;
const norm = (s: string) => s.replace(/\n+$/, "");

describe("新增", () => {
  it("CR1 有 knotebook: 無 id → 201、內容＝本文、標題＝title；沒有 title 行 → Untitled＋untitled-<uuid8>；整檔沒有 frontmatter → 201", async () => {
    const s = await scene();
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Fresh" }, "Para A\n\nPara B"));
    expect(r.statusCode).toBe(201);
    const j = r.json() as { id: string };
    expect(r.json()).toEqual({ id: j.id, created: true, result: "created", base: null, unboundWikilinks: 0 });
    expect((await noteRow(s.ctx, j.id)).title).toBe("Fresh");
    expect(norm(await liveMarkdown(s.ctx, j.id))).toBe("Para A\n\nPara B");
    expect((await noteRow(s.ctx, j.id)).ownerId).toBe(s.u.id);

    const r2 = await bulkPut(s.ctx.app, s.bulk.token, fileOf({}, "No title body"));
    expect(r2.statusCode).toBe(201);
    const n2 = await noteRow(s.ctx, (r2.json() as { id: string }).id);
    expect(n2.title).toBe("Untitled");
    expect(n2.slug).toMatch(/^untitled-[0-9a-f]{8}$/);

    const r3 = await bulkPut(s.ctx.app, s.bulk.token, "Plain file without front matter\n");
    expect(r3.statusCode).toBe(201);
    expect(norm(await liveMarkdown(s.ctx, (r3.json() as { id: string }).id))).toBe("Plain file without front matter");
  });

  it("CR2 重送同檔 → 200 unchanged 同 id、不扣 transferWrite、扣 tokenRead", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 2, windowMs: 60_000 });
    const tokenRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite, tokenRead } });
    const text = fileOf({ title: "Dup" }, "Dup body");
    const r1 = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r1.statusCode).toBe(201);
    const id = (r1.json() as { id: string }).id;
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r2.statusCode).toBe(200);
    expect(r2.json()).toEqual({ id, created: false, result: "unchanged", base: null });
    // 命中扣的是 tokenRead（limit 1 已用完）→ 第二次命中 429
    expect((await bulkPut(s.ctx.app, s.bulk.token, text)).statusCode).toBe(429);
    expect(await liveNotes(s.ctx)).toHaveLength(1);
    // transferWrite 只扣了 1：再新增一篇仍 201
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Other" }, "Other body"))).statusCode).toBe(201);
  });

  it("CR2b CRLF＋結尾空行的同檔 → 去重命中", async () => {
    const s = await scene();
    const text = fileOf({ title: "Dup" }, "Dup body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    const r = await bulkPut(s.ctx.app, s.bulk.token, `${text.replace(/\n/g, "\r\n")}\r\n\r\n`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, created: false });
  });

  it("CR3 重啟後（同一個 DB、第二個 app）仍同 id；CR7 換金鑰後重送 → 新建", async () => {
    const s = await scene();
    const text = fileOf({ title: "Restart" }, "Restart body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.destroy();
    const ctx2 = await buildCollabTestApp({ db: s.ctx.db });
    const r = await bulkPut(ctx2.app, s.bulk.token, text);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id, created: false });
    await ctx2.destroy();
    const ctx3 = await buildCollabTestApp({ db: s.ctx.db, config: { ...testConfig, appSecret: `${testConfig.appSecret}-rotated` } });
    const r3 = await bulkPut(ctx3.app, s.bulk.token, text);
    expect(r3.statusCode).toBe(201);
    expect((r3.json() as { id: string }).id).not.toBe(id);
    expect(await liveNotes(ctx3)).toHaveLength(2);
  });

  it("CR7b 去重列的 key_id 不是目前金鑰（舊金鑰留下的列）→ 當作不存在、新建", async () => {
    // 換金鑰時 file_sha 本身也會變（HMAC 帶 K），所以 CR7 拿掉 key_id 比對仍綠；這案直接把列標成舊金鑰，守 key_id 那一條。
    const s = await scene();
    const text = fileOf({ title: "Stale key" }, "Stale key body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.db.update(transferCreates).set({ keyId: "0000000000000000" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(201);
    expect((r.json() as { id: string }).id).not.toBe(id);
  });

  it("CR4 兩發同時 → 恰一篇（create: 佇列鍵）", async () => {
    const s = await scene();
    const text = fileOf({ title: "Race" }, "Race body");
    const [a, b] = await Promise.all([bulkPut(s.ctx.app, s.bulk.token, text), bulkPut(s.ctx.app, s.bulk.token, text)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect((a.json() as { id: string }).id).toBe((b.json() as { id: string }).id);
    expect(await liveNotes(s.ctx)).toHaveLength(1);
  });

  it("CR5 TTL 外（created_at 改成 31 分前）→ 新建、upsert 不撞 PK", async () => {
    const s = await scene();
    const text = fileOf({ title: "Old" }, "Old body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.db.update(transferCreates).set({ createdAt: sql`now() - interval '31 minutes'` });
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(201);
    const id2 = (r.json() as { id: string }).id;
    expect(id2).not.toBe(id);
    expect((await createsOf(s.ctx)).map(c => c.noteId)).toEqual([id2]);
  });

  it("CR6 原筆記進垃圾桶後重送 → 新建", async () => {
    const s = await scene();
    const text = fileOf({ title: "Trash" }, "Trash body");
    const id = ((await bulkPut(s.ctx.app, s.bulk.token, text)).json() as { id: string }).id;
    await s.ctx.db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, id));
    const r = await bulkPut(s.ctx.app, s.bulk.token, text);
    expect(r.statusCode).toBe(201);
    expect((r.json() as { id: string }).id).not.toBe(id);
    expect(await createsOf(s.ctx)).toHaveLength(1);
  });

  it("CR8 落點四形＋folder_id 指到範圍內資料夾", async () => {
    // all → 我的筆記最上層
    const sAll = await scene();
    const rAll = await bulkPut(sAll.ctx.app, sAll.bulk.token, fileOf({ title: "A" }, "a"));
    expect(await noteRow(sAll.ctx, (rAll.json() as { id: string }).id)).toMatchObject({ ownerId: sAll.u.id, groupId: null, folderId: null });
    // personal＋folder_id（個人資料夾）
    const fP = await seedFolder(sAll.ctx.db, { personal: sAll.u.id });
    const pat2 = await seedTokenForUser(sAll.ctx.db, sAll.u.id, "notes:read notes:write");
    const personal = await issueBulkDirect(sAll.ctx.db, pat2.tokenId, { access: "write", range: { kind: "personal" } });
    const rP = await bulkPut(sAll.ctx.app, personal.token, fileOf({ title: "P", folder_id: fP.id.toUpperCase() }, "p"));
    expect(rP.statusCode).toBe(201);
    expect(await noteRow(sAll.ctx, (rP.json() as { id: string }).id)).toMatchObject({ ownerId: sAll.u.id, groupId: null, folderId: fP.id });
    // folder 範圍沒給 folder_id → 該資料夾；給子資料夾 → 子資料夾
    const child = await seedFolder(sAll.ctx.db, { personal: sAll.u.id }, { parentId: fP.id });
    const pat3 = await seedTokenForUser(sAll.ctx.db, sAll.u.id, "notes:read notes:write");
    const fb = await issueBulkDirect(sAll.ctx.db, pat3.tokenId, { access: "write", range: { kind: "folder", folderId: fP.id } });
    const rF = await bulkPut(sAll.ctx.app, fb.token, fileOf({ title: "F" }, "f"));
    expect(await noteRow(sAll.ctx, (rF.json() as { id: string }).id)).toMatchObject({ folderId: fP.id });
    const rC = await bulkPut(sAll.ctx.app, fb.token, fileOf({ title: "C", folder_id: child.id }, "c"));
    expect(rC.statusCode).toBe(201);
    expect(await noteRow(sAll.ctx, (rC.json() as { id: string }).id)).toMatchObject({ folderId: child.id });
    // group 範圍 → 群組最上層
    const g = await seedGroup(sAll.ctx.db, "G", [{ userId: sAll.u.id, role: "member" }]);
    const pat4 = await seedTokenForUser(sAll.ctx.db, sAll.u.id, "notes:read notes:write");
    const gb = await issueBulkDirect(sAll.ctx.db, pat4.tokenId, { access: "write", range: { kind: "group", groupId: g.id } });
    const rG = await bulkPut(sAll.ctx.app, gb.token, fileOf({ title: "G" }, "g"));
    expect(rG.statusCode).toBe(201);
    expect(await noteRow(sAll.ctx, (rG.json() as { id: string }).id)).toMatchObject({ ownerId: null, groupId: g.id, folderId: null });
  });

  it("CR8bfront matter 只有 title＋folder_id、沒有 knotebook:／id: 行 → 不算 front matter：Untitled、建在權杖範圍最上層、那幾行進了內文；加上 knotebook: 行的同一份 → 照 title／folder_id", async () => {
    const s = await scene();
    const top = await seedFolder(s.ctx.db, { personal: s.u.id });
    const sub = await seedFolder(s.ctx.db, { personal: s.u.id }, { parentId: top.id });
    const pat = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const fb = await issueBulkDirect(s.ctx.db, pat.tokenId, { access: "write", range: { kind: "folder", folderId: top.id } });
    const bare = `---\ntitle: "Ignored title"\nfolder_id: ${sub.id}\n---\nBody of bare file\n`;
    const r = await bulkPut(s.ctx.app, fb.token, bare);
    expect(r.statusCode).toBe(201);
    const id = (r.json() as { id: string }).id;
    expect(await noteRow(s.ctx, id)).toMatchObject({ title: "Untitled", folderId: top.id });
    const md = await liveMarkdown(s.ctx, id);
    expect(md).toContain('title: "Ignored title"');
    expect(md).toContain("Body of bare file");
    // 對照：同一份加上 knotebook: 行
    const withLine = bare.replace("---\n", "---\nknotebook: 1\n");
    const r2 = await bulkPut(s.ctx.app, fb.token, withLine);
    expect(r2.statusCode).toBe(201);
    const id2 = (r2.json() as { id: string }).id;
    expect(await noteRow(s.ctx, id2)).toMatchObject({ title: "Ignored title", folderId: sub.id });
    expect(norm(await liveMarkdown(s.ctx, id2))).toBe("Body of bare file");
  });

  it("CR9 拒絕形（各帶自己的常數訊息）：shared 範圍 403 CREATE_IN_SHARED_FORBIDDEN_MESSAGE；folder_id 看不到 404 FOLDER_NOT_FOUND_MESSAGE；shared 空間資料夾 403 SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE；範圍外資料夾 403 DEST_NOT_IN_RANGE_MESSAGE；create-only 角色：群組最上層 201、群組資料夾 403 NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE；唯讀角色：群組最上層 403 GROUP_CREATE_FORBIDDEN_MESSAGE", async () => {
    const s = await scene({}, { kind: "shared" });
    const r1 = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "S" }, "s"));
    expect(r1.statusCode).toBe(403);
    expect(errOf(r1)).toEqual({ code: "forbidden", message: CREATE_IN_SHARED_FORBIDDEN_MESSAGE });

    const pat = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const all = await issueBulkDirect(s.ctx.db, pat.tokenId, { access: "write" });
    const stranger = await seedUser(s.ctx.db);
    const hidden = await seedFolder(s.ctx.db, { personal: stranger.id });
    const r2 = await bulkPut(s.ctx.app, all.token, fileOf({ title: "H", folder_id: hidden.id }, "h"));
    expect(r2.statusCode).toBe(404);
    expect(errOf(r2)).toEqual({ code: "folder_not_found", message: FOLDER_NOT_FOUND_MESSAGE });

    // 分享給我的空間裡的資料夾（我把別人分享的筆記收進自己的 shared 空間資料夾）
    const sharedFolder = await seedFolder(s.ctx.db, { shared: s.u.id });
    const sn = await seedNote(s.ctx.db, { ownerId: stranger.id }, { title: "SN" });
    await seedShare(s.ctx.db, sn.id, s.u.id, "editor");
    const r3 = await bulkPut(s.ctx.app, all.token, fileOf({ title: "SF", folder_id: sharedFolder.id }, "sf"));
    expect(r3.statusCode).toBe(403);
    expect(errOf(r3)).toEqual({ code: "forbidden", message: SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE });

    // 範圍外：folder 範圍、folder_id 指到範圍外的個人資料夾
    const inF = await seedFolder(s.ctx.db, { personal: s.u.id });
    const outF = await seedFolder(s.ctx.db, { personal: s.u.id });
    const pat2 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const fb = await issueBulkDirect(s.ctx.db, pat2.tokenId, { access: "write", range: { kind: "folder", folderId: inF.id } });
    const r4 = await bulkPut(s.ctx.app, fb.token, fileOf({ title: "O", folder_id: outF.id }, "o"));
    expect(r4.statusCode).toBe(403);
    expect(errOf(r4)).toEqual({ code: "forbidden", message: DEST_NOT_IN_RANGE_MESSAGE });
    // personal 範圍、folder_id 指到群組資料夾 → 範圍外
    const g = await seedGroup(s.ctx.db, "G", [{ userId: s.u.id, role: "member" }]);
    const gf = await seedFolder(s.ctx.db, { group: g.id });
    const pat3 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const pb = await issueBulkDirect(s.ctx.db, pat3.tokenId, { access: "write", range: { kind: "personal" } });
    const r5 = await bulkPut(s.ctx.app, pb.token, fileOf({ title: "PG", folder_id: gf.id }, "pg"));
    expect(r5.statusCode).toBe(403);
    expect(errOf(r5)).toEqual({ code: "forbidden", message: DEST_NOT_IN_RANGE_MESSAGE });

    // create-only 角色
    const co = await seedRole(s.ctx.db, g.id, "create-only", { canRead: true, canCreate: true });
    await setMemberRole(s.ctx.db, g.id, s.u.id, co);
    const pat4 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const gb = await issueBulkDirect(s.ctx.db, pat4.tokenId, { access: "write", range: { kind: "group", groupId: g.id } });
    expect((await bulkPut(s.ctx.app, gb.token, fileOf({ title: "CO" }, "co"))).statusCode).toBe(201);
    const r6 = await bulkPut(s.ctx.app, gb.token, fileOf({ title: "COF", folder_id: gf.id }, "cof"));
    expect(r6.statusCode).toBe(403);
    expect(errOf(r6)).toEqual({ code: "forbidden", message: NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE });
    // 唯讀角色：群組範圍、不給 folder_id → 群組最上層不能建立
    const g2 = await seedGroup(s.ctx.db, "G2", [{ userId: s.u.id, role: "member" }]);
    await setMemberRole(s.ctx.db, g2.id, s.u.id, await seedRole(s.ctx.db, g2.id, "read-only", { canRead: true }));
    const pat5 = await seedTokenForUser(s.ctx.db, s.u.id, "notes:read notes:write");
    const g2b = await issueBulkDirect(s.ctx.db, pat5.tokenId, { access: "write", range: { kind: "group", groupId: g2.id } });
    const r7 = await bulkPut(s.ctx.app, g2b.token, fileOf({ title: "RO" }, "ro"));
    expect(r7.statusCode).toBe(403);
    expect(errOf(r7)).toEqual({ code: "forbidden", message: GROUP_CREATE_FORBIDDEN_MESSAGE });
    expect(await createsOf(s.ctx)).toHaveLength(1);
  });

  it("CR10 解析失敗（unsupported_color）→ 400、notes 不多、transfer_creates 不多", async () => {
    const s = await scene();
    // 先有一篇（旁觀者）：解析失敗時沒有新筆記可指，「仍寫去重列」要有一篇既有筆記才寫得出來（否則被 FK 擋成等價）
    await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Existing" });
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Bad" }, 'x <span style="color:tomato">orange-ish</span>'));
    expect(r.statusCode).toBe(400);
    expect(errOf(r).code).toBe("unsupported_color");
    expect(await s.ctx.db.select().from(notes)).toHaveLength(1);
    expect(await createsOf(s.ctx)).toHaveLength(0);
  });

  it("CR10b解析失敗也扣 transferWrite（解析之前扣，同 edit_note）：limit 1 → 壞色值的新增 400 → 合法的新增 429、沒建", async () => {
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const bad = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Bad" }, 'x <span style="color:tomato">orange-ish</span>'));
    expect(bad.statusCode).toBe(400);
    expect(errOf(bad).code).toBe("unsupported_color");
    const good = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Good" }, "good body"));
    expect(good.statusCode).toBe(429);
    expect(await liveNotes(s.ctx)).toHaveLength(0);
  });

  it("CR10c（寫回上限 256 KiB 內的 2 萬段）→ 400 too_many_blocks、預判擋下（不進完整解析）、扣 transferWrite；連四發都不讓事件迴圈卡住 1 秒以上", async () => {
    const transferWrite = new FixedWindowLimiter({ limit: 4, windowMs: 60_000 });
    const s = await scene({ limiters: { transferWrite } });
    for (let i = 0; i < 4; i++) {
      const md = Array.from({ length: 20_000 }, (_, k) => `p${i} ${k}`).join("\n\n");
      expect(Buffer.byteLength(fileOf({ title: `Huge ${i}` }, md)), "前提：在寫回上限內（不是被 413 擋下）").toBeLessThanOrEqual(TRANSFER_WRITE_BODY_LIMIT);
      let maxGap = 0;
      let last = performance.now();
      const iv = setInterval(() => {
        const n = performance.now();
        maxGap = Math.max(maxGap, n - last);
        last = n;
      }, 5);
      const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: `Huge ${i}` }, md));
      await new Promise(res => setTimeout(res, 20));
      clearInterval(iv);
      expect(r.statusCode, `#${i}`).toBe(400);
      expect(errOf(r).code, `#${i}`).toBe("too_many_blocks");
      // 修前實測（約 1 MB、2.7 萬段）每發 ~3 s；預判後的剩餘成本是 body 解碼、frontmatter、HMAC、逐行掃描。
      expect(maxGap, `#${i} 事件迴圈最長停頓`).toBeLessThan(1_000);
    }
    expect(transferWrite.isBlocked(s.u.id)).toBe(true);
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "After" }, "ok body"))).statusCode).toBe(429);
    expect(await liveNotes(s.ctx)).toHaveLength(0);
  }, 120_000);

  it("CR11 transferWrite limit 1 → 第二篇新增 429", async () => {
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "1" }, "one"))).statusCode).toBe(201);
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "2" }, "two"));
    expect(r.statusCode).toBe(429);
    expect(r.headers["retry-after"]).toBeDefined();
    expect(await liveNotes(s.ctx)).toHaveLength(1);
  });

  it("CR11b（先扣再解析）額度用完時，去重沒命中的新檔直接 429、不先解析：解析會失敗的檔也回 429（不是 400）；去重命中的重送仍 200", async () => {
    const s = await scene({ limiters: { transferWrite: new FixedWindowLimiter({ limit: 1, windowMs: 60_000 }) } });
    const first = fileOf({ title: "1" }, "one");
    expect((await bulkPut(s.ctx.app, s.bulk.token, first)).statusCode).toBe(201);
    const bad = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Bad" }, 'x <span style="color:tomato">orange-ish</span>'));
    expect(bad.statusCode).toBe(429);
    expect(errOf(bad).code).toBe("too_many_requests");
    expect(bad.headers["retry-after"]).toBeDefined();
    const again = await bulkPut(s.ctx.app, s.bulk.token, first);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: false, result: "unchanged" });
    expect(await liveNotes(s.ctx)).toHaveLength(1);
  });

  it("CR12 TTL 清理：31 分前的列被刪、別的使用者的新列留著（旁觀者）", async () => {
    const s = await scene();
    const other = await seedUser(s.ctx.db);
    const opat = await seedTokenForUser(s.ctx.db, other.id, "notes:read notes:write");
    const ob = await issueBulkDirect(s.ctx.db, opat.tokenId, { access: "write" });
    expect((await bulkPut(s.ctx.app, ob.token, fileOf({ title: "Bystander" }, "keep"))).statusCode).toBe(201);
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Old" }, "old"))).statusCode).toBe(201);
    await s.ctx.db.update(transferCreates).set({ createdAt: sql`now() - interval '31 minutes'` }).where(eq(transferCreates.userId, s.u.id));
    expect((await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "New" }, "new"))).statusCode).toBe(201);
    let rows: Awaited<ReturnType<typeof createsOf>> = [];
    const poll = async () => {
      rows = await createsOf(s.ctx);
    };
    await poll();
    for (let i = 0; i < 50 && rows.length !== 2; i++) {
      await new Promise(r => setTimeout(r, 50));
      await poll();
    }
    expect(rows).toHaveLength(2);
    expect(rows.filter(r => r.userId === other.id)).toHaveLength(1);
    expect(rows.filter(r => r.userId === s.u.id)).toHaveLength(1);
  });

  it("CR13 建列失敗映射：createWithContent 前一刻刪掉目標資料夾 → 404 folder_not_found、transfer_creates 不多；201 的 unboundWikilinks＝看不到的 wikilink 數", async () => {
    const hold: { act?: () => Promise<void> } = {};
    const s = await scene({ editingTestHooks: { beforeCreateFromFile: async () => { if (hold.act) { const f = hold.act; hold.act = undefined; await f(); } } } });
    const f = await seedFolder(s.ctx.db, { personal: s.u.id });
    hold.act = async () => { await s.ctx.db.delete(folders).where(eq(folders.id, f.id)); };
    const r = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Doomed", folder_id: f.id }, "doomed"));
    expect(r.statusCode).toBe(404);
    expect(errOf(r).code).toBe("folder_not_found");
    expect(await createsOf(s.ctx)).toHaveLength(0);
    expect(await s.ctx.db.select().from(notes).where(and(eq(notes.title, "Doomed")))).toHaveLength(0);

    await seedNote(s.ctx.db, { ownerId: s.u.id }, { title: "Known target" });
    const r2 = await bulkPut(s.ctx.app, s.bulk.token, fileOf({ title: "Links" }, "see [[Known target]] and [[Missing one]] and [[Missing two]]"));
    expect(r2.statusCode).toBe(201);
    expect(r2.json()).toMatchObject({ unboundWikilinks: 2 });
  });
});
