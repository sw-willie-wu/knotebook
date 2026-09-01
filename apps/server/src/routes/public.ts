import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { eq } from "drizzle-orm";
import { EMPTY_YDOC_UPDATE_B64 } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { Db } from "../db/index.js";
import { noteStates, notes, uploads } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { uploadFilePath } from "../uploads/service.js";

/**
 * #72 公開分享連結的**免登入**端點（無 `app.authenticate`）。
 *
 * 三步順序（缺一不可，理由見 `http/rate-limit.ts` 的 `PUBLIC_MISS_LIMIT` 註解）：
 *   ① 格式 guard（`isValidPublicToken`）——非法輸入直接 404 同形，**不進任何桶**
 *      （超長字串不得成為 BoundedMap 的 key）、不打 DB。
 *   ② `publicMiss.isBlocked(ip)` **不計數**預檢——已超限的 IP 在 DB 查詢前擋下。
 *      預檢對命中與未命中一視同仁：ip 桶用完後任何 token 都是 429，攻擊者拿不到
 *      存在性區分（429 不成為 oracle）；ip 桶未滿時 200/404 的區分本來就是功能
 *      本身（能送 token 的人直接看得到內容），節流沒有多洩任何位元。
 *   ③ DB 以 token 反查——**miss 才 `consume(ip)`**（亂數 token 洪水吃 IP 桶，
 *      大量相異 token 不免疫）；**hit 才 `consume(ip:token)`**（同 token 的讀者
 *      互不影響別的筆記的讀者）。
 *
 * 404 一律**同形**（筆記不存在／未開公開／token 錯／格式不符不可區分——防列舉，
 * 比照 collab 拒連與 shares 的慣例）。回應刻意不含 noteId 與 updatedAt
 * （`notes.updated_at` 只有改標題/slug 才動，回了就是誤導）。
 *
 * token 出現在這些 URL 裡——**不進 log** 由 `app.ts` 的 req serializer
 * （`redactPublicTokens`，Task 1c）負責，本檔不得自行 `request.log` 帶 url。
 */

const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 格式 guard（pure，unit 測試釘住）：43 字元 base64url（`randomBytes(32)` 的長度）。 */
export function isValidPublicToken(token: string): boolean {
  return PUBLIC_TOKEN_RE.test(token);
}

export interface PublicRoutesDeps {
  db: Db;
  uploadsDir: string;
  limiters: { publicMiss: FixedWindowLimiter; publicNote: FixedWindowLimiter; publicUpload: FixedWindowLimiter };
}

/** 三情境共用的同形 404（body 逐位元組一致由測試釘住）。 */
function sendLinkNotFound(reply: FastifyReply): FastifyReply {
  return sendError(reply, 404, "not_found", "連結不存在或已失效");
}

export function publicRoutes(deps: PublicRoutesDeps) {
  /**
   * 三步順序的前兩步＋反查。回 `null` 表示已回覆（404/429）；回列則為命中
   * （已 `consume(ip:token)` 於呼叫端指定的 hit 桶）。
   */
  async function resolvePublicNote(
    request: FastifyRequest,
    reply: FastifyReply,
    token: string,
    hitBucket: FixedWindowLimiter,
  ): Promise<{ id: string; title: string } | null> {
    // ① 格式 guard：不進桶、不打 DB。
    if (!isValidPublicToken(token)) {
      sendLinkNotFound(reply);
      return null;
    }
    const ip = request.ip;
    // ② 不計數預檢：對命中與未命中一視同仁。
    if (deps.limiters.publicMiss.isBlocked(ip)) {
      sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      return null;
    }
    // ③ 反查後分桶計數。
    const [note] = await deps.db
      .select({ id: notes.id, title: notes.title })
      .from(notes)
      .where(eq(notes.publicToken, token))
      .limit(1);
    if (!note) {
      deps.limiters.publicMiss.consume(ip);
      sendLinkNotFound(reply);
      return null;
    }
    if (!hitBucket.consume(`${ip}:${token}`)) {
      sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      return null;
    }
    return note;
  }

  return function register(app: FastifyInstance) {
    app.get("/api/public/notes/:token", async (request, reply) => {
      const { token } = request.params as { token: string };
      const note = await resolvePublicNote(request, reply, token, deps.limiters.publicNote);
      if (!note) return reply;

      // LEFT JOIN 語意：從沒開過編輯器的筆記查無 note_states——那是**合法空文件**，
      // 回 EMPTY_YDOC_UPDATE_B64（零長度會讓 client 的 Y.applyUpdate throw，見
      // shared 的常數註解），不是 404。
      const [state] = await deps.db
        .select({ ydoc: noteStates.ydoc })
        .from(noteStates)
        .where(eq(noteStates.noteId, note.id))
        .limit(1);

      // no-store：撤銷/重生要即時生效，公開內容不進任何快取。
      reply.header("cache-control", "no-store");
      return { title: note.title, ydoc: state ? state.ydoc.toString("base64") : EMPTY_YDOC_UPDATE_B64 };
    });

    app.get("/api/public/notes/:token/uploads/:uploadId", async (request, reply) => {
      const { token, uploadId } = request.params as { token: string; uploadId: string };
      const note = await resolvePublicNote(request, reply, token, deps.limiters.publicUpload);
      if (!note) return reply;

      // 這裡起是「命中」領域（已計 hit 桶）：uploadId 的各種落空回 uploads GET 同款
      // 的檔案 404——**跨筆記 uploadId 也是 404**（token 只授權自己那篇的 blob；
      // A 筆記的圖貼進 B、B 公開後那張圖破圖，記 docs/known-limitations.md）。
      if (!UUID_RE.test(uploadId)) {
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }
      const [row] = await deps.db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
      if (!row || row.noteId !== note.id) {
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      const filePath = uploadFilePath(deps.uploadsDir, row.id);
      try {
        await stat(filePath);
      } catch {
        request.log.error({ uploadId: row.id }, "DB 有上傳紀錄但磁碟找不到對應檔案");
        return sendError(reply, 404, "not_found", "找不到此檔案");
      }

      reply.header("x-content-type-options", "nosniff");
      // 與登入版 uploads GET 同款：`private, immutable`。代價（撤銷後瀏覽器快取內
      // 的圖仍可讀）記 docs/known-limitations.md。
      reply.header("cache-control", "private, max-age=31536000, immutable");
      reply.type(row.mime);
      return reply.send(createReadStream(filePath));
    });
  };
}
