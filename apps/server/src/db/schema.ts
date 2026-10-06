import { pgTable, uuid, text, timestamp, boolean, integer, bigint, jsonb, customType, primaryKey, uniqueIndex, index, check, foreignKey } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { EncryptedApiKey } from "../ai/crypto.js";
import type { EncryptedSecret } from "../lib/sealed-secret.js";
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
  // #187：舊欄，0014 起只剩 §10.3 補登讀它、PR3 解除連結清它；下個 release 刪（B11）。新碼一律走 `user_identities`。
  oidcIssuer: text("oidc_issuer"),
  oidcSub: text("oidc_sub"),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  isAdmin: boolean("is_admin").notNull().default(false),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  tokenVersion: integer("token_version").notNull().default(0),
  // 首登強制改密碼（spec rev 5.7 / §14.2；#187 PR4 起 env bootstrap 管理員不再掛）：
  // 寫入端：只有 admin UI 代建時寫 true；OIDC 自動建帳與 env bootstrap 為 false。
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

/**
 * #187 §4.1：登入服務（OIDC provider）。`id` 由應用端先產（client secret 的 AAD 綁 id，§5.1）。
 * `resolved_issuer`＝最近一次 discovery 成功時的 `metadata.issuer`；所有 identity ↔ provider 比對一律用
 * `coalesce(resolved_issuer, issuer_url)`（effective issuer，`auth/oidc-providers.ts`）。CHECK 守 INV-1（啟用⇒有 secret）、
 * 長度上限（r3-M3：pending cookie 的大小上界靠它）；partial unique 守 INV-3（至多一個 legacy）。
 */
export const authProviders = pgTable(
  "auth_providers",
  {
    id: uuid().primaryKey(),
    template: text().notNull(),
    displayName: text("display_name").notNull(),
    issuerUrl: text("issuer_url").notNull(),
    resolvedIssuer: text("resolved_issuer"),
    clientId: text("client_id").notNull(),
    clientSecretEncrypted: jsonb("client_secret_encrypted").$type<EncryptedSecret>(),
    enabled: boolean().notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    legacyCallback: boolean("legacy_callback").notNull().default(false),
    configVersion: integer("config_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("auth_providers_template_chk", sql`${t.template} in ('gitlab', 'google', 'oidc')`),
    check("auth_providers_display_name_chk", sql`char_length(${t.displayName}) between 1 and 40`),
    check("auth_providers_issuer_url_chk", sql`${t.issuerUrl} ~ '^https?://' and char_length(${t.issuerUrl}) <= 512`),
    check("auth_providers_resolved_issuer_chk", sql`${t.resolvedIssuer} is null or char_length(${t.resolvedIssuer}) <= 512`),
    check("auth_providers_client_id_chk", sql`char_length(${t.clientId}) between 1 and 512`),
    check("auth_providers_enabled_secret_chk", sql`not ${t.enabled} or ${t.clientSecretEncrypted} is not null`),
    uniqueIndex("auth_providers_legacy_callback_idx").on(t.legacyCallback).where(sql`${t.legacyCallback}`),
  ],
);

/**
 * #187 §4.2：登入身分。身分鍵＝`(issuer, sub)`（全域唯一，INV-4）；不存 provider_id（B1）。
 * B2「同帳號同 issuer 一個 sub」在應用層判、序列化點是目標帳號的 users 列鎖（B16），不設 DB 約束。
 */
export const userIdentities = pgTable(
  "user_identities",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    issuer: text().notNull(),
    sub: text().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  t => [
    uniqueIndex("user_identities_issuer_sub_idx").on(t.issuer, t.sub),
    index("user_identities_user_idx").on(t.userId),
  ],
);

/**
 * #187 §4.3：站台設定（singleton，INV-6）。`registration_enabled` 一律預設開（W23）。
 * `password_login_enabled`（rev 10，W24）一律預設開；PR1 只建欄、不讀——行為全在 PR3（spec §9.5），PR1 期間 src 只准本檔命中它（§14.1 第 20 條）。
 */
export const siteSettings = pgTable(
  "site_settings",
  {
    singleton: boolean().primaryKey().default(true),
    registrationEnabled: boolean("registration_enabled").notNull().default(true),
    passwordLoginEnabled: boolean("password_login_enabled").notNull().default(true),
    legacyOidcEnvHandledAt: timestamp("legacy_oidc_env_handled_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [check("site_settings_singleton_chk", sql`${t.singleton}`)],
);

/**
 * #103（migration 0011）：群組。名稱不唯一（D9），長度 1..80 由 CHECK 守——pg 的 `length()`
 * 數的是字元（code point），應用層的 `validateGroupName`（`groups/queries.ts`）用同一個單位。
 * `created_by` 可為 null、`ON DELETE SET NULL`（A9）：建立者之後沒有任何特殊身分（D5），這欄只是紀錄。
 */
export const groups = pgTable("groups", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("groups_name_chk", sql`length(${t.name}) between 1 and 80`)]);

/**
 * #175（migration 0012）：群組角色。七旗標（spec §4.1）；內建兩個（`builtin` = admin／member，`name` 恆 NULL，
 * 顯示名走 i18n——Q19），自訂角色（`builtin` NULL、`name` 必填，`POST /api/groups/:id/roles` 建立，#175 PR3）。五條 CHECK：`builtin` 值域；
 * S8 的名稱兩條（內建恰無名、自訂恰有名；名稱 1..40 字）；S8／S10 的旗標兩條（內建管理員七旗標全真；四個筆記旗標
 * ⇒ 閱讀）——「新建 ⇒ 編輯」在 0013 拿掉（#175 PR3，Willie 裁決：自訂角色怎麼組合由管理者決定）。0013 拿掉 `group_roles_create_needs_edit_chk` 後實質不可逆：一旦有人建了 create-only 角色，要加回這條 CHECK 必須先修正那些資料。兩個管理旗標彼此獨立、也不蘊含閱讀（gate r2 M-4）——刻意沒有 CHECK。
 * `(group_id, id)` 唯一索引是 `group_members` 複合 FK 的目標（S7：成員的角色屬同一群組）。
 */
export const groupRoles = pgTable("group_roles", {
  id: uuid().primaryKey().defaultRandom(),
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  builtin: text(),
  name: text(),
  canRead: boolean("can_read").notNull().default(true),
  canCreate: boolean("can_create").notNull().default(false),
  canEdit: boolean("can_edit").notNull().default(false),
  canDelete: boolean("can_delete").notNull().default(false),
  canManagePublicLink: boolean("can_manage_public_link").notNull().default(false),
  canManageMembers: boolean("can_manage_members").notNull().default(false),
  canManageGroup: boolean("can_manage_group").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("group_roles_builtin_chk", sql`${t.builtin} in ('admin','member')`),
  check("group_roles_name_chk", sql`(${t.builtin} is null) = (${t.name} is not null)`),
  check("group_roles_name_len_chk", sql`${t.name} is null or length(${t.name}) between 1 and 40`),
  check("group_roles_admin_all_chk", sql`${t.builtin} is distinct from 'admin' or (${t.canRead} and ${t.canCreate} and ${t.canEdit} and ${t.canDelete} and ${t.canManagePublicLink} and ${t.canManageMembers} and ${t.canManageGroup})`),
  check("group_roles_read_implied_chk", sql`${t.canRead} or not (${t.canCreate} or ${t.canEdit} or ${t.canDelete} or ${t.canManagePublicLink})`),
  uniqueIndex("group_roles_group_id_id_idx").on(t.groupId, t.id),
  uniqueIndex("group_roles_builtin_idx").on(t.groupId, t.builtin).where(sql`${t.builtin} is not null`),
  uniqueIndex("group_roles_name_idx").on(t.groupId, sql`lower(${t.name})`).where(sql`${t.builtin} is null`),
]);

/**
 * #103／#175：群組成員。`role_id` 以複合 FK `(group_id, role_id) → group_roles(group_id, id)`（NO ACTION，S7）
 * 掛在同一群組的角色上。S1（每個群組至少一位成員持內建管理員角色）**沒有 DB 守衛**：應用層在交易內先
 * `lockGroup` 再以另一條敘述數 `builtin='admin'`（`groups/queries.ts` 的 `countAdmins`）。`group_members_user_idx`：
 * 「某人所屬的群組」與可見性查詢的 grouped 分支用——PK 是 (group_id, user_id)，反向查不到。
 */
export const groupMembers = pgTable("group_members", {
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.groupId, t.userId] }),
  foreignKey({ name: "group_members_role_fk", columns: [t.groupId, t.roleId], foreignColumns: [groupRoles.groupId, groupRoles.id] }),
  index("group_members_user_idx").on(t.userId),
  index("group_members_role_idx").on(t.roleId),
]);

export const notes = pgTable("notes", {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
  title: text().notNull().default("Untitled"),
  // 網址代稱（#122 spec §3a 起 per-user）：NOT NULL——auto（slug_is_custom=false，跟標題
  // 走、由 autoSlugFromTitle 派生＋owner 範圍去重）或自訂（=true，PATCH 顯式設定）。
  // 唯一範圍是 `(owner_id, slug)`（notes_owner_slug_idx），不再全域。存進來的值一律已過
  // `normalizeSlug`（NFC + 小寫）。DB default 三個承重理由（比照 users.handle）：①回滾
  // 兜底（0007 之後退回舊映像，舊碼 POST 不帶 slug 仍能建列）；②既有測試 db.insert(notes)
  // 不帶 slug——沒有 default，drizzle insert 型別會把它變必填；③#145 起這個 default 是
  // 「**不帶 title** 的建立」在生產上的實際來源（不再只是兜底）——`notes/create.ts` 對那條
  // 路只放 `owner_id`（`title`／`slug` 兩把鍵都不放進 values）、一次探測都不發，所以拿掉這
  // 個 default 就等於要求應用層自己替每一篇無標題筆記生一個 slug（帶 title 的建立才走
  // `autoSlugFromTitle` ＋ owner 範圍去重）。
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
  // #106（migration 0010）：最後一次 AI／API 寫入的落款，四欄同進同出（#137 Task 3 在
  // `onStoreDocument` 那一側寫入；本棒只建欄）。`last_edited_token_id` 必須用延遲型別
  // 引用——`api_tokens` 宣告在本檔更下方，直接寫 `apiTokens.id` 會在模組初始化時 TDZ。
  // token 與 agent_label 皆可為 null：cookie 寫入沒有 token，而 agent label 是「讀時
  // 派生、寫入時快照」的顯示名（`auth/agent-label.ts`）。
  lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
  lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
  lastEditedTokenId: uuid("last_edited_token_id").references((): AnyPgColumn => apiTokens.id, { onDelete: "set null" }),
  lastEditedAgentLabel: text("last_edited_agent_label"),
  // #175：`owner_id` 與 `group_id` 恰一個非 NULL（`notes_owner_xor_group_chk`，S6）；群組筆記沒有個人 owner。
  // FK RESTRICT：XOR 下 SET NULL 會撞 CHECK；刪群組前群組必須是空的（PR1–PR3）。`group_role` 已廢除（W1）
  // ——權限只看成員的群組角色。
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "restrict" }),
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
  // #175：群組內 slug 唯一（S12）與群組範圍的 prev 補查；個人範圍仍由 notes_owner_slug_idx 裁決（NULL owner 不互撞）。
  // notes_group_slug_idx 以 group_id 開頭，兼任「群組內所有筆記」（踢線名單、grouped 支的 JOIN、刪群組時撈該群組的筆記）——
  // #103 的單欄 notes_group_idx 因此冗餘，0012 刪除（plan gate r1 A-M5）。
  uniqueIndex("notes_group_slug_idx").on(t.groupId, t.slug),
  index("notes_group_prev_slug_idx").on(t.groupId, t.prevSlug).where(sql`${t.prevSlug} is not null`),
  check("notes_owner_xor_group_chk", sql`(${t.ownerId} is null) <> (${t.groupId} is null)`),
  // S11：群組筆記沒有公開別名（W7）。
  check("notes_group_no_public_slug_chk", sql`${t.groupId} is null or ${t.publicSlug} is null`),
]);

/**
 * #175 §4.3：網址轉址表（W5）。`old_path`＝已正規化的完整路徑（`/n/<handle>/<slug>` 或 `/g/<group uuid 小寫>/<slug>`），
 * 同鍵再寫入最新者勝（B3）。一個月（Q20）、查詢時懶惰清理、無排程器。應用層寫入一律經 `notes/tx/redirects.ts`（#175 Task 4 起；0012 的一次性回填與測試的直插除外）。
 */
export const noteRedirects = pgTable("note_redirects", {
  oldPath: text("old_path").primaryKey(),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("note_redirects_note_idx").on(t.noteId),
  index("note_redirects_expires_idx").on(t.expiresAt),
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

/**
 * #106（migration 0010）：AI／API 對筆記的每一次寫入紀錄，撤回（#137）與清單端點的唯一
 * 資料來源。每篇筆記只保留最近 `RETENTION`（100）列（`notes/editing/apply.ts` 的
 * `insertEditRecord` 在同一個交易內裁切）。
 *
 * 四條 CHECK 都是結構層不變量，不是應用層便利：
 * - `op_chk` 把五個寫入 op 加上 `revert` 釘死成枚舉；
 * - `revert_chk`／`anchor_chk` 是**雙向**蘊含（`revert` ⇔ 有 `revert_of`、`delete_section`
 *   ⇔ 有 anchor），單向版會靜默放行半截列；
 * - `fingerprint_chk` 保證「有 after block 就一定有指紋」，撤回的前置條件因此可以只看
 *   `after_fingerprint is not null`。
 *
 * `revert_of` 的 CASCADE 是刻意的：原始列被裁切掉之後，指向它的撤回列已無意義。
 * `token_id` 是 SET NULL（token 撤銷不該連帶抹掉稽核紀錄），`before_blocks` 存整份 block
 * JSON 快照（**無上限**——撤回要能原樣還原）。
 */
export const noteAiEdits = pgTable(
  "note_ai_edits",
  {
    id: uuid().primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references((): AnyPgColumn => apiTokens.id, { onDelete: "set null" }),
    agentLabel: text("agent_label"),
    op: text().notNull(),
    sectionId: text("section_id"),
    beforeBlocks: jsonb("before_blocks").notNull().default([]),
    afterBlockIds: text("after_block_ids").array().notNull().default([]),
    afterFingerprint: text("after_fingerprint"),
    anchor: jsonb(),
    revertOf: uuid("revert_of").references((): AnyPgColumn => noteAiEdits.id, { onDelete: "cascade" }),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("note_ai_edits_op_chk", sql`${t.op} in ('replace_all','replace_section','insert_after','append','delete_section','revert')`),
    check("note_ai_edits_revert_chk", sql`(${t.op} = 'revert') = (${t.revertOf} is not null)`),
    check("note_ai_edits_fingerprint_chk", sql`(cardinality(${t.afterBlockIds}) = 0) = (${t.afterFingerprint} is null)`),
    check("note_ai_edits_anchor_chk", sql`(${t.op} = 'delete_section') = (${t.anchor} is not null)`),
    index("note_ai_edits_note_created_idx").on(t.noteId, t.createdAt.desc()),
  ]
);

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
 * 刪列——這是最容易被當成 bug 回報的行為，寫在 `docs/api-tokens.md` 的安全提醒段。
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
    // #106（migration 0010）：這支 token 在筆記落款上顯示的 agent 名。NULL＝沒有覆寫值，
    // 讀時由 `deriveAgentLabel(name)` 派生（現值運算式＝`auth/agent-label.ts` 的 `agentLabelOf`）；
    // 寫入這一欄的唯一入口是 `PATCH /api/auth/tokens/:id`（#138），OAuth 換發時由 I7 搬過去。
    // 形狀 CHECK 與派生規則的字元集一致——這欄會被複製進 `note_ai_edits.agent_label` 與
    // `notes.last_edited_agent_label`，在 DB 端擋住形狀，繞過端點的寫入也騙不進來。
    agentLabel: text("agent_label"),
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
    // #106：agent label 的字元集與長度（同 `deriveAgentLabel` 的輸出形）。NULL 合法＝未覆寫。
    check("api_tokens_agent_label_chk", sql`${t.agentLabel} is null or ${t.agentLabel} ~ '^[A-Za-z0-9._-]{1,32}$'`),
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
