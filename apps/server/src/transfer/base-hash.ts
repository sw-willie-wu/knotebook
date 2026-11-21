/**
 * `K` is derived with a namespace like `deriveKey` in `ai/crypto.ts`; with only the DB and no
 * `APP_SECRET`, a dictionary attack on short lines is impossible, and the salt makes the same
 * line hash differently per row. A changed `APP_SECRET` mismatches `key_id` → write-back 409
 * `base_unavailable`. `deriveKeyId` there isn't exported, so its logic is copied.
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { lineKey, normalizeNumbered } from "./normalize.js";
import { tagsKeyOf } from "./note-tags-format.js";

export const LINE_HASH_BYTES = 8;

export function deriveTransferKey(appSecret: string): Buffer {
  return createHash("sha256").update(`${appSecret}:transfer-base`).digest();
}

export function transferKeyId(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function hmacOf(key: Buffer, salt: Buffer, x: string): Buffer {
  return createHmac("sha256", key).update(salt).update(x, "utf8").digest();
}

/** 16 hex characters: must match `BASE_RE` in `frontmatter.ts`, or write-back rejects every file. */
export function newBaseKey(): string {
  return randomBytes(8).toString("hex");
}

export function newSalt(): Buffer {
  return randomBytes(16);
}

/** `body` must already be normalized (`normalizeBody`); `lines` are its untrimmed lines (trimmed here); `kinds` has one 0/1 per line. */
export function baseHashes(
  key: Buffer,
  salt: Buffer,
  input: { body: string; title: string; tags: readonly string[]; lines: string[]; kinds: number[] },
): { bodySha: Buffer; titleSha: Buffer; tagsSha: Buffer; lineHashes: Buffer; lineKinds: Buffer } {
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
    tagsSha: hmacOf(key, salt, tagsKeyOf(input.tags)),
    lineHashes,
    lineKinds: Buffer.from(kinds),
  };
}
