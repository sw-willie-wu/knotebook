/**
 * #286 spec §3.1、§3.4：一次性連結的明文格式與有效述詞。純函式，無 DB。
 *
 * 守衛重點：`knbp_` 的第 4 字元是 `p` 不是 `_`，所以 `isAccessTokenShape("knbp_…")` 為假（同 `knbr_`／`knbt_`）；
 * 有效述詞只在 `auth/one-time-link.ts` 組，這裡用 `PgDialect` 釘住它產出的 SQL。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { ACCESS_TOKEN_PREFIX, generateAccessToken, generateRefreshToken, isAccessTokenShape } from "../../src/auth/api-token.js";
import { generateTransferToken } from "../../src/auth/transfer-token.js";
import {
  RESET_TOKEN_PREFIX,
  activeOneTimeLink,
  generateOneTimeToken,
  isOneTimeTokenShape,
  pendingPasswordResetsOf,
} from "../../src/auth/one-time-link.js";

const dialect = new PgDialect();

describe("一次性連結 token 明文格式（spec §3.1）", () => {
  it("U1：knbp_ + 43 字元 base64url（共 48），每次都不同", () => {
    const a = generateOneTimeToken("password_reset");
    const b = generateOneTimeToken("password_reset");
    expect(a).toMatch(/^knbp_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(48);
    expect(a).not.toBe(b);
  });

  it("U2：前綴不是 knb_ 的延長：重設 token 不是 access token 形狀（第 4 字元 p vs _）", () => {
    expect(RESET_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(generateOneTimeToken("password_reset"))).toBe(false);
  });

  it("U3：isOneTimeTokenShape 只認 knbp_ 後恰好 43 個 base64url 字元", () => {
    const ok = generateOneTimeToken("password_reset");
    expect(isOneTimeTokenShape("password_reset", ok)).toBe(true);
    const bad: Array<[string, string]> = [
      ["access token", generateAccessToken()],
      ["refresh token", generateRefreshToken()],
      ["transfer token", generateTransferToken()],
      ["42 字", "knbp_" + "a".repeat(42)],
      ["44 字", "knbp_" + "a".repeat(44)],
      ["非 base64url 字元", "knbp_" + "!".repeat(43)],
      ["前多空白", " " + ok],
      ["後多空白", ok + " "],
      ["大寫前綴", "KNBP_" + "a".repeat(43)],
      ["空字串", ""],
    ];
    for (const [label, token] of bad) expect(isOneTimeTokenShape("password_reset", token), label).toBe(false);
  });
});

describe("一次性連結的 SQL 述詞（spec §3.4、§4.2 N-3）", () => {
  it("U4：activeOneTimeLink＝kind 相符、未用、未撤銷、expires_at > now()；kind 走參數", () => {
    const q = dialect.sqlToQuery(activeOneTimeLink("password_reset"));
    expect(q.sql).toBe(
      `("one_time_links"."kind" = $1 and "one_time_links"."used_at" is null and "one_time_links"."revoked_at" is null and "one_time_links"."expires_at" > now())`,
    );
    expect(q.params).toEqual(["password_reset"]);
  });

  it("U5：pendingPasswordResetsOf＝kind、target、未用、未撤銷，**不含**到期條件", () => {
    const id = randomUUID();
    const q = dialect.sqlToQuery(pendingPasswordResetsOf(id));
    expect(q.sql).toBe(
      `("one_time_links"."kind" = $1 and "one_time_links"."target_user_id" = $2 and "one_time_links"."used_at" is null and "one_time_links"."revoked_at" is null)`,
    );
    expect(q.params).toEqual(["password_reset", id]);
  });
});
