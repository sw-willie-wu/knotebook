import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type pino from "pino";
import { eq } from "drizzle-orm";
import { buildTestApp, testConfig } from "./helpers.js";
import { aiProviders } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { AiKeyDecryptError, decryptApiKey, encryptApiKey, type EncryptedApiKey } from "../src/ai/crypto.js";
import { createAiRuntime, selfCheckAiKeys } from "../src/ai/runtime.js";

/**
 * issue #14：AI provider 的 API key 密文以 providerId 為 AAD 綁定，並提供 v1 → v2 的
 * 遷移路徑。這一支測的是**跨越 DB 的那一段**（純加解密的行為在
 * `test/unit/ai-crypto.test.ts`）。
 */

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

function fakeLog(): pino.BaseLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn(), silent: vi.fn() } as unknown as pino.BaseLogger;
}

async function insertProviderWith(db: Db, id: string, apiKeyEncrypted: EncryptedApiKey) {
  await db.insert(aiProviders).values({
    id,
    name: `P-${id.slice(0, 8)}`,
    type: "openai_compatible",
    baseUrl: "http://localhost:9",
    apiKeyEncrypted,
  });
}

async function readEncrypted(db: Db, id: string): Promise<EncryptedApiKey> {
  const [row] = await db.select().from(aiProviders).where(eq(aiProviders.id, id));
  return row!.apiKeyEncrypted!;
}

describe("AI key 密文綁 providerId（issue #14）", () => {
  it("把 A 的密文列複製到 B 的資料列 → B 解不開（不會靜靜地拿 A 的金鑰去用）", async () => {
    const { db } = await buildTestApp();
    const idA = randomUUID();
    const idB = randomUUID();

    await insertProviderWith(db, idA, encryptApiKey(testConfig.appSecret, "sk-victim-key", idA));
    // 攻擊者（有 DB 寫入能力）把 A 的密文原樣搬到 B。
    await insertProviderWith(db, idB, await readEncrypted(db, idA));

    expect(decryptApiKey(testConfig.appSecret, await readEncrypted(db, idA), idA)).toBe("sk-victim-key");

    const stolen = await readEncrypted(db, idB);
    expect(() => decryptApiKey(testConfig.appSecret, stolen, idB)).toThrow(AiKeyDecryptError);
  });

  it("啟動自檢會把解得開的 v1 密文就地升級成 v2（遷移路徑）", async () => {
    const { db } = await buildTestApp();
    const id = randomUUID();
    await insertProviderWith(db, id, legacyCiphertext(testConfig.appSecret, "sk-legacy-key"));
    expect((await readEncrypted(db, id)).v).toBe(1);

    await selfCheckAiKeys(db, testConfig.appSecret, createAiRuntime(), fakeLog());

    const upgraded = await readEncrypted(db, id);
    expect(upgraded.v).toBe(2);
    // 升級後的密文與這一列繫在一起：內容不變，但搬到別列就解不開了。
    expect(decryptApiKey(testConfig.appSecret, upgraded, id)).toBe("sk-legacy-key");
    expect(() => decryptApiKey(testConfig.appSecret, upgraded, randomUUID())).toThrow();
  });

  it("解不開的密文不會被升級，也不會擋住啟動（維持降級即可）", async () => {
    const { db } = await buildTestApp();
    const id = randomUUID();
    // 舊格式（v1）＋用別把 secret 加的密文：keyId 對不上，解不開。
    await insertProviderWith(db, id, legacyCiphertext("f".repeat(64), "sk-x"));

    const runtime = createAiRuntime();
    await selfCheckAiKeys(db, testConfig.appSecret, runtime, fakeLog());

    expect(runtime.degraded.has(id)).toBe(true);
    // 沒被升級：升級只發生在「用目前的 APP_SECRET 解得開」的那些密文上。
    expect((await readEncrypted(db, id)).v).toBe(1);
  });
});
