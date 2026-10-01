import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import {
  MAX_LINK_TARGETS,
  autoSlugFromTitle,
  normalizeEmail,
  normalizeHandle,
  normalizeSlug,
  type BacklinkDto,
  type NoteContentDto,
  type NoteDto,
  type NoteEditDto,
  type NoteEditResultDto,
  type NoteSectionDto,
  type ShareDto,
} from "@knotebook/shared";
import { WRITE_BODY_LIMIT } from "../http/body-limits.js";
import { sendError } from "../http/errors.js";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups, noteShares, notes, uploads, users } from "../db/schema.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { TxAbort } from "../http/tx-abort.js";
import type { CollabHooks } from "../collab/hooks.js";
import type { CollabServer } from "../collab/server.js";
import type { EditingRuntime } from "../notes/editing/runtime.js";
import { loadLastEdited, loadNoteDoc, readNoteContent } from "../notes/editing/read.js";
import { cloneForCopy } from "../notes/copy-doc.js";
import { docClock } from "../collab/store.js";
import { listEdits } from "../notes/editing/revert.js";
import { presenceIdentity, presenceTargetForRead, type PresenceRegistry } from "../notes/editing/presence.js";
import { accessFromListRow, editor, lastEditedSelection, visibleNoteBranches } from "../notes/list-query.js";
// ⚠ `FP` 在本檔已無呼叫端（`editBodySchema` 是它唯一的使用者，搬去 `notes/schemas.ts` 了）——
// `no-unused-vars` 是 error ＋ `--max-warnings=0`，留著會 lint 紅。
import { editBodySchema, MD, SEC, TITLE } from "../notes/schemas.js";
import { type NoteWriteService } from "../notes/editing/write-service.js";
import { insertNoteWithAutoSlug, type NoteCreateHooks } from "../notes/create.js";
import { currentAgentLabel } from "../auth/agent-label.js";
import {
  groupNotePermissions,
  OWNER_PERMISSIONS,
  resolveNoteAccess,
  resolveRole,
  roleFromGroupFlags,
  UUID_RE,
  type NoteAccess,
} from "../notes/service.js";
import { upsertShareInTx } from "../notes/tx/shares.js";
import { deleteNotesInTx } from "../notes/tx/delete-notes.js";
import { moveNoteToGroupInTx } from "../notes/tx/move.js";
import { copyNoteInTx } from "../notes/tx/copy.js";
import { patchSlugInTx, type SlugPatchTestHook, type SlugWriteScope } from "../notes/tx/patch-slug.js";
import { UPDATED_AT_NOW } from "../notes/clock.js";
import { groupNotePath, lookupRedirect, userNotePath } from "../notes/redirects.js";
import {
  deriveUniqueAutoSlug,
  fallbackAutoSlug,
  isSlugUniqueViolation,
  MAX_AUTO_SLUG_RETRIES,
  prepareSlugForPatch,
  resolveNoteIdFromRef,
  type SlugScope,
} from "../notes/slug.js";
import { fetchBacklinks, normalizeLinkTargets, syncLinksFromDoc, writeNoteLinks, type WriteNoteLinksHooks } from "../notes/links.js";
import { signCollabToken } from "../collab/token.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { isForeignKeyViolation, uniqueViolationConstraint } from "../db/pg-errors.js";
import { deleteUploadFiles } from "../uploads/service.js";

// ⚠ `createBodySchema` 原本宣告在這裡，#106 起它要吃 `noNul` 與 `MD`，而那兩個常數當時也
// 宣告在本檔（更下面）——維持原位會讓它在 TDZ 內求值，**一 import 就 ReferenceError**。
// #108 把那些常數搬到 `notes/schemas.ts` 之後這條限制已經消失（import binding 會被 hoist），
// `createBodySchema` 不必再避開誰；宣告位置維持原樣純粹是為了不動 diff。

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
// #175 §6.3 移動的 body：`groupId` 只驗是字串（非 UUID 由路由回 404 `group_not_found`，與「群組不存在」逐位元組相同——plan 規格落差 5）。
const moveBodySchema = z.object({ groupId: z.string() }).strict();
// #175 §6.5 複製的 body：省略 `groupId`＝複製到個人；非 UUID 同移動，由路由回 404 `group_not_found`。
const copyBodySchema = z.object({ groupId: z.string().optional() }).strict();

// POST /api/notes/:id/links body（spec §12.3）：`.max(MAX_LINK_TARGETS * 2)` 是提交前的
// 效能粗閘（避免病態大陣列在正規化之前就先跑完整 uuid 格式驗證），**不是**語意上限本身
// ——真正的 `MAX_LINK_TARGETS` 上限判定在 `normalizeLinkTargets`（去重、濾除 self-link
// 之後）才算數，兩處數字不必相等/不可互相取代。
const linksBodySchema = z.object({ link_target_ids: z.array(z.string().uuid()).max(MAX_LINK_TARGETS * 2) });

// #106 不變量 S：`section` 進任何比較之前先在 schema 層擋 NUL 並要求格式；語意見 `notes/schemas.ts` 的 `SEC`。
// `.strict()`：帶未知查詢參數即 400，不靜默忽略。
const contentQuerySchema = z.object({ section: SEC.optional() }).strict();

// 建立時 title 允許省略（DB 端有 default "Untitled"），但若有帶就不可為空字串——
// 與 PATCH 的 title 驗證同一套規則，避免「傳空字串把標題清空」這種語意混淆的落地方式。
// ⚠ 行為變更（對既有呼叫端）：#106 把這個 schema 從 z.object 的預設 strip 改成 `.strict()`，
// 所以「多帶未知欄位」從**靜默忽略**變成 400 invalid_body。刻意的：`content` 一旦上線，
// 打錯成 `contents`／`body` 的請求靜默建出一篇空筆記，比直接回 400 難除錯得多；也與兩條
// 新路由（不變量 S 要求 `.strict()`）一致。已寫進 docs/api.md 與 CHANGELOG 的 Changed。
// ⚠ `title` 也補上 `.refine(noNul)`：這是**既有的洞**，不是新開的——今天 `title` 只有 `.min(1)`，
// 含 U+0000 的標題會一路寫進 pg 的 text 欄位，pg 直接拒收（`22021`），錯誤逃到全域
// errorHandler → 500。既然正在改這一行就順手拉進不變量 S（行為只從 500 變成正常的 400）。
// `PATCH /api/notes/:id` 的 `updateBodySchema.title` 有同一個洞，**本棒刻意不改**（不在觸及面上）。
// `.refine` 排在 `.min(1)` 之後（ZodEffects 上沒有 `.min`）。
// #103 §6.4：`groupId` 建在群組裡；#175 Q13：與 `content` 可以並存（帶內容建在群組裡）。
const createBodySchema = z
  .object({ title: TITLE.optional(), content: MD.optional(), groupId: z.string().uuid().optional() })
  .strict();

// `POST /api/notes/:id/edits` 的 body 搬到 `notes/schemas.ts`（#108 D-N）：MCP 的 `edit_note`
// 吃的是**同一份**——per-op 必填矩陣只能有一份實作。

// `MAX_AUTO_SLUG_RETRIES` 已搬進 `notes/slug.ts` 並 export（#145）——建立路徑的 INSERT
// 重試迴圈（`notes/create.ts`）與本檔 PATCH 的 UPDATE 重試迴圈必須共用同一份 5。

// `updated_at` 的唯一時鐘來源搬到 `notes/clock.ts`（#175：T1 的 `*InTx` 也要用，而 tx/ 檔不能 import 路由檔）。

// `isForeignKeyViolation` 收在 `db/pg-errors.ts` 的共用版（原本這裡有一份邏輯等價的私有
// 重複實作，Task 5 收掉——`notes/links.ts` 的 `writeNoteLinks` 也需要同一個判定，兩處各自
// 維護一份會有漂移風險）。

export interface NotesRouteDeps {
  db: Db;
  collabHooks: CollabHooks;
  config: AppConfig;
  /**
   * #106：`GET /api/notes/:id/content` 的兩個依賴。**兩者皆選配、且缺一條路由就不註冊**
   * （見 `register` 內的閘門）——`buildTestApp` 那種無 collab 的 app 連這條路由都沒有。
   */
  collab?: CollabServer;
  editing?: EditingRuntime;
  /** `collabToken` 供 collab-token endpoint；`slugPatch` 供 PATCH 帶 slug 鍵（含 null——進 slug 分支即計，見四格註解）**與公開別名兩支（#122 PR3）**節流；`publicLink` 供 public-link 的 PUT/DELETE（#72，見各路由）；`contentRead` 供 #106 的內容端點；`edit` 供 #106 的寫入端（`POST /:id/edits`、`POST /api/notes` 帶 `content`）與 #175 的複製；`upload` 供複製依附件數扣（#175 T4 M-1，與 `POST /api/notes/:id/uploads` 同一個桶）。 */
  limiters: { collabToken: FixedWindowLimiter; slugPatch: FixedWindowLimiter; publicLink: FixedWindowLimiter; contentRead: FixedWindowLimiter; edit: FixedWindowLimiter; upload: FixedWindowLimiter };
  /**
   * #108 §10.1（D22／M5）：三條寫入路徑的外圍順序與**唯一**的 `NoteWriteQueue`。
   * 由 `buildApp` 建一次，`mcpRoutes` 拿到的是同一個物件——MCP 寫入與 REST 寫入因此串行。
   * `editingTestHooks`／`editingQueueWaitMs` 兩個透傳欄位隨佇列一起搬進 service，本介面不再有。
   */
  writes: NoteWriteService;
  /**
   * #138：AI presence 註冊表，透傳自 `AppDeps.presence`。**選配**（呼叫端一律 `?.`），
   * 沒有 collab 的部署拿到的是全 no-op 空殼。
   */
  presence?: PresenceRegistry;
  /** Task 5：`POST /api/notes/:id/links` 寫入函式的測試注入縫，透傳自 `AppDeps.linkSyncTestHooks`。 */
  linkSyncTestHooks?: WriteNoteLinksHooks;
  /**
   * #122 PR2：PATCH 的 auto slug 路徑測試注入縫——每輪探測完、UPDATE 發出前呼叫（帶本輪
   * 候選）；測試在這裡搶插同 owner 同 slug 的佔位列，讓 UPDATE 真的撞 `(owner_id, slug)`
   * 唯一索引，藉以驅動「重試 ≤`MAX_AUTO_SLUG_RETRIES` 後退 untitled-<uuid8>」的競態路徑
   * （比照 `linkSyncTestHooks` 慣例）。生產不注入＝零成本。透傳自 `AppDeps.slugUpdateTestHook`。
   */
  slugUpdateTestHook?: (candidate: string) => void | Promise<void>;
  /** #175 T1 的測試縫（`notes/tx/patch-slug.ts`）：`authorized` 在路由授權之後、交易之前；`slug-written` 在交易內。透傳自 `AppDeps.slugPatchTestHook`。 */
  slugPatchTestHook?: SlugPatchTestHook;
  /**
   * #145：**建立**路徑的 auto slug 測試注入縫——每輪探測完、INSERT 發出前呼叫（帶本輪
   * 候選），語意與上面 `slugUpdateTestHook` 對稱（測試搶插同 owner 同 slug 的佔位列，讓
   * INSERT 真的撞 `(owner_id, slug)` 唯一索引，藉以驅動「重試 ≤`MAX_AUTO_SLUG_RETRIES`
   * 後退 untitled-<uuid8>」的競態路徑）。生產不注入＝零成本。透傳自
   * `AppDeps.noteCreateHooks`。⚠ **只接在 `POST /api/notes` 與複製（`POST /api/notes/:id/copy`，交易內模式）兩處**：
   * MCP 的 `create_note` 與 `createWithContent` 走同一支 `insertNoteWithAutoSlug` 的預設模式，競態迴圈只需要一個觀測點；
   * 交易內模式（savepoint 重試，§6.9）是另一個迴圈，由複製那一處觀測。
   */
  noteCreateHooks?: NoteCreateHooks;
  /** #103：交錯點測試注入縫（`groups/test-hook.ts`），透傳自 `AppDeps.groupTestHook`。 */
  groupTestHook?: GroupTestHook;
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
// #106 D6 的三欄同樣不在 `notes` 表的 owner JOIN 上：`editorHandle` 來自**另一個** users
// 別名（`editor`，LEFT JOIN `last_edited_by`），與 `ownerHandle` 是不同的兩個人。各回填點
// 見下：list 兩支 union、`noteWithOwnerSelection`（:ref／by-path）、POST 帶 content 重讀、
// PATCH returning 後補查。
interface NoteFields {
  id: string;
  title: string;
  ownerId: string | null;
  slug: string;
  slugIsCustom: boolean;
  prevSlug: string | null;
  ownerHandle: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastEditedAt: Date | null;
  lastEditedAgentLabel: string | null;
  editorHandle: string | null;
  /** #175：所屬群組兩欄——清單＝分支輸出欄（owned／shared 恆 null）；單篇＝LEFT JOIN groups；PATCH＝`groupNameOf` 補查。 */
  groupId: string | null;
  groupName: string | null;
}

/**
 * #175 §6.1：`access` 由呼叫端傳入——清單＝`accessFromListRow(row)`；單篇＝`resolveNoteAccess`（Q22 一致之後）；
 * 建立＝建立路徑自己算（§6.2，不得寫死 `"owner"`——gate r1 I3）。改吃 `NoteAccess` 讓 tsc 逼出每個呼叫點，
 * **但只保證「會改」、不保證「改對」**——正確值由各路徑的測試釘。`group` 對看得到這篇的人都有值（B7：看得到
 * 群組筆記的只有成員）。
 */
function toNoteDto(note: NoteFields, access: Pick<NoteAccess, "role" | "permissions">): NoteDto {
  return {
    id: note.id,
    title: note.title,
    ownerId: note.ownerId,
    role: access.role,
    slug: note.slug,
    slugIsCustom: note.slugIsCustom,
    prevSlug: note.prevSlug,
    ownerHandle: note.ownerHandle,
    groupId: note.groupId,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    // 四欄同進同出：`last_edited_at` 是 null 就整個 lastEdited 為 null。編輯者帳號被刪
    // （FK `set null`）時 handle 落空 → 空字串（與 `read.ts` 的 `loadLastEdited` 同一形）。
    lastEdited: note.lastEditedAt
      ? { at: note.lastEditedAt.toISOString(), byHandle: note.editorHandle ?? "", agentLabel: note.lastEditedAgentLabel }
      : null,
    group: note.groupId !== null && note.groupName !== null ? { id: note.groupId, name: note.groupName } : null,
    permissions: access.permissions,
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
 * （PATCH 只改標題看 `permissions.edit`、帶 `slug` 鍵看 `permissions.changeSlug`——個人筆記只有 owner 有、群組筆記看
 * 角色的管理公開連結旗標，#175 Q11；DELETE 看 `permissions.delete`——個人筆記只有 owner 有，
 * 群組筆記由角色的刪除旗標決定，沒有的成員落在這裡；#175）。
 */
export function notesRoutes(deps: NotesRouteDeps) {
  // #108 §10.1（D22）：per-note 寫入佇列已經搬進 `deps.writes`（`NoteWriteService`，由
  // `buildApp` 建**一次**）——三條 REST 寫入路徑與 MCP 的寫入工具共用同一個實例。
  // 不同實例＝沒有串行可言，理由鏈見 `notes/editing/queue.ts` 與 `write-service.ts` 檔頭。
  return async function register(app: FastifyInstance): Promise<void> {
    /**
     * 建立／複製進群組的目標檢查（`POST /api/notes {groupId}` 與 `POST …/copy {groupId}` 共用；#175 §6.2、§6.5）：
     * 呼叫者在該群組的成員列＋角色旗標＋群組名。`undefined`＝群組不存在或不是成員（兩者呼叫端都回同一條 404）。
     * 交易外查。`POST /api/notes {groupId}` 只靠這一次（C8：撤旗標與建立之間不保證，§15 第 5 條）；複製另在交易內持
     * 目標 groups KEY SHARE 重驗（`notes/tx/copy.ts` (g)），這裡對複製只是快速 404 與 DTO 的角色／群組名。
     */
    async function loadCreateTarget(userId: string, groupId: string) {
      const [m] = await deps.db
        .select({
          name: groups.name,
          canRead: groupRoles.canRead,
          canCreate: groupRoles.canCreate,
          canEdit: groupRoles.canEdit,
          canDelete: groupRoles.canDelete,
          canManagePublicLink: groupRoles.canManagePublicLink,
        })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .innerJoin(groupRoles, eq(groupRoles.id, groupMembers.roleId))
        .where(and(eq(groupMembers.groupId, groupId), eq(groupMembers.userId, userId)))
        .limit(1);
      return m;
    }

    // #107 D2：這七條（POST /api/notes、GET /api/notes、GET /api/notes/:ref、#106 的
    // GET /api/notes/:id/content、POST /api/notes/:id/edits、GET /api/notes/:id/edits 與
    // POST /api/notes/:id/edits/:editId/revert）在 API token 的允許清單上，其餘 notes 路由
    // 維持 cookie-only——尤其 collab-token 是 D8 明文不收 Bearer。challenge 省略＝等於
    // required；只有 /api/mcp 需要宣告比 required 更寬的集合。
    // ⚠ 之後每新增一條收 Bearer 的 notes 路由，這段清單都要一起改（#136 的最終審查就是被這條抓到）。
    app.post("/api/notes", { preHandler: app.authenticateAny("notes:write") }, async (request, reply) => {
      const parsed = createBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");
      }
      const userId = request.user!.id;

      // #175 §6.2：建立的歸屬、回應用的角色／權限、owner 欄——三者一起決定，後面兩條路（帶／不帶 content）共用。
      // 群組分支的成員資格與新建旗標在交易外查（C8：撤旗標與建立之間不保證，§15 第 5 條）。
      let target: { scope: SlugScope; access: Pick<NoteAccess, "role" | "permissions">; ownerHandle: string | null; groupName: string | null };
      const groupId = parsed.data.groupId;
      if (groupId !== undefined) {
        const m = await loadCreateTarget(userId, groupId);
        // 非成員與「不存在」同一條 404——非成員的站台 admin 無豁免（筆記旗標只看角色，§5.5）。
        if (!m) return sendError(reply, 404, "group_not_found", "找不到此群組");
        // 是成員但角色沒有新建旗標 → 403（gate r4 N-2：對成員而言群組存在不是秘密）。
        if (!m.canCreate) return sendError(reply, 403, "forbidden", "你在這個群組的角色不能建立筆記");
        await deps.groupTestHook?.("membership-checked", { groupId });
        // role／permissions 照旗標推、不假設 editor：0013 起「新建 ⇒ 編輯」蘊含拿掉，create-only 角色會得到 viewer（plan 規格落差 17）。
        target = { scope: { groupId }, access: { role: roleFromGroupFlags(m), permissions: groupNotePermissions(m) }, ownerHandle: null, groupName: m.name };
      } else {
        // ownerHandle 直接取 request.user（A12）：建立者即 owner，不必補查 users。
        target = { scope: { ownerId: userId }, access: { role: "owner", permissions: OWNER_PERMISSIONS }, ownerHandle: request.user!.handle, groupName: null };
      }

      // #106 的 `content` 管線整條收在 `NoteWriteService.createWithContent`（#108 §10.1 D22，
      // spec §5 逐字的順序契約寫在那支的 docstring）；這裡只留部署形態與節流兩道閘門、
      // 錯誤碼 → HTTP 的映射，以及回應組裝。
      if (parsed.data.content !== undefined) {
        // 沒有協作元件就沒有「內容」這回事（同內容端點的註冊閘門）——回 400，不建列。
        if (!deps.writes.available) return sendError(reply, 400, "invalid_body", "此部署不支援帶內容建立筆記");
        // 節流排在 schema 驗證之後、**任何 mount 之前**。
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "寫入過於頻繁");
        let out;
        try {
          out = await deps.writes.createWithContent(request.log, {
            userId,
            userHandle: request.user!.handle,
            tokenId: request.tokenId ?? null,
            title: parsed.data.title,
            content: parsed.data.content,
            scope: target.scope,
          });
        } catch (err) {
          // 成員檢查之後群組被刪：建列那一發撞 FK 23503（同裸建那條，見下）。建列在 service 的 try 之外，所以原樣拋到這裡。
          if (isForeignKeyViolation(err)) return sendError(reply, 404, "group_not_found", "找不到此群組");
          throw err;
        }
        if (!out.ok) {
          if (out.kind === "parse") return sendError(reply, 400, out.code, "無法解析內容");
          // 套用失敗（**含佇列逾時**）：service 已經 best-effort 刪掉剛建的列。這條路徑的
          // 逾時答案刻意是 500 而不是 503（`docs/ai-editing.md` 逐字）。
          return sendError(reply, 500, "internal", "建立筆記失敗");
        }
        const note = out.inserted;
        // Task 3：**重讀**這一列。`note` 是 insert 的 returning，四欄在那一刻還是 null，而
        // 上面那次合併的 disconnect 已經落款了——直接回 `note` 會送出一個恆空的 `lastEdited`
        // 的假答案（`note-last-edited.test.ts` 第二案的「帶 content → 與 DB 一致」釘住）。
        const fresh = await loadNoteWithOwner(note.id);
        // 落空＝回應組裝前這篇又被別的請求刪掉的競態（同 `loadNoteWithOwner` 註解）；內容
        // 已經寫進去了，不能回 500——本 handler 上面那個 500（套用內容失敗）會 best-effort
        // 刪掉剛建的列，重試安全，但這裡列還在、內容也還在，回 500 只會讓外部 AI 重試出
        // 第二篇有內容的筆記，比回一個過期的 `lastEdited` 更糟。退回 insert 的 returning
        // （與無 content 那條路徑同一形，`lastEdited` 因此為 null）：整份回應都在描述一篇
        // 已不存在的筆記，最後編輯資訊不比標題或網址更假，而無 content 那條路徑本來就接受
        // 這件事。**不要**改成路由自己組出落款值——落款的更新只警告不拋出，失敗時路由組出
        // 來的值會是謊話，重讀至少誠實地回舊值。
        return reply
          .code(201)
          .send(toNoteDto(fresh ?? { ...note, ownerHandle: target.ownerHandle, editorHandle: null, groupName: target.groupName }, target.access));
      }

      // 建列整件事收在 `notes/create.ts` 的 `insertNoteWithAutoSlug`（#145，三條建立路徑唯一
      // 的 `insert(notes)` 點）：`title` 未帶時完全不放進 values，讓 DB 的 default "Untitled"
      // 與 `untitled-<uuid8>` 生效（不在應用層重複寫死同一個預設值字面量，唯一真相來源在
      // schema.ts）；帶 `title` 就派生 auto slug。帶 `content` 那條路（上面）走的是同一支，
      // 只是呼叫點在 service 裡、排在解析之後。
      let created;
      try {
        created = await insertNoteWithAutoSlug(deps.db, target.scope, parsed.data.title, deps.noteCreateHooks);
      } catch (err) {
        // 成員檢查之後群組被刪：INSERT 的 FK 檢查等刪群組交易 commit 後報 23503（spec gate r2 G）。個人建立撞不到 FK（owner 就是自己，而 `src/` 內沒有硬刪 users 的路徑）。
        if (isForeignKeyViolation(err)) return sendError(reply, 404, "group_not_found", "找不到此群組");
        throw err;
      }

      // `editorHandle` 恆為 null——這條路徑沒有內容、`last_edited_*` 四欄還是 insert 的預設值，
      // `toNoteDto` 於是把 `lastEdited` 給 null（不必為了一個必然落空的 JOIN 多發一次查詢）。
      return reply
        .code(201)
        .send(toNoteDto({ ...created, ownerHandle: target.ownerHandle, editorHandle: null, groupName: target.groupName }, target.access));
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
      // #108：兩支的欄位集、join 與可見性述詞收在 `notes/list-query.ts`（MCP 的 `list_notes`／
      // `search_notes` 吃同一支工廠）。改吃工廠前後 `.toSQL()` 逐位元組相同（含參數編號）。
      // #175：三支結構性互斥（`owner_id = $u`／`group_id IS NULL`／`group_id IS NOT NULL`），見 list-query.ts。
      const { owned: ownedSelect, shared: sharedSelect, grouped: groupedSelect } = visibleNoteBranches(deps.db, userId);

      // 次要排序鍵 id desc（M3）：updatedAt 精度不足以保證唯一序，未來若加分頁
      // （keyset pagination），排序不穩定會讓同一批結果在跨頁時重複或漏掉列。
      const rows = await unionAll(ownedSelect, sharedSelect, groupedSelect).orderBy(desc(notes.updatedAt), desc(notes.id));

      return rows.map((row): NoteDto => toNoteDto(row, accessFromListRow(row)));
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
      ...lastEditedSelection,
      // #175：所屬群組兩欄——三個取列點（`loadNoteWithOwner`、by-path 兩查）都 LEFT JOIN groups。
      groupId: notes.groupId,
      groupName: groups.name,
    };

    // 授權後的完整列讀取（GET :ref 用；by-path 首查即帶整列，不經這裡）：JOIN users 帶
    // ownerHandle。I2（審查）：resolveRole 判定完到這裡的 re-select 之間存在競態視窗——
    // 若同時有另一個請求把這篇 note 刪了，這裡會查不到列。呼叫端對 undefined 明確回
    // 404，不拿 non-null assertion 賭「resolveRole 說有就一定還在」。
    // #175：LEFT JOIN——群組筆記沒有 owner（INNER 會讓群組筆記重讀落空，帶 content 建立的回應就退回 insert 那一列）。
    async function loadNoteWithOwner(noteId: string): Promise<NoteFields | undefined> {
      const [row] = await deps.db
        .select(noteWithOwnerSelection)
        .from(notes)
        .leftJoin(users, eq(users.id, notes.ownerId))
        .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
        .leftJoin(groups, eq(groups.id, notes.groupId))
        .where(eq(notes.id, noteId))
        .limit(1);
      return row;
    }

    const noteNotFound = (reply: FastifyReply): FastifyReply => sendError(reply, 404, "not_found", "找不到此筆記");

    /**
     * C13 的 rowcount-0 分流（gate r2 N-1）：列不在 → 404（I2 慣例）；列在 → 歸屬在授權之後變了 → 409 conflict。
     * 兩處共用：public-link PUT（§6.6）與 PATCH 的 T1（§4.3，scope 條件命中 0 列）。
     */
    const ownershipChanged = async (reply: FastifyReply, noteId: string): Promise<FastifyReply> => {
      const [row] = await deps.db.select({ id: notes.id }).from(notes).where(eq(notes.id, noteId)).limit(1);
      return row ? sendError(reply, 409, "conflict", "筆記的歸屬已變更，請重新整理後再試") : noteNotFound(reply);
    };

    /**
     * #175 單篇讀取的授權收尾（§6.4、Q22）：先授權（none → 同一條 404，S4）；授權讀到的 `group_id` 與手上那一列
     * 不同（授權與取列之間被移動／轉移——PR2／PR4）→ 重讀列、重授權**一次**，仍不同 → 404。
     */
    async function authorizeRow(reply: FastifyReply, userId: string, note: NoteFields): Promise<NoteDto | FastifyReply> {
      let row = note;
      let access = await resolveNoteAccess(deps.db, userId, row.id);
      if (access.role !== "none" && access.groupId !== row.groupId) {
        const fresh = await loadNoteWithOwner(row.id);
        if (!fresh) return noteNotFound(reply);
        row = fresh;
        access = await resolveNoteAccess(deps.db, userId, row.id);
        if (access.groupId !== row.groupId) return noteNotFound(reply);
      }
      if (access.role === "none") return noteNotFound(reply);
      return toNoteDto(row, access);
    }

    /** by-path 兩形共用的取列 builder（每次呼叫現造——drizzle builder 單次使用）。 */
    function selectNotesWhere(cond: SQL) {
      return deps.db
        .select(noteWithOwnerSelection)
        .from(notes)
        .leftJoin(users, eq(users.id, notes.ownerId))
        .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
        .leftJoin(groups, eq(groups.id, notes.groupId))
        .where(cond);
    }

    /** §6.4 查找序：① 現行 slug → ② 轉址表（過期 → 刪列、當 miss）→ ③ prev_slug（limit 2；0 或 >1 → miss）。 */
    async function resolvePath(scopeCond: SQL, slug: string, redirectKey: string): Promise<NoteFields | undefined> {
      const [hit] = await selectNotesWhere(and(scopeCond, eq(notes.slug, slug))!).limit(1);
      if (hit) return hit;
      const redirected = await lookupRedirect(deps.db, redirectKey);
      if (redirected !== null) return loadNoteWithOwner(redirected);
      const prevHits = await selectNotesWhere(and(scopeCond, eq(notes.prevSlug, slug))!).limit(2);
      return prevHits.length === 1 ? prevHits[0] : undefined;
    }

    /**
     * 新形網址的解析端點（#122 spec §3b）：`/n/<handle>/<slug>` 由 web 端打這裡。
     * 順序：正規化（handle ASCII 小寫、slug NFC+小寫——大小寫/NFD 變體都解得到）→
     * 單一 JOIN 精確比對（一次帶回整列；planner 由 users.handle 唯一鍵起算 nested loop
     * 後吃 `notes_owner_slug_idx`——migrate.test 有 explain 守衛）→ miss → **轉址表**
     * （#175 §6.4；B4：rev 1 是 prev 在前）→ miss → **prev_slug 補查**（單層自訂 redirect；
     * `limit(2)` 偵測多義——同 owner 的多篇筆記可能先後釋放同一個名字，**0 或 >1 命中一律
     * 404**，不猜）→ 授權收尾 `authorizeRow`（none → 404，防列舉：登入面分不出「不存在」與
     * 「無權限」；所有 404 出口都走 `noteNotFound`，body 同形，測試逐位元組釘住）。
     * RESERVED_SLUGS 不含 by-path（spec m4-3 核實：本路由是三段靜態前綴，兩段
     * `/api/notes/by-path` 不會 match 這裡、落回 `:ref`——無衝突面）。
     * 回應與 `GET /api/notes/:id` 同一個 toNoteDto——web 端拿 by-path 結果 seed
     * `["note", id]` 快取的前提（spec A5，形狀斷言在測試釘住）。
     */
    app.get("/api/notes/by-path/:handle/:slug", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { handle: string; slug: string };
      const handle = normalizeHandle(params.handle);
      const slugParam = normalizeSlug(params.slug);
      // `/n/` 形以 `users.handle = $h` 為述詞——刻意只找個人筆記（群組筆記沒有 owner，LEFT JOIN 後 handle 為 NULL）。
      const note = await resolvePath(eq(users.handle, handle), slugParam, userNotePath(handle, slugParam));
      if (!note) return noteNotFound(reply);
      return authorizeRow(reply, request.user!.id, note);
    });

    /**
     * #175 §6.4：`/g/<group_id>/<slug>` 的解析端點（session-only，與 by-path 同）。獨立前綴、不掛在 `by-path/g/…`：
     * `g` 是合法 handle，靜態段與參數段混用要靠 find-my-way 回溯。非 UUID、群組不存在、非成員、無閱讀旗標的成員
     * → 同一條 404（§5.4）。
     */
    app.get("/api/notes/by-group-path/:groupId/:slug", { preHandler: app.authenticate }, async (request, reply) => {
      const params = request.params as { groupId: string; slug: string };
      if (!UUID_RE.test(params.groupId)) return noteNotFound(reply);
      const groupId = params.groupId.toLowerCase();
      const slugParam = normalizeSlug(params.slug);
      const note = await resolvePath(eq(notes.groupId, groupId), slugParam, groupNotePath(groupId, slugParam));
      if (!note) return noteNotFound(reply);
      return authorizeRow(reply, request.user!.id, note);
    });

    // 由 `GET /api/notes/:id` 改名（不並存——同一位置重複註冊 GET 會被 fastify throw
    // "Method already declared"）。`:ref` 可以是 uuid、0007 凍結的 legacy slug、或舊版
    // `<vanity>-<uuid>` 形式，解析順序見 `resolveNoteIdFromRef`（#122 起只查 legacy）。
    app.get("/api/notes/:ref", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
      const { ref } = request.params as { ref: string };
      const userId = request.user!.id;

      const noteId = await resolveNoteIdFromRef(deps.db, ref);
      if (!noteId) return noteNotFound(reply);
      const first = await resolveNoteAccess(deps.db, userId, noteId);
      if (first.role === "none") return noteNotFound(reply);
      await deps.groupTestHook?.("ref-authorized", { noteId });
      const note = await loadNoteWithOwner(noteId);
      if (!note) return noteNotFound(reply);
      // Q22：授權與取列是兩次查詢；歸屬一致就直接用。不一致交給 `authorizeRow`：先以新狀態重授權，仍不一致才重讀列
      // 一次（本支的列是授權後才取的新列，重授權後通常就一致——重讀段在這裡走不到）。⚠ by-path 兩形「取列後、授權前」
      // 被移動的窗口才會走到重讀段：PR1 沒有改歸屬的生產路徑、執行期到不了，也沒有 hook 與測試——PR2（移動）補
      // `path-resolved` 測試點名與兩案（移進成員群組 → 200 新群組；移進非成員群組 → 404）。
      if (first.groupId === note.groupId) return toNoteDto(note, first);
      return authorizeRow(reply, userId, note);
    });

    // #106：內容端點只在有 collab＋editing（生產必有；`buildTestApp` 那種無 collab 的 app
    // 不註冊）時掛——沒有 live doc 的來源就沒有「讀最新內容」這回事，寧可整條不存在（404）
    // 也不要掛一條只會回半套答案的路由。
    if (deps.collab && deps.editing) {
      const collab = deps.collab;
      const editing = deps.editing;
      /**
       * `GET /api/notes/:id/content`（spec §5）——**唯讀，零副作用**：`read.ts` 的
       * `loadNoteDoc` 只 fork live doc 或解 DB 快照，絕不開直連，所以連讀 N 次都不會
       * 動到 `note_states`／backup／`documents`（`note-content.test.ts` 的假綠守衛釘住）。
       *
       * ⚠ 授權在這一層做完（`resolveRole`）：AI 寫入路徑（#137）用的
       * `openDirectConnection` 會繞過 collab 的 `onAuthenticate`，讀路徑雖然不開直連，
       * 但同樣不經過那個 hook——`collab/server.ts` 的 onAuthenticate 旁有對照註解。
       *
       * 順序：格式（不變量 S）→ 角色 → 節流 → 讀。節流排在角色之後，`role === "none"`
       * 的 404 因此**不啃桶**（理由見 `CONTENT_READ_LIMIT`）。
       */
      app.get("/api/notes/:id/content", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
        const { id } = request.params as { id: string };
        // 防禦縱深：`resolveRole` 內部也有同一道 guard（見 `notes/service.ts` UUID_RE 註解），
        // 所以刪掉這行行為不變、沒有測試會紅——留著是為了不把「非法 uuid 不進 SQL」這個本路由
        // 的前提，寄託在另一個模組的私有選擇上。
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "找不到此筆記");
        const q = contentQuerySchema.safeParse(request.query ?? {});
        if (!q.success) return sendError(reply, 400, "invalid_body", "查詢參數格式錯誤");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "找不到此筆記");
        if (!deps.limiters.contentRead.consume(userId)) return sendError(reply, 429, "too_many_requests", "讀取過於頻繁");
        // #138 presence（spec §9）：只有帶 token 的讀者才現身——cookie 讀取（`request.tokenId`
        // 缺席）是使用者本人在用瀏覽器，spec §12.2 明講不設 presence。`touch` 內部只對已載入
        // 的文件動作，所以沒人在線時它是 no-op，讀路徑「零副作用」的不變量仍成立。
        // ⚠ 同 `POST /:id/edits`：拿掉這道 `request.tokenId` 守衛**不會有任何測試變紅**（touch
        // 的 tokenId 一變，clientId 就不同，clock 斷言看不到），擋住它的是 `tsc` 的 TS2345。
        // 規則的**結果面**（cookie 讀者不會多冒出一個 presence）由整合測試
        // `note-presence.test.ts` 第 2 案的 awareness 用戶端識別集合斷言守著。
        if (request.tokenId) {
          const label = await currentAgentLabel(deps.db, request.tokenId);
          if (label) {
            deps.presence?.touch(id, request.tokenId, presenceIdentity(request.user!.handle, label), presenceTargetForRead(q.data.section));
          }
        }
        const result = await readNoteContent({ db: deps.db, collab }, editing, id, q.data.section);
        if (result === "section_not_found") return sendError(reply, 404, "section_not_found", "找不到此段落");
        // #137 起 `lastEdited` 是真值（整篇形與段落形都回，`note-content.test.ts` 兩行釘住）。
        // `loadLastEdited` 是純 SELECT，不開直連——讀路徑零副作用的不變量照舊成立。
        // `reply.send` 本身不做型別檢查——`satisfies` 把 `read.ts` 的回傳形狀釘回 shared 的 DTO，
        // 形狀漂移（少一欄、多一欄）在編譯期就會炸，不必等到執行期才被測試發現（m-5）。
        const body = { ...result, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
        return reply.send(body);
      });

      /**
       * `POST /api/notes/:id/edits`（spec §5／§6.1）——AI／API 的寫入端。
       *
       * 順序：格式（不變量 S）→ 角色 → 節流 → `NoteWriteService.applyToNote`（候選集合／agent
       * label → per-note 佇列 → `applyEdit` → presence 都在它裡面，#108 §10.1 D22）。
       * 節流排在角色之後（`role === "none"` 的 404 與 viewer 的 403 都不啃桶），但**在任何
       * mount／直連之前**——429 是拒絕案，不得留下任何落盤或紀錄。
       *
       * `bodyLimit`＝`WRITE_BODY_LIMIT`（`http/body-limits.ts`，與 `POST /api/mcp` 同一份）：超過由
       * fastify 丟 413，全域 errorHandler 的 `clientErrorCode` 映成 `content_too_large`（與 `MD` 的
       * `.max(262_144)` 是同一個數字但**不同單位**：body 整體比單一欄位大，所以真正的超長 markdown 會先撞
       * bodyLimit 的 413，而非 zod 的 400——兩者都是拒絕，不落盤）。
       */
      app.post("/api/notes/:id/edits", { preHandler: app.authenticateAny("notes:write"), bodyLimit: WRITE_BODY_LIMIT }, async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "找不到此筆記");
        const parsed = editBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendError(reply, 400, "invalid_body", "請求格式錯誤");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "找不到此筆記");
        if (role === "viewer") return sendError(reply, 403, "forbidden", "沒有編輯權限");
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "寫入過於頻繁");
        // 外圍順序（候選集合 → agentLabel → per-note 佇列 → applyEdit → presence）收在
        // `NoteWriteService`（#108 §10.1 D22）；本路由只留授權、限流與錯誤碼 → HTTP 的映射。
        const out = await deps.writes.applyToNote(request.log, {
          noteId: id,
          userId,
          userHandle: request.user!.handle,
          tokenId: request.tokenId ?? null,
          op: parsed.data.op,
          sectionId: "section_id" in parsed.data ? parsed.data.section_id : undefined,
          markdown: "markdown" in parsed.data ? parsed.data.markdown : undefined,
          ifMatch: "if_match" in parsed.data ? parsed.data.if_match : undefined,
        });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "筆記正在被寫入，請稍後再試");
          if (out.code === "fingerprint_mismatch") {
            // 不在 transact 內、直連已 disconnect 之後（spec §5）。不帶 section → 不可能是
            // "section_not_found"，但那個哨兵在回傳型別的 union 裡，不收窄的話 spread 一個字串
            // 會靜默送出 {0:"s",1:"e",…}。
            const current = await readNoteContent({ db: deps.db, collab }, editing, id);
            if (current === "section_not_found") throw new Error("readNoteContent 未帶 section 卻回哨兵值");
            const body = { ...current, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
            return reply.code(409).send({ error: { code: "fingerprint_mismatch", message: "內容已被修改" }, current: body });
          }
          return sendError(reply, out.code === "section_not_found" ? 404 : 400, out.code, "無法套用修改");
        }
        const result = out.result;
        return reply.code(201).send({ editId: result.editId, fingerprint: result.fingerprint, outline: result.outline, unboundWikilinks: result.unboundWikilinks } satisfies NoteEditResultDto);
      });

      /**
       * `GET /api/notes/:id/edits`（spec §5／#137）——AI 修改紀錄清單，新到舊，最多 `RETENTION` 筆。
       *
       * **讀路徑，零副作用**：`listEdits` 走 `read.ts` 的 `loadNoteDoc`（fork live doc 或解 DB 快照），
       * 絕不開直連，也不會讓一份已卸載的文件重新載入（`note-revert.test.ts` 的 `documents.size` 釘住）。
       * 順序與 `/content` 一致：格式 → 角色 → 節流（`CONTENT_READ_LIMIT`，桶 key＝裸 userId），
       * 節流排在角色之後，`role === "none"` 的 404 因此**不啃桶**。
       */
      app.get("/api/notes/:id/edits", { preHandler: app.authenticateAny("notes:read") }, async (request, reply) => {
        const { id } = request.params as { id: string };
        // 同 `/content`：防禦縱深，不把「非法 uuid 不進 SQL」寄託在 `resolveRole` 的私有選擇上。
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "找不到此筆記");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "找不到此筆記");
        if (!deps.limiters.contentRead.consume(userId)) return sendError(reply, 429, "too_many_requests", "讀取過於頻繁");
        // #138：這裡**刻意不 touch** presence——spec §5 明講看修改紀錄不刷新 AI 的在場狀態
        // （守衛＝`note-presence.test.ts` 第 2 案的 clock 斷言）。同檔另外三條都 touch。
        const edits = await listEdits({ db: deps.db, collab }, id) satisfies NoteEditDto[];
        return reply.send({ edits });
      });

      /**
       * `POST /api/notes/:id/edits/:editId/revert`（spec §5／#137）——撤回一筆 AI 修改。
       *
       * 順序：格式（不變量 S）→ 角色 → 節流 → `NoteWriteService.revert`（agent label → per-note
       * 佇列（與 `/edits` 寫入端**同一顆**）→ `revertEdit` → presence）。本端點**沒有 body**，所以
       * 不變量 S 落在路徑參數：
       * `editId` 非 uuid（含 NUL）一律 404 `not_found`，不讓字串進 SQL（pg 對 `uuid` 欄位的型別
       * 轉換錯誤會逃到全域 errorHandler 變成 500）。
       *
       * 三種拒絕：`not_found`（查無此列，或該列屬於別篇筆記）→ 404；`already_reverted`（已撤回過，
       * 或它本身就是撤回列）→ 409；`stale`（落點已被改掉）→ 409 並附 `current`（重跑讀路徑）。
       */
      app.post("/api/notes/:id/edits/:editId/revert", { preHandler: app.authenticateAny("notes:write") }, async (request, reply) => {
        const { id, editId } = request.params as { id: string; editId: string };
        if (!UUID_RE.test(id)) return sendError(reply, 404, "not_found", "找不到此筆記");
        if (!UUID_RE.test(editId)) return sendError(reply, 404, "not_found", "找不到此修改紀錄");
        const userId = request.user!.id;
        const role = await resolveRole(deps.db, userId, id);
        if (role === "none") return sendError(reply, 404, "not_found", "找不到此筆記");
        if (role === "viewer") return sendError(reply, 403, "forbidden", "沒有編輯權限");
        if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "寫入過於頻繁");
        // 外圍順序（agentLabel → **同一顆**佇列 → revertEdit → presence）在 `NoteWriteService`；
        // 本路由只留授權、限流與錯誤碼 → HTTP 的映射（同 `/edits`）。
        const out = await deps.writes.revert(request.log, { noteId: id, editId, userId, userHandle: request.user!.handle, tokenId: request.tokenId ?? null });
        if (!out.ok) {
          if (out.kind === "busy") return sendError(reply, 503, "server_busy", "筆記正在被寫入，請稍後再試");
          if (out.code === "stale") {
            // 不在 transact 內、直連已 disconnect 之後（同 `/edits` 的 409 形）。不帶 section →
            // 不可能是 "section_not_found"，但那個哨兵在回傳型別的 union 裡，不收窄的話 spread
            // 一個字串會靜默送出 {0:"s",1:"e",…}。
            const current = await readNoteContent({ db: deps.db, collab }, editing, id);
            if (current === "section_not_found") throw new Error("readNoteContent 未帶 section 卻回哨兵值");
            const body = { ...current, lastEdited: await loadLastEdited(deps.db, id) } satisfies NoteContentDto | NoteSectionDto;
            return reply.code(409).send({ error: { code: "stale", message: "這筆修改之後筆記又被改過，已無法撤回" }, current: body });
          }
          if (out.code === "already_reverted") return sendError(reply, 409, "already_reverted", "這筆修改已經撤回過了");
          return sendError(reply, 404, "not_found", "找不到此修改紀錄");
        }
        const result = out.result;
        return reply.code(201).send({ editId: result.editId, fingerprint: result.fingerprint, outline: result.outline });
      });
    }

    // PATCH 回應的 ownerHandle 補讀（spec m5-8／A12）：`.returning()` 拿不到 users.handle，且 editor 改他人筆記時
    // 必須回 **owner 的** handle。#175：群組筆記沒有 owner → null（#175 之前一律查 users、查不到就 throw，群組筆記改標題會 500——spec §6.2）。
    // ⚠ S14：這是對 `deps.db` 的閉包，**不得在任何交易內呼叫**（gate r4 I-1 實跑：N=10 並發即永久卡死）。
    async function ownerHandleOf(ownerId: string | null): Promise<string | null> {
      if (ownerId === null) return null;
      const [row] = await deps.db.select({ handle: users.handle }).from(users).where(eq(users.id, ownerId)).limit(1);
      if (!row) throw new Error(`notes.owner_id ${ownerId} 查無對應 users 列（FK 不變量被打破）`);
      return row.handle;
    }

    /**
     * #106 D6：PATCH 的 `.returning()` 同樣拿不到 `editor.handle`——比照上面的 `ownerHandleOf`
     * 補讀一次。與 owner 那支的差別在**落空是正常的**（沒編輯過＝`last_edited_by` 為 null；
     * 編輯者帳號被刪＝FK `set null`），所以回 `null` 而不是 throw。
     */
    async function editorHandleOf(editorId: string | null): Promise<string | null> {
      if (!editorId) return null;
      const [row] = await deps.db.select({ handle: users.handle }).from(users).where(eq(users.id, editorId)).limit(1);
      return row?.handle ?? null;
    }

    /**
     * #103 §6.5：PATCH 的 `.returning()` 同樣拿不到 `groups.name`——比照上面兩支補讀。落空（沒有群組、
     * 或群組剛被刪）回 null，`toNoteDto` 就不輸出 `group`。
     */
    async function groupNameOf(groupId: string | null): Promise<string | null> {
      if (!groupId) return null;
      const [row] = await deps.db.select({ name: groups.name }).from(groups).where(eq(groups.id, groupId)).limit(1);
      return row?.name ?? null;
    }

    /**
     * PATCH 的回應組裝——**一律在交易外**（`ownerHandleOf`／`editorHandleOf`／`groupNameOf` 都是對 `deps.db` 的閉包，S14）。
     * Q22（規格落差 9）：取到的列的歸屬與授權時不同（格 2 沒有 scope 條件）→ 以重算的 access 組 permissions。
     */
    async function respondPatched(updated: typeof notes.$inferSelect, access: NoteAccess, userId: string): Promise<NoteDto> {
      const finalAccess = updated.groupId === access.groupId ? access : await resolveNoteAccess(deps.db, userId, updated.id);
      return toNoteDto(
        {
          ...updated,
          ownerHandle: await ownerHandleOf(updated.ownerId),
          editorHandle: await editorHandleOf(updated.lastEditedBy),
          groupName: await groupNameOf(updated.groupId),
        },
        finalAccess,
      );
    }

    /**
     * PATCH 分流矩陣（#122 spec §3a——**語句形狀＝docs-as-spec 義務**，改動要連同
     * docs/api.md 一起）：`title`／`slug` 各自選配，至少帶一項（見 `updateBodySchema`）。
     * 權限矩陣（#175 Q11）：`slug` 有出現在 body 內（不論其值）一律要求 `permissions.changeSlug`
     * （個人筆記＝owner；群組筆記＝角色的 `can_manage_public_link`）：none → 404、沒有該旗標 → 403，
     * **整包拒絕**；body 只有 `title` 時要求 `permissions.edit`（沒有 → 403）。
     *
     * 四格（slug 自 0007 起 NOT NULL；唯一性在**歸屬的範圍**內——個人筆記 `(owner_id, slug)`
     * 的 `notes_owner_slug_idx`、群組筆記 `(group_id, slug)` 的 `notes_group_slug_idx`（#175 S12）；
     * `slug_is_custom` 記形態；prev 的 CASE＝**只記自訂變更**——custom→custom 與 custom→auto 記、
     * auto→custom 與 auto 重算不記，spec M4-3）。「單一 UPDATE」皆指**寫入 notes 的語句恰一條**；
     * 各格的讀取（pre-read／探測）逐格列明：
     * 1. `{slug: string}`（±title）：先計節流（`limiters.slugPatch`，10 次/10 分鐘/user，
     *    成功失敗都計——判定在格式驗證與 UPDATE 之前）→ `prepareSlugForPatch` → 無
     *    pre-read、無探測，單一 UPDATE `[title=$t,] slug=$1, slug_is_custom=true,
     *    prev_slug=CASE WHEN slug_is_custom THEN slug ELSE prev_slug END`——#175：這三格（1、3、4）
     *    的 UPDATE 各包成一個 T1 短交易（`patchSlugInTx`，`WITH o AS (… FOR UPDATE) UPDATE …`，帶授權時
     *    的歸屬當 scope 條件；0 列 → 列不在 404、列在 409 `conflict`），寫進 prev 的那一刻同交易刪同路徑
     *    轉址（個人 scope 才發，§4.3 B4）；撞 `notes_owner_slug_idx` 或 `notes_group_slug_idx` → 409
     *    `slug_taken`（**constraint 名分流**，其他唯一鍵違反 rethrow——比照 PR1 的 M4-2 契約）；
     *    同請求帶 title 不觸發重算。
     * 2. `{title}`：pre-read 本列 slug_is_custom（特赦，見下）；custom=false 才重算
     *    （以請求新 title 算＋在歸屬範圍內探測，#175 RF5）：單一 UPDATE `title=$1, slug=CASE WHEN
     *    slug_is_custom THEN slug ELSE $auto END`（prev 不動、不開交易、沒有 scope 條件——回應組裝時
     *    若列的歸屬已與授權時不同，重算 access 再組 permissions，規格落差 9）。**不計 slugPatch**
     *    （title 編輯是核心操作；放大上界＝每輪重試都重探測，≤5×20＝100 次索引查詢
     *    ＋6 次 UPDATE（第 6 輪退位不探測），皆有界——title PATCH 本身無節流為現狀，
     *    明示接受）。
     * 3. `{title, slug:null}`：回 auto、以新 title 算（**無 pre-read**——title 已在請求、
     *    必走 auto）：探測＋單一 UPDATE（T1）`title=$t, slug=$auto, slug_is_custom=false,
     *    prev_slug=CASE ...`。slugPatch **計**（進 slug 分支即計；null 無格式驗——與
     *    格 1 的先計後驗一致）。
     * 4. `{slug:null}`：回 auto、以 DB 現行 title 算——pre-read 一次本列 title：探測＋
     *    單一 UPDATE（T1），語句同格 3。slugPatch 計。
     *
     * pre-read 界線（spec m5-5）：TOCTOU 紀律禁的是**唯一性 pre-check**（「先查名字有沒
     * 有人用再寫」——裁決必須在唯一索引）；讀**本列**的 title/slug_is_custom 不在此列
     * （`resolveNoteAccess` 本就先讀列），歸屬範圍的探測（`deriveUniqueAutoSlug` 的可用性特赦）
     * 亦然——探測後裁決仍在索引。
     *
     * auto 撞名（**永不 409**）：探測（述詞排除本列）選尾碼；UPDATE 撞兩把 slug 唯一索引之一＝真競態
     * → 重探測重發，`MAX_AUTO_SLUG_RETRIES`（5）次後退 `untitled-<uuid8>`。格 3／4 每一輪是一個新的
     * T1 交易（23505 只 abort 那一輪，不需要 savepoint）。title 與 slug 一律組進同一個
     * `.update(...).set({...})`：唯一鍵衝突時整條 UPDATE 連同 title 一併回滾，不會發生
     * 「slug 衝突但 title 卻偷偷套用了」這種半套結果。
     *
     * S14：交易內不得向 pool 借連線——T1 的 handle 用 `request.user.handle`（記憶體中），回應組裝
     * （`respondPatched`）一律在交易外。
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

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") return noteNotFound(reply);
      if (hasSlug && !access.permissions.changeSlug) return sendError(reply, 403, "forbidden", "沒有變更網址代稱的權限");
      if (!hasSlug && !access.permissions.edit) return sendError(reply, 403, "forbidden", "沒有編輯權限");

      // #175：slug 的去重範圍與 T1 的 scope 條件都取自**授權當下**的歸屬（§4.3，gate r5 M-2）。
      // role !== "none" 時：groupId 非 null ＝群組筆記；否則是個人筆記，`resolveNoteAccess` 回的 ownerId 必非 null。
      const slugScope: SlugScope = access.groupId !== null ? { groupId: access.groupId } : { ownerId: access.ownerId! };
      const txScope: SlugWriteScope =
        access.groupId !== null ? { kind: "group", groupId: access.groupId } : { kind: "personal", ownerId: access.ownerId! };
      // 寫 prev 的三格要 changeSlug——個人 scope 下能走到這裡的一定是 owner 本人，所以他的 handle 就是 request.user.handle
      // （記憶體中；§4.3。並發改 handle 的極窄窗見 spec §15 第 18 條）。
      const redirectHandle = txScope.kind === "personal" ? request.user!.handle : null;
      // S14：callback 整段就是一個 `patchSlugInTx(tx, …)` 呼叫，引數全是交易前算好的純資料與測試縫。
      const runT1 = (set: { title?: string; slug: string; slugIsCustom: boolean }) =>
        deps.db.transaction(tx => patchSlugInTx(tx, { noteId: id, scope: txScope, set, redirectHandle }, deps.slugPatchTestHook));

      // 格 1：顯式自訂 slug。
      if (hasSlug && slug !== null) {
        if (!deps.limiters.slugPatch.consume(userId)) return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
        const result = prepareSlugForPatch(slug);
        if (!result.ok) return sendError(reply, 400, "invalid_body", result.message);
        await deps.slugPatchTestHook?.("authorized", { noteId: id });
        let updated;
        try {
          updated = await runT1({ ...(title !== undefined ? { title } : {}), slug: result.value, slugIsCustom: true });
        } catch (err) {
          // constraint 名分流（PR1 M4-2 契約）：兩把 slug 唯一索引撞名＝409，其他 23505 rethrow——不認識的 23505 不該被猜成 409。
          if (isSlugUniqueViolation(err)) return sendError(reply, 409, "slug_taken", "此網址代稱已被使用");
          throw err;
        }
        // I2＋C15：scope 條件命中 0 列＝授權之後被刪（404）或歸屬變了（409 conflict）。
        if (!updated) return ownershipChanged(reply, id);
        return respondPatched(updated, access, userId);
      }

      // 格 2–4：auto 路徑。clearingSlug＝格 3／4（body 帶 slug:null）；否則格 2（title-only）。
      const clearingSlug = hasSlug;
      if (clearingSlug && !deps.limiters.slugPatch.consume(userId)) return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");

      // pre-read（特赦界線見上）只在需要時發：格 2 要 slug_is_custom（決定探不探測）、
      // 格 4 要現行 title；格 3 兩者都在請求裡（必走 auto）——不多發一次查詢。
      let preReadSlugIsCustom = false;
      let effectiveTitle = title ?? "";
      if (!clearingSlug || title === undefined) {
        const [row] = await deps.db.select({ title: notes.title, slugIsCustom: notes.slugIsCustom }).from(notes).where(eq(notes.id, id)).limit(1);
        if (!row) return noteNotFound(reply);
        preReadSlugIsCustom = row.slugIsCustom;
        effectiveTitle = title ?? row.title;
      }
      const needsAuto = clearingSlug || !preReadSlugIsCustom;
      if (clearingSlug) await deps.slugPatchTestHook?.("authorized", { noteId: id });

      let updated;
      for (let attempt = 1; ; attempt++) {
        // 候選來源三分支：重試耗盡 → uuid8 退位；要走 auto（或重試中）→ 在歸屬範圍內探測（RF5）；
        // 格 2 的 custom=true → CASE 會保留現行 slug、$auto 只是佔位，傳未探測候選即可
        // ——若 pre-read 後被併發翻回 auto（罕見競態），只有恰好撞索引才落到重試路徑
        // 重新探測；沒撞就直接寫入未探測候選（仍唯一，可接受）。
        let auto: string;
        if (attempt > MAX_AUTO_SLUG_RETRIES) auto = fallbackAutoSlug();
        else if (needsAuto || attempt > 1) auto = await deriveUniqueAutoSlug(deps.db, slugScope, id, effectiveTitle);
        else auto = autoSlugFromTitle(effectiveTitle);
        await deps.slugUpdateTestHook?.(auto);
        try {
          if (clearingSlug) {
            // 格 3／4：每一輪一個新的 T1 交易（23505 只 abort 那一輪，所以不需要 savepoint——§6.9 只管長交易內的重試）。
            updated = await runT1({ ...(title !== undefined ? { title } : {}), slug: auto, slugIsCustom: false });
            if (!updated) return ownershipChanged(reply, id);
          } else {
            // 格 2：不寫 prev、不開交易（語句形狀守衛：恰一條 UPDATE）。
            [updated] = await deps.db
              .update(notes)
              .set({ updatedAt: UPDATED_AT_NOW, title, slug: sql`case when ${notes.slugIsCustom} then ${notes.slug} else ${auto} end` })
              .where(eq(notes.id, id))
              .returning();
          }
          break;
        } catch (err) {
          // 同格 1 的 constraint 名分流：兩把 slug 唯一索引撞名走重試，其他 23505 rethrow。
          if (isSlugUniqueViolation(err) && attempt <= MAX_AUTO_SLUG_RETRIES) continue;
          throw err;
        }
      }
      // I2：格 2 的 UPDATE 命中 0 列＝授權之後被刪。
      if (!updated) return noteNotFound(reply);
      return respondPatched(updated, access, userId);
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
     * `notes/tx/write-links.ts` 檔頭第 1 步）。
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

    /**
     * #175 §6.3 移動（T3）：個人筆記 → 群組。只有個人筆記的 owner（`permissions.moveToGroup`）；目標群組要
     * 成員＋can_create（交易前只驗 UUID 形；成員與旗標只在交易內、對群組列取 KEY SHARE 之後查，走 tx，S14）。
     * 非 UUID／不存在／非成員／無新建旗標／等鎖期間被刪 → 同一條 404
     * `group_not_found`（spec §6.3；與 `POST /api/notes` 的 403 不同——plan 規格落差 4）。
     * commit 後踢線：被清掉的逐人分享者 ∪ 呼叫者（owner→群組角色，重驗）。回 200 NoteDto（新網址形）；
     * `role`／`permissions` 照呼叫者在目標群組的角色實算（授權只看 can_create，搬完可能是 viewer——規格落差 17）。
     */
    app.post("/api/notes/:id/move", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const parsed = moveBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") return noteNotFound(reply);
      if (!access.permissions.moveToGroup) return sendError(reply, 403, "forbidden", "只有筆記擁有者可以把筆記移進群組");
      if (!UUID_RE.test(parsed.data.groupId)) return sendError(reply, 404, "group_not_found", "找不到此群組");

      // S14：callback 整段就是 `moveNoteToGroupInTx(tx, …)`，引數是交易前備好的純資料與測試縫。
      const input = { noteId: id, userId, userHandle: request.user!.handle, groupId: parsed.data.groupId.toLowerCase() };
      let moved;
      try {
        moved = await deps.db.transaction(tx => moveNoteToGroupInTx(tx, input, deps.groupTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // 防禦縱深：(1) 已持目標群組列的 KEY SHARE，群組在交易中刪不掉、UPDATE 不會撞 FK 23503；撞到也回同一條 404（catch 在交易外）。
        if (isForeignKeyViolation(err)) return sendError(reply, 404, "group_not_found", "找不到此群組");
        throw err;
      }
      deps.collabHooks.onGroupAccessChanged([id], [...new Set([...moved.removedShareUserIds, userId])]);
      const fresh = await loadNoteWithOwner(id);
      if (!fresh) return noteNotFound(reply);
      return authorizeRow(reply, userId, fresh);
    });

    /**
     * #175 §6.5 複製（T4）：看得到就能複製；目標個人一律可，群組要成員＋can_create（非 UUID／不存在／非成員／無新建
     * 旗標同一條 404 `group_not_found`——規格落差 4）。群組目標查兩次：這裡交易外的 `loadCreateTarget` 只是快速 404；
     * 授權本身在 `copyNoteInTx` (g) 持目標 groups KEY SHARE 後重驗（review r1 I-1，與 `lockGroup` 互斥，不是 C8 那種交易外
     * 窗口；鎖序與成環分析在 `notes/tx/copy.ts` 檔頭），DTO 的角色／群組名也取 (g) 交易內讀到的值（review r2 M-2）。節流：edit 桶（Q16）。
     * 快照在交易**之前**讀（`loadNoteDoc` 借連線，S14／gate r2 M-6）。commit 後：以複製者身分寫副本的出向
     * note_links（`syncLinksFromDoc`）。複製不踢任何人（§7）。回 201 NoteDto（副本）：`role`／`permissions` 由目標推得
     * ——個人＝owner；群組＝照呼叫者角色旗標實算（授權只看 can_create，create-only 角色得 viewer——規格落差 17）。
     */
    app.post("/api/notes/:id/copy", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const parsed = copyBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return sendError(reply, 400, "invalid_body", parsed.error.issues[0]?.message ?? "請求格式錯誤");

      // 看得到就能讀（規格落差 16：role 非 none ⇒ permissions.read 恆真），不另看 read 旗標。
      if ((await resolveNoteAccess(deps.db, userId, id)).role === "none") return noteNotFound(reply);

      let scope: SlugScope;
      const groupId = parsed.data.groupId;
      if (groupId === undefined) {
        scope = { ownerId: userId };
      } else {
        if (!UUID_RE.test(groupId)) return sendError(reply, 404, "group_not_found", "找不到此群組");
        // 快速 404 only：結果不用來組 DTO（降級可能落在這裡與 (g) 之間——review r2 M-2）。
        const m = await loadCreateTarget(userId, groupId.toLowerCase());
        if (!m || !m.canCreate) return sendError(reply, 404, "group_not_found", "找不到此群組");
        scope = { groupId: groupId.toLowerCase() };
      }
      if (!deps.limiters.edit.consume(userId)) return sendError(reply, 429, "too_many_requests", "寫入過於頻繁");

      const { doc: snapshot } = await loadNoteDoc({ db: deps.db, collab: deps.collab }, id);
      const copy = cloneForCopy(snapshot);
      // #175 T4 M-1（Willie 裁決）：複製會多存一份附件檔，依「會被複製的附件數」扣 upload 桶（與上傳端點同桶、同 429 形；
      // 單位＝檔案數，同上傳端點一次一檔）。數法與 `copyNoteInTx` (3) 同一個述詞（文件引用到、且 `note_id`＝來源）；交易前
      // 數、交易內再讀，兩次之間來源新增／刪除附件會讓扣的數與實際複製的差幾張，磁碟檔已遺失而被跳過的那張（RF4）也照扣——
      // 都只在「多扣或少扣幾張」的量級，不值得為此把扣桶搬進交易。0 張不碰桶。額度不足 → 429、不做任何寫入（edit 桶已扣）。
      const wanted = [...copy.uploadNodes.keys()];
      const toCopy = wanted.length === 0
        ? 0
        : (await deps.db.select({ n: sql<number>`count(*)::int` }).from(uploads).where(and(inArray(uploads.id, wanted), eq(uploads.noteId, id))))[0]!.n;
      if (!deps.limiters.upload.consumeMany(userId, toCopy)) return sendError(reply, 429, "too_many_requests", "請求過於頻繁，請稍後再試");
      // S14：callback 整段就是 `copyNoteInTx(tx, …)`，引數是交易前備好的純資料（`copiedFileIds` 是 out 參數）與測試縫。
      const copiedFileIds: string[] = [];
      const input = { sourceId: id, userId, scope, copy, uploadsDir: deps.uploadsDir, copiedFileIds };
      let created;
      try {
        created = await deps.db.transaction(tx => copyNoteInTx(tx, input, deps.groupTestHook, deps.noteCreateHooks));
      } catch (err) {
        // 交易已 rollback（uploads 列不在了）：best-effort 刪掉已落盤的新檔，失敗只記 log。
        await deleteUploadFiles(deps.uploadsDir, copiedFileIds, request.log);
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        if (isForeignKeyViolation(err)) {
          // 防禦縱深：群組目標在 (g) 已持 groups KEY SHARE，群組在交易中刪不掉，INSERT 不會撞 FK 23503；撞到也回同一條 404。
          if ("groupId" in scope) return sendError(reply, 404, "group_not_found", "找不到此群組");
          // 個人目標唯一可能的 23503 是 notes.owner_id／uploads.uploader_id → users（複製者帳號在交易中被硬刪；`src/` 目前
          // 沒有這條路徑）。個人建立路徑沒有對應的錯誤形（它把 23503 一律當群組被刪），這裡不借用 `group_not_found`
          // （詞不對題，review r1 M-3），回通用 404 `not_found`——對已不存在的帳號而言，「找不到」是最不誤導的答案。
          return noteNotFound(reply);
        }
        throw err;
      }
      const { note: createdNote, target } = created;
      await syncLinksFromDoc({ db: deps.db, log: request.log }, { sourceNoteId: createdNote.id, userId, doc: copy.doc, clock: docClock(copy.doc) });
      // role／permissions 取 (g) 交易內、持 groups KEY SHARE 時讀到的值（與 `lockGroup` 互斥，讀到即 commit 時的值）；
      // 群組名不受此保證：改名走單句 UPDATE、不與 KEY SHARE 衝突，回應可能是舊名。
      const dto = target === null
        ? toNoteDto({ ...createdNote, ownerHandle: request.user!.handle, editorHandle: null, groupName: null }, { role: "owner", permissions: OWNER_PERMISSIONS })
        : toNoteDto({ ...createdNote, ownerHandle: null, editorHandle: null, groupName: target.name }, { role: roleFromGroupFlags(target), permissions: groupNotePermissions(target) });
      return reply.code(201).send(dto);
    });

    app.delete("/api/notes/:id", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      // #175 §6.2 row 15：個人＝owner；群組＝角色的刪除旗標。
      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (!access.permissions.delete) {
        return sendError(reply, 403, "forbidden", "沒有刪除這篇筆記的權限");
      }

      // Plan 2 接縫：關閉/flush 該文件所有進行中的即時協作連線，必須在刪除交易「之前」
      // 完成並 await——若交易先跑，Hocuspocus 端可能在文件已經被刪除之後才嘗試 flush，
      // 落地到一筆孤兒 note_states/note_state_backups（或對已刪除 noteId 的外鍵失敗）。
      // Plan 1 這裡注入的是 noopCollabHooks，本身不做任何事；此呼叫只是先把接縫留好。
      const deleteGate = await deps.collabHooks.beforeNoteDeleted(id);

      // #175 T14：交易本體在 `notes/tx/delete-notes.ts`（S14；PR4 全刪共用）。引數是交易前備好的純資料。
      // 交易內只確定「哪些 upload 列被刪了」（`deleteNotesInTx` 的 `returning`），實際的
      // 磁碟檔案刪除留到 commit 之後才動手——DB rollback 救不回已經被刪掉的檔案，兩件
      // 事不可合併在同一個交易語意下（見 `deleteUploadFiles` 的完整說明）。
      // 交易失敗一定要把閘門收回去（見 `NoteDeleteGate`）：閘門開著的兩分鐘內，這篇筆記的
      // 新連線會被告知「已刪除」並被導離，而它其實還在。
      const ids = [id];
      const deletedUploadIds = await deps.db
        .transaction(tx => deleteNotesInTx(tx, ids))
        .catch((err: unknown) => {
          deleteGate.release();
          throw err;
        });

      // best-effort，commit 之後才動磁碟：單一檔案刪除失敗（含檔案本來就已經不存在）
      // 只記 log，不影響這支 request 的成功回應——DB 端已經確定 commit 成功，這才是
      // 呼叫端真正在意的結果（見 `deleteUploadFiles` 的完整說明）。
      await deleteUploadFiles(deps.uploadsDir, deletedUploadIds, request.log);

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

    // 以下三支分享管理路由全部 authenticate：none → 404 not_found（不洩漏「note 是否存在」給無權限者，與其他
    // notes 路由的防列舉原則一致）；查得到但沒有 `permissions.manageShares` → 403 forbidden。
    // #175：`permissions.manageShares`——只有個人筆記的 owner；群組筆記一律 403（S5；v1 的「群組筆記放行 DELETE」
    // 修復路徑消失，spec §15 第 4 條）。
    app.get("/api/notes/:id/shares", { preHandler: app.authenticate }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (!access.permissions.manageShares) {
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

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (!access.permissions.manageShares) {
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

      // #175 S14（T2）：交易本體在 `notes/tx/shares.ts`（S5 的 `FOR SHARE` 讀 `group_id` 也在那裡）。引數只放
      // 識別字／屬性存取／物件字面——值都在上面 await 完了。
      await deps.groupTestHook?.("share-authorized", { noteId: id });
      try {
        await deps.db.transaction(tx => upsertShareInTx(tx, { noteId: id, targetUserId: target.id, role: parsed.data.role }, deps.groupTestHook));
      } catch (err) {
        if (err instanceof TxAbort) return sendError(reply, err.status, err.errCode, err.message);
        // I2（審查）：resolveRole／email 查找完成到這個 insert 之間存在競態視窗——note
        // 可能被 owner 自己在另一個分頁同時 DELETE 掉（note_shares.note_id 的 FK），或
        // target user 剛好被管理員刪除／停用流程清掉（note_shares.user_id 的 FK，若
        // 未來 users 刪除不再只是 soft delete）——兩種都會讓這個 insert 撞上
        // foreign_key_violation，而不是「權限判斷落後於實際狀態」以外的真正伺服器錯誤。
        // 這裡 catch 住 FK violation 並映射成 404 not_found——不特別區分是 note 還是 user
        // 消失，避免對 owner 洩漏「到底是哪一邊被刪除」的細節。#103：catch 在交易**外**
        // （交易內撞錯會進 aborted 狀態）。
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

      const access = await resolveNoteAccess(deps.db, userId, id);
      if (access.role === "none") {
        return sendError(reply, 404, "not_found", "找不到此筆記");
      }
      if (!access.permissions.manageShares) {
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
     * /public-link/slug，見下）——合計五支，授權看 `permissions.managePublicLink`（個人＝owner、群組＝角色旗標，
     * #175）且共用 `resolvePublicLinkAccess`，錯誤慣例照 shares：none → 404（不可分辨存在性）、
     * 可讀但沒有該權限 → 403。
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
    const resolvePublicLinkAccess = async (reply: FastifyReply, userId: string, noteId: string): Promise<NoteAccess | null> => {
      const access = await resolveNoteAccess(deps.db, userId, noteId);
      if (access.role === "none") {
        sendError(reply, 404, "not_found", "找不到此筆記");
        return null;
      }
      if (!access.permissions.managePublicLink) {
        sendError(reply, 403, "forbidden", "沒有管理公開連結的權限");
        return null;
      }
      return access;
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
      const access = await resolvePublicLinkAccess(reply, userId, id);
      if (!access) return reply;
      const token = randomBytes(32).toString("base64url");
      // I2 慣例：UPDATE 落空＝筆記在判定後被刪，回 404——否則回 200＋一顆從未落地
      // 的 token（owner 複製到必死連結）。重生**不動別名**（spec §4 並存語意）——
      // returning 帶回現行 publicSlug 湊全形回應。
      // #175 C13（§6.6 gate r1 M2）：述詞帶授權時讀到的歸屬（`group_id IS NOT DISTINCT FROM $授權時`）——授權之後
      // 被移進／移出群組（PR2）時 UPDATE 落空，不把 token 寫到授權時沒看過的那一種筆記上。
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      const updated = await deps.db
        .update(notes)
        .set({ publicToken: token })
        .where(and(eq(notes.id, id), sql`${notes.groupId} is not distinct from ${access.groupId}`))
        .returning({ id: notes.id, publicSlug: notes.publicSlug });
      if (updated.length === 0) return ownershipChanged(reply, id);
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
      // #175 §6.6：群組筆記沒有公開網址（S11 `notes_group_no_public_slug_chk`）——述詞加 `group_id IS NULL`。主要形不需要
      // 競態：有 `managePublicLink` 的成員對**已開 token** 的群組筆記打這支，沒有這條件 `public_token IS NOT NULL` 為真、
      // UPDATE 撞 CHECK → 500；有了就落空成 400。C14 是它的競態形：授權之後被移進群組（且群組又重開了 token）（gate r2 A-12）。
      await deps.groupTestHook?.("public-link-authorized", { noteId: id });
      let updated;
      try {
        updated = await deps.db
          .update(notes)
          .set({ publicSlug: result.value })
          .where(and(eq(notes.id, id), sql`${notes.publicToken} is not null`, isNull(notes.groupId)))
          .returning({ publicToken: notes.publicToken, publicSlug: notes.publicSlug });
      } catch (err) {
        // constraint 名分流（比照 slug_taken）：只認 per-user 別名唯一索引，其他 23505 rethrow。
        if (uniqueViolationConstraint(err) === "notes_owner_public_slug_idx") {
          return sendError(reply, 409, "public_slug_taken", "此公開網址已被你的另一篇筆記使用");
        }
        throw err;
      }
      if (updated.length === 0) {
        return sendError(reply, 400, "invalid_body", "筆記尚未開啟公開分享，或它是群組筆記（群組筆記沒有公開網址），無法設定公開網址");
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
