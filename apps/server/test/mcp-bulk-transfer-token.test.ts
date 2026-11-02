/**
 * bulk transfer spec 2026-11-02 §5.1、§5.2、§14：`create_bulk_transfer_token`（plan T8 B1–B12）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SESSION_COOKIE } from "@knotebook/shared";
import { hashToken } from "../src/auth/api-token.js";
import type { IssueBulkTransferTokenSeam } from "../src/auth/tx/issue-bulk-transfer-token.js";
import { loadConfig } from "../src/config.js";
import { apiTokens, transferTokens } from "../src/db/schema.js";
import { FOLDER_GROUP_NOT_FOUND_MESSAGE, FOLDER_NOT_FOUND_MESSAGE } from "../src/mcp/folder-messages.js";
import {
  BULK_NEXT_RO,
  BULK_RANGE_AMBIGUOUS_MESSAGE,
  CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO,
  TOO_MANY_BULK_TOKENS_MESSAGE,
  bulkCurls,
} from "../src/mcp/tools/create-bulk-transfer-token.js";
import { REVOKED_MESSAGE } from "../src/mcp/tools/create-transfer-token.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { seedTokenForUser } from "./editing-helpers.js";
import { cookieOf, seedGroup, seedNote, seedRole, seedUser, setMemberRole, waitForBlockedOrSettled } from "./group-helpers.js";
import { seedFolder } from "./folder-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { expireToken, issueDirect } from "./transfer-helpers.js";
import { callTool, issueBulkDirect } from "./bulk-transfer-helpers.js";

const ORIGIN = "https://kb.example.test:8443";
const config = loadConfig({ DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: "a".repeat(64), PUBLIC_URL: `${ORIGIN}/` });
const TOOL = "create_bulk_transfer_token";
const RO = "notes:read" as const;
const RW = "notes:read notes:write" as const;
const RWMD = "notes:read notes:write notes:move notes:delete" as const;

async function rowOf(db: Parameters<typeof seedUser>[0], token: string) {
  const [r] = await db.select().from(transferTokens).where(eq(transferTokens.tokenHash, hashToken(token)));
  return r;
}
async function bulkCount(db: Parameters<typeof seedUser>[0], parentId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(transferTokens)
    .where(sql`${transferTokens.parentTokenId} = ${parentId} and ${transferTokens.purpose} = 'bulk'`);
  return r!.n;
}
async function toolList(app: Parameters<typeof mcpPost>[0], opts: { token?: string; cookie?: string }) {
  const res = await mcpPost(app, rpc("tools/list"), opts);
  expect(res.statusCode).toBe(200);
  return res.json().result.tools as Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown>; additionalProperties?: unknown } }>;
}

describe("B1：五種範圍與 access 落庫（spec §5.1）", () => {
  it("{}→all、space personal／shared、group_id（大寫輸入落小寫）、folder_id；note_id NULL、purpose bulk", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RO);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const f = await seedFolder(ctx.db, { personal: u.id });
    const cases: Array<[Record<string, unknown>, unknown]> = [
      [{}, { kind: "all" }],
      [{ space: "personal" }, { kind: "personal" }],
      [{ space: "shared" }, { kind: "shared" }],
      [{ group_id: g.id.toUpperCase() }, { kind: "group", groupId: g.id }],
      [{ folder_id: f.id.toUpperCase() }, { kind: "folder", folderId: f.id }],
    ];
    const extra = await seedTokenForUser(ctx.db, u.id, RO);
    for (const [k, [args, range]] of cases.entries()) {
      const tok = k < 3 ? token : extra.token; // 每支母憑證至多 3 支
      const r = await callTool(ctx.app, tok, TOOL, args);
      expect(r.isError, JSON.stringify(args)).toBeUndefined();
      const row = await rowOf(ctx.db, r.structuredContent.token as string);
      expect(row, JSON.stringify(args)).toMatchObject({ purpose: "bulk", noteId: null, access: "read", range });
    }
  });

  it("access：唯讀母憑證 read、讀寫 write、讀寫搬移刪除 write", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    for (const [scope, want] of [[RO, "read"], [RW, "write"], [RWMD, "write"]] as const) {
      const { token } = await seedTokenForUser(ctx.db, u.id, scope);
      const r = await callTool(ctx.app, token, TOOL, {});
      expect(r.structuredContent.access, scope).toBe(want);
      expect((await rowOf(ctx.db, r.structuredContent.token as string))?.access, scope).toBe(want);
    }
  });
});

describe("B2：範圍至多給一個", () => {
  it("兩兩組合與三個都給 → invalid_body＋BULK_RANGE_AMBIGUOUS_MESSAGE、零列", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const { token, tokenId } = await seedTokenForUser(ctx.db, u.id, RO);
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const f = await seedFolder(ctx.db, { personal: u.id });
    for (const args of [
      { space: "personal", group_id: g.id },
      { space: "shared", folder_id: f.id },
      { group_id: g.id, folder_id: f.id },
      { space: "personal", group_id: g.id, folder_id: f.id },
    ]) {
      const r = await callTool(ctx.app, token, TOOL, args);
      expect(r.structuredContent, JSON.stringify(args)).toEqual({ code: "invalid_body", message: BULK_RANGE_AMBIGUOUS_MESSAGE });
    }
    expect(await bulkCount(ctx.db, tokenId)).toBe(0);
  });
});

describe("B3：group_id 要 can_read（spec §5.2-3）", () => {
  it("非成員、canRead:false 角色、隨機 uuid → group_not_found 逐位元組相同；create-only 角色 → 成功", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RO);
    const notMine = await seedGroup(ctx.db, "N", [{ userId: other.id, role: "admin" }]);
    const noRead = await seedGroup(ctx.db, "R", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, noRead.id, u.id, await seedRole(ctx.db, noRead.id, "blind", { canRead: false }));
    const results = [];
    for (const gid of [notMine.id, noRead.id, randomUUID()]) results.push((await callTool(ctx.app, token, TOOL, { group_id: gid })).structuredContent);
    for (const sc of results) expect(sc).toEqual({ code: "group_not_found", message: FOLDER_GROUP_NOT_FOUND_MESSAGE });
    expect(JSON.stringify(results[1])).toBe(JSON.stringify(results[0]));
    expect(JSON.stringify(results[2])).toBe(JSON.stringify(results[0]));
    const createOnly = await seedGroup(ctx.db, "C", [{ userId: u.id, role: "member" }]);
    await setMemberRole(ctx.db, createOnly.id, u.id, await seedRole(ctx.db, createOnly.id, "co", { canRead: true, canCreate: true }));
    expect((await callTool(ctx.app, token, TOOL, { group_id: createOnly.id })).isError).toBeUndefined();
  });
});

describe("B4：folder_id 看不到 → not_found（plan §0.1-12，暫定）", () => {
  it("別人的個人資料夾、隨機 uuid → not_found＋FOLDER_NOT_FOUND_MESSAGE，與 rename_folder 同一個 uuid 的錯誤逐位元組相同；自己的 shared 資料夾、可讀群組的資料夾 → 成功", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const other = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RW);
    const theirs = await seedFolder(ctx.db, { personal: other.id });
    for (const fid of [theirs.id, randomUUID()]) {
      const mine = (await callTool(ctx.app, token, TOOL, { folder_id: fid })).structuredContent;
      expect(mine).toEqual({ code: "not_found", message: FOLDER_NOT_FOUND_MESSAGE });
      const rename = (await callTool(ctx.app, token, "rename_folder", { folder_id: fid, name: "x" })).structuredContent;
      expect(JSON.stringify(mine)).toBe(JSON.stringify(rename));
    }
    const sharedF = await seedFolder(ctx.db, { shared: u.id });
    const g = await seedGroup(ctx.db, "G", [{ userId: u.id, role: "member" }]);
    const groupF = await seedFolder(ctx.db, { group: g.id });
    for (const fid of [sharedF.id, groupF.id]) expect((await callTool(ctx.app, token, TOOL, { folder_id: fid })).isError).toBeUndefined();
  });
});

describe("B5：每支母憑證至多 3 支未過期（spec §5.2-4）", () => {
  it("3 支成功、第 4 支 too_many_requests；過期一支後第 4 支成功；另一支母憑證不受影響；upload／download 不佔名額", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RW);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await callTool(ctx.app, a.token, TOOL, {});
      expect(r.isError, `#${i + 1}`).toBeUndefined();
      ids.push((await rowOf(ctx.db, r.structuredContent.token as string))!.id);
    }
    expect((await callTool(ctx.app, a.token, TOOL, {})).structuredContent).toEqual({ code: "too_many_requests", message: TOO_MANY_BULK_TOKENS_MESSAGE });
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(3);
    await expireToken(ctx.db, ids[0]!);
    expect((await callTool(ctx.app, a.token, TOOL, {})).isError).toBeUndefined();
    const b = await seedTokenForUser(ctx.db, u.id, RW);
    expect((await callTool(ctx.app, b.token, TOOL, {})).isError).toBeUndefined();
    // 已有 5 支 upload／download 的母憑證，3 支 bulk 照樣簽得出
    const c = await seedTokenForUser(ctx.db, u.id, RW);
    const note = await seedNote(ctx.db, { ownerId: u.id });
    for (let i = 0; i < 5; i++) await issueDirect(ctx.db, c.tokenId, note.id, i % 2 === 0 ? "upload" : "download");
    for (let i = 0; i < 3; i++) expect((await callTool(ctx.app, c.token, TOOL, {})).isError, `c#${i + 1}`).toBeUndefined();
  });
});

describe("B6：TTL（spec §21 D3）", () => {
  it("expiresAt − DB now ∈ [29:50, 30:10]；母憑證 5 分後到期 → 截在母憑證到期", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    const dbNow = async () => new Date((await ctx.db.execute<{ now: string }>(sql`select now()::text as now`)).rows[0]!.now).getTime();
    const before = await dbNow();
    const r = await callTool(ctx.app, a.token, TOOL, {});
    const after = await dbNow();
    const exp = new Date(r.structuredContent.expiresAt as string).getTime();
    expect(exp).toBeGreaterThanOrEqual(before + 30 * 60_000 - 10_000);
    expect(exp).toBeLessThanOrEqual(after + 30 * 60_000 + 10_000);
    const b = await seedTokenForUser(ctx.db, u.id, RO);
    await ctx.db.update(apiTokens).set({ accessExpiresAt: sql`now() + interval '5 minutes'` }).where(eq(apiTokens.id, b.tokenId));
    const [p] = await ctx.db.select({ e: apiTokens.accessExpiresAt }).from(apiTokens).where(eq(apiTokens.id, b.tokenId));
    const r2 = await callTool(ctx.app, b.token, TOOL, {});
    expect(r2.isError).toBeUndefined();
    expect(new Date(r2.structuredContent.expiresAt as string).getTime()).toBe(p!.e!.getTime());
  });
});

describe("B7：註冊（spec §5.2-1、§14.1；PR-1 一律唯讀描述）", () => {
  it("(a) session 沒有 (b) 無 collab＋讀寫 token 沒有 (c) 唯讀／讀寫 token 有、description 都是 RO (d) properties 恰三鍵、additionalProperties false", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const cookie = (await cookieOf(u.id))[SESSION_COOKIE]!;
    expect((await toolList(ctx.app, { cookie })).map(t => t.name)).not.toContain(TOOL);
    for (const scope of [RO, RW, RWMD]) {
      const { token } = await seedTokenForUser(ctx.db, u.id, scope);
      const tool = (await toolList(ctx.app, { token })).find(t => t.name === TOOL);
      expect(tool, scope).toBeDefined();
      expect(tool!.description, scope).toBe(CREATE_BULK_TRANSFER_TOKEN_DESCRIPTION_RO);
      expect(Object.keys(tool!.inputSchema.properties ?? {}).sort(), scope).toEqual(["folder_id", "group_id", "space"]);
      expect(tool!.inputSchema.additionalProperties, scope).toBe(false);
    }
    const plain = await buildTestApp();
    const v = await seedUser(plain.db);
    const { token } = await seedTokenForUser(plain.db, v.id, RW);
    expect((await toolList(plain.app, { token })).map(t => t.name)).not.toContain(TOOL);
  });
});

describe("B8：簽發途中母憑證被撤銷", () => {
  it("beforeLock 刪母列 → unauthorized＋REVOKED_MESSAGE、零列", async () => {
    const seam: IssueBulkTransferTokenSeam = {};
    const ctx = await buildCollabTestApp({ config, mcpTestHooks: { issueBulkTransferToken: seam } });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    seam.beforeLock = async () => {
      await ctx.db.delete(apiTokens).where(eq(apiTokens.id, a.tokenId));
    };
    expect((await callTool(ctx.app, a.token, TOOL, {})).structuredContent).toEqual({ code: "unauthorized", message: REVOKED_MESSAGE });
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(0);
  });
});

describe("B9：同一母憑證並發簽發——① 鎖母列序列化計數", () => {
  it("已有 2 支：第一發停在 afterCount，第二發卡在 ①（blocked）；放行後恰 3 支、第二發 too_many_requests", async () => {
    const seam: IssueBulkTransferTokenSeam = {};
    const ctx = await buildCollabTestApp({ config, mcpTestHooks: { issueBulkTransferToken: seam } });
    const pool = ctx.db.$client;
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    // 暖身：讓 touchLastUsed（api_tokens 的 UPDATE）先做完，否則會被當成第二發 blocked 的假證據（同 mcp-transfer-flow M2a）。
    expect((await mcpPost(ctx.app, rpc("tools/list"), { token: a.token })).statusCode).toBe(200);
    for (let i = 0; i < 2; i++) await issueBulkDirect(ctx.db, a.tokenId);
    let calls = 0;
    let second: ReturnType<typeof callTool> | undefined;
    let state: "blocked" | "settled" | undefined;
    seam.afterCount = async () => {
      if (calls++ !== 0) return;
      second = callTool(ctx.app, a.token, TOOL, {});
      state = await waitForBlockedOrSettled(pool, second);
    };
    const first = await callTool(ctx.app, a.token, TOOL, {});
    const secondResult = await second!;
    expect(state).toBe("blocked");
    expect(first.isError).toBeUndefined();
    expect(secondResult.structuredContent.code).toBe("too_many_requests");
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(3);
  });
});

describe("B10：輸出形與 curl（spec §14.2、§14.3）", () => {
  it("鍵恰 {token, expiresAt, access, export, note, revoke, next}；curl 只指 publicOrigin、權杖只在 Authorization header；next＝RO", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const { token } = await seedTokenForUser(ctx.db, u.id, RW);
    const sc = (await callTool(ctx.app, token, TOOL, {})).structuredContent;
    expect(Object.keys(sc).sort()).toEqual(["access", "expiresAt", "export", "next", "note", "revoke", "token"]);
    const t = sc.token as string;
    expect(t.startsWith("knbt_")).toBe(true);
    const curls = bulkCurls(ORIGIN, t);
    expect(sc.export).toEqual(curls.export);
    expect(sc.note).toEqual(curls.note);
    expect(sc.revoke).toEqual(curls.revoke);
    for (const k of ["export", "note", "revoke"] as const) {
      const c = (sc[k] as { url: string; curl: string }).curl;
      expect(c.split(t).length - 1, k).toBe(1);
      expect(c, k).toContain(`-H "Authorization: Bearer ${t}"`);
      for (const m of c.matchAll(/https?:\/\/[^"/]+/g)) expect(m[0], k).toBe(ORIGIN);
    }
    expect(sc.next).toBe(BULK_NEXT_RO);
  });
});

describe("B11：簽發後清掉過期列", () => {
  it("一列已過期 → 成功簽發後消失；未過期的留著", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    const dead = await issueBulkDirect(ctx.db, a.tokenId);
    const live = await issueBulkDirect(ctx.db, a.tokenId);
    await expireToken(ctx.db, dead.id);
    expect((await callTool(ctx.app, a.token, TOOL, {})).isError).toBeUndefined();
    await vi.waitFor(
      async () => {
        const ids = (await ctx.db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
        expect(ids).not.toContain(dead.id);
        expect(ids).toContain(live.id);
      },
      { timeout: 5_000 },
    );
  });
});

describe("B12：strict", () => {
  it("多一個鍵 spaces → SDK 輸入驗證錯誤、零列", async () => {
    const ctx = await buildCollabTestApp({ config });
    const u = await seedUser(ctx.db);
    const a = await seedTokenForUser(ctx.db, u.id, RO);
    const r = await callTool(ctx.app, a.token, TOOL, { spaces: "personal" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Input validation error");
    expect(await bulkCount(ctx.db, a.tokenId)).toBe(0);
  });
});
