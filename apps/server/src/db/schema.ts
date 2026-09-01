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
  // 自訂網址代稱（spec §11.4）：全域唯一但可為 NULL（未設定），且多筆 NULL 彼此不視為
  // 衝突——一般 unique index 會把 NULL 當作互異值處理（符合我們要的語意），但寫成
  // partial index `WHERE slug IS NOT NULL` 更明確表達意圖，也讓索引本身更小。存進來的
  // 值一律已經過 `normalizeSlug`（NFC + 小寫），查找（GET /api/notes/:ref）與寫入
  // （PATCH）都用正規化後的字串比對，不依賴 pg collation 做大小寫/正規化處理。
  slug: text(),
  // #72 公開分享連結：`base64url(randomBytes(32))`（43 字元）。**存原文不存 hash**
  // ——token 授權的 note_states 與它同一個 DB，hash 化不改變攻擊者能力邊界，而
  // 「owner 隨時可複製現行連結」是產品需求（spec D1；與 AI 金鑰不同，那是第三方
  // 憑證）。代價由兩條紀律扛——**皆由同 PR 的 Task 1b/1c commit 落地**：公開端點
  // 格式 guard 先行（1b）、token 不進 log 的 req serializer（1c）；在那之前 token
  // 只出現在管理端 response body，不經 URL。NULL＝未開公開。
  publicToken: text("public_token"),
  linksClock: bigint("links_clock", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),   // 保留欄位；v0.1 硬刪
}, t => [
  index("notes_owner_idx").on(t.ownerId),   // GET /api/notes 自有分支（owner_id = $u）用
  uniqueIndex("notes_slug_idx").on(t.slug).where(sql`${t.slug} is not null`),
  // 公開端點以 token 反查筆記用；partial＝NULL 彼此不衝突（比照 notes_slug_idx）。
  uniqueIndex("notes_public_token_idx").on(t.publicToken).where(sql`${t.publicToken} is not null`),
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
