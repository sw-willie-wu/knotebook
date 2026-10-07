import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { authProviders } from "../../db/schema.js";
import type { EncryptedSecret } from "../../lib/sealed-secret.js";
import { TxAbort } from "../../http/tx-abort.js";
import { assertSsoOnlyGuardInTx, lockSiteSettingsInTx } from "./admin-site-settings.js";

// #187 PR2：站台管理對 `auth_providers` 的交易本體（S14：只收 tx、只做 DB）。列表、POST 的 RETURNING 與本檔的 UPDATE
// RETURNING 共用 `adminProviderColumns()`——`hasSecret` 由 SQL 端 `is not null` 算，**從不** SELECT 密文本體（INV-5；
// 比照 `routes/admin-ai.ts` 的 `providerListColumns`）。
// #187 PR3：B27 第一句、B19 在 UPDATE 之後（spec §9.2 rev 10）。

export interface AdminProviderRow {
  id: string;
  template: string;
  displayName: string;
  issuerUrl: string;
  clientId: string;
  enabled: boolean;
  sortOrder: number;
  legacyCallback: boolean;
  configVersion: number;
  createdAt: Date;
  hasSecret: boolean;
  issuerResolved: boolean;
  iconKind: string;
  iconVersion: number;
}

/** 每次現造（drizzle 的 `sql` 片段與 select 形不重用）。`createdAt` 必須是欄位本身——raw `sql` 選時間戳回字串。 */
export function adminProviderColumns() {
  return {
    id: authProviders.id,
    template: authProviders.template,
    displayName: authProviders.displayName,
    issuerUrl: authProviders.issuerUrl,
    clientId: authProviders.clientId,
    enabled: authProviders.enabled,
    sortOrder: authProviders.sortOrder,
    legacyCallback: authProviders.legacyCallback,
    configVersion: authProviders.configVersion,
    createdAt: authProviders.createdAt,
    hasSecret: sql<boolean>`${authProviders.clientSecretEncrypted} is not null`,
    issuerResolved: sql<boolean>`${authProviders.resolvedIssuer} is not null`,
    // 圖示：只選換算要的兩欄（template 已在上面），**不選 icon_data／icon_mime**（spec §5.3）。
    iconKind: authProviders.iconKind,
    iconVersion: authProviders.iconVersion,
  };
}

export interface UpdateAuthProviderInput {
  id: string;
  displayName?: string;
  issuerUrl?: string;
  clientId?: string;
  sortOrder?: number;
  enabled?: boolean;
  /** 圖示種類（不含 upload）。帶了就在同一句 UPDATE 清掉上傳圖（data／mime 設 NULL）；icon_version 不動、config_version 不看它。 */
  iconKind?: "template" | "gitlab" | "google" | "none";
  /** B19 P2 的「操作者」。 */
  actorUserId: string;
  /** 已封好的新 secret（AAD 綁 id；**交易外**封——S14）。undefined＝這次沒帶 secret，走 §5.2 (a) 句。 */
  newSecretSealed?: EncryptedSecret;
}

export interface UpdateAuthProviderResult {
  row: AdminProviderRow;
  /** 只供稽核 log 的 `from`：B27 站台設定鎖之後的一般讀——改 `issuer_url` 的寫入（provider PATCH）都排在那把鎖後，讀到的是當下的 issuer（PR3 起；`recordResolvedIssuer` 不取這把鎖，但它只寫 `resolved_issuer`）。 */
  previousIssuerUrl: string;
}

/**
 * #187 §5.2：改登入服務。**所有「有沒有變」的判斷都在這一句 UPDATE 的 SET 右側**——SET 右側一律對舊 tuple 求值、UPDATE 對
 * 該列取 row lock，所以「issuer 有沒有變」永遠是拿這一次要寫進去的值跟當下的舊值比（#46：Node 端先讀再比是 TOCTOU，
 * 60 輪命中 17 次）。沒帶的欄位以 `coalesce(參數, 現值)` 代入（r3-M2）：沒帶 issuerUrl 不算改 issuer、沒帶 clientId 不算改 client。
 *
 * (a) 沒帶 secret：issuer 變了 → 清 secret、清 resolved_issuer、停用；版本只在 issuer 或 client id 實際變更時 +1。
 * (b) 帶了 secret：secret 直接覆寫、版本 +1；issuer 變了 → 清 resolved_issuer、**強制停用**（INV-2 的加嚴形）。
 *
 * #187 PR3：B27 第一句、B19 在 UPDATE 之後（spec §9.2 rev 10）。
 */
export async function updateAuthProviderInTx(tx: Tx, input: UpdateAuthProviderInput): Promise<UpdateAuthProviderResult> {
  // B27：第一句取站台設定列鎖（序列化所有站台設定寫入，C25）。之後的 `before` 讀因此可信（其他 provider PATCH 都排在鎖後）。
  const settings = await lockSiteSettingsInTx(tx);
  const [before] = await tx
    .select({ issuerUrl: authProviders.issuerUrl, enabled: authProviders.enabled })
    .from(authProviders)
    .where(eq(authProviders.id, input.id))
    .limit(1);
  if (!before) throw new TxAbort(404, "not_found", "找不到此登入服務");

  const newIssuer = () => sql`coalesce(${input.issuerUrl ?? null}::text, ${authProviders.issuerUrl})`;
  const newClientId = () => sql`coalesce(${input.clientId ?? null}::text, ${authProviders.clientId})`;
  const issuerChanged = () => sql`${authProviders.issuerUrl} is distinct from ${newIssuer()}`;
  const clientChanged = () => sql`${authProviders.clientId} is distinct from ${newClientId()}`;

  const common = {
    issuerUrl: newIssuer(),
    clientId: newClientId(),
    displayName: sql`coalesce(${input.displayName ?? null}::text, ${authProviders.displayName})`,
    sortOrder: sql`coalesce(${input.sortOrder ?? null}::integer, ${authProviders.sortOrder})`,
    resolvedIssuer: sql`case when ${issuerChanged()} then null else ${authProviders.resolvedIssuer} end`,
    enabled: sql`case when ${issuerChanged()} then false else coalesce(${input.enabled ?? null}::boolean, ${authProviders.enabled}) end`,
    // 圖示（spec 2026-10-07-provider-icon §4.3）：沒帶 iconKind → 三欄原值；帶了 → 換 kind 並清圖（CHECK auth_providers_icon_upload_chk 要求非 upload ⇔ 兩欄皆 NULL）。
    iconKind: sql`coalesce(${input.iconKind ?? null}::text, ${authProviders.iconKind})`,
    iconData: sql`case when ${input.iconKind ?? null}::text is null then ${authProviders.iconData} else null::bytea end`,
    iconMime: sql`case when ${input.iconKind ?? null}::text is null then ${authProviders.iconMime} else null::text end`,
    updatedAt: sql`now()`,
  };
  const set =
    input.newSecretSealed === undefined
      ? {
          ...common,
          clientSecretEncrypted: sql`case when ${issuerChanged()} then null::jsonb else ${authProviders.clientSecretEncrypted} end`,
          configVersion: sql`case when ${issuerChanged()} or ${clientChanged()} then ${authProviders.configVersion} + 1 else ${authProviders.configVersion} end`,
        }
      : {
          ...common,
          clientSecretEncrypted: input.newSecretSealed,
          configVersion: sql`${authProviders.configVersion} + 1`,
        };

  const [row] = await tx.update(authProviders).set(set).where(eq(authProviders.id, input.id)).returning(adminProviderColumns());
  // 讀到之後、UPDATE 之前被刪（別的管理員 DELETE）→ 0 列。
  if (!row) throw new TxAbort(404, "not_found", "找不到此登入服務");
  // B19：DB 值為關時，任何使 enabled 由 true 變 false 的形（含 §5.2 改 issuer 的隱含停用）都在寫入後狀態上驗 P1／P2；違反 → throw、整筆回滾。
  if (!settings.passwordLoginEnabled && before.enabled && !row.enabled) await assertSsoOnlyGuardInTx(tx, input.actorUserId);
  return { row, previousIssuerUrl: before.issuerUrl };
}

/**
 * #187 §9.2、W11：刪除登入服務——**單句裁決「已停用才刪」**（C7：與並發的重新啟用以 row lock 序列化，後到者以新版 tuple 判）。
 * 0 列時再查一次分辨 409／404（r2-N3）。identities 不動（B1：身分不綁 provider，以同 issuer 重建即恢復）。
 * #187 PR3：B27 第一句（spec §9.2 rev 10；不需 B19——已停用才刪得掉）。
 */
export async function deleteAuthProviderInTx(tx: Tx, input: { id: string }): Promise<void> {
  await lockSiteSettingsInTx(tx); // B27（不需 B19：已停用才刪得掉，不改 enabled 集合）
  const deleted = await tx
    .delete(authProviders)
    .where(and(eq(authProviders.id, input.id), eq(authProviders.enabled, false)))
    .returning({ id: authProviders.id });
  if (deleted.length === 1) return;
  const [still] = await tx.select({ enabled: authProviders.enabled }).from(authProviders).where(eq(authProviders.id, input.id)).limit(1);
  if (still) throw new TxAbort(409, "provider_enabled", "這個登入服務仍在啟用中，請先停用再刪除");
  throw new TxAbort(404, "not_found", "找不到此登入服務");
}
