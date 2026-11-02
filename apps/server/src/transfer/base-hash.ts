/**
 * bulk transfer spec 2026-11-02 §8.1–§8.2：基底的雜湊。只存雜湊、不存內容（§21 D2）。
 *
 * - `H(x) = HMAC-SHA256(K, salt ‖ utf8(x))`；`K = sha256("${APP_SECRET}:transfer-base")`（namespace 導出子金鑰，
 *   同 `ai/crypto.ts` 的 `deriveKey`）。只拿到 DB、沒有 `APP_SECRET` 就無法對短行跑字典；鹽讓同一行在不同列的雜湊不同。
 * - `key_id = sha256(K)` 前 8 hex（同 `ai/crypto.ts` 的 `deriveKeyId`，那支未 export，照抄邏輯）。換了 `APP_SECRET`
 *   之後舊基底的 `key_id` 對不上，寫回回 409 `base_unavailable`（§8.1）。
 * - 行雜湊：每行先 `lineKey`（trimEnd）；`kinds[i] === 1`（numbered 段的行）再 `normalizeNumbered`；取 HMAC 前 8 bytes 依序串接。
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lineKey, normalizeNumbered } from "./normalize.js";

export const LINE_HASH_BYTES = 8;

export function deriveTransferKey(appSecret: string): Buffer {
  return createHash("sha256").update(`${appSecret}:transfer-base`).digest();
}

export function transferKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** HMAC-SHA256(key, salt ‖ utf8(x))——兩次 `update` 等價於串接，免 concat。 */
export function hmacOf(key: Buffer, salt: Buffer, x: string): Buffer {
  return createHmac("sha256", key).update(salt).update(x, "utf8").digest();
}

/** 基底鍵（frontmatter 的 `base`）：隨機 8 bytes＝16 hex。寫回的格式守衛是 `/^[0-9a-f]{16}$/`。 */
export function newBaseKey(): string {
  return randomBytes(8).toString("hex");
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

/**
 * `body` 必須是**已正規化**的本文（`normalizeBody`）；`lines` 是它切出的行（未 trimEnd，這裡做）；`kinds` 每行一個（0／1）。
 */
export function baseHashes(
  key: Buffer,
  salt: Buffer,
  input: { body: string; title: string; lines: string[]; kinds: number[] },
): { bodySha: Buffer; titleSha: Buffer; lineHashes: Buffer; lineKinds: Buffer } {
  const { lines, kinds } = input;
  if (lines.length !== kinds.length) throw new Error("baseHashes: lines and kinds differ in length");
  const lineHashes = Buffer.alloc(lines.length * LINE_HASH_BYTES);
  for (let i = 0; i < lines.length; i++) {
    const k = lineKey(lines[i]!);
    hmacOf(key, salt, kinds[i] === 1 ? normalizeNumbered(k) : k).copy(lineHashes, i * LINE_HASH_BYTES, 0, LINE_HASH_BYTES);
  }
  return {
    bodySha: hmacOf(key, salt, input.body),
    titleSha: hmacOf(key, salt, input.title),
    lineHashes,
    lineKinds: Buffer.from(kinds),
  };
}
