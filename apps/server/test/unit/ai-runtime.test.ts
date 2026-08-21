import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type pino from "pino";
import { checkProviderKeys, createAiRuntime, type AiProviderRow } from "../../src/ai/runtime.js";
import { encryptApiKey, type EncryptedApiKey } from "../../src/ai/crypto.js";

const secret = "a".repeat(64);

/** 手造一份 issue #14 之前格式的密文（v1，沒有 AAD）。 */
function legacyCiphertext(appSecret: string, plaintext: string): EncryptedApiKey {
  const key = createHash("sha256").update(`${appSecret}:ai-key`).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    v: 1,
    keyId: createHash("sha256").update(key).digest("hex").slice(0, 8),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}


function fakeLog(): pino.BaseLogger & { warn: ReturnType<typeof vi.fn> } {
  return {
    warn: vi.fn(),
  } as unknown as pino.BaseLogger & { warn: ReturnType<typeof vi.fn> };
}

function provider(overrides: Partial<AiProviderRow> = {}): AiProviderRow {
  return {
    id: "provider-1",
    name: "Test Provider",
    type: "openai_compatible",
    baseUrl: "https://api.example.com",
    apiKeyEncrypted: null,
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

describe("checkProviderKeys（純函式，spec §13）", () => {
  it("api_key_encrypted 為 NULL → 跳過，不降級、不 log", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    checkProviderKeys([provider({ apiKeyEncrypted: null })], secret, runtime, log);
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("enabled 且能正確解密 → 不降級", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-1");
    checkProviderKeys([provider({ apiKeyEncrypted: encrypted })], secret, runtime, log);
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("enabled 但解密失敗（壞密文）→ 加入 degraded，log.warn 訊息含「至 admin 後台重輸 API key」指引", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-broken");
    const tampered = { ...encrypted, keyId: "deadbeef" };
    checkProviderKeys([provider({ id: "provider-broken", apiKeyEncrypted: tampered })], secret, runtime, log);

    expect(runtime.degraded.has("provider-broken")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const [, msg] = log.warn.mock.calls[0] as [object, string];
    expect(msg).toContain("admin 後台重輸 API key");
  });

  it("disabled provider 縱使密文壞掉也不檢查、不降級", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-disabled");
    const tampered = { ...encrypted, keyId: "deadbeef" };
    checkProviderKeys([provider({ id: "provider-disabled", enabled: false, apiKeyEncrypted: tampered })], secret, runtime, log);

    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("多筆混合：只有解密失敗的那筆進 degraded，其餘不受影響", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    // 密文綁 providerId（issue #14）：這份密文要能解，就必須是**為它所在的那一列**加的。
    const good = encryptApiKey(secret, "sk-good-key", "p-good");
    const bad = { ...good, keyId: "deadbeef" };

    checkProviderKeys(
      [
        provider({ id: "p-null", apiKeyEncrypted: null }),
        provider({ id: "p-good", apiKeyEncrypted: good }),
        provider({ id: "p-bad", apiKeyEncrypted: bad }),
        provider({ id: "p-disabled-bad", enabled: false, apiKeyEncrypted: bad }),
      ],
      secret,
      runtime,
      log
    );

    expect(runtime.degraded).toEqual(new Set(["p-bad"]));
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // fix round 1（I-1）：`apiKeyEncrypted` 為 `undefined`（非 `null`）——`== null` 修復前
  // 用的是 `=== null`，會漏接 undefined、直接掉進 `decryptApiKey` 讀 `payload.keyId`
  // 炸裸 TypeError（不是 AiKeyDecryptError，會被上面「非 AiKeyDecryptError 一律往外
  // 丟」的 tripwire 整個丟出這個函式）。
  it("api_key_encrypted 為 undefined（非 null）→ 同 NULL 語意，跳過、不降級、不炸", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    expect(() => checkProviderKeys([provider({ apiKeyEncrypted: undefined })], secret, runtime, log)).not.toThrow();
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });

  // fix round 1（I-1）：`apiKeyEncrypted` 是完全不是物件的壞資料（DB 被手動改壞、或
  // 未來欄位格式演進中的過渡資料）——必須走「降級」路徑，不可讓 `decryptApiKey` 拋出
  // 的裸 TypeError 逃出 `checkProviderKeys`（進而讓呼叫端 `selfCheckAiKeys`/`index.ts`
  // 的開機流程被單一壞資料列拖垮，見 crypto.ts 對應修法註解）。
  it("api_key_encrypted 是非物件壞資料（字串）→ 不炸、正常降級 + log.warn", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    expect(() =>
      // Task 4 交接：schema.ts 的 apiKeyEncrypted 已加 `.$type<EncryptedApiKey>()`（純型別，見
      // db/schema.ts 註解），這裡刻意模擬「執行期壞資料」（DB 被手動改壞的情境），型別上
      // 本來就不合法——`as unknown as EncryptedApiKey` 是唯一正確的繞過方式，不是型別錯誤。
      checkProviderKeys([provider({ id: "provider-corrupt", apiKeyEncrypted: "not-an-object" as unknown as EncryptedApiKey })], secret, runtime, log)
    ).not.toThrow();
    expect(runtime.degraded.has("provider-corrupt")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  // fix round 1（I-2）：密文格式版本欄位 `v` 不是 1（例如未來格式升級留下的舊密文，或
  // 被竄改的版本號）——同樣走降級路徑，不悄悄用 v1 語意解出一個「碰巧解得動」但語意
  // 不保證正確的結果。
  it("api_key_encrypted 的 v 不是 1 → 不炸、正常降級 + log.warn", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    // ⚠ id 必須與列上的一致，AAD 才對得上——否則這條會因為「AAD 不符」而降級，跟版本檢查
    // 毫無關係（改動前它就是這樣假綠的：`v: 2` 在這個 PR 之後是完全合法的版本）。
    const encrypted = encryptApiKey(secret, "sk-good-key", "provider-bad-version");
    const badVersion = { ...encrypted, v: 3 };
    expect(() =>
      // 同上：`v: 2` 在型別上不合法（`EncryptedApiKey.v` 鎖定字面值 1），刻意模擬未來
      // 格式版本升級留下的舊密文，需要繞過型別。
      checkProviderKeys([provider({ id: "provider-bad-version", apiKeyEncrypted: badVersion as unknown as EncryptedApiKey })], secret, runtime, log)
    ).not.toThrow();
    expect(runtime.degraded.has("provider-bad-version")).toBe(true);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe("密文升級掃描（issue #14）", () => {
  it("v1 且解得開 → 進 upgradableIds", () => {
    const runtime = createAiRuntime();
    const legacy = legacyCiphertext(secret, "sk-legacy");
    const { upgradableIds } = checkProviderKeys([provider({ id: "p-legacy", apiKeyEncrypted: legacy })], secret, runtime, fakeLog());
    expect(upgradableIds).toEqual(["p-legacy"]);
  });

  it("v2 **不可以**進 upgradableIds（否則每次開機都白重寫一遍所有密文）", () => {
    const runtime = createAiRuntime();
    const modern = encryptApiKey(secret, "sk-x", "p-modern");
    const { upgradableIds } = checkProviderKeys([provider({ id: "p-modern", apiKeyEncrypted: modern })], secret, runtime, fakeLog());
    expect(upgradableIds).toEqual([]);
  });

  it("解不開的不進 upgradableIds（不會把壞資料寫得更死）", () => {
    const runtime = createAiRuntime();
    const broken = { ...legacyCiphertext(secret, "sk-x"), keyId: "deadbeef" };
    const { upgradableIds } = checkProviderKeys([provider({ id: "p-broken", apiKeyEncrypted: broken })], secret, runtime, fakeLog());
    expect(upgradableIds).toEqual([]);
    expect(runtime.degraded.has("p-broken")).toBe(true);
  });

  it("停用的 provider 仍然會被升級，但解不開時不降級、不 log（兩件事分開）", () => {
    const runtime = createAiRuntime();
    const log = fakeLog();
    const legacy = legacyCiphertext(secret, "sk-legacy");
    const broken = { ...legacyCiphertext(secret, "sk-x"), keyId: "deadbeef" };

    const { upgradableIds } = checkProviderKeys(
      [
        provider({ id: "p-disabled-legacy", enabled: false, apiKeyEncrypted: legacy }),
        provider({ id: "p-disabled-broken", enabled: false, apiKeyEncrypted: broken }),
      ],
      secret,
      runtime,
      log
    );

    // 停用但解得開的 v1 一樣要升級：留著一份不驗 AAD 的密文，等於 issue #14 沒修完。
    expect(upgradableIds).toEqual(["p-disabled-legacy"]);
    expect(runtime.degraded.size).toBe(0);
    expect(log.warn).not.toHaveBeenCalled();
  });
});
