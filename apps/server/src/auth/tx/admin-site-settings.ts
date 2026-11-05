import { eq, sql } from "drizzle-orm";
import { VERSION_DAYS_MAX, type TrashSettingsDto, type VersionSettingsDto } from "@knotebook/shared";
import type { Tx } from "../../db/tx.js";
import { authProviders, siteSettings } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { hasUsableSso } from "../sign-in-methods.js";

export const SITE_SETTINGS_MISSING_MESSAGE = "Site settings are missing (site_settings has no row).";

/**
 * #187 B27：站台設定寫入的序列化點＝`site_settings` 列。settings PATCH 與所有 provider PATCH／DELETE 的交易**第一句**都取它
 * （`FOR NO KEY UPDATE`，一律取、不看 DB 值——條件式取鎖會留漏網形）。B19 是「寫入後狀態」的跨列判斷：兩位管理員各停用一個
 * provider 時，沒有這把鎖各自看不到對方未提交的列、都會通過 P1（C25）。讀不到列 → 500（§4.3、§17 第 34 條）。
 * **持這把鎖的交易不鎖帳號列**（C28 無環：解除連結是「帳號列 → site_settings」單向）。本檔與 admin-auth-providers.ts 的註解一律寫「帳號列」——鎖序閘門剝註解後掃 `\busers\b`。
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

/**
 * #187 B19：DB 值為關時的防自鎖守衛，在**寫入後**狀態上驗（同交易、B27 鎖之後）。一律以 DB 值判——env 強制不豁免（救援期間的修改
 * 也要得出「拿掉 env 之後仍進得來」的狀態）。P1 至少一個啟用中 provider；P2 操作者本人有一個 identity 對到啟用中 provider 的
 * effective issuer（與 §9.5 的 `actingAdminHasSso` 同一個函式）。
 */
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
  /** 鎖下讀到的舊值（稽核 log 用：有變才記）。 */
  previousPasswordLoginEnabled: boolean;
  passwordLoginEnabled: boolean;
}

/**
 * #187 交易表 P4（§9.5 PATCH）。①B27 鎖 ②UPDATE ③**只有 body 帶 `passwordLoginEnabled: false`** 才驗 B19（gate r4-M1：只改註冊開關
 * 不驗——否則 DB 已關時，env 救援登入、本人尚無 SSO 的管理員連註冊開關都改不了；DB 原本已關也照驗，冪等）。違反 → throw，
 * 整筆回滾（含同一次帶的註冊開關，RF3）。開啟永遠允許。不撤任何 session（B25）。
 */
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
/** #272 §8：PATCH 的 `autoWaitMinutes` 超出 1–60（路由 schema 的 refine 用；DB CHECK `site_settings_version_auto_wait_chk` 是最後防線）。 */
export const VERSION_AUTO_WAIT_RANGE_MESSAGE = "The auto-save wait must be a whole number of minutes from 1 to 60.";

export interface UpdateVersionSettingsInput {
  keepAllDays?: number;
  dailyUntilDays?: number;
  autoVersionsEnabled?: boolean;
  /** #272 §8：自動存版等待（分鐘）；範圍由路由驗。 */
  autoWaitMinutes?: number;
}

/**
 * 版本歷史 §6.7：照 `updateSiteSettingsInTx` 的形。①B27 鎖（`lockSiteSettingsInTx` 只回兩個登入欄位，四個版本欄在鎖後另讀）
 * ②合併 ③驗 `1 ≤ F ≤ D ≤ 3650`（違反 → 400 `invalid_body`，DB CHECK `site_settings_version_days_chk` 是同值的最後防線）④UPDATE。
 * 天數改了只影響之後的清除（§10.2）；等待 X 改了下一輪掃描就作用在已待切的筆記（#272 §4.1）。
 */
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

/**
 * #181 §6.9：垃圾桶保留天數。照 `updateVersionSettingsInTx` 的形：先取 B27 鎖（與其他站台設定寫入序列化）再 UPDATE。
 * 範圍由路由驗（DB CHECK `site_settings_trash_retention_chk` 是最後防線）；`null`＝不自動永久刪除。改了只影響之後的清理輪次。
 */
export async function updateTrashSettingsInTx(tx: Tx, input: { retentionDays: number | null }): Promise<TrashSettingsDto> {
  await lockSiteSettingsInTx(tx);
  await tx
    .update(siteSettings)
    .set({ trashRetentionDays: input.retentionDays, updatedAt: sql`now()` })
    .where(eq(siteSettings.singleton, true));
  return { retentionDays: input.retentionDays };
}
