import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { authProviders, siteSettings } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { hasUsableSso } from "../sign-in-methods.js";

export const SITE_SETTINGS_MISSING_MESSAGE = "站台設定遺失（site_settings 沒有列）";

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
  if (anyEnabled === undefined) throw new TxAbort(409, "sso_provider_required", "關閉帳號密碼登入前，請先啟用至少一個登入服務");
  if (!(await hasUsableSso(tx, actorUserId))) {
    throw new TxAbort(409, "admin_sso_link_required", "關閉帳號密碼登入前，請先在個人設定連結一個啟用中的登入服務");
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
