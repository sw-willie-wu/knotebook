import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  AiKeyDecryptError,
  decryptApiKey,
  encryptApiKey,
  type EncryptedApiKey,
} from "../../src/ai/crypto.js";

const secret = "a".repeat(64);
const PROVIDER_A = "a1b2c3d4-1111-1111-1111-111111111111";
const PROVIDER_B = "b1b2c3d4-2222-2222-2222-222222222222";

describe("ai/crypto：API key 靜態加密（spec §13.2）", () => {
  it("往返相等", () => {
    const payload = encryptApiKey(secret, "sk-super-secret-key", PROVIDER_A);
    expect(decryptApiKey(secret, payload, PROVIDER_A)).toBe("sk-super-secret-key");
  });

  it("keyId 是衍生金鑰的雜湊指紋，不是金鑰本身的片段", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const derivedKeyHex = createHash("sha256").update(`${secret}:ai-key`).digest("hex");
    expect(payload.keyId).not.toBe(derivedKeyHex.slice(0, 8));
  });

  it("iv 每次不同（不重用 nonce）", () => {
    const a = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const b = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(a.iv).not.toBe(b.iv);
  });

  it("iv 為 12 bytes（base64 解碼後）", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(Buffer.from(payload.iv, "base64")).toHaveLength(12);
  });

  it("錯 secret 解密（keyId 不符）→ 提前判、拋 AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(() => decryptApiKey("b".repeat(64), payload, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("同一把 secret，但密文被竄改（GCM tag 驗證失敗）→ 拋同型別 AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const ctBytes = Buffer.from(payload.ct, "base64");
    ctBytes[0] = (ctBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...payload, ct: ctBytes.toString("base64") };
    expect(() => decryptApiKey(secret, tampered, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("tag 被竄改 → 拋 AiKeyDecryptError", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const tagBytes = Buffer.from(payload.tag, "base64");
    tagBytes[0] = (tagBytes[0] ?? 0) ^ 0xff;
    const tampered = { ...payload, tag: tagBytes.toString("base64") };
    expect(() => decryptApiKey(secret, tampered, PROVIDER_A)).toThrow(AiKeyDecryptError);
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
      expect(() => decryptApiKey(secret, badPayload as unknown as EncryptedApiKey, PROVIDER_A)).toThrow(AiKeyDecryptError);
    });
  });

  // fix round 1（I-2）：`v` 欄位從不驗證的漏洞——`{ ...payload, v: 3 }` 先前會正常解密
  // 成功（GCM 本身不在乎 `v` 這個 metadata 欄位），等同悄悄接受了一份宣稱是未來/未知
  // 格式版本的密文。修法後任何非 1 的 `v` 一律視為解密失敗。
  it("v 不是 1／2（例如未知的未來格式版本）→ 拋 AiKeyDecryptError，不悄悄解密成功", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const badVersion = { ...payload, v: 3 } as unknown as EncryptedApiKey;
    expect(() => decryptApiKey(secret, badVersion, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });
});

describe("密文綁 providerId（AAD，issue #14）", () => {
  it("寫出來的是 v2", () => {
    expect(encryptApiKey(secret, "sk-x", PROVIDER_A).v).toBe(2);
  });

  it("把 A 的密文搬到 B 的資料列 → 解不開（這就是這條 issue 的全部）", () => {
    const payload = encryptApiKey(secret, "sk-super-secret-key", PROVIDER_A);
    expect(decryptApiKey(secret, payload, PROVIDER_A)).toBe("sk-super-secret-key");
    expect(() => decryptApiKey(secret, payload, PROVIDER_B)).toThrow(AiKeyDecryptError);
  });

  it("providerId 只要差一個字元就解不開（AAD 是逐位元組驗的）", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    expect(() => decryptApiKey(secret, payload, `${PROVIDER_A} `)).toThrow(AiKeyDecryptError);
    expect(() => decryptApiKey(secret, payload, PROVIDER_A.toUpperCase())).toThrow(AiKeyDecryptError);
  });

  it("把 v2 密文的 v 改成 1 不能繞過綁定（GCM 的 tag 涵蓋 AAD）", () => {
    // 這是這個設計最明顯的攻擊面：既然 v1 的解密路徑刻意不帶 AAD，攻擊者只要把
    // `v: 2` 改成 `v: 1` 就能要求我們用「不驗 AAD」的方式去解一份綁過 AAD 的密文。
    // 擋住它的不是我們的分支判斷，而是 GCM 本身——認證標籤是連同 AAD 一起算出來的，
    // 少帶 AAD 就驗不過。這條測試把這個性質釘住，別讓後人「順手」改成寬鬆一點的驗法。
    const payload = encryptApiKey(secret, "sk-secret", PROVIDER_A);
    const downgraded = { ...payload, v: 1 as const };
    expect(() => decryptApiKey(secret, downgraded, PROVIDER_B)).toThrow(AiKeyDecryptError);
    // 連「用對的 providerId」也一樣解不開——v1 路徑根本不會帶 AAD 進去。
    expect(() => decryptApiKey(secret, downgraded, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("v 是字串 \"2\"（DB 裡的壞資料）→ 拒絕，不當成數字 2", () => {
    const payload = encryptApiKey(secret, "sk-x", PROVIDER_A);
    const weird = { ...payload, v: "2" } as unknown as EncryptedApiKey;
    expect(() => decryptApiKey(secret, weird, PROVIDER_A)).toThrow(AiKeyDecryptError);
  });

  it("v1（這條 issue 之前寫入的密文）仍然讀得動，且不看 providerId", () => {
    // 用 v1 的方式手造一份密文（沒有 AAD）——等同 issue #14 之前的 `encryptApiKey`。
    const key = createHash("sha256").update(`${secret}:ai-key`).digest();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("sk-legacy", "utf8"), cipher.final()]);
    const legacy: EncryptedApiKey = {
      v: 1,
      keyId: createHash("sha256").update(key).digest("hex").slice(0, 8),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };

    // 舊格式沒有綁定，所以換誰的 id 都解得開——這正是為什麼 `selfCheckAiKeys` 會把它
    // 就地升級成 v2，而不是放著等使用者哪天重輸 API key。
    expect(decryptApiKey(secret, legacy, PROVIDER_A)).toBe("sk-legacy");
    expect(decryptApiKey(secret, legacy, PROVIDER_B)).toBe("sk-legacy");
  });
});
