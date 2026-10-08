/**
 * #200 spec §4.1、§4.5：transfer token 的明文格式與 401 的 challenge 組字。純函式，無 DB。
 *
 * 守衛重點：`knbt_` 的第 4 字元是 `t` 不是 `_`，所以 `isAccessTokenShape("knbt_…")` 為假——transfer token 送到任何
 * `authenticateAny` 路由（`routes/notes.ts` 七處、`/api/mcp`）都在前綴那關 401、不進 DB（同 `knbr_` 的手法，
 * `test/unit/api-token.test.ts` 的 refresh 案）。
 */
import { describe, expect, it } from "vitest";
import { ACCESS_TOKEN_PREFIX, generateAccessToken, generateRefreshToken, isAccessTokenShape } from "../../src/auth/api-token.js";
import { buildTransferChallenge } from "../../src/auth/challenge.js";
import {
  MAX_PENDING_UPLOAD_TOKENS,
  TRANSFER_TOKEN_PREFIX,
  generateTransferToken,
  isTransferTokenShape,
} from "../../src/auth/transfer-token.js";

describe("transfer token 明文格式（spec §4.1）", () => {
  it("knbt_ + 43 字元 base64url（共 48），每次都不同", () => {
    const a = generateTransferToken();
    const b = generateTransferToken();
    expect(a).toMatch(/^knbt_[A-Za-z0-9_-]{43}$/);
    expect(a).toHaveLength(48);
    expect(a).not.toBe(b);
  });

  it("前綴不是 knb_ 的延長：transfer token 不是 access token 形狀（第 4 字元 t vs _）", () => {
    expect(TRANSFER_TOKEN_PREFIX.startsWith(ACCESS_TOKEN_PREFIX)).toBe(false);
    expect(isAccessTokenShape(generateTransferToken())).toBe(false);
  });

  it("isTransferTokenShape 只認 knbt_ 開頭：knb_／knbr_／含有但不在開頭的都不算", () => {
    expect(isTransferTokenShape(generateTransferToken())).toBe(true);
    expect(isTransferTokenShape(generateAccessToken())).toBe(false);
    expect(isTransferTokenShape(generateRefreshToken())).toBe(false);
    expect(isTransferTokenShape("Xknbt_abc")).toBe(false);
  });

  it("每支母憑證的未消費 upload token 上限是 5（spec §4.3a）", () => {
    expect(MAX_PENDING_UPLOAD_TOKENS).toBe(5);
  });
});

describe("buildTransferChallenge（spec §4.5，T22 的字串）", () => {
  it("帶 error：逐字 `Bearer realm=\"knotebook-transfer\", error=\"invalid_token\"`，不含 resource_metadata／scope", () => {
    expect(buildTransferChallenge("invalid_token")).toBe('Bearer realm="knotebook-transfer", error="invalid_token"');
  });
  it("不帶 error（other-scheme）：逐字 `Bearer realm=\"knotebook-transfer\"`", () => {
    expect(buildTransferChallenge()).toBe('Bearer realm="knotebook-transfer"');
  });
});
