import { createHash, timingSafeEqual } from "node:crypto";

/** PKCE S256 驗證。⚠ 長度不等要先回 false——`timingSafeEqual` 對長度不同會丟例外。 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
