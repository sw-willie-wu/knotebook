/**
 * 加成員／分享對話框的使用者建議：`GET /api/users/suggest?q=`。
 *
 * **隱私邊界**：這**不是**全站名錄——全站搜尋會讓任何登入者列舉所有帳號的 email。只在呼叫者「已經認識」的人裡找：
 * ① 與呼叫者同在至少一個群組的成員（`GET /api/groups/:id/members` 本來就把他們的 email 給任何成員看——A8；
 *    那支哪天收回成員的 email，① 要一起拿掉，見 routes/groups.ts 該路由上的註解）；
 * ② 呼叫者把**自己的**筆記逐人分享過的對象（`GET /api/notes/:id/shares` 本來就給 owner 看）。垃圾桶裡的筆記不算（`deleted_at IS NULL`；
 *    那時分享名單在介面上看不到，還原後就又算了）。
 * 刻意**不含**「把筆記分享給我的人」：被分享者在介面上只看得到 owner 的 handle，看不到 email（`NoteDto` 只帶
 * `ownerHandle`），收進來就是把原本看不到的 email 洩出去。也排除自己與停用帳號（停用帳號仍可輸入完整 email 加入／分享，
 * 只是不出現在建議裡）。關係一斷（被移出群組、撤銷分享）下一次查詢就不再出現——每次都即時查，沒有快取。
 *
 * session-only（`app.authenticate`，不收 Bearer）：這支只服務 web 的兩個對話框；token 的 scope（`notes:*`）不涵蓋人員查詢，
 * 收 Bearer 只會讓外洩的 token 多一條撈 email 的路。
 *
 * 比對：`q` trim 後 2–100 字，對 email 與顯示名稱做不分大小寫的子字串比對（`%`／`_`／`\` 照字面，ESCAPE `\`）；
 * 排序＝前綴命中在前，再顯示名稱、id（決定性）；最多 `USER_SUGGEST_MAX_RESULTS` 筆。單句查詢（兩支 UNION 的 CTE），沒有 N+1。
 * 節流：`userSuggest` 桶（key=userId，見 `USER_SUGGEST_LIMIT`），驗證通過之後才扣。
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sql } from "drizzle-orm";
import {
  USER_SUGGEST_MAX_QUERY, USER_SUGGEST_MAX_RESULTS, USER_SUGGEST_MIN_QUERY, type UserSuggestResponse, type UserSuggestionDto,
} from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";

const suggestQuerySchema = z
  .object({
    q: z
      .string()
      .transform(s => s.trim())
      .pipe(z.string().min(USER_SUGGEST_MIN_QUERY, "查詢字串太短").max(USER_SUGGEST_MAX_QUERY, "查詢字串太長")),
  })
  .strict();

/** LIKE 樣式跳脫：`\` 先跳脫自己，再跳脫 `%`／`_`（搭配 `ESCAPE '\'`）。 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, ch => `\\${ch}`);
}

export interface UsersRouteDeps {
  db: Db;
  limiters: { userSuggest: FixedWindowLimiter };
}

export function usersRoutes(deps: UsersRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.get("/api/users/suggest", { preHandler: app.authenticate }, async (request, reply) => {
      const parsed = suggestQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      const me = request.user!.id;
      if (!deps.limiters.userSuggest.consume(me)) return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");

      const escaped = escapeLike(parsed.data.q);
      const contains = `%${escaped}%`;
      const prefix = `${escaped}%`;
      // lower() 兩邊都套（樣式也交給 PG lower，避免 JS 與 PG 的大小寫規則不一致）。
      // known：①同群組成員（group_members 自連；吃 group_members_user_idx 與 PK）；②我擁有的筆記的分享對象
      // （notes_owner_idx → note_shares PK）。UNION 去重後再 JOIN users。
      const res = await deps.db.execute<{ id: string; email: string; display_name: string }>(sql`
        with known as (
          select other.user_id as id
            from group_members mine
            join group_members other on other.group_id = mine.group_id
           where mine.user_id = ${me}
          union
          select ns.user_id as id
            from notes n
            join note_shares ns on ns.note_id = n.id
           where n.owner_id = ${me}
             and n.deleted_at is null
        )
        select u.id, u.email, u.display_name
          from known k
          join users u on u.id = k.id
         where u.id <> ${me}
           and u.disabled_at is null
           and (lower(u.email) like lower(${contains}) escape '\\'
                or lower(u.display_name) like lower(${contains}) escape '\\')
         order by case when lower(u.email) like lower(${prefix}) escape '\\'
                         or lower(u.display_name) like lower(${prefix}) escape '\\' then 0 else 1 end,
                  u.display_name, u.id
         limit ${USER_SUGGEST_MAX_RESULTS}
      `);
      const users = res.rows.map((r): UserSuggestionDto => ({ userId: r.id, email: r.email, displayName: r.display_name }));
      const dto: UserSuggestResponse = { users };
      return dto;
    });
  };
}
