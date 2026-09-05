import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { apiTokens } from "../db/schema.js";

/** I1：每位使用者計入額度的 grant 上限。 */
export const TOKEN_LIMIT_PER_USER = 20;

/**
 * 這個查詢在 `/oauth/token` 內是在 transaction 裡跑的，所以參數型別要同時吃 `Db` 與
 * drizzle 的 transaction handle——`Db` 的 `.transaction()` callback 參數型別即是後者。
 */
export type DbOrTx = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * I1 的「有效」定義——**只給額度用**。`kind='oauth' OR` 那半段是因為 refresh 不到期
 * （access 過期不代表授權失效）；**不得**拿去當認證述詞（`auth/bearer.ts`），帶進去
 * 會讓過期的 oauth access token 永遠有效。
 *
 * `excludeClientId`：OAuth 路徑要扣掉會被 I7 取代的那一列，否則「20 支且其中一支就是
 * 本 client」的使用者重新授權同一個 client 會吃 409，與同意頁的「將取代舊授權」矛盾。
 * `/oauth/token`（§5.4 步驟 5）走的是「先刪後計」——兩者等價，改一邊要一起改。
 *
 * **軟配額**：查完再插、不鎖 user 列，並行建立可短暫超出 20（非安全邊界）。
 */
export async function countBillableGrants(db: DbOrTx, userId: string, excludeClientId?: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiTokens)
    .where(
      and(
        eq(apiTokens.userId, userId),
        sql`(${apiTokens.kind} = 'oauth' or ${apiTokens.accessExpiresAt} is null or ${apiTokens.accessExpiresAt} > now())`,
        excludeClientId === undefined
          ? undefined
          : sql`not (${apiTokens.kind} = 'oauth' and ${apiTokens.clientId} = ${excludeClientId})`
      )
    );
  return row?.count ?? 0;
}
