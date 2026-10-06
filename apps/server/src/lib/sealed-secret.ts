import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** #187 §5.1：通用靜態加密的密文格式。與 `ai/crypto.ts` 的 `EncryptedApiKey` v2 **逐欄相同**（不得改 AI 密文格式）。 */
export interface EncryptedSecret {
  v: 2;
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}

/** 解不開（格式不對、版本不認得、金鑰指紋不符、GCM 認證失敗）一律拋這個。訊息不含明文。 */
export class SecretDecryptError extends Error {}

/** 與 `ai/crypto.ts` 同一條 namespace 紀律：同一把 APP_SECRET 依用途衍生互不相通的金鑰。 */
function deriveKey(appSecret: string, namespace: string): Buffer {
  return createHash("sha256").update(`${appSecret}:${namespace}`).digest();
}

/** 衍生金鑰的雜湊指紋（前 8 hex），與 `ai/crypto.ts` 的 `deriveKeyId` 同算法。 */
function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * #187 §5.1：通用靜態加密。輸出格式＝`EncryptedApiKey` v2（`ai/crypto.ts`）——`encryptApiKey` 就是
 * `sealSecret(appSecret, "ai-key", plaintext, "ai-key:v2:<providerId>")`。`aad` 綁「這份密文屬於哪一列」：
 * 搬到別列解不開（issue #14 的同一個理由）。
 */
export function sealSecret(appSecret: string, namespace: string, plaintext: string, aad: string): EncryptedSecret {
  const key = deriveKey(appSecret, namespace);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 2, keyId: keyIdOf(key), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

/** `payload` 是 DB jsonb 讀出來的 `unknown`——這裡做形狀檢查，壞資料不會變成裸 TypeError。 */
export function openSecret(appSecret: string, namespace: string, payload: unknown, aad: string): string {
  if (payload === null || typeof payload !== "object") throw new SecretDecryptError("密文格式不是物件");
  const p = payload as Partial<EncryptedSecret>;
  if (p.v !== 2 || typeof p.keyId !== "string" || typeof p.iv !== "string" || typeof p.tag !== "string" || typeof p.ct !== "string") {
    throw new SecretDecryptError("密文格式不認得");
  }
  const key = deriveKey(appSecret, namespace);
  if (p.keyId !== keyIdOf(key)) throw new SecretDecryptError("金鑰指紋不符（APP_SECRET 可能已變更）");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(p.iv, "base64"));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(p.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(p.ct, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretDecryptError("密文驗證失敗（已損毀、被竄改，或屬於別的列）");
  }
}
