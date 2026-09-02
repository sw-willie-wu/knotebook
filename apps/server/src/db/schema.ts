import { pgTable, uuid, text, timestamp, boolean, integer, bigint, jsonb, customType, primaryKey, uniqueIndex, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EncryptedApiKey } from "../ai/crypto.js";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  // #122：URL 用的使用者名（/n/<handle>/…）。反正規化副本——配置的唯一裁決者是
  // `handles` registry（見下），這欄供 JOIN 與回應組裝。DB default 有兩個承重理由：
  // ①回滾兜底（0006 之後退回舊映像，舊碼 insert 不帶 handle 仍能建帳）；②大量既有
  // 整合測試直接 db.insert(users) 不帶 handle——沒有 default，drizzle 的 insert 型別
  // 會把它變必填、整套 typecheck 全紅（plan gate 注意事項 8）。
  // `.unique()` 產出的 constraint 名 `users_handle_unique` 是錯誤判別契約的鍵
  // （handle_taken vs email_taken 靠 constraint 名分流）——**不得改成 uniqueIndex()**
  // （那會產 CREATE UNIQUE INDEX，pg 錯誤帶回的名字就不在判別白名單裡）。
  handle: text()
    .notNull()
    .unique()
    .default(sql`'user-' || substr(gen_random_uuid()::text, 1, 8)`),
  passwordHash: text("password_hash"),
  oidcIssuer: text("oidc_issuer"),
  oidcSub: text("oidc_sub"),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  isAdmin: boolean("is_admin").notNull().default(false),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  tokenVersion: integer("token_version").notNull().default(0),
  // 首登強制改密碼（spec rev 5.7 / §14.2）：env bootstrap 建立的 admin、admin UI 代建的
  // 帳號皆掛 true；OIDC 自動建帳維持 false（DB 預設）。
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("users_oidc_idx").on(t.oidcIssuer, t.oidcSub),
  // issue #18：email 比對全面走 `lower(users.email) = $1`（登入、分享查人、OIDC 連結，
  // 見 routes/auth.ts、routes/notes.ts、routes/oidc.ts）——沒有這個 functional index
  // 每一次都是全表掃描。⚠ **刻意非唯一**：目前允許大小寫不同的重複列存在，OIDC 的
  // 多列偵測（`oidc_conflict`）依賴這個前提（docs/known-limitations.md）；改成
  // uniqueIndex 會讓那條路徑從「可偵測的衝突」變成「寫入直接炸」。migrate.test.ts
  // 有測試釘住「存在且非唯一」。
  index("users_email_lower_idx").on(sql`lower(${t.email})`),
]);

/**
 * #122：handle 配置的**唯一裁決者**（單一 registry，PK 裁決恰好一次——比照
 * [[ai-provider-key-exfil]] 的「判斷必須在 DB 端做」紀律）。取名＝`INSERT INTO handles`
 * （含墓碑：`released` 列**永久**占住 PK，改名釋放的舊名任何人（含本人）不得再取）。
 * 三條建帳路徑一律 registry-first（同 tx 內先 INSERT handles 再 INSERT users）。
 *
 * `user_id` **刻意無 `.references()`**（repo 慣例是 uuid 都掛 FK——這裡是明示例外，
 * spec §2a）：①registry-first 順序下 handles 列先於 users 列插入，掛 FK 三條建帳
 * 路徑全死；②產品無刪使用者功能，且墓碑列本就必須活得比使用者久。
 * CHECK 三條都是結構層不變量：charset/長度、state 枚舉、released_at↔state 一致
 * （第三條漏了會讓改名額度的 `state='released'` 計數漏算）。
 */
export const handles = pgTable(
  "handles",
  {
    handle: text().primaryKey(),
    userId: uuid("user_id").notNull(),
    state: text().notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  t => [
    check("handles_handle_chk", sql`${t.handle} ~ '^[a-z0-9-]{1,32}$'`),
    check("handles_state_chk", sql`${t.state} in ('live','released')`),
    check("handles_released_at_chk", sql`(${t.state} = 'released') = (${t.releasedAt} is not null)`),
    // 改名額度查詢（Task 4：WHERE user_id=$me AND state='released' AND released_at>…）
    // 的反向索引——比照 note_shares_user_idx 的慣例（讀碼審查 minor 7）。
    index("handles_user_idx").on(t.userId),
  ],
);

export const instanceSetup = pgTable("instance_setup", {
  singleton: boolean().primaryKey().default(true),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("instance_setup_singleton_chk", sql`${t.singleton}`)]);

export const notes = pgTable("notes", {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  title: text().notNull().default("Untitled"),
  // 網址代稱（#122 spec §3a 起 per-user）：NOT NULL——auto（slug_is_custom=false，跟標題
  // 走、由 autoSlugFromTitle 派生＋owner 範圍去重）或自訂（=true，PATCH 顯式設定）。
  // 唯一範圍是 `(owner_id, slug)`（notes_owner_slug_idx），不再全域。存進來的值一律已過
  // `normalizeSlug`（NFC + 小寫）。DB default 兩個承重理由（比照 users.handle）：①回滾
  // 兜底（0007 之後退回舊映像，舊碼 POST 不帶 slug 仍能建列）；②既有測試 db.insert(notes)
  // 不帶 slug——沒有 default，drizzle insert 型別會把它變必填。
  slug: text()
    .notNull()
    .default(sql`'untitled-' || substr(gen_random_uuid()::text, 1, 8)`),
  // slug 是否為使用者顯式自訂：false＝auto（title PATCH 會重算）、true＝PATCH {slug:string}
  // 設定過（title 變更不動 slug；{slug:null} 翻回 false）。
  slugIsCustom: boolean("slug_is_custom").notNull().default(false),
  // 單層自訂 redirect（spec §3a：只記「自訂變更」——custom→custom 與 custom→auto；auto
  // 重算不寫，否則打字殘影會灌出 untitled 洪水）。查找走 notes_owner_prev_slug_idx。
  prevSlug: text("prev_slug"),
  // 0007 當下的舊全域 slug 凍結快照——舊形 `/notes/<slug>` 永久相容的唯一資料來源。
  // **不可變**：任何 UPDATE 改動它會被 DB trigger `notes_legacy_slug_guard`（0007 手寫
  // SQL，drizzle schema 表達不了）RAISE EXCEPTION 擋下；日後維護/migration 要動它必須
  // 先 DROP TRIGGER。新列恆 NULL。
  legacySlug: text("legacy_slug"),
  // #72 公開分享連結：`base64url(randomBytes(32))`（43 字元）。**存原文不存 hash**
  // ——token 授權的 note_states 與它同一個 DB，hash 化不改變攻擊者能力邊界，而
  // 「owner 隨時可複製現行連結」是產品需求（spec D1；與 AI 金鑰不同，那是第三方
  // 憑證）。代價由兩條紀律扛——**皆由同 PR 的 Task 1b/1c commit 落地**：公開端點
  // 格式 guard 先行（1b）、token 不進 log 的 req serializer（1c）；在那之前 token
  // 只出現在管理端 response body，不經 URL。NULL＝未開公開。
  publicToken: text("public_token"),
  // #122 PR3 公開別名（/p/<handle>/<slug>）：顯式 opt-in、與私人 slug 完全獨立的
  // 命名空間（同 owner 的別名可撞自己的私人 slug）。NULL＝未設。「只有已公開
  // （public_token 非 NULL）的筆記能設別名」是**應用層不變量、DB 層不強制**（直插
  // 殘留形是合法列——正是讀取端拿來測兜底的形），**由 PR3 Task 2 落地**：條件式
  // UPDATE（WHERE ... AND public_token IS NOT NULL）＋DELETE public-link 的同一支
  // UPDATE 連帶清空；公開讀取端另以 JOIN 述詞含 token 非空兜底（Task 3）。
  publicSlug: text("public_slug"),
  linksClock: bigint("links_clock", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),   // 保留欄位；v0.1 硬刪
}, t => [
  index("notes_owner_idx").on(t.ownerId),   // GET /api/notes 自有分支（owner_id = $u）用
  // per-user 唯一（#122）：同 owner 不重複、跨 owner 可同名。PATCH 的 slug 寫入
  // 不 pre-check，交給這把索引裁決（自訂→409 slug_taken；auto→重探測重發）。
  uniqueIndex("notes_owner_slug_idx").on(t.ownerId, t.slug),
  // 舊形 `/notes/<slug>` 查找專用；快照值繼承自舊全域唯一索引，故全域唯一仍成立
  // （trigger 保證不再變動、新列 NULL 不佔位）。
  uniqueIndex("notes_legacy_slug_idx").on(t.legacySlug).where(sql`${t.legacySlug} is not null`),
  // by-path miss 後的 prev_slug 補查（0 或 >1 命中一律 404）——非唯一（同 owner 的多篇
  // 筆記可能先後釋放同一個名字），>1 的判定靠查詢端。
  index("notes_owner_prev_slug_idx").on(t.ownerId, t.prevSlug).where(sql`${t.prevSlug} is not null`),
  // 公開端點以 token 反查筆記用；partial＝NULL 彼此不衝突。
  uniqueIndex("notes_public_token_idx").on(t.publicToken).where(sql`${t.publicToken} is not null`),
  // 公開別名 per-user 唯一（#122 PR3）：同 owner 不重複、跨 owner 可同名；constraint
  // 名是管理端 409 public_slug_taken 的分流依據。partial＝未設別名不佔位。
  uniqueIndex("notes_owner_public_slug_idx").on(t.ownerId, t.publicSlug).where(sql`${t.publicSlug} is not null`),
]);

export const noteStates = pgTable("note_states", {
  noteId: uuid("note_id").primaryKey().references(() => notes.id, { onDelete: "cascade" }),
  ydoc: bytea().notNull(),
  version: integer().notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const noteStateBackups = pgTable("note_state_backups", {
  id: uuid().primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  ydoc: bytea().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("nsb_note_created_idx").on(t.noteId, t.createdAt)]);

export const noteShares = pgTable("note_shares", {
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),   // N10：CASCADE
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.noteId, t.userId] }),
        check("note_shares_role_chk", sql`${t.role} in ('viewer','editor')`),
        // GET /api/notes 被分享分支（JOIN ... ON user_id = $u）用——(note_id, user_id) 的 PK
        // 已能服務「查某 note 的分享名單」，但反向「查某 user 被分享的所有 note」需要
        // user_id 開頭的獨立索引，否則會退化成全表掃描。
        index("note_shares_user_idx").on(t.userId)]);

export const noteLinks = pgTable("note_links", {
  sourceNoteId: uuid("source_note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  targetNoteId: uuid("target_note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.sourceNoteId, t.targetNoteId] }),
        index("note_links_target_idx").on(t.targetNoteId)]);

export const uploads = pgTable("uploads", {
  id: uuid().primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "set null" }),
  mime: text().notNull(),
  size: integer().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("uploads_note_idx").on(t.noteId)]);   // DELETE /api/notes/:id 交易內 `WHERE note_id = $1` 用

export const aiProviders = pgTable("ai_providers", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  type: text().notNull(),
  baseUrl: text("base_url").notNull(),
  // 純型別鎖定（Task 4 交接）：無 migration 影響，只讓 drizzle 推斷出的 TS 型別是
  // `EncryptedApiKey | null` 而非 `unknown | null`，讓 `runtime.ts`/`admin-ai.ts` 不必
  // 各自 `as EncryptedApiKey` cast——執行期仍是裸 jsonb，實際存入的值是否真的符合這個
  // 形狀不受此型別註記保護（`decryptApiKey` 對壞資料的防禦性檢查因此仍然必要，見該檔）。
  apiKeyEncrypted: jsonb("api_key_encrypted").$type<EncryptedApiKey>(),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("ai_providers_type_chk", sql`${t.type} in ('openai_compatible','anthropic')`)]);

export const aiModels = pgTable("ai_models", {
  id: uuid().primaryKey().defaultRandom(),
  providerId: uuid("provider_id").notNull().references(() => aiProviders.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  displayName: text("display_name").notNull(),
  purpose: text().notNull().default("chat"),
  isDefault: boolean("is_default").notNull().default(false),
  enabled: boolean().notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("ai_models_provider_model_idx").on(t.providerId, t.modelId),
        check("ai_models_purpose_chk", sql`${t.purpose} in ('chat','embedding')`)]);

export const aiActions = pgTable("ai_actions", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  systemPrompt: text("system_prompt").notNull(),
  userTemplate: text("user_template").notNull(),
  modelId: uuid("model_id").references(() => aiModels.id, { onDelete: "set null" }),
  applyMode: text("apply_mode").notNull().default("preview"),
  sortOrder: integer("sort_order").notNull().default(0),
  enabled: boolean().notNull().default(true),
}, t => [check("ai_actions_apply_mode_chk", sql`${t.applyMode} in ('direct','preview')`)]);

/**
 * #107／#132：OAuth client（由 Dynamic Client Registration 建立）。
 *
 * **#130 完全不寫這張表**——四張表一次建齊只是為了讓 #132 不必再開一次 migration，
 * 空表無害；結構守衛在 `test/migrate.test.ts` 的 `0009_api-tokens` 那個 describe。
 *
 * `client_name` 是 client **自述、未經驗證**的字串，而且會渲染在同意頁上——它是
 * 「只收 loopback redirect」之外唯一的釣魚防線。DCR 是免認證端點，所以長度在 DB 端
 * 就擋（1..64，與 DCR 端點的 zod 同一個數字）：無上限的話，一個 1 MB 的名字會一路進 DB、進同意頁 DOM、再進
 * `api_tokens.name` 的快照與每一次 `GET /api/auth/tokens` 的回應。
 * ⚠ **控制字元／bidi 覆寫的過濾在 DCR 端點做（#132），DB 只管長度與形狀**。
 *
 * `redirect_uris` 只在 DB 端保證「是 1..8 個元素的 JSON 陣列」；**loopback-only 的
 * 判定在 DCR 端點**（要解析 URL，SQL 表達不了），別以為有東西在 DB 擋。
 *
 * `client_id` 是 server 自產的隨機值，故**刻意沒有** `handles.handle` 那種形狀
 * CHECK：那條是用來擋使用者輸入的，這裡沒有使用者輸入。
 *
 * `last_used_at` 是 **NOT NULL DEFAULT now()**，與 `api_tokens.last_used_at`（nullable，
 * NULL＝從未使用）**刻意相反**：#132 的清理拿它跟「30 天前」比，用 NOT NULL 才不必在
 * 述詞裡處理 NULL；而 `api_tokens` 那邊要在設定頁顯示「從未使用」，需要分辨得出來。
 */
export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientName: text("client_name").notNull(),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("oauth_clients_name_chk", sql`length(${t.clientName}) between 1 and 64`),
    check(
      "oauth_clients_redirect_uris_chk",
      sql`jsonb_typeof(${t.redirectUris}) = 'array' and jsonb_array_length(${t.redirectUris}) between 1 and 8`
    ),
  ]
);

/**
 * #107：API token（grant）。PAT 與 OAuth 授權共用同一張表、同一條 Bearer 驗證、
 * 同一份設定頁列表——`kind` 是唯一的分野。合表的理由：一條 Bearer 查詢、一份設定頁
 * 列表、一個撤銷端點；拆兩張表要換來 UNION 查詢與兩套撤銷路徑。代價是三個 nullable
 * 欄，由下面四條 CHECK 在 DB 端把非法組合擋掉（判斷在 DB 端做，比照 ai_providers 的
 * 金鑰判定紀律）。
 *
 * `access_token_hash`／`refresh_token_hash` 存 sha256 hex，**明文不落任何儲存**：
 * 只在 `POST /api/auth/tokens` 的 201 與 #132 的 `/oauth/token` 200 出現一次。
 * `access_token_hash` 是**全域**唯一（不是 per-user）——Bearer 驗證是「拿 hash 查一列」，
 * 允許重複就會變成同一串明文對到兩個身分。熱路徑 `WHERE access_token_hash = $1` 走
 * 這條 UNIQUE 隱含的 btree，**不需要另建索引**。
 *
 * `access_expires_at` 對 PAT 可 NULL（預設不到期），對 oauth 由 CHECK 強制非 NULL
 * （access 24h，過期後只剩 refresh 能換發）。⚠ 認證述詞是「**非 NULL 且已過期**才拒」
 * ——寫成 `access_expires_at > now()` 會讓每支預設 PAT 全滅（Bearer 驗證在 #130 的後續
 * task 才落地，屆時的實作檔是 `auth/bearer.ts`）。
 *
 * `name` 對 PAT 是使用者自取（端點另以 zod 限 1..64），對 oauth 是
 * `oauth_clients.client_name` 的**快照**——client 之後改名，既有 grant 上的名字不會跟著
 * 動（比照 `users.handle` 的反正規化副本）。DB 的 1..64 與端點的 zod 是**同一個數字**：
 * CHECK 是繞過端點（migration／psql）時的兜底，不是另一套較寬的規則。⚠ 兩張表的
 * 上限必須一起改——`name` 是 `client_name` 的快照，這邊較嚴就會在複製時撞 CHECK。
 *
 * ⚠ **PAT 不受 `users.token_version` 撤銷保護**：那是「登出所有裝置」的機制，與這張表
 * 零關聯。使用者改密碼後 API token 仍然有效（刻意，比照 GitHub PAT），撤銷只能逐支
 * 刪列——這是最容易被當成 bug 回報的行為，#130 的 docs task 要把它寫進
 * `docs/api-tokens.md` 的安全提醒段（該檔此刻還不存在）。
 *
 * `api_tokens_oauth_user_client_uidx` 是「同一 (user, client) 只留一個 grant」的
 * **結構性保證**：#132 兩張並發 code 各自「先刪後插」的 race 由索引裁決，撞索引者回
 * `invalid_grant`。partial（`where kind='oauth'`）讓 PAT 完全不受約束。
 *
 * `api_tokens_refresh_chk` 順帶把「**每個 oauth grant 一定有 refresh token**」寫死成
 * 結構不變量。#132 若要發不帶 refresh 的短期 grant，得改這條 CHECK＝再開一支 migration。
 */
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    name: text().notNull(),
    scope: text().notNull(),
    accessTokenHash: text("access_token_hash").notNull().unique(),
    refreshTokenHash: text("refresh_token_hash").unique(),
    clientId: text("client_id").references(() => oauthClients.clientId, { onDelete: "cascade" }),
    accessExpiresAt: timestamp("access_expires_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("api_tokens_kind_chk", sql`${t.kind} in ('pat','oauth')`),
    // 落庫形是正規化過的**集合**字串（`normalizeScope` 的兩個輸出），不是裸的單值。
    check("api_tokens_scope_chk", sql`${t.scope} in ('notes:read','notes:read notes:write')`),
    check("api_tokens_name_chk", sql`length(${t.name}) between 1 and 64`),
    // 兩條都是**雙向**蘊含：pat ⇔ 沒有 client／refresh，oauth ⇔ 兩者都有。單向版
    // （只擋 pat 那半邊）會讓 #132 少塞一欄時靜默放行半截列——測試四格矩陣都釘住了。
    check("api_tokens_client_chk", sql`(${t.kind} = 'pat') = (${t.clientId} is null)`),
    check("api_tokens_refresh_chk", sql`(${t.kind} = 'pat') = (${t.refreshTokenHash} is null)`),
    check("api_tokens_oauth_expiry_chk", sql`${t.kind} = 'pat' or ${t.accessExpiresAt} is not null`),
    index("api_tokens_user_idx").on(t.userId),
    // FK 的支撐索引（比照 note_shares_user_idx／uploads_note_idx 的既有慣例）：
    // 刪一個 oauth client 會 CASCADE 掃這張表，而 oauth_user_client_uidx 的前導欄是
    // user_id，服務不了 `WHERE client_id = $1`。
    index("api_tokens_client_idx").on(t.clientId),
    uniqueIndex("api_tokens_oauth_user_client_uidx")
      .on(t.userId, t.clientId)
      .where(sql`${t.kind} = 'oauth'`),
  ]
);

/**
 * #132：pending authorization request（同意頁只認它的 id，不認散裝參數）。#130 不寫。
 *
 * `state` 原樣存原樣回——RFC 6749 §4.1.2 要求回 client 送來的 exact value，**不得截斷**；
 * 2048 的上限擋的是「client 送一個超大 state 把表撐爆」。
 *
 * `code_challenge` **只存值、不存 method**：#132 的 `/authorize` 只接受
 * `code_challenge_method=S256`，`plain` 直接回 `invalid_request`（`plain` 等於沒有
 * PKCE）。因此不需要 method 欄——**別看到裸的 code_challenge 就以為可以存 plain**。
 *
 * `id` 是 server 自產的隨機值，同 `oauth_clients.client_id`，刻意沒有形狀 CHECK。
 *
 * #132 的清理是 `DELETE ... WHERE expires_at < now()`，**刻意不建 expires_at 索引**：
 * 表恆小（10 分鐘到期）且清理會刪掉大比例的列，planner 本來就會選 seq scan。
 */
export const oauthRequests = pgTable(
  "oauth_requests",
  {
    id: text().primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    scope: text().notNull(),
    state: text(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  t => [
    check("oauth_requests_scope_chk", sql`${t.scope} in ('notes:read','notes:read notes:write')`),
    check("oauth_requests_state_chk", sql`${t.state} is null or length(${t.state}) <= 2048`),
    index("oauth_requests_client_idx").on(t.clientId),
  ]
);

/**
 * #132：authorization code（10 分鐘）。#130 不寫。
 *
 * `redirect_uri` 存 authorize **當次**送來的完整值（含 ephemeral port）——token 換發是
 * 跟這個當次值逐字比對，不是跟註冊值比。`code_challenge` 同 `oauth_requests`：只有 S256。
 *
 * ⚠ 「單次消費」是**應用層**不變量，DB 層不強制：#132 用 `DELETE ... RETURNING` 消費，
 * 沒有 `used_at` 欄。代價是**分辨不出「code 被重放」與「code 從不存在／已過期」**，因此
 * 實作不了 RFC 6749 §4.1.2 建議的「偵測 code reuse → 撤銷該次授權已發出的 token」。
 * 這是刻意的取捨（PKCE 已讓攔截到的 code 無法兌換），#132 要把它補進
 * `docs/known-limitations.md`（該檔目前還沒有這一條）；
 * 要改成偵測得出來，就得加 `used_at` 欄＝再開一支 migration。
 *
 * 清理同 `oauth_requests`：全表掃描，刻意不建 expires_at 索引。
 */
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scope: text().notNull(),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  t => [
    check("oauth_codes_scope_chk", sql`${t.scope} in ('notes:read','notes:read notes:write')`),
    index("oauth_codes_client_idx").on(t.clientId),
    index("oauth_codes_user_idx").on(t.userId),
  ]
);
