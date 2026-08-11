import { eq } from "drizzle-orm";
import type pino from "pino";
import type { Db } from "../db/index.js";
import { aiProviders } from "../db/schema.js";
import { AiKeyDecryptError, decryptApiKey, type EncryptedApiKey } from "./crypto.js";

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
 * - `enabled: false` 的 provider 略過（不檢查、不降級——未啟用本來就不會被用到）。
 * - `apiKeyEncrypted: null`（尚未設定 API key）→ 略過、不降級（NULL 是合法的初始狀態，
 *   不是錯誤，見 brief）。
 * - 解密失敗（keyId 不符或 GCM 驗證失敗，見 `crypto.ts` 的 `AiKeyDecryptError`）→
 *   `log.warn` 記錄（訊息含「至 admin 後台重輸 API key」指引）並加入 `runtime.degraded`。
 *
 * 刻意寫成純函式（不碰 DB）：unit test 用假的 rows 陣列直接測，不必假造 drizzle 查詢。
 */
export function checkProviderKeys(providers: AiProviderRow[], appSecret: string, runtime: AiRuntime, log: pino.BaseLogger): void {
  for (const provider of providers) {
    if (!provider.enabled) continue;
    // `== null` 而非 `=== null`：涵蓋 `undefined`（jsonb 欄位理論上只會是 `null` 或
    // 實際值，但這裡不假設 drizzle 的行為永遠如此——防禦性地讓 `undefined` 也走
    // 「跳過不降級」，而不是漏接後掉進下面 `decryptApiKey` 直接炸裸例外）。
    if (provider.apiKeyEncrypted == null) continue;

    try {
      decryptApiKey(appSecret, provider.apiKeyEncrypted as EncryptedApiKey);
    } catch (err) {
      if (!(err instanceof AiKeyDecryptError)) throw err;
      log.warn(
        { providerId: provider.id, providerName: provider.name, err },
        `AI provider「${provider.name}」的 API key 解密失敗——請至 admin 後台重輸 API key`
      );
      runtime.degraded.add(provider.id);
    }
  }
}

/**
 * 薄層：SELECT 已啟用的 providers → 轉呼叫 `checkProviderKeys`（與 Task 4
 * `loadAiSnapshot`/`resolveActionModel` 同款「DB 查詢薄層 + 純函式核心」拆法）。
 * 啟動期自檢用（`index.ts`），也可供之後（例如 APP_SECRET 輪替後）重新呼叫。
 */
export async function selfCheckAiKeys(db: Db, appSecret: string, runtime: AiRuntime, log: pino.BaseLogger): Promise<void> {
  const providers = await db.select().from(aiProviders).where(eq(aiProviders.enabled, true));
  checkProviderKeys(providers, appSecret, runtime, log);
}
