/**
 * #108 §10.2 D23／M13：`requireWriteScope()` 的三件事（scope 檢查／session 跳過／`tokenWrite`
 * 扣點）與桶 key 的形狀。
 *
 * ⚠ **第 2 發是 `insufficient_scope` 那條分支「唯一」的守衛**（P16）：`/api/mcp` 上，工具是
 * **按 scope 過濾之後才註冊**的，所以唯讀憑證根本沒有 `edit_note` 可以呼叫（它拿到的是 SDK
 * 的「Tool edit_note not found」）；而 session 路徑在第 1 步就 return 了。**HTTP 上到不了那個
 * 分支**——整合測試那邊的案 10／24／S2／29b 一個字都碰不到它，不得寫成「案 10 守著」。
 * 突變證明：把 scope 分支整條刪掉 → 只有本檔第 2 發紅，HTTP 面一條都不紅。
 *
 * 為什麼直接構造 ctx 而不經 HTTP：這一支收的是 `McpToolCtx`，四個欄位（`authKind`／
 * `tokenScope`／`limiters.tokenWrite`／`userId`）就是它讀到的全部，單獨呼叫是它天然的介面
 * （同 `mcp/context.ts` 檔頭「每支工具都可以單獨呼叫」的設計）。
 */
import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "../../src/http/rate-limit.js";
import { requireWriteScope } from "../../src/mcp/write-scope.js";
import type { McpToolCtx } from "../../src/mcp/context.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * ⚠ **cast 是刻意的**：`McpToolCtx` 還有 `db`／`writes`／`log` 等這一支**一個字都不讀**的欄位，
 * 造出來只會讓「它到底讀了什麼」變模糊。代價誠實記下：日後 `requireWriteScope` 若開始讀第五個
 * 欄位，這裡會在執行期炸（`undefined` 解參考），不是 tsc 擋下來的。
 */
function ctxWith(over: {
  authKind: "token" | "session";
  tokenScope: McpToolCtx["tokenScope"];
  tokenWrite: FixedWindowLimiter;
}): McpToolCtx {
  return {
    userId: USER_ID,
    authKind: over.authKind,
    tokenScope: over.tokenScope,
    limiters: { tokenWrite: over.tokenWrite },
  } as unknown as McpToolCtx;
}

const oneShot = () => new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });

describe("#108 requireWriteScope", () => {
  it("session 憑證：直接放行，且 tokenWrite 桶一格都沒動（完整身分，比照 bearer.ts）", () => {
    const tokenWrite = oneShot();
    const ctx = ctxWith({ authKind: "session", tokenScope: null, tokenWrite });
    expect(requireWriteScope(ctx)).toBeNull();
    expect(requireWriteScope(ctx)).toBeNull();
    // 呼叫兩次之後桶仍是滿的——證明它真的沒扣，而不是「剛好還沒滿」。
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
  });

  it("唯讀 token：insufficient_scope ＋ 帶處置字樣，且 403 不啃桶", () => {
    const tokenWrite = oneShot();
    const err = requireWriteScope(ctxWith({ authKind: "token", tokenScope: "notes:read", tokenWrite }));
    expect(err).not.toBeNull();
    expect(err!.structuredContent.code).toBe("insufficient_scope");
    // D7 的處置字樣：訊息必須非空且指得到設定頁（模型看得到的字串一律英文）。
    expect(err!.structuredContent.message).toContain("notes:write");
    expect(err!.structuredContent.message).toContain("Settings");
    // 「403 不啃桶」——桶仍是滿的。
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
  });

  it("讀寫 token：放行，且桶少一格", () => {
    const tokenWrite = oneShot();
    expect(requireWriteScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite }))).toBeNull();
    // 那一格已經被 requireWriteScope 吃掉了。
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(false);
  });

  it("桶用罄：too_many_requests", () => {
    const tokenWrite = oneShot();
    const ctx = ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite });
    expect(requireWriteScope(ctx)).toBeNull();
    const err = requireWriteScope(ctx);
    expect(err!.structuredContent.code).toBe("too_many_requests");
  });

  // ⚠ **這一發是「桶 key 寫成裸 userId」唯一的守衛**：兩種寫法在上面四發都一模一樣，
  //   差別只在 MCP 與 REST 有沒有記同一本帳（`bearer.ts` 用的是 `token:${userId}`）。
  it("桶 key 逐字是 `token:${userId}`，與 bearer.ts 同一本帳", () => {
    const tokenWrite = oneShot();
    // 先由「REST 那一側」把唯一的一格用掉。
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
    const err = requireWriteScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite }));
    expect(err!.structuredContent.code).toBe("too_many_requests");
  });
});
