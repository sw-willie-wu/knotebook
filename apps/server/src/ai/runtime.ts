import { and, eq, sql } from "drizzle-orm";
import type pino from "pino";
import type { Db } from "../db/index.js";
import { aiProviders } from "../db/schema.js";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey } from "./crypto.js";

/**
 * AI 執行期狀態（spec §13）：目前只有「降級集合」——啟動自檢或之後任何一次解密失敗
 * 都會把該 providerId 加進來，代表這個 provider 目前不可用（前端/路由層據此隱藏或
 * 標記為不可用，避免每次呼叫都重新踩一次解密失敗）。**process 存活期間單調累積**，
 * 不會自動移除——admin 在後台重輸 API key 後由該路由的成功寫入路徑自行
 * `runtime.degraded.delete(providerId)`（Task 4），本 task 只建集合本身與寫入路徑。
 */
export interface AiRuntime {
  degraded: Set<string>;
}

export function createAiRuntime(): AiRuntime {
  return { degraded: new Set() };
}

export type AiProviderRow = typeof aiProviders.$inferSelect;

/**
 * 純函式：逐一檢查 providers 的 API key 是否能用目前的 APP_SECRET 解密。
 * - `enabled: false` 的 provider **不降級也不 log**（未啟用本來就不會被用到），但**仍然納入
 *   密文升級**（見下方回傳值）。這兩件事必須分開：停用的列上那份 v1 密文若永遠不升級，它就是
 *   一份「解密時不驗 AAD」的 blob 一直躺在 DB 裡，把它複製到任何一個啟用中的 provider 就能
 *   讓 issue #14 的問題原封不動地留著（審查指出）。
 * - `apiKeyEncrypted: null`（尚未設定 API key）→ 略過、不降級（NULL 是合法的初始狀態，
 *   不是錯誤，見 brief）。
 * - 解密失敗（keyId 不符或 GCM 驗證失敗，見 `crypto.ts` 的 `AiKeyDecryptError`）→
 *   `log.warn` 記錄（訊息含「至 admin 後台重輸 API key」指引）並加入 `runtime.degraded`。
 *
 * 刻意寫成純函式（不碰 DB）：unit test 用假的 rows 陣列直接測，不必假造 drizzle 查詢。
 * 回傳「解得開、但還是舊格式（v1，沒有 AAD 綁定）」的那些 provider **id**——由呼叫端決定要
 * 不要就地升級（issue #14）。⚠ 刻意只回 id 不回明文金鑰：明文的生命週期就該留在解密的那一行
 * 附近，不要讓它跨過函式邊界變成「順手 log 一下回傳值」的現成標的（審查指出）。
 */
export function checkProviderKeys(
  providers: AiProviderRow[],
  appSecret: string,
  runtime: AiRuntime,
  log: pino.BaseLogger
): { upgradableIds: string[] } {
  const upgradableIds: string[] = [];
  for (const provider of providers) {
    // `== null` 而非 `=== null`：涵蓋 `undefined`（jsonb 欄位理論上只會是 `null` 或
    // 實際值，但這裡不假設 drizzle 的行為永遠如此——防禦性地讓 `undefined` 也走
    // 「跳過不降級」，而不是漏接後掉進下面 `decryptApiKey` 直接炸裸例外）。
    if (provider.apiKeyEncrypted == null) continue;

    try {
      decryptApiKey(appSecret, provider.apiKeyEncrypted, provider.id);
      if (provider.apiKeyEncrypted.v === 1) upgradableIds.push(provider.id);
    } catch (err) {
      if (!(err instanceof AiKeyDecryptError)) throw err;
      // 停用的 provider 解不開不是問題（沒人會用到它），維持「不降級、不 log」的既有語意。
      if (!provider.enabled) continue;
      log.warn(
        { providerId: provider.id, providerName: provider.name, err },
        `AI provider「${provider.name}」的 API key 解密失敗——請至 admin 後台重輸 API key`
      );
      runtime.degraded.add(provider.id);
    }
  }
  return { upgradableIds };
}

/**
 * 薄層：SELECT providers → 轉呼叫 `checkProviderKeys`（與 Task 4
 * `loadAiSnapshot`/`resolveActionModel` 同款「DB 查詢薄層 + 純函式核心」拆法），再把還是舊
 * 格式的密文就地升級。啟動期自檢用（`index.ts`），也可供之後（例如 APP_SECRET 輪替後）重新呼叫。
 */
export async function selfCheckAiKeys(db: Db, appSecret: string, runtime: AiRuntime, log: pino.BaseLogger): Promise<void> {
  // 查**全部** provider，不是只查啟用中的：降級只對啟用中的有意義，但密文升級對停用的列
  // 同樣必要（見 `checkProviderKeys` 的說明）。
  const providers = await db.select().from(aiProviders);
  const { upgradableIds } = checkProviderKeys(providers, appSecret, runtime, log);
  if (upgradableIds.length === 0) return;

  // issue #14 的遷移路徑：解得開的舊格式（v1，密文沒綁 providerId）就地重寫成 v2。
  // 沒有這一步的話，既有部署要等到有人「去後台重輸 API key」才會拿到那道綁定，等於
  // 修了也沒生效。用目前的 APP_SECRET 解得開才升級，所以不會把壞掉的資料寫得更死。
  //
  // 升級失敗（DB 寫入出錯）**不擋啟動**：舊密文仍然讀得動、AI 功能完全不受影響，下次啟動
  // 再試一次即可——與「壞掉的單一 provider 只降級、不擋啟動」同一個精神。
  let upgraded = 0;
  for (const id of upgradableIds) {
    const provider = providers.find(row => row.id === id);
    if (provider?.apiKeyEncrypted == null) continue;
    try {
      const apiKey = decryptApiKey(appSecret, provider.apiKeyEncrypted, id);
      // ⚠ 只在「這一列還是 v1」時才寫（CAS）。多實例／滾動更新時，另一個實例還在開機掃描的
      // 期間，admin 可能剛好 PATCH 了新的 API key（一律寫 v2）——沒有這道條件的話，這裡會拿
      // 開機當下讀到的**舊** plaintext 覆蓋回去，把剛設好的新金鑰無聲回捲，而 log 還會說
      // 「已升級為 v2」（審查指出）。命中 0 列＝別人先改過，跳過即可。
      await db
        .update(aiProviders)
        .set({ apiKeyEncrypted: encryptApiKey(appSecret, apiKey, id) })
        .where(and(eq(aiProviders.id, id), sql`${aiProviders.apiKeyEncrypted}->>'v' = '1'`));
      upgraded += 1;
    } catch (err) {
      log.warn(
        { providerId: id, err },
        "AI provider API key 密文升級為 v2 失敗（AI 功能不受影響，舊格式仍可解密），下次啟動會再試"
      );
    }
  }
  // 讓自架者能確認遷移有沒有收斂——沒有這行的話，「還剩幾列是舊格式」在外部完全看不出來
  // （API 只回 hasKey）。
  log.info({ upgraded, remaining: upgradableIds.length - upgraded }, "AI provider API key 密文升級掃描完成");
}
