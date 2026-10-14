// #272 §7.5（案 27）：e2e 測試縫 PUT /api/admin/test/version-auto-wait——只在 config.testHooks 時註冊（KNOTEBOOK_E2E_TEST_HOOKS=1 且
// PUBLIC_URL 是 loopback）；requireAdmin；strict { seconds: 1–3600 的整數 | null }；204；覆寫掃描器的等待 X（null＝回站台設定）。
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { markPending } from "../src/collab/versions.js";
import { loadConfig } from "../src/config.js";
import { seedDoc } from "./copy-helpers.js";
import { cookieOf, seedNote, seedUser } from "./group-helpers.js";
import { buildCollabTestApp, buildTestApp } from "./helpers.js";
import { paraDoc, versionsOf } from "./version-helpers.js";

const ENV = { DATABASE_URL: "postgres://u:p@localhost:5432/test", APP_SECRET: "a".repeat(64) };
const ROUTE = "/api/admin/test/version-auto-wait";
async function put(app: FastifyInstance, who: string, payload: unknown) {
  return app.inject({ method: "PUT", url: ROUTE, cookies: await cookieOf(who), payload: payload as object });
}

describe("e2e 測試縫路由（案 27）", () => {
  it("沒設環境變數 → 路由不存在（404）", async () => {
    const { app, db } = await buildTestApp();
    const admin = await seedUser(db, { isAdmin: true });
    expect((await put(app, admin.id, { seconds: 2 })).statusCode).toBe(404);
  });

  it("設了但 PUBLIC_URL 不是 loopback → 忽略：路由不存在（404）", async () => {
    const config = loadConfig({ ...ENV, PUBLIC_URL: "https://notes.example.com", KNOTEBOOK_E2E_TEST_HOOKS: "1" });
    expect(config.testHooksIgnored).toBe(true);
    const { app, db } = await buildTestApp({ config });
    const admin = await seedUser(db, { isAdmin: true });
    expect((await put(app, admin.id, { seconds: 2 })).statusCode).toBe(404);
  });

  it("開著：只有站台管理員；strict { seconds: 1–3600 整數 | null }；204 後覆寫掃描器的 X，null 回站台設定", async () => {
    const config = loadConfig({ ...ENV, PUBLIC_URL: "http://localhost:3000", KNOTEBOOK_E2E_TEST_HOOKS: "1" });
    expect(config.testHooks).toBe(true);
    const ctx = await buildCollabTestApp({ config });
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const user = await seedUser(ctx.db);
    expect((await ctx.app.inject({ method: "PUT", url: ROUTE, payload: { seconds: 2 } })).statusCode).toBe(401);
    expect((await put(ctx.app, user.id, { seconds: 2 })).statusCode).toBe(403);
    for (const body of [{ seconds: 0 }, { seconds: 3601 }, { seconds: 1.5 }, { seconds: "2" }, {}, { seconds: 2, x: 1 }]) {
      const r = await put(ctx.app, admin.id, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect(r.json().error.code).toBe("invalid_body");
    }
    const seedPending = async (text: string) => {
      const n = await seedNote(ctx.db, { ownerId: admin.id });
      await seedDoc(ctx.db, n.id, paraDoc([text]));
      await markPending(ctx.db, { noteId: n.id, at: new Date(Date.now() - 3_000), add: [{ user_id: admin.id, agent_label: null }], ref: null, spaceKey: `u:${admin.id}` });
      return n.id;
    };
    const a = await seedPending("測試縫");
    expect(await ctx.collab.versions.scanDue()).toBe(0); // 站台設定 5 分鐘：3 秒前的變動還沒到期
    expect((await put(ctx.app, admin.id, { seconds: 2 })).statusCode).toBe(204);
    expect(await ctx.collab.versions.scanDue()).toBe(1);
    expect(await versionsOf(ctx.db, a)).toHaveLength(1);
    expect((await put(ctx.app, admin.id, { seconds: null })).statusCode).toBe(204);
    const b = await seedPending("回站台設定");
    expect(await ctx.collab.versions.scanDue()).toBe(0);
    expect(await versionsOf(ctx.db, b)).toEqual([]);
  });
});
