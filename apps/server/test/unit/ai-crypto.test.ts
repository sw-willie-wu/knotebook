import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey, type EncryptedApiKey } from "../../src/ai/crypto.js";

const secret = "a".repeat(64);

describe("ai/crypto：API key 靜態加密（spec §13.2）", () => {
  it("往返相等", () => {
    const payload = encryptApiKey(secret, "sk-super-secret-key");
    expect(decryptApiKey(secret, payload)).toBe("sk-super-secret-key");
  });

  it("keyId 是衍生金鑰的雜湊指紋，不是金鑰本身的片段", () => {
    const payload = encryptApiKey(secret, "sk-x");
    const derivedKeyHex = createHash("sha256").update(`${secret}:ai-key`).digest("hex");
    expect(payload.keyId).not.toBe(derivedKeyHex.slice(0, 8));
  });

  it("iv 每次不同（不重用 nonce）", () => {
    const a = encryptApiKey(secret, "sk-x");
    const b = encryptApiKey(secret, "sk-x");
    expect(a.iv).not.toBe(b.iv);
  });

  it("iv 為 12 bytes（base64 解碼後）", () => {
    const payload = encryptApiKey(secret, "sk-x");
    expect(Buffer.from(payload.iv, "base64")).toHaveLength(12);
  });

  it("錯 secret 解密（keyId 不符）→ 提前判、拋 AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x");
    expect(() => decryptApiKey("b".repeat(64), payload)).toThrow(AiKeyDecryptError);
  });

  it("同一把 secret，但密文被竄改（GCM tag 驗證失敗）→ 拋同型別 AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x");
    const ctBytes = Buffer.from(payload.ct, "base64");
    ctBytes[0] = (ctBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...payload, ct: ctBytes.toString("base64") };
    expect(() => decryptApiKey(secret, tampered)).toThrow(AiKeyDecryptError);
  });

  it("tag 被竄改 → 拋 AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x");
    const tagBytes = Buffer.from(payload.tag, "base64");
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...payload, tag: tagBytes.toString("base64") };
    expect(() => decryptApiKey(secret, tampered)).toThrow(AiKeyDecryptError);
  });

  // fix round 1（I-1）：payload 不是物件（null/字串/數字）——實際來源是 DB jsonb 欄位，
  // `ai/runtime.ts` 用 `as EncryptedApiKey` 從 `unknown` cast 過來，靜態型別擔保不了
  // 執行期真的是這個形狀。壞資料必須拋 `AiKeyDecryptError`（而非裸 TypeError），
  // 否則會逃出型別契約、讓 `selfCheckAiKeys` 直接把伺服器啟動炸掉（見 crypto.ts 的
  // 該段註解）。
  describe("payload 不是物件（I-1：不可拋裸 TypeError，必須是 AiKeyDecryptError）", () => {
    it.each([
      ["null", null],
      ["字串", "not-an-object"],
      ["數字", 42],
    ])("payload=%s → 拋 AiKeyDecryptError", (_label, badPayload) => {
      expect(() => decryptApiKey(secret, badPayload as unknown as EncryptedApiKey)).toThrow(AiKeyDecryptError);
    });
  });

  // fix round 1（I-2）：`v` 欄位從不驗證的漏洞——`{ ...payload, v: 2 }` 先前會正常解密
  // 成功（GCM 本身不在乎 `v` 這個 metadata 欄位），等同悄悄接受了一份宣稱是未來/未知
  // 格式版本的密文。修法後任何非 1 的 `v` 一律視為解密失敗。
  it("v 不是 1（例如未知的未來格式版本）→ 拋 AiKeyDecryptError，不悄悄解密成功", () => {
    const payload = encryptApiKey(secret, "sk-x");
    const badVersion = { ...payload, v: 2 } as unknown as EncryptedApiKey;
    expect(() => decryptApiKey(secret, badVersion)).toThrow(AiKeyDecryptError);
  });
});
