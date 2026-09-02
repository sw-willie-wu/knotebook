import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, eq, sql } from "drizzle-orm";
import { EMPTY_YDOC_UPDATE_B64, normalizeHandle, normalizeSlug, validateHandle, validateSlug } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import type { Db } from "../db/index.js";
import { noteStates, notes, uploads, users } from "../db/schema.js";
import { UUID_RE } from "../notes/service.js";
import { uploadFilePath } from "../uploads/service.js";

/**
 * #72／#122 PR3 公開分享的**免登入**端點（無 `app.authenticate`）。兩形網址：
 * token 形 `/api/public/notes/:token`（#72）與別名形 `/api/public/notes/:handle/:slug`
 * （#122 PR3，owner 顯式 opt-in 的 public_slug）——各自帶 uploads 子端點，合計四條，
 * 全部走同一支 `resolvePublicNote`（唯一實作，禁寫姊妹函式——四步序與 404 同形
 * 只能存在一份，兩份會漂移）。
 *
 * 四步序（缺一不可、次序不可換，理由見 `http/rate-limit.ts` 的 `PUBLIC_MISS_LIMIT`
 * 註解）：
 *   ① 格式 guard（token 形＝`isValidPublicToken`；別名形＝normalizeHandle/Slug 後
 *      validateHandle＋validateSlug）——非法輸入直接 404 同形，**不進任何桶**
 *      （超長字串不得成為 BoundedMap 的 key）、不打 DB。
 *   ② `publicMiss.isBlocked(ip)` **不計數**預檢——已超限的 IP 在 DB 查詢前擋下。
 *      預檢對命中與未命中一視同仁：ip 桶用完後任何輸入都是 429，攻擊者拿不到
 *      存在性區分（429 不成為 oracle）。
 *   ③ DB 反查（token 形＝public_token 等值；別名形＝users×notes 單一 JOIN，述詞
 *      **必含 `public_token IS NOT NULL`**——撤公開→兩形全死的結構保證，殘留列
 *      讀不到）——**miss 才 `consume(ip)`**（兩形共用 miss 桶）。
 *   ④ **hit 才 consume**，key 兩形不同但**同一 limiter 實例**：token 形
 *      `${ip}:${token}`、別名形 `${ip}:path:${noteId}`——不可能相撞（token 是
 *      base64url、不含 `:`，`:path:` 中綴只出現在別名形）。同一篇筆記兩形額度
 *      因此各自計（乘二）＝明示接受，記 docs/known-limitations.md。
 *
 * 404 一律**同形**（不存在／未公開／token 錯／無別名／格式不符不可區分——防列舉，
 * 比照 collab 拒連與 shares 的慣例）。回應恰 `{title, ydoc}` 兩鍵——**不回 token**
 * （別名頁洩 token＝把可猜的網址升級成不可撤的把手）、不含 noteId 與 updatedAt。
 *
 * token 出現在 token 形 URL 裡——**不進 log** 由 `app.ts` 的 req serializer
 * （`redactPublicTokens`，Task 1c）負責，本檔不得自行 `request.log` 帶 url。
 */

const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** 格式 guard（pure，unit 測試釘住）：43 字元 base64url（`randomBytes(32)` 的長度）。 */
export function isValidPublicToken(token: string): boolean {
  return PUBLIC_TOKEN_RE.test(token);
}

/**
 * log 遮罩（pure，unit 釘住）：把 `/p/<段>` 與 `/api/public/notes/<段>` 的**第一段**
 * 換成 `:token` 再進 log——**刻意過寬**（非 43 字元的段也遮；#122 PR3 的別名形
 * `/p/<handle>/<slug>` 第一段是 handle 不是 token，也會被遮成 `/p/:token/<slug>`
 * ——接受：log 遮罩寧可多遮，「差一個字元的幾乎 token」也不留，而 handle/slug
 * 本就不是機密）。由 `app.ts` 的 req serializer 無條件套在 `req.url` 上（含測試
 * 注入 logger 的情形——見該處註解）。
 */
export function redactPublicTokens(url: string): string {
  // ⚠ 先收斂開頭的重複斜線、比對不分大小寫（審查真 socket 實測抓到的洩漏形）：
  // SPA fallback 對 `//p/<token>`、`/P/<token>`、`//api/public/...` 一律照常服務
  // （fastify 路由與 EXCLUDED_PREFIXES 都比不中，落進 fallback 回 200），`^` 錨定
  // ＋大小寫敏感的字面比對會讓這些變體把 token 原文寫進 log。收斂會讓 log 裡的
  // URL 與原始請求略有出入（`//p/…` 記成 `/p/:token…`）——安全不變量優先於
  // log 逐字保真。
  const collapsed = url.replace(/^\/{2,}/, "/");
  return collapsed
    .replace(/^\/p\/[^/?#]+/i, "/p/:token")
    .replace(/^\/api\/public\/notes\/[^/?#]+/i, "/api/public/notes/:token");
}

/**
 * `/p` 公開分享頁的 pathname 判定——noindex 條件（spa.ts）與 log 遮罩共用同一份
 * 正規化（開頭斜線收斂＋不分大小寫），**不得各寫一份字面比對**（只修一邊的話
 * `//p/<token>` 這類變體會拿不到 noindex 或洩進 log，兩處同時破——審查實測過）。
 * `pathname === "/p"` 也算：本身沒有 token、掛 noindex 無害，且讓 `/p` 與 `/p/`
 * 行為一致（有測試釘住）。
 */
export function isPublicSharePath(pathname: string): boolean {
  const p = pathname.replace(/^\/{2,}/, "/").toLowerCase();
  return p === "/p" || p.startsWith("/p/");
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

/**
 * 一種公開網址形＝三個注入點（檔頭四步序的可變部分；固定步序寫死在
 * `resolvePublicNote` 本體，**不得**把 guard 折進 lookup——那會讓「格式 guard
 * 不進桶不打 DB」（§5.4）靜默破掉）。
 */
interface PublicRefSpec<Q> {
  /** ① 正規化＋格式 guard（pure）：非法形回 null（404 同形、不進桶、不打 DB）。 */
  guard: () => Q | null;
  /** ③ DB 反查（單一查詢）：miss 回 undefined。 */
  lookup: (q: Q) => Promise<{ id: string; title: string } | undefined>;
  /** ④ hit 桶 key（兩形不同、同一 limiter——見檔頭）。 */
  hitKey: (q: Q, ip: string, noteId: string) => string;
}

export function publicRoutes(deps: PublicRoutesDeps) {
  /**
   * 四步序的唯一實作（兩形四路由全走這裡）。回 `null` 表示已回覆（404/429）；
   * 回列則為命中（已 consume 呼叫端指定的 hit 桶）。
   */
  async function resolvePublicNote<Q>(
    request: FastifyRequest,
    reply: FastifyReply,
    hitBucket: FixedWindowLimiter,
    spec: PublicRefSpec<Q>,
  ): Promise<{ id: string; title: string } | null> {
    // ① 格式 guard：不進桶、不打 DB。
    const q = spec.guard();
    if (q === null) {
      sendLinkNotFound(reply);
      return null;
    }
    const ip = request.ip;
    // ② 不計數預檢：對命中與未命中一視同仁。
    if (deps.limiters.publicMiss.isBlocked(ip)) {
      sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      return null;
    }
    // ③ 反查後分桶計數（兩形共用 miss 桶）。
    const note = await spec.lookup(q);
    if (!note) {
      deps.limiters.publicMiss.consume(ip);
      sendLinkNotFound(reply);
      return null;
    }
    // ④ hit 桶（key 形見檔頭）。
    if (!hitBucket.consume(spec.hitKey(q, ip, note.id))) {
      sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      return null;
    }
    return note;
  }

  /** token 形（#72）。 */
  function tokenSpec(token: string): PublicRefSpec<string> {
    return {
      guard: () => (isValidPublicToken(token) ? token : null),
      lookup: (t) =>
        deps.db
          .select({ id: notes.id, title: notes.title })
          .from(notes)
          .where(eq(notes.publicToken, t))
          .limit(1)
          .then((rows) => rows[0]),
      hitKey: (t, ip) => `${ip}:${t}`,
    };
  }

  /** 別名形（#122 PR3）。 */
  function pathSpec(rawHandle: string, rawSlug: string): PublicRefSpec<{ handle: string; slug: string }> {
    return {
      guard: () => {
        const handle = normalizeHandle(rawHandle);
        const slug = normalizeSlug(rawSlug);
        if (validateHandle(handle) !== null || validateSlug(slug) !== null) return null;
        return { handle, slug };
      },
      // 單一 JOIN；述詞含 `public_token IS NOT NULL`（撤公開→全死的結構保證，
      // 殘留列讀不到）。**只比對 public_slug**——私人 slug/prev/legacy 都不是
      // 公開面（測試以三條負向釘住）。
      lookup: (q) =>
        deps.db
          .select({ id: notes.id, title: notes.title })
          .from(notes)
          .innerJoin(users, eq(users.id, notes.ownerId))
          .where(and(eq(users.handle, q.handle), eq(notes.publicSlug, q.slug), sql`${notes.publicToken} is not null`))
          .limit(1)
          .then((rows) => rows[0]),
      hitKey: (_q, ip, noteId) => `${ip}:path:${noteId}`,
    };
  }

  return function register(app: FastifyInstance) {
    /** 兩形共用的 200 回應器（標頭與 body 形只存在一份——同形保證）。 */
    async function sendPublicNote(reply: FastifyReply, note: { id: string; title: string }) {
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
    }

    async function sendPublicUpload(request: FastifyRequest, reply: FastifyReply, note: { id: string }, uploadId: string) {
      // 這裡起是「命中」領域（已計 hit 桶）：uploadId 的各種落空回 uploads GET 同款
      // 的檔案 404——**跨筆記 uploadId 也是 404**（公開授權只及自己那篇的 blob；
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
    }

    app.get("/api/public/notes/:token", async (request, reply) => {
      const { token } = request.params as { token: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicNote, tokenSpec(token));
      if (!note) return reply;
      return sendPublicNote(reply, note);
    });

    app.get("/api/public/notes/:handle/:slug", async (request, reply) => {
      const { handle, slug } = request.params as { handle: string; slug: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicNote, pathSpec(handle, slug));
      if (!note) return reply;
      return sendPublicNote(reply, note);
    });

    app.get("/api/public/notes/:token/uploads/:uploadId", async (request, reply) => {
      const { token, uploadId } = request.params as { token: string; uploadId: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicUpload, tokenSpec(token));
      if (!note) return reply;
      return sendPublicUpload(request, reply, note, uploadId);
    });

    app.get("/api/public/notes/:handle/:slug/uploads/:uploadId", async (request, reply) => {
      const { handle, slug, uploadId } = request.params as { handle: string; slug: string; uploadId: string };
      const note = await resolvePublicNote(request, reply, deps.limiters.publicUpload, pathSpec(handle, slug));
      if (!note) return reply;
      return sendPublicUpload(request, reply, note, uploadId);
    });
  };
}
