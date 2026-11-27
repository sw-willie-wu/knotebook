import { eq, sql } from "drizzle-orm";
import { VERSION_DAYS_MAX, type NotificationSettingsDto, type TrashSettingsDto, type VersionSettingsDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { authProviders, siteSettings } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { hasUsableSso } from "../sign-in-methods.js";

export const SITE_SETTINGS_MISSING_MESSAGE = "Site settings are missing (site_settings has no row).";

/**
 * Settings writes and every provider PATCH/DELETE take this row first, unconditionally (a conditional lock leaves gaps), so two admins
 * disabling providers can't both pass the lock-out guard.
 */
export async function lockSiteSettingsInTx(tx: Tx): Promise<{ registrationEnabled: boolean; passwordLoginEnabled: boolean }> {
  const [row] = await tx
    .select({ registrationEnabled: siteSettings.registrationEnabled, passwordLoginEnabled: siteSettings.passwordLoginEnabled })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true))
    .for("no key update");
  if (row === undefined) throw new TxAbort(500, "internal", SITE_SETTINGS_MISSING_MESSAGE);
  return row;
}

/** By DB values only (an env override isn't exempt), so a state reached during rescue still holds without the env. Call it after the write, in the same transaction, holding the site-settings lock. */
export async function assertSsoOnlyGuardInTx(tx: Tx, actorUserId: string): Promise<void> {
  const [anyEnabled] = await tx.select({ one: sql<number>`1` }).from(authProviders).where(eq(authProviders.enabled, true)).limit(1);
  if (anyEnabled === undefined) throw new TxAbort(409, "sso_provider_required", "Enable at least one sign-in service before turning off password sign-in.");
  if (!(await hasUsableSso(tx, actorUserId))) {
    throw new TxAbort(409, "admin_sso_link_required", "Link an enabled sign-in service to your own account in Settings before turning off password sign-in.");
  }
}

export interface UpdateSiteSettingsInput {
  actorUserId: string;
  registrationEnabled?: boolean;
  passwordLoginEnabled?: boolean;
}

export interface UpdateSiteSettingsResult {
  previousPasswordLoginEnabled: boolean;
  passwordLoginEnabled: boolean;
}

/** The guard runs only when the body sets `passwordLoginEnabled: false` (also when the DB value is already off: idempotent), so a registration-only change stays possible during env rescue. A violation rolls back everything, registration switch included. Enabling is always allowed; no session is revoked. */
export async function updateSiteSettingsInTx(tx: Tx, input: UpdateSiteSettingsInput): Promise<UpdateSiteSettingsResult> {
  const before = await lockSiteSettingsInTx(tx);
  const passwordLoginEnabled = input.passwordLoginEnabled ?? before.passwordLoginEnabled;
  await tx
    .update(siteSettings)
    .set({ registrationEnabled: input.registrationEnabled ?? before.registrationEnabled, passwordLoginEnabled, updatedAt: sql`now()` })
    .where(eq(siteSettings.singleton, true));
  if (input.passwordLoginEnabled === false) await assertSsoOnlyGuardInTx(tx, input.actorUserId);
  return { previousPasswordLoginEnabled: before.passwordLoginEnabled, passwordLoginEnabled };
}

export const VERSION_DAYS_RANGE_MESSAGE = "Retention days must satisfy 1 ≤ keepAllDays ≤ dailyUntilDays ≤ 3650.";
/** The route schema enforces the range; CHECK `site_settings_version_auto_wait_chk` is the backstop. */
export const VERSION_AUTO_WAIT_RANGE_MESSAGE = "The auto-save wait must be a whole number of minutes from 1 to 60.";

export interface UpdateVersionSettingsInput {
  keepAllDays?: number;
  dailyUntilDays?: number;
  autoVersionsEnabled?: boolean;
  autoWaitMinutes?: number;
}

/** The version columns are read after the lock (`lockSiteSettingsInTx` returns only the login fields). `1 <= keepAllDays <= dailyUntilDays <= 3650` else 400 (CHECK `site_settings_version_days_chk` is the same-value backstop). Changed days only affect later purges; a changed wait applies on the next scan to notes already waiting. */
export async function updateVersionSettingsInTx(tx: Tx, input: UpdateVersionSettingsInput): Promise<VersionSettingsDto> {
  await lockSiteSettingsInTx(tx);
  const [cur] = await tx
    .select({
      keepAllDays: siteSettings.versionKeepAllDays,
      dailyUntilDays: siteSettings.versionDailyUntilDays,
      autoVersionsEnabled: siteSettings.autoVersionsEnabled,
      autoWaitMinutes: siteSettings.versionAutoWaitMinutes,
    })
    .from(siteSettings)
    .where(eq(siteSettings.singleton, true));
  const next: VersionSettingsDto = {
    keepAllDays: input.keepAllDays ?? cur!.keepAllDays,
    dailyUntilDays: input.dailyUntilDays ?? cur!.dailyUntilDays,
    autoVersionsEnabled: input.autoVersionsEnabled ?? cur!.autoVersionsEnabled,
    autoWaitMinutes: input.autoWaitMinutes ?? cur!.autoWaitMinutes,
  };
  if (!(1 <= next.keepAllDays && next.keepAllDays <= next.dailyUntilDays && next.dailyUntilDays <= VERSION_DAYS_MAX)) {
    throw new TxAbort(400, "invalid_body", VERSION_DAYS_RANGE_MESSAGE);
  }
  await tx
    .update(siteSettings)
    .set({
      versionKeepAllDays: next.keepAllDays,
      versionDailyUntilDays: next.dailyUntilDays,
      autoVersionsEnabled: next.autoVersionsEnabled,
      versionAutoWaitMinutes: next.autoWaitMinutes,
      updatedAt: sql`now()`,
    })
    .where(eq(siteSettings.singleton, true));
  return next;
}

export const TRASH_RETENTION_RANGE_MESSAGE = "Retention days must be a whole number from 1 to 3650, or null to never delete automatically.";

/** The route validates the range (CHECK `site_settings_trash_retention_chk` is the backstop); `null` means never auto-purge; only later cleanup rounds are affected. */
export async function updateTrashSettingsInTx(tx: Tx, input: { retentionDays: number | null }): Promise<TrashSettingsDto> {
  await lockSiteSettingsInTx(tx);
  await tx
    .update(siteSettings)
    .set({ trashRetentionDays: input.retentionDays, updatedAt: sql`now()` })
    .where(eq(siteSettings.singleton, true));
  return { retentionDays: input.retentionDays };
}

export const NOTIFICATION_RETENTION_RANGE_MESSAGE = "Retention days must be a whole number from 1 to 3650, or null to never delete automatically.";

/** The route validates the range (CHECK `site_settings_notification_retention_chk` is the backstop); `null` means never expire; only later cleanup rounds are affected. */
export async function updateNotificationSettingsInTx(tx: Tx, input: { retentionDays: number | null }): Promise<NotificationSettingsDto> {
  await lockSiteSettingsInTx(tx);
  await tx
    .update(siteSettings)
    .set({ notificationRetentionDays: input.retentionDays, updatedAt: sql`now()` })
    .where(eq(siteSettings.singleton, true));
  return { retentionDays: input.retentionDays };
}
