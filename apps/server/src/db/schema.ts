import { pgTable, uuid, text, timestamp, date, boolean, integer, bigint, smallint, jsonb, customType, primaryKey, unique, uniqueIndex, index, check, foreignKey } from "drizzle-orm/pg-core";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { NoteWidth, TagColor } from "@knotebook/shared";
import type { EncryptedApiKey } from "../ai/crypto.js";
import type { EncryptedSecret } from "../lib/sealed-secret.js";
import type { BulkRange } from "../auth/transfer-token.js";
const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

// Declared before `users`: `users`/`groups`/`site_settings` FKs reference `storagePlans.id` directly (TDZ). `quota_bytes` NULL = unlimited.
// The 409 `storage_plan_name_taken` mapping keys on `storage_plans_name_lower_idx`.
export const storagePlans = pgTable(
  "storage_plans",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    quotaBytes: bigint("quota_bytes", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex("storage_plans_name_lower_idx").on(sql`lower(${t.name})`),
    check("storage_plans_name_chk", sql`char_length(${t.name}) between 1 and 40`),
    check("storage_plans_quota_chk", sql`${t.quotaBytes} is null or ${t.quotaBytes} between 0 and 1125899906842624`),
  ],
);

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  // #122: denormalized copy; `handles` is the allocator. DB default for rollback and for test inserts without a handle.
  // `.unique()`, not uniqueIndex(): handle_taken vs email_taken is mapped by the constraint name `users_handle_unique`.
  handle: text()
    .notNull()
    .unique()
    .default(sql`'user-' || substr(gen_random_uuid()::text, 1, 8)`),
  passwordHash: text("password_hash"),
  // Legacy (#187): only the startup backfill reads it and unlinking clears it; use `user_identities`.
  oidcIssuer: text("oidc_issuer"),
  oidcSub: text("oidc_sub"),
  displayName: text("display_name").notNull(),
  avatarUrl: text("avatar_url"),
  isAdmin: boolean("is_admin").notNull().default(false),
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  tokenVersion: integer("token_version").notNull().default(0),
  // Nothing sets this any more (#285); only accounts from the removed admin-create flow that never changed their password carry it.
  mustChangePassword: boolean("must_change_password").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // The DEFAULT snapshots the site default at INSERT, so callers needn't pass it; no `site_settings` row → NULL → 23502.
  // Named `foreignKey()`, not `.references()`: error mapping keys on constraint names.
  storagePlanId: uuid("storage_plan_id").notNull().default(sql`public.knotebook_default_storage_plan('user')`),
  // Effective = site switch AND this column; read when a note loads, so a toggle applies from the next load.
  autoVersions: boolean("auto_versions").notNull().default(true),
  // Written outside any tx with SKIP LOCKED (never waits on the users-then-identity lock order), so a login may go unrecorded.
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  // Bearer-token and AI requests don't count; throttled per user and SKIP LOCKED, so updates may be missed.
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  // true = the user never chose an avatar, so an OIDC picture may be auto-selected; any avatar choice by the user clears it.
  avatarAuto: boolean("avatar_auto").notNull().default(true),
}, t => [
  uniqueIndex("users_oidc_idx").on(t.oidcIssuer, t.oidcSub),
  // Deliberately not unique: OIDC's `oidc_conflict` detection relies on case-variant duplicates being possible
  // (docs/known-limitations.md); a unique index would turn that into a write error. migrate.test.ts pins this.
  index("users_email_lower_idx").on(sql`lower(${t.email})`),
  foreignKey({ name: "users_storage_plan_fk", columns: [t.storagePlanId], foreignColumns: [storagePlans.id] }).onDelete("restrict"),
  // Backs the RESTRICT check on plan delete and the plans' user count.
  index("users_storage_plan_idx").on(t.storagePlanId),
]);

// #122: sole handle allocator. No FK on `user_id`: user creation inserts here before `users` in the same tx, and users are
// never deleted. `released` rows come only from older servers after a rollback (#291).
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
    index("handles_user_idx").on(t.userId),
  ],
);

// #291: one row per rename; counts toward the rename quota.
export const handleRenames = pgTable(
  "handle_renames",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    renamedAt: timestamp("renamed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index("handle_renames_user_time_idx").on(t.userId, t.renamedAt)],
);

export const instanceSetup = pgTable("instance_setup", {
  singleton: boolean().primaryKey().default(true),
  completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("instance_setup_singleton_chk", sql`${t.singleton}`)]);

// #187: `id` is app-generated because the client secret's AAD binds it. Issuer matching uses `coalesce(resolved_issuer, issuer_url)`
// (`auth/oidc-providers.ts`). Length limits bound the pending cookie size.
export const authProviders = pgTable(
  "auth_providers",
  {
    id: uuid().primaryKey(),
    template: text().notNull(),
    displayName: text("display_name").notNull(),
    issuerUrl: text("issuer_url").notNull(),
    resolvedIssuer: text("resolved_issuer"),
    clientId: text("client_id"),
    clientSecretEncrypted: jsonb("client_secret_encrypted").$type<EncryptedSecret>(),
    enabled: boolean().notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    legacyCallback: boolean("legacy_callback").notNull().default(false),
    configVersion: integer("config_version").notNull().default(1),
    // New providers always start false (DB default; the create API doesn't accept it); a migration carried over the old `registration_enabled`.
    autoCreateEnabled: boolean("auto_create_enabled").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // List queries never select `icon_data`; `icon_version` is the public icon URL's `?v=`.
    iconKind: text("icon_kind").notNull().default("template"),
    iconData: bytea("icon_data"),
    iconMime: text("icon_mime"),
    iconVersion: integer("icon_version").notNull().default(0),
  },
  t => [
    check("auth_providers_template_chk", sql`${t.template} in ('gitlab', 'google', 'oidc')`),
    check("auth_providers_display_name_chk", sql`char_length(${t.displayName}) between 1 and 40`),
    check("auth_providers_issuer_url_chk", sql`${t.issuerUrl} ~ '^https?://' and char_length(${t.issuerUrl}) <= 512`),
    check("auth_providers_resolved_issuer_chk", sql`${t.resolvedIssuer} is null or char_length(${t.resolvedIssuer}) <= 512`),
    // NULL passes (char_length is NULL); enabled ⇒ client ID is enforced by enabled_client_id_chk.
    check("auth_providers_client_id_chk", sql`char_length(${t.clientId}) between 1 and 512`),
    check("auth_providers_enabled_secret_chk", sql`not ${t.enabled} or ${t.clientSecretEncrypted} is not null`),
    check("auth_providers_enabled_client_id_chk", sql`not ${t.enabled} or ${t.clientId} is not null`),
    check("auth_providers_icon_kind_chk", sql`${t.iconKind} in ('template', 'gitlab', 'google', 'upload', 'none')`),
    check(
      "auth_providers_icon_upload_chk",
      sql`(${t.iconKind} = 'upload' and ${t.iconData} is not null and ${t.iconMime} is not null) or (${t.iconKind} <> 'upload' and ${t.iconData} is null and ${t.iconMime} is null)`,
    ),
    check("auth_providers_icon_mime_chk", sql`${t.iconMime} is null or ${t.iconMime} in ('image/png', 'image/jpeg', 'image/webp')`),
    // Literal, not interpolated (that would become a bind parameter); must equal shared `MAX_PROVIDER_ICON_BYTES` (shared constant test).
    check("auth_providers_icon_size_chk", sql`${t.iconData} is null or octet_length(${t.iconData}) <= 262144`),
    uniqueIndex("auth_providers_legacy_callback_idx").on(t.legacyCallback).where(sql`${t.legacyCallback}`),
  ],
);

// #187: "one sub per issuer per account" is checked in the app under the users row lock; no DB constraint.
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
    // IdP `picture` from the last login, recorded even if not downloaded; never returned in responses.
    lastPictureUrl: text("last_picture_url"),
    // Picture URL of a deleted OIDC avatar candidate; a later login with the same `picture` isn't auto-downloaded.
    pictureDismissedUrl: text("picture_dismissed_url"),
  },
  t => [
    uniqueIndex("user_identities_issuer_sub_idx").on(t.issuer, t.sub),
    index("user_identities_user_idx").on(t.userId),
    check("user_identities_last_picture_url_chk", sql`${t.lastPictureUrl} is null or char_length(${t.lastPictureUrl}) <= 2048`),
    check("user_identities_picture_dismissed_url_chk", sql`${t.pictureDismissedUrl} is null or char_length(${t.pictureDismissedUrl}) <= 2048`),
  ],
);

// Originals are files in the uploads dir named `original_file` (new uuid on replace, old file deleted after commit), not `uploads` rows.
// `is_current`, not `users.avatar_id` (`avatar_url` is unused): no FK cycle and no pointing at another user's candidate.
export const userAvatars = pgTable(
  "user_avatars",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    source: text().notNull(),
    identityId: uuid("identity_id").references(() => userIdentities.id, { onDelete: "set null" }),
    oidcPictureUrl: text("oidc_picture_url"),
    originalFile: uuid("original_file").notNull(),
    // Lets an IdP URL change with an unchanged image keep the crop.
    originalSha256: bytea("original_sha256").notNull(),
    originalMime: text("original_mime").notNull(),
    originalSize: bigint("original_size", { mode: "number" }).notNull(),
    // EXIF-rotated size reported by the browser; NULL (like `display_data`) for OIDC candidates until the owner's browser renders them.
    originalWidth: integer("original_width"),
    originalHeight: integer("original_height"),
    cropX: integer("crop_x"),
    cropY: integer("crop_y"),
    cropSize: integer("crop_size"),
    displayData: bytea("display_data"),
    displayMime: text("display_mime"),
    // = coalesce(octet_length(display_data), 0), stored so personal storage can SUM(original_size + display_size); a CHECK keeps it in sync.
    displaySize: integer("display_size").notNull().default(0),
    // Bumped on every image change: the URL's `?v=` and the re-crop precondition.
    version: integer().notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index("user_avatars_user_idx").on(t.userId),
    uniqueIndex("user_avatars_original_file_idx").on(t.originalFile),
    uniqueIndex("user_avatars_identity_idx").on(t.identityId).where(sql`${t.identityId} is not null`),
    uniqueIndex("user_avatars_current_idx").on(t.userId).where(sql`${t.isCurrent}`),
    check("user_avatars_source_chk", sql`${t.source} in ('upload', 'oidc')`),
    check("user_avatars_oidc_url_chk", sql`(${t.source} = 'oidc') = (${t.oidcPictureUrl} is not null)`),
    check("user_avatars_oidc_url_len_chk", sql`${t.oidcPictureUrl} is null or char_length(${t.oidcPictureUrl}) <= 2048`),
    check("user_avatars_sha256_chk", sql`octet_length(${t.originalSha256}) = 32`),
    check("user_avatars_original_mime_chk", sql`${t.originalMime} in ('image/png', 'image/jpeg', 'image/webp')`),
    // Literal (interpolation would become a bind parameter); must equal shared `SITE_LIMITS.uploadMaxBytes.max` (migrate test).
    check("user_avatars_original_size_chk", sql`${t.originalSize} > 0 and ${t.originalSize} <= 10485760`),
    check(
      "user_avatars_crop_chk",
      sql`(${t.cropX} is null and ${t.cropY} is null and ${t.cropSize} is null) or (${t.cropX} is not null and ${t.cropY} is not null and ${t.cropSize} is not null and ${t.cropSize} > 0)`,
    ),
    // Must equal shared `MAX_AVATAR_DISPLAY_BYTES` (literal, as above).
    check("user_avatars_display_size_max_chk", sql`${t.displayData} is null or octet_length(${t.displayData}) <= 262144`),
    check("user_avatars_display_pair_chk", sql`(${t.displayData} is null) = (${t.displayMime} is null)`),
    check("user_avatars_display_mime_chk", sql`${t.displayMime} is null or ${t.displayMime} in ('image/png', 'image/jpeg', 'image/webp')`),
    check("user_avatars_upload_display_chk", sql`${t.source} <> 'upload' or ${t.displayData} is not null`),
    check("user_avatars_display_size_chk", sql`${t.displaySize} = coalesce(octet_length(${t.displayData}), 0)`),
    check("user_avatars_version_chk", sql`${t.version} >= 1`),
  ],
);

// #187: `registration_enabled` only governs password self-sign-up (SSO uses each provider's `auto_create_enabled`).
// `password_login_enabled` holds the DB value; an env override is never written back (`auth/password-login.ts`).
export const siteSettings = pgTable(
  "site_settings",
  {
    singleton: boolean().primaryKey().default(true),
    registrationEnabled: boolean("registration_enabled").notNull().default(true),
    passwordLoginEnabled: boolean("password_login_enabled").notNull().default(true),
    // Unused since the `OIDC_*` env import was removed; dropping it needs a migration.
    legacyOidcEnvHandledAt: timestamp("legacy_oidc_env_handled_at", { withTimezone: true }),
    // Snapshotted by the DEFAULT functions at creation; changes don't affect existing users/groups.
    defaultUserStoragePlanId: uuid("default_user_storage_plan_id").notNull(),
    defaultGroupStoragePlanId: uuid("default_group_storage_plan_id").notNull(),
    versionKeepAllDays: integer("version_keep_all_days").notNull().default(7),
    versionDailyUntilDays: integer("version_daily_until_days").notNull().default(30),
    autoVersionsEnabled: boolean("auto_versions_enabled").notNull().default(true),
    versionAutoWaitMinutes: integer("version_auto_wait_minutes").notNull().default(5),
    // NULL = never auto-delete.
    trashRetentionDays: integer("trash_retention_days").default(7),
    // NULL = never expire.
    notificationRetentionDays: integer("notification_retention_days").default(30),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("site_settings_singleton_chk", sql`${t.singleton}`),
    check(
      "site_settings_trash_retention_chk",
      sql`${t.trashRetentionDays} is null or (${t.trashRetentionDays} >= 1 and ${t.trashRetentionDays} <= 3650)`,
    ),
    check(
      "site_settings_notification_retention_chk",
      sql`${t.notificationRetentionDays} is null or (${t.notificationRetentionDays} >= 1 and ${t.notificationRetentionDays} <= 3650)`,
    ),
    check("site_settings_version_auto_wait_chk", sql`1 <= ${t.versionAutoWaitMinutes} and ${t.versionAutoWaitMinutes} <= 60`),
    check(
      "site_settings_version_days_chk",
      sql`1 <= ${t.versionKeepAllDays} and ${t.versionKeepAllDays} <= ${t.versionDailyUntilDays} and ${t.versionDailyUntilDays} <= 3650`,
    ),
    foreignKey({ name: "site_settings_default_user_plan_fk", columns: [t.defaultUserStoragePlanId], foreignColumns: [storagePlans.id] }).onDelete("restrict"),
    foreignKey({ name: "site_settings_default_group_plan_fk", columns: [t.defaultGroupStoragePlanId], foreignColumns: [storagePlans.id] }).onDelete("restrict"),
  ],
);

// Name length uses `length()` (code points), same unit as `validateGroupName`. `created_by` is only a record, hence SET NULL.
export const groups = pgTable("groups", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  storagePlanId: uuid("storage_plan_id").notNull().default(sql`public.knotebook_default_storage_plan('group')`),
  // Effective = site switch AND this column; read when a note loads, so a toggle applies from the next load.
  autoVersions: boolean("auto_versions").notNull().default(true),
}, t => [
  check("groups_name_chk", sql`length(${t.name}) between 1 and 80`),
  foreignKey({ name: "groups_storage_plan_fk", columns: [t.storagePlanId], foreignColumns: [storagePlans.id] }).onDelete("restrict"),
  index("groups_storage_plan_idx").on(t.storagePlanId),
]);

// #175: built-in roles have no `name` (i18n). Deliberately no CHECK that create ⇒ edit (admins choose; re-adding it would need
// existing create-only roles fixed) or that manage flags imply read. `(group_id, id)` is the target of the members' composite FK.
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

// "Every group keeps a built-in admin" has no DB guard: the app counts admins in a separate statement after `lockGroup` (`countAdmins`).
export const groupMembers = pgTable("group_members", {
  groupId: uuid("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.groupId, t.userId] }),
  foreignKey({ name: "group_members_role_fk", columns: [t.groupId, t.roleId], foreignColumns: [groupRoles.groupId, groupRoles.id] }),
  // "Groups of a user" and visibility queries; the (group_id, user_id) PK can't serve them.
  index("group_members_user_idx").on(t.userId),
  index("group_members_role_idx").on(t.roleId),
]);

// personal and shared (the sharee's own filing) use `owner_id`; group uses `group_id`. Cycles, depth and counts are app-enforced
// under the structure lock. Hand-written in 0034 (drizzle lacks NULLS NOT DISTINCT): `folders_sibling_name_idx` and triggers
// `notes_folder_space_trg`, `folders_parent_space_trg`, `note_placements_folder_trg` (SQLSTATE `KF001`–`KF003`, `db/pg-errors.ts`).
export const folders = pgTable("folders", {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "cascade" }),
  parentId: uuid("parent_id").references((): AnyPgColumn => folders.id, { onDelete: "cascade" }),
  name: text().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("folders_kind_chk", sql`${t.kind} in ('personal','group','shared')`),
  check("folders_space_chk", sql`(${t.kind} = 'group') = (${t.groupId} is not null) and (${t.ownerId} is null) = (${t.groupId} is not null)`),
  check("folders_name_chk", sql`length(${t.name}) between 1 and 80`),
  check("folders_parent_not_self_chk", sql`${t.parentId} is distinct from ${t.id}`),
  index("folders_owner_idx").on(t.ownerId).where(sql`${t.ownerId} is not null`),
  index("folders_group_idx").on(t.groupId).where(sql`${t.groupId} is not null`),
  index("folders_parent_idx").on(t.parentId).where(sql`${t.parentId} is not null`),
]);

export const notes = pgTable("notes", {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "restrict" }),
  title: text().notNull().default("Untitled"),
  // Already `normalizeSlug`ed. DB default for rollback and test inserts, and the real slug of notes created without a title
  // (`notes/create.ts` omits `title` and `slug` there, #145).
  slug: text()
    .notNull()
    .default(sql`'untitled-' || substr(gen_random_uuid()::text, 1, 8)`),
  // false = auto (recomputed on title change); true = set via PATCH {slug}; {slug:null} reverts to auto.
  slugIsCustom: boolean("slug_is_custom").notNull().default(false),
  // One-level redirect, set only on custom changes; auto recomputes skip it so typing doesn't flood redirects.
  prevSlug: text("prev_slug"),
  // Frozen pre-0007 global slug for legacy `/notes/<slug>` URLs. Immutable: trigger `notes_legacy_slug_guard` (0007) rejects updates.
  legacySlug: text("legacy_slug"),
  // Plaintext: hashing adds nothing against DB access (note_states is in the same DB) and owners must be able to copy the link.
  // So public endpoints check its format first, logs redact it, and the admin side returns it only in bodies, never URLs.
  publicToken: text("public_token"),
  // "Only public notes have an alias" is app-enforced, not by the DB: conditional UPDATE (`AND public_token IS NOT NULL`),
  // cleared by DELETE public-link's UPDATE, and public reads join on a non-NULL token.
  publicSlug: text("public_slug"),
  // Must match NOTE_WIDTHS (note-width-check-sync.test.ts).
  publicWidth: text("public_width").$type<NoteWidth>().notNull().default("standard"),
  linksClock: bigint("links_clock", { mode: "number" }).notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // #106: last AI/API write, four columns written together. Lazy reference because `apiTokens` is declared below (TDZ).
  lastEditedAt: timestamp("last_edited_at", { withTimezone: true }),
  lastEditedBy: uuid("last_edited_by").references(() => users.id, { onDelete: "set null" }),
  lastEditedTokenId: uuid("last_edited_token_id").references((): AnyPgColumn => apiTokens.id, { onDelete: "set null" }),
  lastEditedAgentLabel: text("last_edited_agent_label"),
  // RESTRICT: SET NULL would break `notes_owner_xor_group_chk`; a group must be empty before deletion.
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "restrict" }),
  // #181: set only by `notes/tx/trash.ts`, from DB `now()`; NULL = live.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  deletedBy: uuid("deleted_by"),
  // Counter never goes back on pruning, resets when all versions are cleared. "Has full text" checks `version_base_seq`,
  // not row count. No FK: the app keeps the base from being deleted.
  versionCounter: integer("version_counter").notNull().default(0),
  versionBaseSeq: integer("version_base_seq"),
  versionBaseFingerprint: text("version_base_fingerprint"),
  // #272: `version_pending_at` = last content flush (app clock); the ref fingerprint is set only if the segment began without a base.
  versionPendingAt: timestamp("version_pending_at", { withTimezone: true }),
  versionPendingEditors: jsonb("version_pending_editors").$type<VersionEditorJson[]>().notNull().default([]),
  versionPendingRefFingerprint: text("version_pending_ref_fingerprint"),
  // #272: written and cleared with version_base_seq (app-enforced, no CHECK). No FK, so a deleted base can still show as "(deleted)".
  versionBaseVersionId: uuid("version_base_version_id"),
  // Kept while in the trash so restore puts the note back.
  folderId: uuid("folder_id"),
  // Only meaningful in the trash, but no "snapshot ⇒ in trash" CHECK: an older server restoring after a rollback clears only `deleted_at`.
  trashFolderPath: jsonb("trash_folder_path").$type<string[]>(),
}, t => [
  index("notes_owner_idx").on(t.ownerId),
  // Writes don't pre-check; this index decides (custom → 409 slug_taken; auto → re-probe).
  uniqueIndex("notes_owner_slug_idx").on(t.ownerId, t.slug),
  // Still globally unique: values come from the old global index, the trigger freezes them, new rows are NULL.
  uniqueIndex("notes_legacy_slug_idx").on(t.legacySlug).where(sql`${t.legacySlug} is not null`),
  // Not unique: one owner's notes may have released the same name; the query treats >1 matches as 404.
  index("notes_owner_prev_slug_idx").on(t.ownerId, t.prevSlug).where(sql`${t.prevSlug} is not null`),
  uniqueIndex("notes_public_token_idx").on(t.publicToken).where(sql`${t.publicToken} is not null`),
  // The constraint name drives the 409 public_slug_taken mapping.
  uniqueIndex("notes_owner_public_slug_idx").on(t.ownerId, t.publicSlug).where(sql`${t.publicSlug} is not null`),
  // Group notes have a NULL owner, so notes_owner_slug_idx doesn't cover them; leading group_id also serves per-group scans.
  uniqueIndex("notes_group_slug_idx").on(t.groupId, t.slug),
  index("notes_group_prev_slug_idx").on(t.groupId, t.prevSlug).where(sql`${t.prevSlug} is not null`),
  check("notes_owner_xor_group_chk", sql`(${t.ownerId} is null) <> (${t.groupId} is null)`),
  check("notes_group_no_public_slug_chk", sql`${t.groupId} is null or ${t.publicSlug} is null`),
  check("notes_public_width_chk", sql`${t.publicWidth} in ('standard','wide','full')`),
  check("notes_version_base_pair_chk", sql`(${t.versionBaseSeq} is null) = (${t.versionBaseFingerprint} is null)`),
  index("notes_version_pending_idx").on(t.versionPendingAt).where(sql`${t.versionPendingAt} is not null`),
  check(
    "notes_version_pending_chk",
    sql`${t.versionPendingAt} is not null or (${t.versionPendingEditors} = '[]'::jsonb and ${t.versionPendingRefFingerprint} is null)`,
  ),
  foreignKey({ name: "notes_deleted_by_fk", columns: [t.deletedBy], foreignColumns: [users.id] }).onDelete("set null"),
  check("notes_deleted_by_chk", sql`${t.deletedBy} is null or ${t.deletedAt} is not null`),
  index("notes_deleted_at_idx").on(t.deletedAt).where(sql`${t.deletedAt} is not null`),
  // Same space as its folder: enforced by trigger `notes_folder_space_trg` (migration 0034).
  foreignKey({ name: "notes_folder_fk", columns: [t.folderId], foreignColumns: [folders.id] }).onDelete("set null"),
  check("notes_trash_folder_path_chk", sql`${t.trashFolderPath} is null or jsonb_typeof(${t.trashFolderPath}) = 'array'`),
  index("notes_folder_idx").on(t.folderId).where(sql`${t.folderId} is not null`),
]);

// #175: rows expire after one month; the same key rewritten keeps the latest write. `old_path` is the normalized path (`/n/<handle>/<slug>` or `/g/<lowercase group uuid>/<slug>`). Expired rows are cleaned
// lazily at lookup (no scheduler); app writes go through `notes/tx/redirects.ts`.
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

/** One `note_versions.editors` entry: deduped by (user_id, agent_label), first-seen order. */
export interface VersionEditorJson {
  user_id: string;
  agent_label: string | null;
}

// #269: candidates frozen by the 0026 seed (later notes' links went through the write path); re-scanning needs a new seed migration.
export const noteLinkConversion = pgTable(
  "note_link_conversion",
  {
    noteId: uuid("note_id").primaryKey().references(() => notes.id, { onDelete: "cascade" }),
    status: text().notNull(),
    attempts: integer().notNull().default(0),
    converted: integer().notNull().default(0),
    unresolved: integer().notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [check("note_link_conversion_status_chk", sql`${t.status} in ('pending','done','retry','failed')`)],
);

// Full Y.Doc per version; `manual` is kept forever, `auto` is pruned by the site day tiers. `base_seq` is set only when the base wasn't the latest version ("continued from vX").
export const noteVersions = pgTable(
  "note_versions",
  {
    id: uuid().primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    ydoc: bytea().notNull(),
    kind: text().notNull(),
    name: text(),
    editors: jsonb().$type<VersionEditorJson[]>().notNull().default([]),
    baseSeq: integer("base_seq"),
    // #272: written together with base_seq when that is non-NULL. No FK; NULL for older rows whose base was already deleted.
    baseVersionId: uuid("base_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    uniqueIndex("note_versions_note_seq_idx").on(t.noteId, t.seq),
    index("note_versions_note_kind_created_idx").on(t.noteId, t.kind, t.createdAt),
    check("note_versions_kind_chk", sql`${t.kind} in ('auto','manual')`),
  ],
);

// #93: written only by `notes/tx/search-index.ts`. `section_id` always matches SECTION_ID_RE and is unique per note by the extractor, not an index, because
// attachment rows (reserved `source_kind`, unused) may need other rules.
export const noteSearchSections = pgTable(
  "note_search_sections",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    sourceKind: text("source_kind").notNull().default("note"),
    sourceId: uuid("source_id"),
    sectionId: text("section_id").notNull(),
    ord: integer().notNull(),
    heading: text().notNull().default(""),
    body: text().notNull(),
  },
  t => [
    check("nss_source_kind_chk", sql`${t.sourceKind} in ('note', 'attachment')`),
    check("nss_source_id_chk", sql`(${t.sourceKind} = 'note') = (${t.sourceId} is null)`),
    check("nss_section_id_chk", sql`${t.sectionId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    index("nss_note_idx").on(t.noteId, t.sourceKind, t.ord),
    // pg_trgm GIN index for the body LIKE in `notes/search-sql.ts` (queries with a run of 3+ characters that pg_trgm indexes, which depends on the database's LC_CTYPE); migration 0042 creates the extension first.
    index("nss_body_trgm_idx").using("gin", sql`lower(${t.body}) gin_trgm_ops`),
  ],
);

// #93: `content_hash` (`searchContentHash`) instead of a per-note clock: Yjs deletions don't advance the state vector.
export const noteSearchState = pgTable("note_search_state", {
  noteId: uuid("note_id").primaryKey().references(() => notes.id, { onDelete: "cascade" }),
  extractorVersion: smallint("extractor_version").notNull(),
  sourceVersion: integer("source_version").notNull(),
  contentHash: text("content_hash").notNull(),
  indexedUnits: integer("indexed_units").notNull(),
  capped: boolean().notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Derived cache of the knowledge info on headings, rebuilt from `note_states` by `knowledge/index-write.ts`; the note's document stays the source of truth.
// Space and folder are not stored: queries join `notes`, so moving a note needs no update here. Several CHECKs mirror constants in shared (knowledge-check-sync.test.ts).
// `superseded_note_id` NULL = the same note; no FK because the replacing note may have been deleted since.
export const noteKnowledge = pgTable(
  "note_knowledge",
  {
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    knowledgeId: text("knowledge_id").notNull(),
    blockId: text("block_id").notNull(),
    ord: integer().notNull(),
    level: smallint().notNull(),
    heading: text().notNull(),
    // `when` is a reserved word in SQL.
    readWhen: text("read_when").notNull(),
    conclusion: text().notNull(),
    evidence: text().notNull(),
    verified: date({ mode: "string" }),
    status: text().notNull(),
    icon: text().notNull(),
    parentKnowledgeId: text("parent_knowledge_id"),
    supersededNoteId: uuid("superseded_note_id"),
    supersededKnowledgeId: text("superseded_knowledge_id"),
    descTotal: integer("desc_total").notNull().default(0),
    descVerified: integer("desc_verified").notNull().default(0),
    descNoDate: integer("desc_no_date").notNull().default(0),
    descNeedsReview: integer("desc_needs_review").notNull().default(0),
    descOutdated: integer("desc_outdated").notNull().default(0),
    custom: jsonb("custom").$type<Record<string, string>>(),
  },
  t => [
    primaryKey({ name: "note_knowledge_pk", columns: [t.noteId, t.knowledgeId] }),
    check("nk_knowledge_id_chk", sql`${t.knowledgeId} ~ '^k_[0-9a-f]{8}$'`),
    check("nk_block_id_chk", sql`${t.blockId} ~ '^[A-Za-z0-9_-]{1,64}$'`),
    check("nk_level_chk", sql`${t.level} between 1 and 6`),
    // Same pattern as KNOWLEDGE_KEY_RE.
    check("nk_evidence_chk", sql`${t.evidence} = '' or ${t.evidence} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`),
    check("nk_status_chk", sql`${t.status} in ('', 'verified', 'unverified', 'outdated')`),
    check("nk_icon_chk", sql`${t.icon} in ('outdated', 'needsReview', 'noVerifiedDate', 'verified')`),
    check("nk_superseded_chk", sql`${t.supersededKnowledgeId} is null or ${t.supersededKnowledgeId} ~ '^k_[0-9a-f]{8}$'`),
    check("nk_superseded_pair_chk", sql`${t.supersededNoteId} is null or ${t.supersededKnowledgeId} is not null`),
  ],
);

// Same shape as `note_search_state`: `content_hash` instead of a per-note clock, and one lock row per note for the writers.
export const noteKnowledgeState = pgTable("note_knowledge_state", {
  noteId: uuid("note_id").primaryKey().references(() => notes.id, { onDelete: "cascade" }),
  extractorVersion: smallint("extractor_version").notNull(),
  sourceVersion: integer("source_version").notNull(),
  contentHash: text("content_hash").notNull(),
  entries: integer().notNull(),
  capped: boolean().notNull(),
  indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
});

// Definitions are never deleted so a key is never reused; a definition made by a group that was later deleted keeps its row with `origin_group_id` NULL.
// `field_ref`: `evidence` or `x-<key>`; the key patterns equal KNOWLEDGE_KEY_RE (see knowledge-check-sync.test.ts).
export const knowledgeFieldDefs = pgTable("knowledge_field_defs", {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),
  fieldRef: text("field_ref").notNull(),
  key: text().notNull(),
  type: text(),
  originKind: text("origin_kind").notNull(),
  originGroupId: uuid("origin_group_id").references(() => groups.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("kfd_field_idx").on(t.fieldRef).where(sql`${t.kind} = 'field'`),
  uniqueIndex("kfd_option_idx").on(t.fieldRef, t.key).where(sql`${t.kind} = 'option'`),
  check("kfd_key_chk", sql`${t.key} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`),
  check("kfd_field_ref_chk", sql`${t.fieldRef} = 'evidence' or ${t.fieldRef} ~ '^x-[a-z0-9][a-z0-9-]{0,63}$'`),
  check("kfd_kind_type_chk", sql`(${t.kind} = 'field' and ${t.type} is not null and ${t.type} in ('text', 'select', 'date', 'link', 'member') and ${t.fieldRef} = 'x-' || ${t.key}) or (${t.kind} = 'option' and ${t.type} is null)`),
  check("kfd_reserved_chk", sql`not (${t.kind} = 'option' and ${t.fieldRef} = 'evidence' and ${t.key} in ('tested', 'docs', 'inferred', 'unconfirmed'))`),
  check("kfd_origin_chk", sql`(${t.originKind} = 'site' and ${t.originGroupId} is null) or ${t.originKind} = 'group'`),
]);

// `group_id` NULL = the site level. A NULL attribute inherits from the level above; `option_key` '' is the field itself.
export const knowledgeFieldOverrides = pgTable("knowledge_field_overrides", {
  id: uuid().primaryKey().defaultRandom(),
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "cascade" }),
  fieldRef: text("field_ref").notNull(),
  optionKey: text("option_key").notNull().default(""),
  enabled: boolean(),
  name: text(),
  position: integer(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("kfo_site_idx").on(t.fieldRef, t.optionKey).where(sql`${t.groupId} is null`),
  uniqueIndex("kfo_group_idx").on(t.groupId, t.fieldRef, t.optionKey).where(sql`${t.groupId} is not null`),
  check("kfo_field_ref_chk", sql`${t.fieldRef} in ('when', 'conclusion', 'evidence', 'verified', 'superseded_by') or ${t.fieldRef} ~ '^x-[a-z0-9][a-z0-9-]{0,63}$'`),
  check("kfo_option_key_chk", sql`${t.optionKey} = '' or ${t.optionKey} ~ '^[a-z0-9][a-z0-9-]{0,63}$'`),
  check("kfo_name_chk", sql`${t.name} is null or char_length(${t.name}) between 1 and 60`),
  check("kfo_position_chk", sql`${t.position} is null or ${t.position} >= 0`),
]);

export const noteShares = pgTable("note_shares", {
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.noteId, t.userId] }),
        check("note_shares_role_chk", sql`${t.role} in ('viewer','editor')`),
        // Serves "notes shared with a user"; the (note_id, user_id) PK can't.
        index("note_shares_user_idx").on(t.userId)]);

// Removed with the share (FK CASCADE); trigger `note_placements_folder_trg` (0034) allows only the placer's own shared folders.
export const notePlacements = pgTable("note_placements", {
  userId: uuid("user_id").notNull(),
  noteId: uuid("note_id").notNull(),
  folderId: uuid("folder_id").notNull().references(() => folders.id, { onDelete: "cascade" }),
}, t => [
  primaryKey({ columns: [t.userId, t.noteId] }),
  foreignKey({ name: "note_placements_share_fk", columns: [t.noteId, t.userId], foreignColumns: [noteShares.noteId, noteShares.userId] }).onDelete("cascade"),
  index("note_placements_folder_idx").on(t.folderId),
]);

// Kept through trash, unsharing or lost access; the list filters by visibility, so the note returns to its old position.
// FK on `notes`, not `note_shares`: unsharing would drop the row, and group and own notes have no share row.
// `created_at` is whole milliseconds like JS `Date`, so server order and the client's optimistic order agree.
export const noteFavorites = pgTable("note_favorites", {
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`date_trunc('milliseconds', now())`),
}, t => [
  primaryKey({ columns: [t.userId, t.noteId] }),
  // PK leads with user_id; the cascade on permanent note deletion needs this.
  index("note_favorites_note_idx").on(t.noteId),
]);

// A tag belongs to exactly one space: a user's personal space or a group.
// `name_key` is a generated column rather than an expression index because drizzle's `onConflictDoUpdate({ target })` takes columns only.
// The color CHECK must match TAG_PRESET_COLORS and CUSTOM_COLOR_RE (tag-color-check-sync.test.ts).
export const tags = pgTable("tags", {
  id: uuid().primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").references(() => users.id, { onDelete: "cascade" }),
  groupId: uuid("group_id").references(() => groups.id, { onDelete: "cascade" }),
  name: text().notNull(),
  nameKey: text("name_key").notNull().generatedAlwaysAs(sql`lower(name)`),
  color: text().$type<TagColor>().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("tags_space_chk", sql`(${t.ownerId} is null) <> (${t.groupId} is null)`),
  check("tags_name_len_chk", sql`length(${t.name}) between 1 and 40`),
  check("tags_color_chk", sql`${t.color} in ('blue','green','orange','purple','pink','red','yellow','brown','gray') or ${t.color} ~ '^#[0-9a-f]{6}$'`),
  uniqueIndex("tags_owner_name_idx").on(t.ownerId, t.nameKey).where(sql`${t.ownerId} is not null`),
  uniqueIndex("tags_group_name_idx").on(t.groupId, t.nameKey).where(sql`${t.groupId} is not null`),
]);

// `created_at` is whole milliseconds like JS `Date`, so the order tags were added in is stable across server and client.
export const noteTags = pgTable("note_tags", {
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`date_trunc('milliseconds', now())`),
}, t => [
  primaryKey({ columns: [t.noteId, t.tagId] }),
  // PK leads with note_id; deleting a tag needs this.
  index("note_tags_tag_idx").on(t.tagId),
]);

export const noteLinks = pgTable("note_links", {
  sourceNoteId: uuid("source_note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  targetNoteId: uuid("target_note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
}, t => [primaryKey({ columns: [t.sourceNoteId, t.targetNoteId] }),
        index("note_links_target_idx").on(t.targetNoteId)]);

// #106: the only source for revert (#137); trimmed to `RETENTION` rows per note in the insert tx (`insertEditRecord`).
// Two-way CHECKs: one-way versions would silently accept half-filled rows. `file_sync`: anchor ⇔ deleted region.
// `revert_of` CASCADE: reverting a trimmed row is meaningless. `token_id` SET NULL: revoking a token keeps the audit trail.
// `before_blocks` is unbounded so revert can restore exactly.
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
    check("note_ai_edits_op_chk", sql`${t.op} in ('replace_all','replace_section','insert_after','append','delete_section','revert','file_sync')`),
    check("note_ai_edits_revert_chk", sql`(${t.op} = 'revert') = (${t.revertOf} is not null)`),
    check("note_ai_edits_fingerprint_chk", sql`(cardinality(${t.afterBlockIds}) = 0) = (${t.afterFingerprint} is null)`),
    check(
      "note_ai_edits_anchor_chk",
      sql`case when ${t.op} = 'delete_section' then ${t.anchor} is not null when ${t.op} = 'file_sync' then (${t.anchor} is not null) = (cardinality(${t.afterBlockIds}) = 0) else ${t.anchor} is null end`
    ),
    index("note_ai_edits_note_created_idx").on(t.noteId, t.createdAt.desc()),
  ]
);

export const uploads = pgTable("uploads", {
  id: uuid().primaryKey().defaultRandom(),
  noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
  uploaderId: uuid("uploader_id").references(() => users.id, { onDelete: "set null" }),
  // #247: who brought the bytes into the space (uploader, group mover or copier); `uploader_id` is the origin.
  // NULL = account deleted, or row created while rolled back to v0.9. No index, like uploader_id: queries join from notes.
  chargedToId: uuid("charged_to_id").references(() => users.id, { onDelete: "set null" }),
  mime: text().notNull(),
  // bigint: media files can exceed 2^31 bytes.
  size: bigint({ mode: "number" }).notNull(),
  // Sanitized client name; NULL for rows that predate stored names.
  fileName: text("file_name"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
// deleteNotesInTx's WHERE note_id IN (...).
}, t => [
  index("uploads_note_idx").on(t.noteId),
  check("uploads_file_name_len_chk", sql`${t.fileName} is null or octet_length(${t.fileName}) between 1 and 200`),
]);

export const aiProviders = pgTable("ai_providers", {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  type: text().notNull(),
  baseUrl: text("base_url").notNull(),
  // Type annotation only: the jsonb value is unchecked at runtime, so `decryptApiKey` still validates it.
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

// #107/#132: DCR is unauthenticated and `client_name` is self-asserted and shown on the consent page, so the DB caps its length
// (same 1..64 as the DCR zod); control/bidi filtering and loopback-only `redirect_uris` are checked in the DCR endpoint.
// `last_used_at` is NOT NULL so cleanup needs no NULL handling (unlike `api_tokens`, which shows "never used").
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

// #107: PATs and OAuth grants share one table: one Bearer lookup, one list, one revoke path. Plaintext tokens are never stored;
// `access_token_hash` is globally unique so one plaintext can't map to two identities;
// that UNIQUE also serves the Bearer lookup, so no extra index.
// `access_expires_at` NULL = PAT never expires; auth rejects only "non-NULL and expired" (`auth/bearer.ts`).
// For oauth `name` snapshots `oauth_clients.client_name`, so both 1..64 limits must change together.
// PATs survive `users.token_version` bumps (sign out everywhere, password change), like GitHub PATs; see docs/api-tokens.md.
// One grant per (user, client): concurrent code exchanges race on the partial unique index and the loser gets `invalid_grant`.
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
    // #106: NULL = derived from `name` at read time (`agentLabelOf`). Set only by `PATCH /api/auth/tokens/:id`, kept on OAuth
    // re-authorization; the CHECK guards copies into `note_ai_edits`/`notes` against writes bypassing the endpoint.
    agentLabel: text("agent_label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("api_tokens_kind_chk", sql`${t.kind} in ('pat','oauth')`),
    // Normalized scope sets (`normalizeScope` output), equal to `TOKEN_SCOPES`; scope-check-sync.test.ts and migrate.test.ts guard drift.
    check("api_tokens_scope_chk", sql`${t.scope} in ('notes:read','notes:read notes:write','notes:read notes:write notes:move','notes:read notes:write notes:delete','notes:read notes:write notes:move notes:delete')`),
    check("api_tokens_name_chk", sql`length(${t.name}) between 1 and 64`),
    // Two-way implications; one-way versions would silently accept half-filled rows.
    check("api_tokens_client_chk", sql`(${t.kind} = 'pat') = (${t.clientId} is null)`),
    check("api_tokens_refresh_chk", sql`(${t.kind} = 'pat') = (${t.refreshTokenHash} is null)`),
    check("api_tokens_oauth_expiry_chk", sql`${t.kind} = 'pat' or ${t.accessExpiresAt} is not null`),
    // Must match `AGENT_LABEL_RE` and shared `deriveAgentLabel` output.
    check("api_tokens_agent_label_chk", sql`${t.agentLabel} is null or ${t.agentLabel} ~ '^[A-Za-z0-9._-]{1,32}$'`),
    index("api_tokens_user_idx").on(t.userId),
    // Backs the client_id FK cascade; oauth_user_client_uidx leads with user_id.
    index("api_tokens_client_idx").on(t.clientId),
    uniqueIndex("api_tokens_oauth_user_client_uidx")
      .on(t.userId, t.clientId)
      .where(sql`${t.kind} = 'oauth'`),
  ]
);

// #132: `state` is returned verbatim (RFC 6749 §4.1.2), so it is capped, never truncated. No method column: `/authorize` accepts
// only S256 (`plain` is no PKCE). No `expires_at` index: rows live 10 minutes and cleanup deletes most, so a seq scan wins.
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
    // Normalized scope sets (`normalizeScope` output), equal to `TOKEN_SCOPES`; scope-check-sync.test.ts and migrate.test.ts guard drift.
    check("oauth_requests_scope_chk", sql`${t.scope} in ('notes:read','notes:read notes:write','notes:read notes:write notes:move','notes:read notes:write notes:delete','notes:read notes:write notes:move notes:delete')`),
    check("oauth_requests_state_chk", sql`${t.state} is null or length(${t.state}) <= 2048`),
    index("oauth_requests_client_idx").on(t.clientId),
  ]
);

// #132: `redirect_uri` is the exact value from this authorize call (ephemeral port included); token exchange compares against it.
// Single use is app-enforced (`DELETE ... RETURNING`, no `used_at`), so a replay can't be told from a missing code and can't
// revoke the grant (PKCE makes intercepted codes useless; see docs/known-limitations.md). No `expires_at` index, as for
// oauth_requests.
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
    // Normalized scope sets (`normalizeScope` output), equal to `TOKEN_SCOPES`; scope-check-sync.test.ts and migrate.test.ts guard drift.
    check("oauth_codes_scope_chk", sql`${t.scope} in ('notes:read','notes:read notes:write','notes:read notes:write notes:move','notes:read notes:write notes:delete','notes:read notes:write notes:move notes:delete')`),
    index("oauth_codes_client_idx").on(t.clientId),
    index("oauth_codes_user_idx").on(t.userId),
  ]
);

// #200: no `user_id` on purpose: the user comes via `parent_token_id`, so revoking the parent, OAuth re-authorization (delete then
// insert), OAuth client cleanup and user deletion all cascade away child rows; refresh updates in place and keeps them.
// Only uploads are single use; downloads are reusable within the TTL.
export const transferTokens = pgTable(
  "transfer_tokens",
  {
    id: uuid().primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull().unique(),
    parentTokenId: uuid("parent_token_id")
      .notNull()
      .references(() => apiTokens.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").references(() => notes.id, { onDelete: "cascade" }),
    purpose: text().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    access: text(),
    range: jsonb().$type<BulkRange>(),
  },
  t => [
    check("transfer_tokens_purpose_chk", sql`${t.purpose} in ('upload','download','bulk')`),
    check("transfer_tokens_consumed_chk", sql`${t.purpose} = 'upload' or ${t.consumedAt} is null`),
    check("transfer_tokens_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
    check("transfer_tokens_bulk_note_chk", sql`(${t.purpose} = 'bulk') = (${t.noteId} is null)`),
    check("transfer_tokens_bulk_access_chk", sql`(${t.purpose} = 'bulk') = (${t.access} is not null)`),
    check("transfer_tokens_bulk_range_chk", sql`(${t.purpose} = 'bulk') = (${t.range} is not null)`),
    check("transfer_tokens_access_chk", sql`${t.access} in ('read','write')`),
    // FK cascades on parent revoke and note delete; parent_idx also serves the unconsumed count at issuance.
    index("transfer_tokens_parent_idx").on(t.parentTokenId),
    index("transfer_tokens_note_idx").on(t.noteId),
    index("transfer_tokens_expires_idx").on(t.expiresAt),
  ]
);

// Defined here, not in `transfer/`, so schema depends on types only (no cycle). `start`/`count`: line range in the normalized export.
// `links`: `linkTextHash` of wikilinks without custom text; absent in older bases.
export type TransferSegment = { ids: string[]; fps: string[]; start: number; count: number; links?: string[] };

// bulk transfer write-back base: salted HMAC hashes only, keyed from `APP_SECRET`, so rotating it invalidates bases (`key_id`).
// No three-way merge: if the note changed since download, write-back answers 409 `base_unavailable` (`NoteWriteService.syncFile`).
// `segments` NULL = segment table didn't match at download; such bases can't be written back.
export const transferBases = pgTable(
  "transfer_bases",
  {
    key: text().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    salt: bytea().notNull(),
    keyId: text("key_id").notNull(),
    bodySha: bytea("body_sha").notNull(),
    titleSha: bytea("title_sha").notNull(),
    // Null on a base made before these columns existed.
    tagsSha: bytea("tags_sha"),
    lineHashes: bytea("line_hashes").notNull(),
    lineKinds: bytea("line_kinds").notNull(),
    segments: jsonb().$type<TransferSegment[] | null>(),
    appliedBodySha: bytea("applied_body_sha"),
    // `note_ai_edits` rows from this write-back; a resend after any was reverted gets 409. No FK: a trimmed row counts as not reverted.
    appliedEditIds: uuid("applied_edit_ids").array(),
    appliedTitleSha: bytea("applied_title_sha"),
    appliedTagsSha: bytea("applied_tags_sha"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    index("transfer_bases_user_note_created_idx").on(t.userId, t.noteId, t.createdAt.desc()),
    index("transfer_bases_last_used_idx").on(t.lastUsedAt),
    // FK cascade on note delete; the other indexes don't lead with note_id.
    index("transfer_bases_note_idx").on(t.noteId),
  ]
);

// bulk transfer: dedupes "create note" write-backs; the PK makes concurrent duplicates upsert into one note.
// Rows with another `key_id` are ignored.
export const transferCreates = pgTable(
  "transfer_creates",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fileSha: bytea("file_sha").notNull(),
    noteId: uuid("note_id")
      .notNull()
      .references(() => notes.id, { onDelete: "cascade" }),
    keyId: text("key_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    primaryKey({ columns: [t.userId, t.fileSha] }),
    index("transfer_creates_created_idx").on(t.createdAt),
    // FK cascade on note delete; the other indexes don't lead with note_id.
    index("transfer_creates_note_idx").on(t.noteId),
  ]
);

// #286/#285: plaintext is never stored; the validity predicate lives only in `auth/one-time-link.ts`. Expired unused reset rows
// still hold the one-active-reset slot, so regenerate/cancel/disable revoke the old one first.
export const oneTimeLinks = pgTable(
  "one_time_links",
  {
    id: uuid().primaryKey().defaultRandom(),
    kind: text().notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    targetUserId: uuid("target_user_id").references(() => users.id, { onDelete: "cascade" }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    label: text(),
    usedById: uuid("used_by_id").references(() => users.id, { onDelete: "set null" }),
  },
  t => [
    check("one_time_links_kind_chk", sql`${t.kind} in ('password_reset', 'invite')`),
    check("one_time_links_reset_target_chk", sql`${t.kind} <> 'password_reset' or ${t.targetUserId} is not null`),
    check("one_time_links_expiry_chk", sql`${t.expiresAt} > ${t.createdAt}`),
    check("one_time_links_end_chk", sql`${t.usedAt} is null or ${t.revokedAt} is null`),
    check("one_time_links_invite_target_chk", sql`${t.kind} <> 'invite' or ${t.targetUserId} is null`),
    check("one_time_links_invite_fields_chk", sql`${t.kind} = 'invite' or (${t.label} is null and ${t.usedById} is null)`),
    check("one_time_links_label_chk", sql`${t.label} is null or char_length(${t.label}) between 1 and 100`),
    check("one_time_links_used_by_chk", sql`${t.usedById} is null or ${t.usedAt} is not null`),
    uniqueIndex("one_time_links_reset_active_uidx")
      .on(t.targetUserId)
      .where(sql`${t.kind} = 'password_reset' and ${t.usedAt} is null and ${t.revokedAt} is null`),
    index("one_time_links_kind_created_idx").on(t.kind, t.createdAt),
  ],
);

// #388: the session JWT's `sid` is this row's id, so logout signs out one device. Ids needn't be secret: the JWT is signed.
// `expires_at` = JWT `exp`, not sliding. Disabling an account and password change/add/reset (in the `tv` bump tx) delete all rows.
// API and transfer tokens are unaffected.
export const sessions = pgTable(
  "sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  t => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

// #397: no row = default/auto, so "reset" deletes it. Ranges are validated in `SiteLimits.update` and `resolveSnapshot`, not the
// DB (new limits need no migration); invalid rows are skipped, not deleted, as a later version may accept them. Env overrides rows.
export const siteLimits = pgTable(
  "site_limits",
  {
    key: text().primaryKey(),
    value: integer().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [
    check("site_limits_key_chk", sql`${t.key} ~ '^[a-zA-Z][a-zA-Z0-9]{0,63}$'`),
    check("site_limits_value_chk", sql`${t.value} >= 0`),
  ],
);

// #397: rows of one change share `changed_at` (`now()` = tx start), which the UI groups by. `*_value` NULL = default/auto.
// `key` has no FK so history survives removed limits.
export const siteLimitChanges = pgTable(
  "site_limit_changes",
  {
    id: uuid().primaryKey().defaultRandom(),
    key: text().notNull(),
    oldValue: integer("old_value"),
    newValue: integer("new_value"),
    oldEffective: integer("old_effective").notNull(),
    newEffective: integer("new_effective").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  t => [index("site_limit_changes_changed_at_idx").on(t.changedAt.desc())],
);

// Outside the Yjs document: no schema version, fingerprint or `notes.updated_at` effect. `reply_to_id` has no FK: it is
// validated at write time and a missing target at read time means the answered comment was deleted.
// The length CHECKs must match COMMENT_BODY_MAX / COMMENT_QUOTE_MAX (comment-check-sync.test.ts).
export const noteComments = pgTable(
  "note_comments",
  {
    id: uuid().primaryKey().defaultRandom(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    authorId: uuid("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references((): AnyPgColumn => apiTokens.id, { onDelete: "set null" }),
    agentLabel: text("agent_label"),
    replyToId: uuid("reply_to_id"),
    anchorBlockId: text("anchor_block_id"),
    anchorQuote: text("anchor_quote"),
    body: text().notNull(),
    // Insert time after the locks are taken, not transaction start: the MCP `since` lag assumes it.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  t => [
    check("note_comments_body_chk", sql`char_length(${t.body}) between 1 and 4000`),
    check("note_comments_quote_chk", sql`${t.anchorQuote} is null or char_length(${t.anchorQuote}) between 1 and 200`),
    index("note_comments_note_created_idx").on(t.noteId, t.createdAt, t.id),
    index("note_comments_token_idx").on(t.tokenId),
  ],
);

// The only thing that makes a span a mention; rendering never parses mentions out of the body.
export const noteCommentMentions = pgTable(
  "note_comment_mentions",
  {
    commentId: uuid("comment_id").notNull().references(() => noteComments.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    agentLabel: text("agent_label"),
    start: integer().notNull(),
    length: integer().notNull(),
  },
  t => [
    primaryKey({ columns: [t.commentId, t.start] }),
    check("note_comment_mentions_span_chk", sql`${t.start} >= 0 and ${t.length} >= 2`),
  ],
);

// Who has been notified for a comment, so edits never notify the same target twice. NULL label is its own value.
export const commentNotified = pgTable(
  "comment_notified",
  {
    commentId: uuid("comment_id").notNull().references(() => noteComments.id, { onDelete: "cascade" }),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    agentLabel: text("agent_label"),
  },
  t => [unique("comment_notified_target_uq").on(t.commentId, t.userId, t.agentLabel).nullsNotDistinct()],
);

// `agent_label` NULL = the person; set = that person's agent with this label.
export const notifications = pgTable(
  "notifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    agentLabel: text("agent_label"),
    kind: text().notNull(),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").notNull().references(() => noteComments.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actorAgentLabel: text("actor_agent_label"),
    // Same clock as note_comments.created_at.
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().default(sql`clock_timestamp()`),
  },
  t => [
    check("notifications_kind_chk", sql`${t.kind} in ('mention','reply')`),
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc(), t.id),
    index("notifications_note_idx").on(t.noteId),
    index("notifications_comment_idx").on(t.commentId),
    index("notifications_created_idx").on(t.createdAt),
  ],
);

export const notificationSeen = pgTable("notification_seen", {
  userId: uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  seenAt: timestamp("seen_at", { withTimezone: true }).notNull(),
});

export const noteCommentReads = pgTable(
  "note_comment_reads",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    noteId: uuid("note_id").notNull().references(() => notes.id, { onDelete: "cascade" }),
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
  },
  t => [
    primaryKey({ columns: [t.userId, t.noteId] }),
    // PK leads with user_id; the cascade on note deletion needs this.
    index("note_comment_reads_note_idx").on(t.noteId),
  ],
);
