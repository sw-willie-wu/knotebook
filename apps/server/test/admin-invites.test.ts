/**
 * #285 管理員邀請 API（spec §5.2）：建立（A1–A3、A5、A8–A10）、列表（A6）、撤銷（A7）。
 * 非 admin／未登入的 403／401 併在 `admin-users.test.ts` 的 requireAdmin 清單（A4）。
 * 每案各建一個 app（fresh DB）；造列一律 raw SQL，`created_at` 與 `expires_at` 以 SQL 同推（`one_time_links_expiry_chk`）。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { buildTestApp, testConfig } from "./helpers.js";
import { cookieOf, seedUser } from "./group-helpers.js";
import { oneTimeLinks, siteSettings } from "../src/db/schema.js";
import type { AppDeps } from "../src/app.js";
import type { Db } from "../src/db/index.js";
import { hashToken } from "../src/auth/api-token.js";

const REDACTED = "產生邀請時發生非預期的資料庫錯誤（錯誤本體已遮蔽）";
const PARAMS_LEAK = /params: |"params"\s*:/;
const DTO_KEYS = ["createdAt", "createdBy", "expiresAt", "id", "label", "revokedAt", "status", "usedAt", "usedBy"];

/** pino 的 `logMethod` hook（結構化欄位）＋ stream（整份輸出字串）兩路一起收（同 password-reset.test.ts）。 */
function logged() {
  const lines: Array<{ msg?: string; obj: Record<string, unknown> }> = [];
  const out: string[] = [];
  return {
    lines,
    out,
    options: {
      logger: {
        level: "info",
        stream: { write: (chunk: string) => void out.push(chunk) },
        hooks: {
          logMethod(this: unknown, args: unknown[], method: (...a: unknown[]) => void) {
            const [obj, msg] = args as [Record<string, unknown>, string | undefined];
            if (typeof obj === "object" && obj !== null) lines.push({ msg, obj });
            method.apply(this, args as never[]);
          },
        },
      },
    },
  };
}

async function setup(overrides: Partial<AppDeps> = {}) {
  const log = logged();
  const built = await buildTestApp(overrides, log.options);
  const admin = await seedUser(built.db, { isAdmin: true });
  return { ...built, log, admin, cookies: await cookieOf(admin.id) };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

function issue(ctx: Ctx, payload: unknown) {
  return ctx.app.inject({ method: "POST", url: "/api/admin/invites", cookies: ctx.cookies, payload: payload as object });
}

function list(ctx: Ctx) {
  return ctx.app.inject({ method: "GET", url: "/api/admin/invites", cookies: ctx.cookies });
}

function revoke(ctx: Ctx, id: string) {
  return ctx.app.inject({ method: "DELETE", url: `/api/admin/invites/${id}`, cookies: ctx.cookies });
}

async function rows(db: Db) {
  return db.select().from(oneTimeLinks);
}

async function epochOf(db: Db, id: string): Promise<number> {
  const r = await db.execute<{ e: string }>(sql`select extract(epoch from expires_at - created_at)::text as e from one_time_links where id = ${id}`);
  return Number(r.rows[0]!.e);
}

interface RawInvite {
  createdMinAgo: number;
  /** 距現在的分鐘數；負數＝已過期。 */
  expiresInMin: number;
  label?: string;
  createdBy?: string;
  usedAtMinAgo?: number;
  usedBy?: string;
  revokedAtMinAgo?: number;
  kind?: "invite" | "password_reset";
  target?: string;
}

async function rawInvite(db: Db, o: RawInvite): Promise<{ id: string; hash: string }> {
  const hash = hashToken(randomUUID());
  const r = await db.execute<{ id: string }>(
    sql`insert into one_time_links (kind, token_hash, target_user_id, created_by_id, label, created_at, expires_at, used_at, used_by_id, revoked_at)
        values (${o.kind ?? "invite"}, ${hash}, ${o.target ?? null}, ${o.createdBy ?? null}, ${o.label ?? null},
          now() - make_interval(mins => ${o.createdMinAgo}::int), now() + make_interval(mins => ${o.expiresInMin}::int),
          ${o.usedAtMinAgo === undefined ? null : sql`now() - make_interval(mins => ${o.usedAtMinAgo}::int)`}, ${o.usedBy ?? null},
          ${o.revokedAtMinAgo === undefined ? null : sql`now() - make_interval(mins => ${o.revokedAtMinAgo}::int)`})
        returning id`,
  );
  return { id: r.rows[0]!.id, hash };
}

async function setPasswordLogin(db: Db, enabled: boolean) {
  await db.update(siteSettings).set({ passwordLoginEnabled: enabled });
}

describe("POST /api/admin/invites", () => {
  it("A1：201 { invite, token }；token 形狀、雜湊落庫、到期推算、invite 欄位（1／3／7 天）", async () => {
    const ctx = await setup();
    const res = await issue(ctx, { expiresInDays: 3 });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { invite: Record<string, unknown>; token: string };
    expect(Object.keys(body).sort()).toEqual(["invite", "token"]);
    expect(body.token).toMatch(/^knbi_[A-Za-z0-9_-]{43}$/);
    const all = await rows(ctx.db);
    expect(all).toHaveLength(1);
    const row = all[0]!;
    expect(row).toMatchObject({ kind: "invite", tokenHash: hashToken(body.token), targetUserId: null, createdById: ctx.admin.id, label: null });
    expect(await epochOf(ctx.db, row.id)).toBe(259200);
    expect(body.invite).toMatchObject({
      id: row.id,
      status: "pending",
      createdBy: { id: ctx.admin.id, email: ctx.admin.email },
      usedBy: null,
      usedAt: null,
      revokedAt: null,
      expiresAt: row.expiresAt.toISOString(),
    });
    for (const [days, secs] of [[1, 86400], [7, 604800]] as const) {
      const r = await issue(ctx, { expiresInDays: days });
      expect(r.statusCode, r.body).toBe(201);
      expect(await epochOf(ctx.db, (r.json() as { invite: { id: string } }).invite.id)).toBe(secs);
    }
  });

  it.each([
    ["0", { expiresInDays: 0 }],
    ["8", { expiresInDays: 8 }],
    ["1.5", { expiresInDays: 1.5 }],
    ['"3"', { expiresInDays: "3" }],
    ["缺 expiresInDays", {}],
    ["多餘鍵", { expiresInDays: 3, extra: 1 }],
    ["label 101 字", { expiresInDays: 3, label: "字".repeat(101) }],
    ["label 含 NUL", { expiresInDays: 3, label: "a\u0000b" }],
    ["label 非字串", { expiresInDays: 3, label: 5 }],
  ])("A2：body 不合（%s）→ 400 invalid_body、不插列", async (_name, payload) => {
    const ctx = await setup();
    const res = await issue(ctx, payload);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: "invalid_body" } });
    expect(await rows(ctx.db)).toHaveLength(0);
  });

  it("A3：label trim；空字串與全空白存 NULL；100 個 emoji 原樣存", async () => {
    const ctx = await setup();
    const labelOf = async (label: string) => {
      const res = await issue(ctx, { expiresInDays: 1, label });
      expect(res.statusCode, res.body).toBe(201);
      const id = (res.json() as { invite: { id: string } }).invite.id;
      const [row] = await ctx.db.select({ label: oneTimeLinks.label }).from(oneTimeLinks).where(eq(oneTimeLinks.id, id));
      return row!.label;
    };
    expect(await labelOf("  Alice  ")).toBe("Alice");
    expect(await labelOf("")).toBeNull();
    expect(await labelOf("   ")).toBeNull();
    expect(await labelOf("😀".repeat(100))).toBe("😀".repeat(100));
  });

  it("A5：帳密關閉 → 403 password_login_disabled、不插列；壞 body 仍 400；env 強制＋DB 關 → 201", async () => {
    const ctx = await setup();
    await setPasswordLogin(ctx.db, false);
    const res = await issue(ctx, { expiresInDays: 3 });
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "password_login_disabled" } });
    expect(await rows(ctx.db)).toHaveLength(0);
    expect((await issue(ctx, { expiresInDays: 0 })).statusCode).toBe(400);

    const forced = await setup({ config: { ...testConfig, passwordLoginForceEnable: true } });
    await setPasswordLogin(forced.db, false);
    expect((await issue(forced, { expiresInDays: 3 })).statusCode).toBe(201);
  });

  it("A8：建立 log 的鍵恰為 userId／linkId／expiresAt；整份輸出不含 token、雜湊、備註", async () => {
    const ctx = await setup();
    const res = await issue(ctx, { expiresInDays: 2, label: "secret-note-285" });
    expect(res.statusCode, res.body).toBe(201);
    const { token } = res.json() as { token: string };
    const line = ctx.log.lines.find(l => l.msg === "產生邀請");
    expect(line, "應有建立 log").toBeDefined();
    expect(Object.keys(line!.obj).sort()).toEqual(["expiresAt", "linkId", "userId"]);
    const out = ctx.log.out.join("");
    expect(out).not.toContain(token);
    expect(out).not.toContain(hashToken(token));
    expect(out).not.toContain("secret-note-285");
  });

  it("A9：建立成功後機會性清理 30 天前結束的舊邀請", async () => {
    const ctx = await setup();
    const old = await rawInvite(ctx.db, { createdMinAgo: 32 * 1440, expiresInMin: -31 * 1440 + 60, revokedAtMinAgo: 31 * 1440 });
    expect((await issue(ctx, { expiresInDays: 1 })).statusCode).toBe(201);
    const deadline = Date.now() + 2_000;
    let gone = false;
    while (Date.now() < deadline) {
      const found = await ctx.db.select({ id: oneTimeLinks.id }).from(oneTimeLinks).where(eq(oneTimeLinks.id, old.id));
      if (found.length === 0) {
        gone = true;
        break;
      }
      await new Promise(r => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
  });

  it("A10：INSERT 的非預期 DB 錯誤 → 500，log 遮蔽（無 params、無 64 位十六進位）", async () => {
    const ctx = await setup();
    await ctx.db.execute(sql.raw("ALTER TABLE one_time_links ADD CONSTRAINT t285_block CHECK (false) NOT VALID"));
    const res = await issue(ctx, { expiresInDays: 3 });
    expect(res.statusCode).toBe(500);
    const out = ctx.log.out.join("");
    expect(out).toContain(REDACTED);
    expect(out).not.toMatch(PARAMS_LEAK);
    expect(out).not.toMatch(/[0-9a-f]{64}/);
  });
});

describe("GET /api/admin/invites", () => {
  it("A6：只列邀請、鍵集合與 status、排序、usedBy／createdBy、不含雜湊；建立者被刪後 createdBy 為 null", async () => {
    const ctx = await setup();
    const c = await seedUser(ctx.db);
    const redeemer = await seedUser(ctx.db);
    const resetTarget = await seedUser(ctx.db);
    const pending = await rawInvite(ctx.db, { createdMinAgo: 60, expiresInMin: 1440, label: "P", createdBy: c.id });
    const expired = await rawInvite(ctx.db, { createdMinAgo: 120, expiresInMin: -60, createdBy: c.id });
    const revoked = await rawInvite(ctx.db, { createdMinAgo: 180, expiresInMin: -30, revokedAtMinAgo: 60, createdBy: c.id });
    // revoked 與 used 的 expires_at 都已過：守 CASE 順序（used、revoked 都優先於 expired）。
    const used = await rawInvite(ctx.db, { createdMinAgo: 240, expiresInMin: -60, usedAtMinAgo: 120, usedBy: redeemer.id, createdBy: c.id });
    const reset = await rawInvite(ctx.db, { kind: "password_reset", target: resetTarget.id, createdMinAgo: 30, expiresInMin: 60, createdBy: c.id });

    const res = await list(ctx);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as Array<Record<string, unknown> & { id: string; status: string; createdBy: unknown; usedBy: unknown }>;
    expect(body).toHaveLength(4);
    for (const x of body) expect(Object.keys(x).sort()).toEqual(DTO_KEYS);
    expect(body.map(x => [x.id, x.status])).toEqual([
      [pending.id, "pending"],
      [expired.id, "expired"],
      [revoked.id, "revoked"],
      [used.id, "used"],
    ]);
    expect(body[0]!.label).toBe("P");
    expect(body[3]!.usedBy).toEqual({ id: redeemer.id, email: redeemer.email });
    expect(body.every(x => JSON.stringify(x.createdBy) === JSON.stringify({ id: c.id, email: c.email }))).toBe(true);
    for (const r of [pending, expired, revoked, used, reset]) expect(res.body).not.toContain(r.hash);
    expect(res.body).not.toContain(reset.id);

    await ctx.db.execute(sql`delete from users where id = ${c.id}`);
    const after = await list(ctx);
    expect(after.statusCode, after.body).toBe(200);
    const afterBody = after.json() as Array<{ createdBy: unknown }>;
    expect(afterBody).toHaveLength(4);
    expect(afterBody.every(x => x.createdBy === null)).toBe(true);
  });
});

describe("DELETE /api/admin/invites/:id", () => {
  async function statusOf(ctx: Ctx, id: string): Promise<string | undefined> {
    const body = (await list(ctx)).json() as Array<{ id: string; status: string }>;
    return body.find(x => x.id === id)?.status;
  }

  it("A7：撤銷 pending → 204＋log；重撤 204 無第二行；used → 409；expired → 204 且維持 expired；不存在／非 uuid／重設列 → 404；大寫 uuid → 204", async () => {
    const ctx = await setup();
    const other = await seedUser(ctx.db);
    const pending = await rawInvite(ctx.db, { createdMinAgo: 10, expiresInMin: 1440 });
    const res = await revoke(ctx, pending.id);
    expect(res.statusCode, res.body).toBe(204);
    const [row] = await ctx.db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, pending.id));
    expect(row!.revokedAt).not.toBeNull();
    expect(await statusOf(ctx, pending.id)).toBe("revoked");
    const logsOf = () => ctx.log.lines.filter(l => l.msg === "撤銷邀請");
    expect(logsOf()).toHaveLength(1);
    expect(logsOf()[0]!.obj).toEqual({ userId: ctx.admin.id, linkId: pending.id });

    expect((await revoke(ctx, pending.id)).statusCode).toBe(204);
    expect(logsOf()).toHaveLength(1);

    const used = await rawInvite(ctx.db, { createdMinAgo: 20, expiresInMin: 1440, usedAtMinAgo: 5, usedBy: other.id });
    const usedRes = await revoke(ctx, used.id);
    expect(usedRes.statusCode, usedRes.body).toBe(409);
    expect(usedRes.json()).toMatchObject({ error: { code: "invite_used" } });

    const expired = await rawInvite(ctx.db, { createdMinAgo: 120, expiresInMin: -60 });
    expect((await revoke(ctx, expired.id)).statusCode).toBe(204);
    expect(await statusOf(ctx, expired.id)).toBe("expired");
    const [expiredRow] = await ctx.db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, expired.id));
    expect(expiredRow!.revokedAt).toBeNull();

    const reset = await rawInvite(ctx.db, { kind: "password_reset", target: other.id, createdMinAgo: 10, expiresInMin: 60 });
    for (const id of [randomUUID(), "not-a-uuid", reset.id]) {
      const r = await revoke(ctx, id);
      expect(r.statusCode, id).toBe(404);
      expect(r.json()).toMatchObject({ error: { code: "invite_not_found" } });
    }
    const [resetRow] = await ctx.db.select().from(oneTimeLinks).where(eq(oneTimeLinks.id, reset.id));
    expect(resetRow!.revokedAt).toBeNull();

    // 回歸：id 先轉小寫再比對。
    const upper = await rawInvite(ctx.db, { createdMinAgo: 10, expiresInMin: 1440 });
    expect((await revoke(ctx, upper.id.toUpperCase())).statusCode).toBe(204);
    expect(logsOf().at(-1)!.obj.linkId).toBe(upper.id);
    expect(await statusOf(ctx, upper.id)).toBe("revoked");

    // 撤銷不看帳密開關。
    const open = await rawInvite(ctx.db, { createdMinAgo: 10, expiresInMin: 1440 });
    await setPasswordLogin(ctx.db, false);
    expect((await revoke(ctx, open.id)).statusCode).toBe(204);
    expect(await statusOf(ctx, open.id)).toBe("revoked");
  });
});
