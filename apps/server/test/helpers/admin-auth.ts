import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AppDeps, BuildAppOptions } from "../../src/app.js";
import type { Db } from "../../src/db/index.js";
import { authProviders } from "../../src/db/schema.js";
import { buildTestApp, type TestApp } from "../helpers.js";
import { cookieOf, seedUser, type SeededUser } from "../group-helpers.js";

/** #187 PR2：建 app＋一個站台管理員（無密碼、直接簽 session）。 */
export async function adminApp(
  overrides: Partial<AppDeps> = {},
  options: BuildAppOptions = {},
): Promise<TestApp & { admin: SeededUser; cookies: Record<string, string> }> {
  const built = await buildTestApp(overrides, options);
  const admin = await seedUser(built.db, { isAdmin: true });
  return { ...built, admin, cookies: await cookieOf(admin.id) };
}

/** 非管理員 403、未登入 401（`requireAdmin`）。 */
export async function expectAdminOnly(
  app: FastifyInstance,
  db: Db,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
): Promise<void> {
  const plain = await seedUser(db);
  const asPlain = await app.inject({ method, url, cookies: await cookieOf(plain.id), ...(payload ? { payload } : {}) });
  expect(asPlain.statusCode, `${method} ${url} 非管理員`).toBe(403);
  const anon = await app.inject({ method, url, ...(payload ? { payload } : {}) });
  expect(anon.statusCode, `${method} ${url} 未登入`).toBe(401);
}

/** pino `logMethod` hook 攔每一行（同 `test/admin-ai.test.ts:291-306` 的作法）。 */
export function captureLogs(): { lines: Array<{ msg?: string; obj: Record<string, unknown>; level: string }>; options: BuildAppOptions } {
  const lines: Array<{ msg?: string; obj: Record<string, unknown>; level: string }> = [];
  return {
    lines,
    options: {
      logger: {
        level: "info",
        hooks: {
          logMethod(this: { levels?: { labels?: Record<number, string> } }, args: unknown[], method: (...a: unknown[]) => void, level: number) {
            const [obj, msg] = args as [Record<string, unknown>, string | undefined];
            if (typeof obj === "object" && obj !== null) lines.push({ msg, obj, level: this.levels?.labels?.[level] ?? String(level) });
            method.apply(this, args as never[]);
          },
        },
      },
    },
  };
}

/** 直讀一列（含密文本體——只給測試斷言用）。 */
export async function providerRow(db: Db, id: string) {
  const [row] = await db.select().from(authProviders).where(eq(authProviders.id, id));
  return row;
}
