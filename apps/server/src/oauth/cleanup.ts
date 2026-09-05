import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { apiTokens, oauthClients, oauthCodes, oauthRequests } from "../db/schema.js";

/**
 * I5：唯一的清理點，五條 DELETE。
 *
 * **性質：沒有排程**——只在每次 DCR（`POST /oauth/register`）、authorize（`GET /oauth/authorize`）、
 * decision（`POST /api/oauth/decision`）、`/oauth/token` 換發**成功**（authorization_code grant）、
 * `/oauth/token` refresh **成功**與建 PAT（`POST /api/auth/tokens`），共六個時機會性執行；殘留
 * 列要等下一次有人用 OAuth 才回收（記在 docs/known-limitations.md）。
 *
 * ⚠ 呼叫順序的約束（authorize／decision 內必須早於 client 查表）記在那兩個呼叫點。
 *
 * 五條的**目標表**述詞都沒有索引支撐，刻意不建：表恆小，觸發點都被限流壓著。
 */
export async function runOauthCleanup(db: Db): Promise<void> {
  // ① 30 天未使用的 client（CASCADE 帶走它的 grant／request／code）。判準是
  //    last_used_at——Bearer 驗證成功會連帶更新它，天天在用的 client 才不會被清掉。
  await db.delete(oauthClients).where(sql`${oauthClients.lastUsedAt} < now() - interval '30 days'`);

  // ② 建立超過 24h 卻從沒換出過任何 grant 或 code 的殭屍 client（灌表的形；正常 client
  //    在幾十秒內就會產生 code）。
  await db.delete(oauthClients).where(
    sql`${oauthClients.createdAt} < now() - interval '24 hours'
        and not exists (select 1 from ${apiTokens} where ${apiTokens.clientId} = ${oauthClients.clientId})
        and not exists (select 1 from ${oauthCodes} where ${oauthCodes.clientId} = ${oauthClients.clientId})`
  );

  // ③④ 過期的 pending request 與 authorization code。排在 ② 之後，所以「唯一的 code
  //    剛過期」的殭屍 client 要下一輪才被清掉——自癒，不必調順序。
  await db.delete(oauthRequests).where(sql`${oauthRequests.expiresAt} < now()`);
  await db.delete(oauthCodes).where(sql`${oauthCodes.expiresAt} < now()`);

  // ⑤ 過期超過 30 天的 PAT。`kind='pat'` 那半段承重：oauth grant 的 access 過期不代表
  //    授權失效（refresh 不到期），它們只由 ① 與撤銷收斂。
  await db
    .delete(apiTokens)
    .where(and(eq(apiTokens.kind, "pat"), sql`${apiTokens.accessExpiresAt} < now() - interval '30 days'`));
}
