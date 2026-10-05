/** #187 §5.1：通用靜態加密的密文格式。與 `ai/crypto.ts` 的 `EncryptedApiKey` v2 **逐欄相同**（不得改 AI 密文格式）。 */
export interface EncryptedSecret {
  v: 2;
  keyId: string;
  iv: string;
  tag: string;
  ct: string;
}
