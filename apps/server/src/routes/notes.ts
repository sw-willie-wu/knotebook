import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, ne, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { MAX_LINK_TARGETS, autoSlugFromTitle, normalizeEmail, normalizeHandle, normalizeSlug, type BacklinkDto, type NoteDto, type Role, type ShareDto } from "@knotebook/shared";
import { sendError } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { noteLinks, noteShares, noteStateBackups, noteStates, notes, uploads, users } from "../db/schema.js";
import type { CollabHooks } from "../collab/hooks.js";
import { resolveRole, resolveRoleWithOwner, UUID_RE } from "../notes/service.js";
import { deriveUniqueAutoSlug, fallbackAutoSlug, prepareSlugForPatch, resolveNoteIdFromRef } from "../notes/slug.js";
import { fetchBacklinks, normalizeLinkTargets, writeNoteLinks, type WriteNoteLinksHooks } from "../notes/links.js";
import { signCollabToken } from "../collab/token.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { isForeignKeyViolation, uniqueViolationConstraint } from "../db/pg-errors.js";
import { deleteUploadFiles } from "../uploads/service.js";

// 建立時 title 允許省略（DB 端有 default "Untitled"），但若有帶就不可為空字串——
// 與 PATCH 的 title 驗證同一套規則，避免「傳空字串把標題清空」這種語意混淆的落地方式。
const createBodySchema = z.object({ title: z.string().min(1).optional() });

// PATCH 契約（spec §11.4 逐字）：title／slug 皆選配，但至少要帶一項——兩者都缺時走
// safeParse 失敗路徑，回 400 invalid_body（與其他 body schema 一致，不特地為「空
// payload」開一條不同的錯誤碼）。`slug` 允許顯式 `null`（清除既有自訂網址代稱）與
// 字串（新設定，routes 內再走 `prepareSlugForPatch` 正規化+驗證）——`undefined`
// （鍵不存在）代表「這次 PATCH 不動 slug」，三態語意靠 zod 的 `nullable().optional()`
// 表達，不能只用 `nullable()`（那樣呼叫端必須每次都明確傳 `slug: null` 才能不改動）。
// 未知欄位一律被 z.object 預設的 strip 行為丟棄（不需要額外 `.strict()`/`.passthrough()`）。
const updateBodySchema = z
  .object({
    title: z.string().min(1).optional(),
    slug: z.string().nullable().optional(),
  })
  .refine(b => b.title !== undefined || b.slug !== undefined, { message: "title 與 slug 至少需帶一項" });
const putShareBodySchema = z.object({ email: z.string().email(), role: z.enum(["viewer", "editor"]) });

// POST /api/notes/:id/links body（spec §12.3）：`.max(MAX_LINK_TARGETS * 2)` 是提交前的
// 效能粗閘（避免病態大陣列在正規化之前就先跑完整 uuid 格式驗證），**不是**語意上限本身
// ——真正的 `MAX_LINK_TARGETS` 上限判定在 `normalizeLinkTargets`（去重、濾除 self-link
// 之後）才算數，兩處數字不必相等/不可互相取代。
const linksBodySchema = z.object({ link_target_ids: z.array(z.string().uuid()).max(MAX_LINK_TARGETS * 2) });

// auto slug 的 UPDATE 撞唯一索引（真競態）重試上限（#122 spec §3a）：1..5 次重探測重發，
// 第 6 次改用 `fallbackAutoSlug()`（untitled-<uuid8>）——再撞（~2^-32）就讓錯誤冒出去。
const MAX_AUTO_SLUG_RETRIES = 5;

// `isForeignKeyViolation` 收在 `db/pg-errors.ts` 的共用版（原本這裡有一份邏輯等價的私有
// 重複實作，Task 5 收掉——`notes/links.ts` 的 `writeNoteLinks` 也需要同一個判定，兩處各自
// 維護一份會有漂移風險）。

export interface NotesRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  config: AppConfig;
  /** `collabToken` 供 collab-token endpoint；`slugPatch` 供 PATCH 帶 slug 鍵（含 null——進 slug 分支即計，見四格註解）**與公開別名兩支（#122 PR3）**節流；`publicLink` 供 public-link 的 PUT/DELETE（#72，見各路由）。 */
  limiters: { collabToken: FixedWindowLimiter; slugPatch: FixedWindowLimiter; publicLink: FixedWindowLimiter };
  /** Task 5：`POST /api/notes/:id/links` 寫入函式的測試注入縫，透傳自 `AppDeps.linkSyncTestHooks`。 */
  linkSyncTestHooks?: WriteNoteLinksHooks;
  /**
   * #122 PR2：PATCH 的 auto slug 路徑測試注入縫——每輪探測完、UPDATE 發出前呼叫（帶本輪
   * 候選）；測試在這裡搶插同 owner 同 slug 的佔位列，讓 UPDATE 真的撞 `(owner_id, slug)`
   * 唯一索引，藉以驅動「重試 ≤`MAX_AUTO_SLUG_RETRIES` 後退 untitled-<uuid8>」的競態路徑
   * （比照 `linkSyncTestHooks` 慣例）。生產不注入＝零成本。透傳自 `AppDeps.slugUpdateTestHook`。
   */
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  /**
   * Task 11：DELETE note 交易 commit 後，補刪該筆記名下上傳 blob 檔案要用的目錄——
   * 與 `UploadsRouteDeps.uploadsDir`／`AppConfig` 同一份，透傳自 `AppDeps.uploadsDir`
   * （見 `app.ts` 註冊點）。
   */
  uploadsDir: string;
}

// 只列出 toNoteDto 實際會用到的欄位（而非完整 `typeof notes.$inferSelect`）：GET
// list 那支改走 UNION ALL 後，兩個分支各自的 select shape 只挑這幾欄 + role，不含
// linksClock/deletedAt——用這個窄介面讓「完整 note row」與「union 出來的窄 row」都能
// 結構相容地傳進來，不必為了餵同一個函式而多 select 用不到的欄位。
// `ownerHandle` 不在 notes 表上（#122）——各回填點自行帶入：JOIN users（list/:ref/
// by-path）、`request.user.handle`（POST——建立者即 owner，spec A12）、returning 後
// 補一次 SELECT users（PATCH——editor 改他人筆記時必須回 **owner 的** handle）。
interface NoteFields {
  id: string;
  title: string;
  ownerId: string;
  slug: string;
  slugIsCustom: boolean;
  prevSlug: string | null;
  ownerHandle: string;
  createdAt: Date;
  updatedAt: Date;
}

function toNoteDto(note: NoteFields, role: Role): NoteDto {
  return {
    id: note.id,
    title: note.title,
    ownerId: note.ownerId,
    role,
    slug: note.slug,
    slugIsCustom: note.slugIsCustom,
    prevSlug: note.prevSlug,
    ownerHandle: note.ownerHandle,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

/**
 * Notes CRUD 路由——皆需認證（`authenticate` preHandler）。
 *
 * `GET /api/notes/:ref`（Task 8 由 `:id` 改名，見 `resolveNoteIdFromRef`）／`PATCH`／
 * `DELETE` 一律先經 `resolveRole` 判斷權限：查無權限
 * （'none'，涵蓋「note 不存在」與「存在但未分享給此使用者」兩種情況）一律回 404
 * `not_found`，不區分這兩者——避免把「note 是否存在」洩漏給無權限的使用者
 * （spec：防列舉）。403 `forbidden` 只用在「查得到、但角色不夠」的情況
 * （PATCH 需要 editor+，viewer 會落在這裡；DELETE 需要 owner，editor/viewer 會落在這裡）。
 */
export function notesRoutes(deps: NotesRouteDeps) {
  return async function register(app: FastifyInstance): Promise<void> {
    // #107 D2：這三條（POST /api/notes、GET /api/notes、GET /api/notes/:ref）在 API token
    // 的允許清單上，其餘 notes 路由維持 cookie-only——尤其 collab-token 是 D8 明文不收
    // Bearer。challenge 省略＝等於 required；只有 /api/mcp 需要宣告比 required 更寬的集合。
    app.post("/api/notes", { preHandler: app.authenticateAny("notes:write") }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const userId = request.user!.id;

      // title 未帶時完全不放進 values——讓 DB 的 default "Untitled" 生效，而不是應用層
      // 自己重複寫死同一個預設值字面量（唯一真相來源在 schema.ts）。
      const values = parsed.data.title === undefined ? { ownerId: userId } : { ownerId: userId, title: parsed.data.title };
      const [note] = await deps.db.insert(notes).values(values).returning();

      // ownerHandle 直接取 request.user（A12）：建立者即 owner，不必補查 users。
      return reply.code(201).send(toNoteDto({ ...note, ownerHandle: request.user!.handle }, "owner"));
    });

    app.get("/api/notes", { preHandler: app.authenticateAny("notes:read") }, async request => {
      const userId = request.user!.id;

      // I1（審查）：原本的 leftJoin + WHERE(owner_id=$u OR note_shares.user_id=$u) 形狀
      // 中，那個 OR 橫跨了 outer join 兩側的欄位——單靠幫 owner_id／note_shares.user_id
      // 個別加索引救不了，planner 對這種「join 結果上的 OR」通常還是得整個 notes 表
      // 全掃一輪（無法把 OR 的任一邊下推成單獨的 index scan）。改寫成 UNION ALL 兩支
      // 各自單純的查詢：自有分支 `WHERE owner_id=$u`（吃 notes_owner_idx）、被分享分支
      // `INNER JOIN note_shares ON note_id=notes.id AND user_id=$u`（吃
      // note_shares_user_idx），兩支各自可以走 index scan，讓索引真的生效。
      //
      // Task 11 re-review（I1 補述）：兩分支結構上不保證互斥——note_shares 目前雖然靠
      // PUT /api/notes/:id/shares 的 `cannot_share_with_self` 擋掉 owner 把自己加進
      // 自己的分享名單，但那只是應用層的單一入口擋，不是資料庫層的不可能。若未來有
      // 其他路徑（手動 SQL、資料修復腳本、之後新增的匯入功能等）繞過那層檢查，塞進一筆
      // owner 對自己 note 的 note_shares 列，被分享分支就會多撈出同一篇 note 的第二列
      // （role 還會是錯的：note_shares 上存的 'editor'/'viewer'，而非其實際身分
      // 'owner'）。因此被分享分支額外加上 `ne(notes.ownerId, userId)`，在資料庫層面
      // 直接排除這種自我分享列，讓「同一位使用者、同一篇 note 只會出現一列」在結構上
      // 就不可能被打破，不依賴上層某個入口有沒有檢查到——防禦縱深（見
      // test/shares.test.ts「GET /api/notes 清單去重」）。
      // #122：兩支各 JOIN users 帶出 ownerHandle（自有分支的 owner 恆為請求者，理論上可
      // 免 JOIN 抄 request.user.handle——但兩支 select shape 必須同形才能 unionAll，
      // 且讓「handle 一律來自 DB 的 owner 列」在兩支上一致，不留特例）。
      const ownedSelect = deps.db
        .select({
          id: notes.id,
          title: notes.title,
          ownerId: notes.ownerId,
          slug: notes.slug,
          slugIsCustom: notes.slugIsCustom,
          prevSlug: notes.prevSlug,
          ownerHandle: users.handle,
          createdAt: notes.createdAt,
          updatedAt: notes.updatedAt,
          role: sql<string>`'owner'`.as("role"),
        })
        .from(notes)
        .innerJoin(users, eq(users.id, notes.ownerId))
        .where(eq(notes.ownerId, userId));

      const sharedSelect = deps.db
        .select({
          id: notes.id,
          title: notes.title,
          ownerId: notes.ownerId,
          slug: notes.slug,
          slugIsCustom: notes.slugIsCustom,
          prevSlug: notes.prevSlug,
          ownerHandle: users.handle,
          createdAt: notes.createdAt,
          updatedAt: notes.updatedAt,
          role: noteShares.role,
        })
        .from(notes)
        .innerJoin(noteShares, and(eq(noteShares.noteId, notes.id), eq(noteShares.userId, userId)))
        .innerJoin(users, eq(users.id, notes.ownerId))
        .where(ne(notes.ownerId, userId));

      // 次要排序鍵 id desc（M3）：updatedAt 精度不足以保證唯一序，未來若加分頁
      // （keyset pagination），排序不穩定會讓同一批結果在跨頁時重複或漏掉列。
      const rows = await unionAll(ownedSelect, sharedSelect).orderBy(desc(notes.updatedAt), desc(notes.id));

      return rows.map((row): NoteDto => toNoteDto(row, row.role as Role));
    });

    // GET :ref 與 by-path 共用的「完整列＋ownerHandle」select shape（A5 同形的結構保證）。
    const noteWithOwnerSelection = {
      id: notes.id,
      title: notes.title,
      ownerId: notes.ownerId,
      slug: notes.slug,
      slugIsCustom: notes.slugIsCustom,
      prevSlug: notes.prevSlug,
      ownerHandle: users.handle,
      createdAt: notes.createdAt,
      updatedAt: notes.updatedAt,
    };

    // 授權後的完整列讀取（GET :ref 用；by-path 首查即帶整列，不經這裡）：JOIN users 帶
    // ownerHandle。I2（審查）：resolveRole 判定完到這裡的 re-select 之間存在競態視窗——
    // 若同時有另一個請求把這篇 note 刪了，這裡會查不到列。呼叫端對 undefined 明確回
    // 404，不拿 non-null assertion 賭「resolveRole 說有就一定還在」。
    async function loadNoteWithOwner(noteId: string): Promise<NoteFields | undefined> {
      const [row] = await deps.db
        .select(noteWithOwnerSelection)
        .from(notes)
        .innerJoin(users, eq(users.id, notes.ownerId))
        .where(eq(notes.id, noteId))
        .limit(1);
      return row;
    }

    /**
     * 新形網址的解析端點（#122 spec §3b）：`/n/<handle>/<slug>` 由 web 端打這裡。
     * 順序：正規化（handle ASCII 小寫、slug NFC+小寫——大小寫/NFD 變體都解得到）→
     * 單一 JOIN 精確比對（一次帶回整列；planner 由 users.handle 唯一鍵起算 nested loop
     * 後吃 `notes_owner_slug_idx`——migrate.test 有 explain 守衛）→ miss → **prev_slug
     * 補查**（單層自訂 redirect；`limit(2)` 偵測多義——同 owner 的多篇筆記可能先後釋放
     * 同一個名字，**0 或 >1 命中一律 404**，不猜）→ `resolveRole`（none → 404，防列舉：
     * 登入面分不出「不存在」與「無權限」；三處 404 body 同形，測試逐位元組釘住）。
     * RESERVED_SLUGS 不含 by-path（spec m4-3 核實：本路由是三段靜態前綴，兩段
     * `/api/notes/by-path` 不會 match 這裡、落回 `:ref`——無衝突面）。
     */
    app.get("/api/notes/by-path/:handle/:slug", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { handle: string; slug: string };
      const userId = request.user!.id;
      const handle = normalizeHandle(params.handle);
      const slugParam = normalizeSlug(params.slug);

      // 首查即帶整列（讀碼審查 m6：省掉授權後的第三趟 re-select——本支的列在授權判定
      // 前就已讀到，I2 的競態視窗不適用）。
      const [hit] = await deps.db
        .select(noteWithOwnerSelection)
        .from(notes)
        .innerJoin(users, eq(users.id, notes.ownerId))
        .where(and(eq(users.handle, handle), eq(notes.slug, slugParam)))
        .limit(1);
      let note = hit;
      if (!note) {
        const prevHits = await deps.db
          .select(noteWithOwnerSelection)
          .from(notes)
          .innerJoin(users, eq(users.id, notes.ownerId))
          .where(and(eq(users.handle, handle), eq(notes.prevSlug, slugParam)))
          .limit(2);
        if (prevHits.length !== 1) {
          return sendError(reply, 404, "not_found", "找不到此筆記");
        }
        note = prevHits[0];
      }

      const role = await resolveRole(deps.db, userId, note.id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      // 回應與 `GET /api/notes/:id` 同一個 toNoteDto——web 端拿 by-path 結果 seed
      // `["note", id]` 快取的前提（spec A5，形狀斷言在測試釘住）。
      return toNoteDto(note, role);
    });

    // 由 `GET /api/notes/:id` 改名（不並存——同一位置重複註冊 GET 會被 fastify throw
    // "Method already declared"）。`:ref` 可以是 uuid、0007 凍結的 legacy slug、或舊版
    // `<vanity>-<uuid>` 形式，解析順序見 `resolveNoteIdFromRef`（#122 起只查 legacy）。
    app.get("/api/notes/:ref", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
      const { ref } = request.params as { ref: string };
      const userId = request.user!.id;

      const noteId = await resolveNoteIdFromRef(deps.db, ref);
      if (!noteId) {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }

      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }

      const note = await loadNoteWithOwner(noteId);
      if (!note) {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      return toNoteDto(note, role);
    });

    // PATCH 回應的 ownerHandle 補讀（spec m5-8／A12）：`.returning()` 拿不到 users.handle，
    // 且 editor 改他人筆記時必須回 **owner 的** handle（不得抄 request.user）。原子性契約
    // 指的是 title/slug 的單語句寫入——回應組裝的讀取不在其列。owner 列必存在
    // （notes.owner_id 有 FK RESTRICT），落空唯一可能是型別層想不到的競態，fail-fast。
    async function ownerHandleOf(ownerId: string): Promise<string> {
      const [row] = await deps.db.select({ handle: users.handle }).from(users).where(eq(users.id, ownerId)).limit(1);
      if (!row) throw new Error(`notes.owner_id ${ownerId} 查無對應 users 列（FK 不變量被打破）`);
      return row.handle;
    }

    /**
     * PATCH 分流矩陣（#122 spec §3a——**語句形狀＝docs-as-spec 義務**，改動要連同
     * docs/api.md 一起）：`title`／`slug` 各自選配，至少帶一項（見 `updateBodySchema`）。
     * 權限矩陣不變：`slug` 有出現在 body 內（不論其值）一律要求 owner：none → 404、
     * viewer/editor → 403，**整包拒絕**；body 只有 `title` 時 viewer → 403，
     * editor/owner → 200。
     *
     * 四格（slug 自 0007 起 NOT NULL＋`(owner_id, slug)` per-user 唯一；`slug_is_custom`
     * 記形態；prev 的 CASE＝**只記自訂變更**——custom→custom 與 custom→auto 記、
     * auto→custom 與 auto 重算不記，spec M4-3）。「單一 UPDATE」皆指**寫入語句恰一條**；
     * 各格的讀取（pre-read／探測）逐格列明：
     * 1. `{slug: string}`（±title）：先計節流（`limiters.slugPatch`，10 次/10 分鐘/user，
     *    成功失敗都計——判定在格式驗證與 UPDATE 之前）→ `prepareSlugForPatch` → 無
     *    pre-read、無探測，單一 UPDATE `[title=$t,] slug=$1, slug_is_custom=true,
     *    prev_slug=CASE WHEN slug_is_custom THEN slug ELSE prev_slug END`；撞
     *    `notes_owner_slug_idx` → 409 `slug_taken`（**constraint 名分流**，其他唯一鍵
     *    違反 rethrow——比照 PR1 的 M4-2 契約）；同請求帶 title 不觸發重算。
     * 2. `{title}`：pre-read 本列 slug_is_custom（特赦，見下）；custom=false 才重算
     *    （以請求新 title 算＋探測）：單一 UPDATE `title=$1, slug=CASE WHEN
     *    slug_is_custom THEN slug ELSE $auto END`（prev 不動）。**不計 slugPatch**
     *    （title 編輯是核心操作；放大上界＝每輪重試都重探測，≤5×20＝100 次索引查詢
     *    ＋6 次 UPDATE（第 6 輪退位不探測），皆有界——title PATCH 本身無節流為現狀，
     *    明示接受）。
     * 3. `{title, slug:null}`：回 auto、以新 title 算（**無 pre-read**——title 已在請求、
     *    必走 auto）：探測＋單一 UPDATE `title=$t, slug=$auto, slug_is_custom=false,
     *    prev_slug=CASE ...`。slugPatch **計**（進 slug 分支即計；null 無格式驗——與
     *    格 1 的先計後驗一致）。
     * 4. `{slug:null}`：回 auto、以 DB 現行 title 算——pre-read 一次本列 title：探測＋
     *    單一 UPDATE，語句同格 3。slugPatch 計。
     *
     * pre-read 界線（spec m5-5）：TOCTOU 紀律禁的是**唯一性 pre-check**（「先查名字有沒
     * 有人用再寫」——裁決必須在 `(owner_id, slug)` 索引）；讀**本列**的 title/
     * slug_is_custom/owner_id 不在此列（`resolveRoleWithOwner` 本就先讀列），owner 範圍
     * 探測（`deriveUniqueAutoSlug` 的可用性特赦）亦然——探測後裁決仍在索引。
     *
     * auto 撞名（**永不 409**）：探測（述詞排除本列）選尾碼；UPDATE 撞唯一索引＝真競態
     * → 重探測重發，`MAX_AUTO_SLUG_RETRIES`（5）次後退 `untitled-<uuid8>`。title 與
     * slug 一律組進同一個 `.update(...).set({...})`（單一 SQL 陳述式本身即原子——不需要
     * 額外包 `db.transaction`）：唯一鍵衝突時整條 UPDATE 連同 title 一併回滾，不會發生
     * 「slug 衝突但 title 卻偷偷套用了」這種半套結果。
     */
    app.patch("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = updateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const { title, slug } = parsed.data;
      const hasSlug = slug !== undefined;

      const { role, ownerId } = await resolveRoleWithOwner(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (hasSlug && role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以變更網址代稱");
      }
      if (!hasSlug && role === "viewer") {
        return sendError(reply, 403, "forbidden", "沒有編輯權限");
      }

      // 「只記自訂變更」的 prev 規則（spec M4-3）——格 1 與格 3/4 共用同一片段，
      // 抽成具名 const 讓兩處永遠同步（PG 對 SET 運算式一律讀 OLD 列值，CASE 讀到的
      // 是更新前的 slug_is_custom/slug）。
      const prevSlugOnCustomChange = sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${notes.prevSlug} end`;

      // 格 1：顯式自訂 slug。
      if (hasSlug && slug !== null) {
        if (!deps.limiters.slugPatch.consume(userId)) {
          return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
        }
        const result = prepareSlugForPatch(slug);
        if (!result.ok) {
          return sendError(reply, 400, "invalid_body", result.message);
        }
        // I2（審查）：resolveRole 判定完到 UPDATE 之間可能被另一個請求刪除，
        // `.returning()` 落空＝UPDATE 命中 0 列——明確回 404，不拿 non-null assertion 賭。
        let updated;
        try {
          [updated] = await deps.db
            .update(notes)
            .set({
              updatedAt: new Date(),
              ...(title !== undefined ? { title } : {}),
              slug: result.value,
              slugIsCustom: true,
              prevSlug: prevSlugOnCustomChange,
            })
            .where(eq(notes.id, id))
            .returning();
        } catch (err) {
          // constraint 名分流（PR1 M4-2 契約）：只有 per-user 唯一索引撞名映射 slug_taken，
          // 其他唯一鍵違反（未來新增）一律 rethrow——不認識的 23505 不該被猜成 409。
          if (uniqueViolationConstraint(err) === "notes_owner_slug_idx") {
            return sendError(reply, 409, "slug_taken", "此網址代稱已被使用");
          }
          throw err;
        }
        if (!updated) {
          return sendError(reply, 404, "not_found", "找不到此筆記");
        }
        return toNoteDto({ ...updated, ownerHandle: await ownerHandleOf(updated.ownerId) }, role);
      }

      // 格 2–4：auto 路徑。clearingSlug＝格 3/4（body 帶 slug:null）；否則格 2（title-only）。
      const clearingSlug = hasSlug;
      if (clearingSlug && !deps.limiters.slugPatch.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }

      // pre-read（特赦界線見上）只在需要時發：格 2 要 slug_is_custom（決定探不探測）、
      // 格 4 要現行 title；格 3 兩者都在請求裡（必走 auto）——不多發一次查詢。
      let preReadSlugIsCustom = false;
      let effectiveTitle = title ?? "";
      if (!clearingSlug || title === undefined) {
        const [row] = await deps.db
          .select({ title: notes.title, slugIsCustom: notes.slugIsCustom })
          .from(notes)
          .where(eq(notes.id, id))
          .limit(1);
        if (!row) {
          return sendError(reply, 404, "not_found", "找不到此筆記");
        }
        preReadSlugIsCustom = row.slugIsCustom;
        effectiveTitle = title ?? row.title;
      }
      // role !== 'none' ⇒ resolveRoleWithOwner 的 ownerId 必非 null（見該函式契約）。
      const noteOwnerId = ownerId!;
      const needsAuto = clearingSlug || !preReadSlugIsCustom;

      let updated;
      for (let attempt = 1; ; attempt++) {
        // 候選來源三分支：重試耗盡 → uuid8 退位；要走 auto（或重試中）→ 探測；
        // 格 2 的 custom=true → CASE 會保留現行 slug、$auto 只是佔位，傳未探測候選即可
        // ——若 pre-read 後被併發翻回 auto（罕見競態），只有恰好撞索引才落到重試路徑
        // 重新探測；沒撞就直接寫入未探測候選（仍唯一，可接受）。
        let auto: string;
        if (attempt > MAX_AUTO_SLUG_RETRIES) {
          auto = fallbackAutoSlug();
        } else if (needsAuto || attempt > 1) {
          auto = await deriveUniqueAutoSlug(deps.db, noteOwnerId, id, effectiveTitle);
        } else {
          auto = autoSlugFromTitle(effectiveTitle);
        }
        await deps.slugUpdateTestHook?.(auto);
        try {
          if (clearingSlug) {
            [updated] = await deps.db
              .update(notes)
              .set({
                updatedAt: new Date(),
                ...(title !== undefined ? { title } : {}),
                slug: auto,
                slugIsCustom: false,
                prevSlug: prevSlugOnCustomChange,
              })
              .where(eq(notes.id, id))
              .returning();
          } else {
            [updated] = await deps.db
              .update(notes)
              .set({
                updatedAt: new Date(),
                title,
                slug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${auto} end`,
              })
              .where(eq(notes.id, id))
              .returning();
          }
          break;
        } catch (err) {
          // 同格 1 的 constraint 名分流：只有 per-user 索引撞名走重試，其他 23505 rethrow。
          if (uniqueViolationConstraint(err) === "notes_owner_slug_idx" && attempt <= MAX_AUTO_SLUG_RETRIES) {
            continue;
          }
          throw err;
        }
      }
      if (!updated) {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      return toNoteDto({ ...updated, ownerHandle: await ownerHandleOf(updated.ownerId) }, role);
    });

    /**
     * wikilink 索引器提交同步點（spec §12.3 逐字，Task 5）：body `link_target_ids` 是該筆記
     * 目前內容解析出的**完整**目標集合（client 每次送全量，不是增量 diff）——交易內整組
     * 取代 `note_links`。
     *
     * 權限矩陣同 PATCH 的 title-only 分支（不含 slug 那條需要 owner 的線）：none → 404
     * `not_found`、viewer → 403 `forbidden`、editor/owner → 受理。
     *
     * 驗證/正規化順序：zod 陣列格式（`.max(MAX_LINK_TARGETS * 2)` 粗閘）→ 權限矩陣 →
     * `normalizeLinkTargets`（去重、濾 self-link，正規化後 > `MAX_LINK_TARGETS` → 400
     * `invalid_body`）→ `linkSyncGate`。
     *
     * `linkSyncGate`（Task 4 接縫，委派 Hocuspocus 記憶體中的文件狀態）：`ok:false` 代表
     * 這篇筆記目前不在記憶體裡、或提交者本身沒有該筆記的開啟中連線——一律 409 `not_loaded`，
     * 不落地任何寫入（沒有 `note_states` 回退路徑，收斂交由 client 重試，見 Task 7）。
     * `ok:true` 附帶的 `clock` 是本次寫入要 CAS 進 `notes.links_clock` 的候選值（LWW，見
     * `notes/links.ts` 的 `attemptOnce` 說明）。
     *
     * `writeNoteLinks` 內部已處理 FK race 重試（一次）與 40001/40P01 → `"busy"`；這裡只需
     * 把 `"busy"` 映射成 409 `server_busy`，其餘未預期錯誤 log 後回 500（不吞給呼叫端猜）。
     */
    app.post("/api/notes/:id/links", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = linksBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role === "viewer") {
        return sendError(reply, 403, "forbidden", "沒有編輯權限");
      }

      const normalized = normalizeLinkTargets(id, parsed.data.link_target_ids);
      if (!normalized.ok) {
        return sendError(reply, 400, "invalid_body", "連結目標數量超過上限");
      }

      const gate = deps.collabHooks.linkSyncGate(id, userId);
      if (!gate.ok) {
        return sendError(reply, 409, "not_loaded", "筆記尚未就緒，請稍後再試");
      }

      try {
        const outcome = await writeNoteLinks(
          deps.db,
          { sourceNoteId: id, userId, targetIds: normalized.targets, clock: gate.clock },
          deps.linkSyncTestHooks
        );
        if (outcome === "busy") {
          return sendError(reply, 409, "server_busy", "伺服器忙碌，請稍後再試");
        }
      } catch (err) {
        request.log.error(err);
        return sendError(reply, 500, "internal", "伺服器內部錯誤");
      }

      return reply.code(204).send();
    });

    /**
     * 反向連結清單（spec §12.3）：查詢連到 `:id` 的來源筆記，供 backlinks 面板渲染。
     *
     * 這裡的 `resolveRole` 判斷的是「呼叫者對被查詢的筆記本身」有沒有讀取權（none →
     * 404 `not_found`，與其他 notes 路由的防列舉慣例一致；非 uuid `:id` 經
     * `resolveRole` 內部的 `UUID_RE` guard 天然落在同一個 404 分支，不需要另外判斷）。
     * **不代表呼叫者對每篇來源筆記都有權**——來源筆記各自的可見範圍另外在
     * `fetchBacklinks` 內用 owned ∪ shared 的授權述詞 inline 過濾（單一 SQL，見該函式
     * 註解），避免把無權筆記的存在與標題洩漏給呼叫者（spec §12.3 逐字：「反向連結讀取
     * 端同樣過濾」）。
     */
    app.get("/api/notes/:id/backlinks", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }

      const backlinks: BacklinkDto[] = await fetchBacklinks(deps.db, id, userId);
      return { backlinks };
    });

    app.delete("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以刪除");
      }

      // Plan 2 接縫：關閉/flush 該文件所有進行中的即時協作連線，必須在刪除交易「之前」
      // 完成並 await——若交易先跑，Hocuspocus 端可能在文件已經被刪除之後才嘗試 flush，
      // 落地到一筆孤兒 note_states/note_state_backups（或對已刪除 noteId 的外鍵失敗）。
      // Plan 1 這裡注入的是 noopCollabHooks，本身不做任何事；此呼叫只是先把接縫留好。
      const deleteGate = await deps.collabHooks.beforeNoteDeleted(id);

      // `.returning({ id })`（Task 11）：交易內只確定「哪些 upload 列被刪了」，實際的
      // 磁碟檔案刪除留到 commit 之後才動手——DB rollback 救不回已經被刪掉的檔案，兩件
      // 事不可合併在同一個交易語意下（見 `deleteUploadFiles` 的完整說明）。
      // 交易失敗一定要把閘門收回去（見 `NoteDeleteGate`）：閘門開著的兩分鐘內，這篇筆記的
      // 新連線會被告知「已刪除」並被導離，而它其實還在。
      const deletedUploads = await deps.db
        .transaction(async tx => {
          await tx.delete(noteStates).where(eq(noteStates.noteId, id));
          await tx.delete(noteStateBackups).where(eq(noteStateBackups.noteId, id));
          await tx.delete(noteShares).where(eq(noteShares.noteId, id));
          await tx.delete(noteLinks).where(or(eq(noteLinks.sourceNoteId, id), eq(noteLinks.targetNoteId, id)));
          const deleted = await tx.delete(uploads).where(eq(uploads.noteId, id)).returning({ id: uploads.id });
          await tx.delete(notes).where(eq(notes.id, id));
          return deleted;
        })
        .catch((err: unknown) => {
          deleteGate.release();
          throw err;
        });

      // best-effort，commit 之後才動磁碟：單一檔案刪除失敗（含檔案本來就已經不存在）
      // 只記 log，不影響這支 request 的成功回應——DB 端已經確定 commit 成功，這才是
      // 呼叫端真正在意的結果（見 `deleteUploadFiles` 的完整說明）。
      await deleteUploadFiles(
        deps.uploadsDir,
        deletedUploads.map(u => u.id),
        request.log
      );

      return reply.code(204).send();
    });

    /**
     * 簽發共編（Hocuspocus）連線用的短效 token（spec §5 關鍵契約，逐字）。
     *
     * 與其他 notes 路由的「none → 404」慣例**刻意不同**：有 session 但對此 note 無權限
     * （`resolveRole` 回 'none'）一律回 **200 + `role:'none'` 的 token**，絕不 403/404。
     * 理由：此 endpoint 只是「幫你把目前的權限狀態簽成一份可攜的憑證」，本身不代表
     * 「你正在存取這篇筆記的內容」；真正的存取控制在 Hocuspocus `onAuthenticate`
     * （Task 5）憑 token 內的 role 執行——'none' token 會在那裡被拒連，而不是在這裡
     * 提前用 HTTP 錯誤碼洩漏「有沒有權限」這件事的存在與否（此 endpoint 本身不因權限
     * 高低而有不同的可觀察行為，防止被拿來當作權限探測 oracle）。
     *
     * body 的 `role` 與 JWT 內的 role 重複：client 不解 JWT（也不該解——那是 server 與
     * Hocuspocus 之間的憑證），N4 降級通知要顯示的角色資訊改讀這個頂層欄位。
     *
     * per-user 節流（`limiters.collabToken`，預設 60 次/分鐘）：超限回標準 429
     * `too_many_requests`——不像 `sendLoginThrottled` 額外帶 `retryAfterMs`（spec 沒有
     * 要求 client 據此排程重試，維持標準錯誤 body 形狀即可）。
     *
     * ⚠ **key 是 userId、不分筆記，這是刻意的**（issue #24 定案）。這道節流要擋的是
     * 「一個已登入的使用者把這支 endpoint 當迴圈打」所造成的 DB／CPU 負載（每一發都是
     * 一次 `resolveRole` 查詢加一次 JWT 簽章），而消耗者就是那個使用者——額度自然該記
     * 在他頭上。兩個看似更「精準」的 key 都更差：
     *
     * - **加上 noteId**（每篇筆記一份額度）會把攻擊者的可用額度乘上筆記數，正好把防線
     *   放到最寬——洗 token 本來就可以輪著筆記洗。
     * - **改用／加上 IP** 會讓共用出口 IP 的辦公室網路互相拖累，而此處既然已經有 session，
     *   userId 比 IP 更接近真正的主體。
     *
     * 額度對正常使用者夠嗎（issue 提的另一半）：一篇筆記只在「建線／重連／server 主動
     * 要求重驗」時各打一發，不是輪詢；而重驗是 **per-(note, user)** 而非整份文件廣播（N1），
     * 所以別人的撤權不會放大到這個使用者頭上。同時開幾十篇筆記仍遠低於 60 次/分鐘。
     *
     * 超限的可觀察後果（語意的另一半）：client 對 429 會退避重試（shared 的
     * `COLLAB_TOKEN_RETRY_DELAYS_MS`，首發＋4 次共 5 發），而 `FixedWindowLimiter` 是「必計數」（超限
     * 的那一發也算）。重試全部用完仍拿不到 token 時，client 不會把使用者踢出（N7），而是
     * 以 `TOKEN_RESTART_DELAYS_MS`（5／15／60 秒，帶抖動）重啟整條連線（issue #39）。
     *
     * 因此「卡住的分頁」穩態大約是 **每分鐘 5 發左右**（一輪重啟＝一次完整的退避表）。
     * 60 次/分鐘的額度是 **per-user、跨分頁跨筆記共用一個桶**，所以同一使用者同時卡住
     * 十幾個分頁時，這個額度是會被同一個人自己吃掉的——重啟間隔的上限與抖動就是為了
     * 壓住這件事（見 `useCollab.ts` 的 `TOKEN_RESTART_DELAYS_MS`）。
     *
     * 它**不**負責擋「攻擊者換帳號就換一份額度」：這個專案的帳號不是自助註冊的（admin
     * 代建或 OIDC 自動佈建），「能不能拿到一個帳號」那道門檔在帳號佈建那一層，不在
     * 這裡。
     */
    app.post("/api/notes/:id/collab-token", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      if (!deps.limiters.collabToken.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }

      const role = await resolveRole(deps.db, userId, id);
      const token = await signCollabToken(deps.config.appSecret, {
        noteId: id,
        userId,
        role,
        tv: request.sessionTv!,
      });

      return { token, role };
    });

    // 以下三支分享管理路由全部 authenticate + owner-only：none → 404 not_found（不
    // 洩漏「note 是否存在」給無權限者，與其他 notes 路由的防列舉原則一致）；查得到但
    // 角色不是 owner（editor/viewer）→ 403 forbidden。
    app.get("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以查看分享名單");
      }

      // orderBy(users.email)：回應順序確定性，比照 GET /api/notes 清單的次要排序鍵慣例
      // （沒有穩定排序，測試斷言與前端渲染順序都會受 DB 實際回傳順序影響而不可靠）。
      const rows = await deps.db
        .select({ userId: noteShares.userId, email: users.email, displayName: users.displayName, role: noteShares.role })
        .from(noteShares)
        .innerJoin(users, eq(users.id, noteShares.userId))
        .where(eq(noteShares.noteId, id))
        .orderBy(users.email);

      return rows.map((row): ShareDto => ({ userId: row.userId, email: row.email, displayName: row.displayName, role: row.role as ShareDto["role"] }));
    });

    app.put("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const parsed = putShareBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以管理分享");
      }

      // lower() 讀取端比對（spec §14.3 三處對稱）＋多列命中防護（同 routes/auth.ts login
      // 理由：正常情況下 email 有 unique 約束不會有多列，這裡是防禦縱深）。
      const [target] = await deps.db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${normalizeEmail(parsed.data.email)}`)
        .orderBy(users.createdAt, users.id)
        .limit(1);
      if (!target) {
        return sendError(reply, 404, "user_not_found", "找不到此使用者");
      }
      if (target.id === userId) {
        return sendError(reply, 400, "cannot_share_with_self", "不能分享給自己");
      }

      try {
        await deps.db
          .insert(noteShares)
          .values({ noteId: id, userId: target.id, role: parsed.data.role })
          .onConflictDoUpdate({ target: [noteShares.noteId, noteShares.userId], set: { role: parsed.data.role } });
      } catch (err) {
        // I2（審查）：resolveRole／email 查找完成到這個 insert 之間存在競態視窗——note
        // 可能被 owner 自己在另一個分頁同時 DELETE 掉（note_shares.note_id 的 FK），或
        // target user 剛好被管理員刪除／停用流程清掉（note_shares.user_id 的 FK，若
        // 未來 users 刪除不再只是 soft delete）——兩種都會讓這個 insert 撞上
        // foreign_key_violation，而不是「權限判斷落後於實際狀態」以外的真正伺服器錯誤。
        // 用 `note!`/`target!` 賭「resolveRole／email 查找說有就一定還在」在併發下不
        // 成立（同 GET/PATCH/DELETE /api/notes/:id 已有的 I2 慣例），這裡改成明確
        // catch 住 FK violation 並映射成 404 not_found——不特別區分是 note 還是 user
        // 消失，避免對 owner 洩漏「到底是哪一邊被刪除」的細節。
        if (isForeignKeyViolation(err)) {
          return sendError(reply, 404, "not_found", "找不到此筆記");
        }
        throw err;
      }

      // binding 規格：role 從 editor 降為 viewer（撤權）或任何變更都要呼叫
      // onShareChanged 逼迫 Plan 2 重驗該使用者在此文件上的連線權限。這裡不特地去查
      // upsert 前的舊 role 來判斷「這次到底算不算降級」——統一呼叫：對「其實是升級」或
      // 「角色沒變」的情況，重驗只是多一次無害的握手（Plan 1 這裡注入的
      // noopCollabHooks 甚至完全不做事）；反之若漏判某個實際上是降級的情況（例如未來
      // 改壞這段判斷邏輯），代價是「已撤權的使用者還能繼續編輯進行中的連線」，遠比多餘
      // 呼叫一次更危險。統一呼叫用簡單性換取這裡不會漏判。
      deps.collabHooks.onShareChanged(id, target.id);

      const dto: ShareDto = { userId: target.id, email: target.email, displayName: target.displayName, role: parsed.data.role };
      return dto;
    });

    app.delete("/api/notes/:id/shares/:userId", { preHandler: app.authenticate }, async (request, reply) => {
      const { id, userId: targetUserId } = request.params as { id: string; userId: string };
      const userId = request.user!.id;

      const role = await resolveRole(deps.db, userId, id);
      if (role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (role !== "owner") {
        return sendError(reply, 403, "forbidden", "只有擁有者可以管理分享");
      }

      // 與 resolveRole 內部對 noteId 的處理同理：`:userId` 路徑參數格式不可信任，先用
      // UUID_RE 擋掉非法格式（否則 DELETE 的 WHERE 條件會讓 pg 直接 throw "invalid
      // input syntax for type uuid"，被全域錯誤 handler 歸類成 500）。效果上等同「這個
      // userId 沒有對應的分享列」，回同一個 404 share_not_found，不特別區分。
      if (!UUID_RE.test(targetUserId)) {
        return sendError(reply, 404, "share_not_found", "找不到此分享");
      }

      const [deleted] = await deps.db
        .delete(noteShares)
        .where(and(eq(noteShares.noteId, id), eq(noteShares.userId, targetUserId)))
        .returning();
      if (!deleted) {
        return sendError(reply, 404, "share_not_found", "找不到此分享");
      }

      deps.collabHooks.onShareChanged(id, targetUserId);

      return reply.code(204).send();
    });

    /**
     * #72 公開分享連結管理端（token 三支）＋ #122 PR3 公開別名兩支（PUT/DELETE
     * /public-link/slug，見下）——合計五支，全部 owner-only 且共用
     * `resolvePublicLinkAccess`，錯誤慣例照 shares：resolveRole 為 none → 404
     * （不可分辨存在性）、可讀但非 owner → 403。
     * PUT 語意＝**每次都重生**（client 慣例：開面板先 GET、null 才 PUT，
     * 避免誤重生）；token 存原文的理由與代價見 db/schema.ts 的欄位註解。
     * GET/PUT 回應形＝`{token, slug}` 全形（web 的 mutation onSuccess 直寫回應進
     * 快取——缺任一鍵＝快取該鍵被抹成 undefined，公開連結列或別名列會憑空消失）。
     *
     * 節流是**兩顆桶、相反紀律**的並存（刻意，勿統一）：
     * - token 的 PUT/DELETE＝`publicLink` 桶，**consume 早於授權判定**——與
     *   collab-token 同形：key=userId 讓陌生人猜 noteId 的洪水只吃**他自己**的桶
     *   （不可跨人 DoS），並擋在 resolveRole 的 DB 查詢之前；代價是 403/404 的
     *   請求同樣計數。
     * - 別名的 PUT/DELETE＝**併 `slugPatch` 桶**（別名就是另一種 slug 寫入，與
     *   PATCH notes 的 slug 分支共享 10 次/10 分鐘額度），**先授權後扣**：
     *   resolveRole → consume → body/格式驗證（PATCH 另有 zod 前置解析會先擋畸形
     *   body；別名這側無 zod schema、刻意把畸形 body 也計入桶）——非 owner 的
     *   403/404 不耗桶。兩支與 public-link 同樣**不動 `updated_at`**（分享狀態非
     *   內容變更，動了會讓純分享動作把筆記推到清單頂端）。
     * PUT 的重生語意**非冪等**（RFC 9110 下 PUT 允許自動重試）——目前靠 client
     * 慣例（先 GET、null 才 PUT）承擔，若未來出現自動重試的中介層要改成
     * create-if-absent＋獨立 rotate。
     */
    const resolvePublicLinkAccess = async (reply: FastifyReply, userId: string, noteId: string): Promise<boolean> => {
      const role = await resolveRole(deps.db, userId, noteId);
      if (role === "none") {
        sendError(reply, 404, "not_found", "找不到此筆記");
        return false;
      }
      if (role !== "owner") {
        sendError(reply, 403, "forbidden", "只有擁有者可以管理公開連結");
        return false;
      }
      return true;
    };

    app.get("/api/notes/:id/public-link", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!(await resolvePublicLinkAccess(reply, request.user!.id, id))) return reply;
      // I2 慣例（比照 PATCH）：resolveRole 判定完到這裡之間筆記可能被刪——落空回
      // 404，不拿「resolveRole 說有」賭它還在。
      const [row] = await deps.db.select({ publicToken: notes.publicToken, publicSlug: notes.publicSlug }).from(notes).where(eq(notes.id, id)).limit(1);
      if (!row) return sendError(reply, 404, "not_found", "找不到此筆記");
      return { token: row.publicToken, slug: row.publicSlug };
    });

    app.put("/api/notes/:id/public-link", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!deps.limiters.publicLink.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      const token = randomBytes(32).toString("base64url");
      // I2 慣例：UPDATE 落空＝筆記在判定後被刪，回 404——否則回 200＋一顆從未落地
      // 的 token（owner 複製到必死連結）。重生**不動別名**（spec §4 並存語意）——
      // returning 帶回現行 publicSlug 湊全形回應。
      const updated = await deps.db.update(notes).set({ publicToken: token }).where(eq(notes.id, id)).returning({ id: notes.id, publicSlug: notes.publicSlug });
      if (updated.length === 0) return sendError(reply, 404, "not_found", "找不到此筆記");
      return { token, slug: updated[0].publicSlug };
    });

    app.delete("/api/notes/:id/public-link", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!deps.limiters.publicLink.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      // I2 慣例：同 PUT——**note 本身**落空才回 404；token 已是 null 不算落空，
      // 照回 204（對 token 狀態冪等，重複 DELETE 一律 204）。
      // #122 PR3：**同一支 UPDATE 連帶清空 public_slug**（spec §4「DELETE 清兩者」）
      // ——撤公開後別名不得殘留（殘留列會占唯一索引、且在重生 token 後悄悄復活）。
      const cleared = await deps.db.update(notes).set({ publicToken: null, publicSlug: null }).where(eq(notes.id, id)).returning({ id: notes.id });
      if (cleared.length === 0) return sendError(reply, 404, "not_found", "找不到此筆記");
      return reply.code(204).send();
    });

    /**
     * #122 PR3：公開別名 CRUD（`/p/<handle>/<slug>` 的 slug 半邊）。桶紀律與回應
     * 形見上方五支總註解。設別名的前置條件「筆記已公開」**不做 pre-read**：判定
     * 完全交給條件式 UPDATE 的 `public_token IS NOT NULL` 述詞＋rowcount——把
     * 「A 設別名 / B 撤公開」的 TOCTOU 窗整個關掉（pre-read 版在讀與寫之間會產出
     * token NULL＋別名非 NULL 的殘留列）。rowcount 0 一律 400 invalid_body：涵蓋
     * 「未公開」與「resolveRole 後筆記被刪」兩形——後者與 I2 慣例的 404 刻意偏離
     * 一格（競態窗極窄，400 也不洩露更多資訊，不值得為它多一次讀）。
     */
    app.put("/api/notes/:id/public-link/slug", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      if (!deps.limiters.slugPatch.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }
      const body = request.body as { slug?: unknown } | null;
      if (!body || typeof body.slug !== "string") {
        return sendError(reply, 400, "invalid_body", "slug 必須是字串");
      }
      const result = prepareSlugForPatch(body.slug);
      if (!result.ok) {
        return sendError(reply, 400, "invalid_body", result.message);
      }
      let updated;
      try {
        updated = await deps.db
          .update(notes)
          .set({ publicSlug: result.value })
          .where(and(eq(notes.id, id), sql`${notes.publicToken} is not null`))
          .returning({ publicToken: notes.publicToken, publicSlug: notes.publicSlug });
      } catch (err) {
        // constraint 名分流（比照 slug_taken）：只認 per-user 別名唯一索引，其他 23505 rethrow。
        if (uniqueViolationConstraint(err) === "notes_owner_public_slug_idx") {
          return sendError(reply, 409, "public_slug_taken", "此公開網址已被你的另一篇筆記使用");
        }
        throw err;
      }
      if (updated.length === 0) {
        return sendError(reply, 400, "invalid_body", "筆記尚未開啟公開分享，無法設定公開網址");
      }
      return { token: updated[0].publicToken, slug: updated[0].publicSlug };
    });

    app.delete("/api/notes/:id/public-link/slug", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      if (!(await resolvePublicLinkAccess(reply, userId, id))) return reply;
      if (!deps.limiters.slugPatch.consume(userId)) {
        return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      }
      // 冪等 DELETE：本無別名也 204；rowcount 0（resolveRole 後筆記被刪）**同收 204**
      // ——DELETE 語意本就 vacuous。⚠ 兩支的 rowcount-0 政策不同（此支 204、姊妹
      // DELETE /public-link 是 I2 的 404）＝各自承接既有慣例；此差異只在 resolveRole
      // 之後的極窄競態窗成立、測試不可觀測，純文件義務。
      await deps.db.update(notes).set({ publicSlug: null }).where(eq(notes.id, id));
      return reply.code(204).send();
    });
  };
}
