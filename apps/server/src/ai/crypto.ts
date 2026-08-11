import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// AI provider API key 的靜態加密（spec §13.2）。金鑰衍生比照 `auth/session.ts` 的
// sha256 namespace 慣例（`sessionKey`）——同一個 APP_SECRET 用不同 namespace 字串
// 字尾衍生出互不相通的用途專屬金鑰，不會讓 session JWT 的簽章金鑰與這裡的加密金鑰
// 撞在一起（即使兩者都源自同一個 APP_SECRET）。

/** AES-256-GCM 需要 32 bytes 金鑰；sha256 摘要正好 32 bytes，直接當金鑰用。 */
function deriveKey(appSecret: string): Buffer {
  return createHash("sha256").update(`${appSecret}:ai-key`).digest();
}

/**
 * `keyId` 是**衍生金鑰的雜湊指紋**，不是金鑰本身（或其片段）的任何形式外洩——
 * 對衍生金鑰再雜湊一次取前 8 hex chars，純粹用來快速判斷「這筆密文是不是用目前這把
 * APP_SECRET 衍生出的金鑰加的」（例如 APP_SECRET 被更換後，舊密文的 keyId 會對不上，
 * 可以在真的跑 GCM 解密之前就先判斷失敗，且理由更明確：金鑰換了，而非資料被竄改）。
 */
function deriveKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export interface EncryptedApiKey {
  v: 1;
  keyId: string;
  /** base64，12 bytes（AES-GCM 建議的 IV 長度）。 */
  iv: string;
  /** base64，GCM 認證標籤。 */
  tag: string;
  /** base64，密文本體。 */
  ct: string;
}

/** `keyId` 不符（APP_SECRET 已變更）或 GCM 認證失敗（密文被竄改/損毀）皆拋此型別。 */
export class AiKeyDecryptError extends Error {}

export function encryptApiKey(appSecret: string, plaintext: string): EncryptedApiKey {
  const key = deriveKey(appSecret);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    keyId: deriveKeyId(key),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ct.toString("base64"),
  };
}

export function decryptApiKey(appSecret: string, payload: EncryptedApiKey): string {
  // 防禦性檢查——`payload` 的靜態型別是 `EncryptedApiKey`，但實際來源是 DB 的 jsonb
  // 欄位（`ai/runtime.ts` 從 `unknown` cast 過來，沒有經過 schema 驗證），執行期完全
  // 可能是 `null`／字串／數字這類根本不是物件的壞資料（例如手動改過 DB、未來欄位格式
  // 演進中的過渡資料）。`typeof payload !== "object"` 同時擋掉 `null` 以外的非物件值
  // 與 `undefined`（`typeof undefined === "undefined"`），前面的 `payload === null`
  // 只是讓 null 這個最常見的壞值語意上更直白，非嚴格必要（下一條件已涵蓋）。
  // 不加這段的話，壞資料列會在下面 `payload.keyId` 讀取處直接炸出裸 TypeError，
  // 逃出 `AiKeyDecryptError` 的型別契約，讓呼叫端（`checkProviderKeys`）的
  // 「非 AiKeyDecryptError 一律往外丟」tripwire 把它整個丟出 `selfCheckAiKeys`，
  // 在 `index.ts` 沒有 try/catch 包住的情況下直接讓開機失敗——與「壞掉的單一
  // provider 只降級、不擋啟動」的設計精神相反。
  if (payload === null || typeof payload !== "object") {
    throw new AiKeyDecryptError("AI provider API key 解密失敗（密文格式不是物件，資料可能已損毀）：請至 admin 後台重輸 API key");
  }
  // `v` 是密文格式版本欄位——目前只有 v1，遇到非 1（例如未來格式升級但金鑰仍是舊版
  // 產出、或資料被竄改成不認得的版本號）一律視為解密失敗，不可靜默沿用 v1 的欄位
  // 語意去解一份格式其實不同的密文（即使剛好解得動也不代表結果正確）。
  if (payload.v !== 1) {
    throw new AiKeyDecryptError(`AI provider API key 解密失敗（未知的密文格式版本 v=${JSON.stringify(payload.v)}）：請至 admin 後台重輸 API key`);
  }
  const key = deriveKey(appSecret);
  // keyId 不符時提前判斷、不進 GCM 解密——理由見上方 deriveKeyId 註解。
  if (payload.keyId !== deriveKeyId(key)) {
    throw new AiKeyDecryptError("AI provider API key 解密失敗（金鑰指紋不符，APP_SECRET 可能已變更）：請至 admin 後台重輸 API key");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const pt = Buffer.concat([decipher.update(Buffer.from(payload.ct, "base64")), decipher.final()]);
    return pt.toString("utf8");
  } catch (err) {
    throw new AiKeyDecryptError(
      `AI provider API key 解密失敗（密文驗證失敗，可能已損毀或被竄改）：請至 admin 後台重輸 API key（原始錯誤：${err instanceof Error ? err.message : String(err)}）`
    );
  }
}
