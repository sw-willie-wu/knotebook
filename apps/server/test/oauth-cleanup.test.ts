/**
 * #132 Task 3：I5 機會性清理（§3 I5）的五條 DELETE。
 *
 * 這一族守的是每一條的**述詞邊界**：① 看 last_used_at 不是 created_at、② 只清「建立超過
 * 24h 且從沒換出過 grant／code」的殭屍、③④ 只清過期的、⑤ 只清 PAT 且要過期滿 30 天。
 * 述詞少一半仍全綠是本專案反覆踩過的假綠形，所以每條都配一個「不該被清掉」的對照。
 */
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../src/db/schema.js";
import { runOauthCleanup } from "../src/oauth/cleanup.js";
import type { Db } from "../src/db/index.js";
import { freshDb, insertPasswordUser } from "./helpers.js";

// 這族只要 db（不打路由），用 freshDb 而非 buildTestApp——省掉八次建整個 app。
// 用既有的 `insertPasswordUser`（email 走 randomUUID，不會撞唯一鍵）。
async function createUser(db: Db): Promise<string> {
  return (await insertPasswordUser(db)).id;
}

describe("I5 機會性清理（§3 I5）", () => {
  it("① 30 天未使用的 client 連同其 grant 一起消失", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "stale",
        clientName: "Stale",
        redirectUris: ["http://127.0.0.1/cb"],
        lastUsedAt: sql`now() - interval '31 days'`,
      });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Stale",
        scope: "notes:read",
        accessTokenHash: "h1",
        refreshTokenHash: "r1",
        clientId: "stale",
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      await db.insert(oauthRequests).values({
        id: "req1",
        clientId: "stale",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        scope: "notes:read",
        expiresAt: sql`now() + interval '5 minutes'`,
      });
      await db.insert(oauthCodes).values({
        codeHash: "code1",
        clientId: "stale",
        userId,
        scope: "notes:read",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        expiresAt: sql`now() + interval '5 minutes'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(oauthClients)).toHaveLength(0);
      // CASCADE 帶走三者（spec ① 逐字如此），未過期的 request／code 也一併消失
      expect(await db.select().from(apiTokens)).toHaveLength(0);
      expect(await db.select().from(oauthRequests)).toHaveLength(0);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  // ① 的判準是 last_used_at，而 Bearer 驗證成功會連帶更新它（#130 的 touchLastUsed）
  // ——兩個時間戳語意一致，天天在用的 client 才不會被清掉。
  it("① 不碰 last_used_at 在 30 天內的 client（即使 created_at 是 90 天前）", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "active",
        clientName: "Active",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '90 days'`,
        // 緊邊界：29 天而非 1 小時，門檻寫成 24h 之類就會紅
        lastUsedAt: sql`now() - interval '29 days'`,
      });
      // 必須有 grant，否則會落進 ② 的殭屍條件而被刪——這一案要測的是 ① 不誤刪。
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Active",
        scope: "notes:read",
        accessTokenHash: "active-h",
        refreshTokenHash: "active-r",
        clientId: "active",
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(oauthClients)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("② 建立超過 24h 且無 grant／code 的殭屍 client 消失，有 code 的留下", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      for (const clientId of ["zombie", "busy"]) {
        await db.insert(oauthClients).values({
          clientId,
          clientName: clientId,
          redirectUris: ["http://127.0.0.1/cb"],
          createdAt: sql`now() - interval '25 hours'`,
        });
      }
      await db.insert(oauthCodes).values({
        codeHash: "c1",
        clientId: "busy",
        userId,
        scope: "notes:read",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        expiresAt: sql`now() + interval '5 minutes'`,
      });

      await runOauthCleanup(db);

      const remaining = await db.select({ id: oauthClients.clientId }).from(oauthClients);
      expect(remaining.map(r => r.id)).toEqual(["busy"]);
    } finally {
      await close();
    }
  });

  it("② 有 grant 的 client 也留下（述詞的另一半）", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "granted",
        clientName: "Granted",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "Granted",
        scope: "notes:read",
        accessTokenHash: "g1",
        refreshTokenHash: "gr1",
        clientId: "granted",
        accessExpiresAt: sql`now() + interval '1 day'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(oauthClients)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("② 不碰建立未滿 24h 的 client（剛註冊還沒授權完）", async () => {
    const { db, close } = await freshDb();
    try {
      // 緊邊界：23 小時（門檻若被改鬆成 1 小時就會紅）
      await db.insert(oauthClients).values({
        clientId: "fresh",
        clientName: "Fresh",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '23 hours'`,
      });
      await runOauthCleanup(db);
      expect(await db.select().from(oauthClients)).toHaveLength(1);
    } finally {
      await close();
    }
  });

  // ② 排在 ③④ 之前，所以「唯一的 code 剛過期」的殭屍要兩輪才清乾淨。這是自癒行為，
  // 但沒有測試的話它只是一句註解；把 ③④ 移到 ② 之前，第一輪的斷言就會紅。
  it("② 與 ③④ 的順序：唯一的 code 已過期時，client 第二輪才消失", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "expiring",
        clientName: "Expiring",
        redirectUris: ["http://127.0.0.1/cb"],
        createdAt: sql`now() - interval '25 hours'`,
      });
      await db.insert(oauthCodes).values({
        codeHash: "expired-code",
        clientId: "expiring",
        userId,
        scope: "notes:read",
        redirectUri: "http://127.0.0.1:1/cb",
        codeChallenge: "x".repeat(43),
        expiresAt: sql`now() - interval '1 minute'`,
      });

      await runOauthCleanup(db);
      // 第一輪：② 看到 code 還在而放過 client，④ 隨後清掉那個 code
      expect(await db.select().from(oauthClients)).toHaveLength(1);
      expect(await db.select().from(oauthCodes)).toHaveLength(0);

      await runOauthCleanup(db);
      expect(await db.select().from(oauthClients)).toHaveLength(0);
    } finally {
      await close();
    }
  });

  it("③④ 過期的 request 與 code 消失，未過期的留下", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({ clientId: "c", clientName: "C", redirectUris: ["http://127.0.0.1/cb"] });
      for (const [id, offset] of [
        ["old", "-1 minute"],
        ["new", "+5 minutes"],
      ] as const) {
        await db.insert(oauthRequests).values({
          id,
          clientId: "c",
          redirectUri: "http://127.0.0.1:1/cb",
          codeChallenge: "x".repeat(43),
          scope: "notes:read",
          expiresAt: sql`now() + interval '${sql.raw(offset)}'`,
        });
        await db.insert(oauthCodes).values({
          codeHash: id,
          clientId: "c",
          userId,
          scope: "notes:read",
          redirectUri: "http://127.0.0.1:1/cb",
          codeChallenge: "x".repeat(43),
          expiresAt: sql`now() + interval '${sql.raw(offset)}'`,
        });
      }

      await runOauthCleanup(db);

      expect((await db.select({ id: oauthRequests.id }).from(oauthRequests)).map(r => r.id)).toEqual(["new"]);
      expect((await db.select({ h: oauthCodes.codeHash }).from(oauthCodes)).map(r => r.h)).toEqual(["new"]);
    } finally {
      await close();
    }
  });

  it("⑤ 只清過期超過 30 天的 PAT，不碰未到 30 天的與不到期的", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(apiTokens).values([
        {
          userId,
          kind: "pat",
          name: "old",
          scope: "notes:read",
          accessTokenHash: "p1",
          accessExpiresAt: sql`now() - interval '31 days'`,
        },
        {
          userId,
          kind: "pat",
          name: "recent",
          scope: "notes:read",
          accessTokenHash: "p2",
          accessExpiresAt: sql`now() - interval '3 days'`,
        },
        { userId, kind: "pat", name: "forever", scope: "notes:read", accessTokenHash: "p3", accessExpiresAt: null },
      ]);

      await runOauthCleanup(db);

      const names = (await db.select({ name: apiTokens.name }).from(apiTokens)).map(r => r.name).sort();
      expect(names).toEqual(["forever", "recent"]);
    } finally {
      await close();
    }
  });

  // ⑤ 的 `kind='pat'` 那半段：oauth grant 的 access 過期 31 天**不該**被這條清掉
  // （refresh 不到期，授權仍然有效；它只由 ① 與撤銷收斂）。
  it("⑤ 不碰 access 過期超過 30 天的 oauth grant", async () => {
    const { db, close } = await freshDb();
    try {
      const userId = await createUser(db);
      await db.insert(oauthClients).values({
        clientId: "og",
        clientName: "OG",
        redirectUris: ["http://127.0.0.1/cb"],
        lastUsedAt: sql`now() - interval '1 hour'`,
      });
      await db.insert(apiTokens).values({
        userId,
        kind: "oauth",
        name: "OG",
        scope: "notes:read",
        accessTokenHash: "og1",
        refreshTokenHash: "ogr1",
        clientId: "og",
        accessExpiresAt: sql`now() - interval '31 days'`,
      });

      await runOauthCleanup(db);

      expect(await db.select().from(apiTokens)).toHaveLength(1);
    } finally {
      await close();
    }
  });
});
