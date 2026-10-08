/**
 * #200 spec §6、§9.3 M1–M3（M2a 的確定性並發與 M4 log 在 `mcp-transfer-flow.test.ts`）。
 * harness：`buildTestApp`（無 collab）——`create_transfer_token` 在部署形態閘門外（spec §6.1），無 collab 的 app 也有它。
 * PUBLIC_URL 刻意設成與 inject 的 Host（`localhost:80`）不同的 https origin，證明 `url`／`curl` 取自 PUBLIC_URL。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { IssueTransferTokenSeam } from "../src/auth/tx/issue-transfer-token.js";
import { MAX_PENDING_UPLOAD_TOKENS } from "../src/auth/transfer-token.js";
import { loadConfig } from "../src/config.js";
import { apiTokens, notes, transferTokens } from "../src/db/schema.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../src/mcp/note-read.js";
import {
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RO,
  CREATE_TRANSFER_TOKEN_DESCRIPTION_RW,
  DOWNLOAD_NEXT,
  REVOKED_MESSAGE,
  TOO_MANY_PENDING_MESSAGE,
  UPLOAD_NEXT,
  VIEWER_UPLOAD_MESSAGE,
} from "../src/mcp/tools/create-transfer-token.js";
import { buildTestApp, freshLimiters } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedShare, seedUser } from "./group-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { PNG_BYTES, expireToken, fileBody, issueDirect, ownerWithPat, upload } from "./transfer-helpers.js";
import { SESSION_COOKIE } from "@knotebook/shared";

const ORIGIN = "https://kb.example.test:8443";
const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: "a".repeat(64), PUBLIC_URL: `${ORIGIN}/` });

type Payload = { purpose: string; noteId: string; token: string; expiresAt: string; url: string; method: string; curl: string; next: string };

async function call(app: Parameters<typeof mcpPost>[0], token: string, args: Record<string, unknown>) {
  const res = await mcpPost(app, rpc("tools/call", { name: "create_transfer_token", arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  return res.json().result as { isError?: true; structuredContent?: Record<string, unknown>; content: Array<{ type: string; text: string }> };
}
async function toolsOf(app: Parameters<typeof mcpPost>[0], opts: { token?: string; cookie?: string }) {
  const res = await mcpPost(app, rpc("tools/list"), opts);
  expect(res.statusCode).toBe(200);
  return res.json().result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { enum?: string[] }> } }>;
}

describe("M1：tools/list（spec §6.1）", () => {
  it("讀寫憑證：有 create_transfer_token、purpose enum 兩值、讀寫版描述", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const tool = (await toolsOf(app, { token: o.pat })).find(t => t.name === "create_transfer_token");
    expect(tool).toBeDefined();
    expect(tool!.description).toBe(CREATE_TRANSFER_TOKEN_DESCRIPTION_RW);
    expect(tool!.inputSchema.properties.purpose!.enum).toEqual(["upload", "download"]);
    expect(Object.keys(tool!.inputSchema.properties).sort()).toEqual(["note_id", "purpose"]);
  });

  it("唯讀憑證：有、enum 只有 download、唯讀版描述（不描述 upload 這個 purpose）", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db, "notes:read");
    const tool = (await toolsOf(app, { token: o.pat })).find(t => t.name === "create_transfer_token");
    expect(tool!.description).toBe(CREATE_TRANSFER_TOKEN_DESCRIPTION_RO);
    // 唯讀版描述本來就含 "uploaded"（"any image uploaded to that note"，spec §6.5）——要擋的是「描述 upload 這個 purpose」：
    expect(tool!.description).not.toContain("`upload`");
    expect(tool!.description).not.toContain("upload an image");
    expect(tool!.inputSchema.properties.purpose!.enum).toEqual(["download"]);
  });

  it("session（cookie）打 /api/mcp：沒有 create_transfer_token", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const cookie = (await cookieOf(o.userId))[SESSION_COOKIE]!;
    const names = (await toolsOf(app, { cookie })).map(t => t.name);
    expect(names).not.toContain("create_transfer_token");
  });

  it("唯讀憑證送 purpose:upload → SDK 輸入驗證錯誤（無 code），且 tokenWrite 未被扣", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ config, limiters: freshLimiters({ tokenWrite }) });
    const o = await ownerWithPat(db, "notes:read");
    const r = await call(app, o.pat, { note_id: o.noteId, purpose: "upload" });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(await db.select().from(transferTokens)).toHaveLength(0);
    // 同一使用者的讀寫憑證：tokenWrite（key token:<userId>）還有那 1 發
    const { token: rw } = await seedTokenForUser(db, o.userId, "notes:read notes:write");
    const write = await mcpPost(app, rpc("tools/call", { name: "create_note", arguments: {} }), { token: rw });
    expect(write.json().result.isError).toBeUndefined();
  });
});

describe("M2：create_transfer_token 的流程（spec §6.3、§6.4）", () => {
  it("upload 正路：url／curl／next 逐字；noteId 小寫（輸入大寫）；expiresAt ≈ now＋10 分；method POST", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const before = Date.now();
    const r = await call(app, o.pat, { note_id: o.noteId.toUpperCase(), purpose: "upload" });
    expect(r.isError).toBeUndefined();
    const p = r.structuredContent as Payload;
    expect(r.content[0]!.text).toBe(JSON.stringify(p));
    expect(p.purpose).toBe("upload");
    expect(p.noteId).toBe(o.noteId);
    expect(p.token).toMatch(/^knbt_[A-Za-z0-9_-]{43}$/);
    expect(p.method).toBe("POST");
    expect(p.url).toBe(`${ORIGIN}/api/notes/${o.noteId}/uploads`);
    expect(p.curl).toBe(`curl -sS -X POST -H "Authorization: Bearer ${p.token}" -F "file=@<path-to-image>" "${ORIGIN}/api/notes/${o.noteId}/uploads"`);
    expect(p.next).toBe(UPLOAD_NEXT);
    const exp = Date.parse(p.expiresAt);
    expect(exp).toBeGreaterThanOrEqual(before + 10 * 60_000 - 5_000);
    expect(exp).toBeLessThanOrEqual(Date.now() + 10 * 60_000 + 5_000);
  });

  it("download 正路：url 帶 <upload_id> 佔位、curl 逐字、method GET、next 逐字", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const p = (await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).structuredContent as Payload;
    expect(p.method).toBe("GET");
    expect(p.url).toBe(`${ORIGIN}/api/uploads/<upload_id>`);
    expect(p.curl).toBe(`curl -sS -H "Authorization: Bearer ${p.token}" -o <output-file> "${ORIGIN}/api/uploads/<upload_id>"`);
    expect(p.next).toBe(DOWNLOAD_NEXT);
  });

  it("看不到的筆記與不存在的筆記 → 同一個 not_found（逐位元組）", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const stranger = await ownerWithPat(db);
    const hidden = await call(app, o.pat, { note_id: stranger.noteId, purpose: "download" });
    const missing = await call(app, o.pat, { note_id: randomUUID(), purpose: "download" });
    expect(hidden.structuredContent).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
    expect(hidden.content[0]!.text).toBe(missing.content[0]!.text);
  });

  it("viewer：upload → forbidden（逐字訊息）；download 照簽", async () => {
    const { app, db } = await buildTestApp({ config });
    const owner = await ownerWithPat(db);
    const viewer = await seedUser(db);
    const { token } = await seedTokenForUser(db, viewer.id);
    await seedShare(db, owner.noteId, viewer.id, "viewer");
    expect((await call(app, token, { note_id: owner.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "forbidden",
      message: VIEWER_UPLOAD_MESSAGE,
    });
    expect((await call(app, token, { note_id: owner.noteId, purpose: "download" })).isError).toBeUndefined();
  });

  it("upload 扣 tokenWrite（limit:1 → 第二發 too_many_requests）、不扣 contentRead；download 扣 contentRead、不扣 tokenWrite", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const contentRead = new FixedWindowLimiter({ limit: 1, windowMs: 60_000 });
    const { app, db } = await buildTestApp({ config, limiters: freshLimiters({ tokenWrite, contentRead }) });
    const o = await ownerWithPat(db);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent!.code).toBe("too_many_requests");
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).isError).toBeUndefined();
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).structuredContent!.code).toBe("too_many_requests");
  });

  // 守檔頭「流程順序是契約」的 ①→②：upload 先扣 tokenWrite、再查筆記權限——所以對看不到的筆記簽 upload 也會扣。
  // `requireWriteScope` 挪到 `resolveNoteAccess` 之後，none 就在扣之前 return，下面第二發會成功（突變實測見 #200 PR1 Task 7 回報）。
  it("upload 對看不到的筆記：not_found，但 tokenWrite 已扣（limit:1 → 接著對自己的筆記 upload 被 too_many_requests）", async () => {
    const tokenWrite = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({ config, limiters: freshLimiters({ tokenWrite }) });
    const o = await ownerWithPat(db);
    const stranger = await ownerWithPat(db);
    expect((await call(app, o.pat, { note_id: stranger.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "not_found",
      message: NOTE_NOT_FOUND_MESSAGE,
    });
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent!.code).toBe("too_many_requests");
    expect(await db.select().from(transferTokens)).toHaveLength(0);
  });

  it("母憑證只剩 60 秒 → expiresAt 截在它；next 與描述沒有 10 分以外的時間承諾", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const parentExp = new Date(Date.now() + 60_000);
    await db.update(apiTokens).set({ accessExpiresAt: parentExp }).where(eq(apiTokens.id, o.patId));
    const p = (await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent as Payload;
    expect(Date.parse(p.expiresAt)).toBe(parentExp.getTime());
    for (const s of [UPLOAD_NEXT, DOWNLOAD_NEXT, CREATE_TRANSFER_TOKEN_DESCRIPTION_RW, CREATE_TRANSFER_TOKEN_DESCRIPTION_RO]) {
      expect(s.match(/\d+\s*(?:minutes?|seconds?|hours?)/g) ?? [], s).toEqual(s.includes("10 minutes") ? ["10 minutes"] : []);
    }
  });

  it("母憑證在簽發途中被刪（beforeLock 縫）→ unauthorized、零列", async () => {
    const seam: IssueTransferTokenSeam = {};
    const { app, db } = await buildTestApp({ config, mcpTestHooks: { issueTransferToken: seam } });
    const o = await ownerWithPat(db);
    seam.beforeLock = async () => {
      await db.delete(apiTokens).where(eq(apiTokens.id, o.patId));
    };
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "unauthorized",
      message: REVOKED_MESSAGE,
    });
    expect(await db.select().from(transferTokens)).toHaveLength(0);
  });

  it("母憑證在簽發途中到期（beforeLock 縫把 access_expires_at 改成過去）→ expiry_chk → unauthorized", async () => {
    const seam: IssueTransferTokenSeam = {};
    const { app, db } = await buildTestApp({ config, mcpTestHooks: { issueTransferToken: seam } });
    const o = await ownerWithPat(db);
    seam.beforeLock = async () => {
      await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 second'` }).where(eq(apiTokens.id, o.patId));
    };
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).structuredContent).toEqual({
      code: "unauthorized",
      message: REVOKED_MESSAGE,
    });
  });

  for (const purpose of ["upload", "download"] as const) {
    it(`筆記在 resolveNoteAccess 之後被刪（afterCount 縫，${purpose}）→ not_found＋NOTE_NOT_FOUND_MESSAGE`, async () => {
      const seam: IssueTransferTokenSeam = {};
      const { app, db } = await buildTestApp({ config, mcpTestHooks: { issueTransferToken: seam } });
      const o = await ownerWithPat(db);
      seam.afterCount = async () => {
        await db.delete(notes).where(eq(notes.id, o.noteId));
      };
      expect((await call(app, o.pat, { note_id: o.noteId, purpose })).structuredContent).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
    });
  }

  it("M2a（基本形）：連簽 5 支 upload → 第 6 支 too_many_requests（逐字）；用掉一支（POST 201）後可簽；過期一支後可簽；download 不受限", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    expect(TOO_MANY_PENDING_MESSAGE).toContain(` ${MAX_PENDING_UPLOAD_TOKENS} unused upload tokens`);
    const tokens: Payload[] = [];
    for (let i = 0; i < 5; i++) tokens.push((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent as Payload);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).structuredContent).toEqual({
      code: "too_many_requests",
      message: TOO_MANY_PENDING_MESSAGE,
    });
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).isError).toBeUndefined();
    expect((await upload(app, o.noteId, fileBody(PNG_BYTES), { token: tokens[0]!.token })).statusCode).toBe(201);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
    const [row] = await db
      .select({ id: transferTokens.id })
      .from(transferTokens)
      .where(sql`${transferTokens.purpose} = 'upload' and ${transferTokens.consumedAt} is null`)
      .limit(1);
    await expireToken(db, row!.id);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "upload" })).isError).toBeUndefined();
  });
});

describe("M3：清理（spec §4.6）", () => {
  it("一列已過期 → 下一次成功簽發後消失（fire-and-forget，等它）；未過期的留著", async () => {
    const { app, db } = await buildTestApp({ config });
    const o = await ownerWithPat(db);
    const dead = await issueDirect(db, o.patId, o.noteId, "download");
    const live = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, dead.id);
    expect((await call(app, o.pat, { note_id: o.noteId, purpose: "download" })).isError).toBeUndefined();
    await vi.waitFor(
      async () => {
        const ids = (await db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
        expect(ids).not.toContain(dead.id);
        expect(ids).toContain(live.id);
      },
      { timeout: 5_000 }
    );
  });
});
