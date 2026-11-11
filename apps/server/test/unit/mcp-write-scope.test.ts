/**
 * #108：`requireWriteScope()` 的三件事（scope 檢查／session 跳過／`tokenWrite`
 * 扣點）與桶 key 的形狀。
 *
 * ⚠ **第 2 發是 `insufficient_scope` 那條分支「唯一」的守衛**：`/api/mcp` 上，工具是
 * **按 scope 過濾之後才註冊**的，所以唯讀憑證根本沒有 `edit_note` 可以呼叫（它拿到的是 SDK
 * 的「Tool edit_note not found」）；而 session 路徑在第 1 步就 return 了。**HTTP 上到不了那個
 * 分支**——整合測試那邊的案 10／24／29b 一個字都碰不到它，不得寫成「案 10 守著」。
 * 突變證明：把 scope 分支整條刪掉 → 只有本檔第 2 發紅，HTTP 面一條都不紅。
 *
 * 為什麼直接構造 ctx 而不經 HTTP：這一支收的是 `McpToolCtx`，四個欄位（`authKind`／
 * `tokenScope`／`limiters.tokenWrite`／`userId`）就是它讀到的全部，單獨呼叫是它天然的介面
 * （同 `mcp/context.ts` 檔頭「每支工具都可以單獨呼叫」的設計）。
 */
import { describe, expect, it } from "vitest";
import { FixedWindowLimiter } from "../../src/http/rate-limit.js";
import type { TokenScope } from "@knotebook/shared";
import {
  canDeleteNotes,
  canMoveNotes,
  DELETE_SCOPE_MESSAGE,
  INSUFFICIENT_SCOPE_MESSAGE,
  requireDeleteScope,
  requireMoveScope,
  requireWriteScope,
} from "../../src/mcp/write-scope.js";
import { moveNoteToGroupTool, MOVE_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/move-note-to-group.js";
import { deleteNoteTool } from "../../src/mcp/tools/delete-note.js";
import { restoreNoteTool } from "../../src/mcp/tools/restore-note.js";
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
    // 處置字樣：訊息必須非空且指得到設定頁（模型看得到的字串一律英文）。
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

const MSG = "test message";

describe("#239 canMoveNotes", () => {
  it("四格＋漂移形", () => {
    expect(canMoveNotes({ authKind: "session", tokenScope: null })).toBe(true);
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read" })).toBe(false);
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read notes:write" })).toBe(false);
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read notes:write notes:move" })).toBe(true);
    // CHECK 漂移形：有 move 沒 write → 不得放行。
    expect(canMoveNotes({ authKind: "token", tokenScope: "notes:read notes:move" as TokenScope })).toBe(false);
  });
});

describe("#239 requireMoveScope", () => {
  it("讀寫憑證：insufficient_scope＋呼叫端訊息，且不啃 tokenWrite", () => {
    const tokenWrite = oneShot();
    const err = requireMoveScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite }), MSG);
    expect(err!.structuredContent.code).toBe("insufficient_scope");
    expect(err!.structuredContent.message).toBe(MSG);
    expect(tokenWrite.consume(`token:${USER_ID}`)).toBe(true);
  });
  it("唯讀憑證：回 write 的處置訊息（不是呼叫端訊息）", () => {
    const err = requireMoveScope(ctxWith({ authKind: "token", tokenScope: "notes:read", tokenWrite: oneShot() }), MSG);
    expect(err!.structuredContent.message).not.toBe(MSG);
    expect(err!.structuredContent.message).toContain("notes:write");
  });
  it("讀寫搬移：放行並扣一格；session：放行不扣", () => {
    const tw = oneShot();
    expect(requireMoveScope(ctxWith({ authKind: "token", tokenScope: "notes:read notes:write notes:move", tokenWrite: tw }), MSG)).toBeNull();
    expect(tw.consume(`token:${USER_ID}`)).toBe(false);
    const ts = oneShot();
    expect(requireMoveScope(ctxWith({ authKind: "session", tokenScope: null, tokenWrite: ts }), MSG)).toBeNull();
    expect(ts.consume(`token:${USER_ID}`)).toBe(true);
  });
});

const R = "notes:read";
const RW = "notes:read notes:write";
const RWM = "notes:read notes:write notes:move";
const RWD = "notes:read notes:write notes:delete";
const RWMD = "notes:read notes:write notes:move notes:delete";

// #181 D：requireDeleteScope 的兩個 scope 分支在 HTTP 上到不了（delete_note／restore_note 只在 canDeleteNotes 時註冊），
// 本段是它們唯一的守衛；tokenWrite 扣點在 HTTP 上活著（另由 mcp-trash-tools.test.ts 守）。
describe("#181 D canDeleteNotes", () => {
  it("五形＋session＋兩種漂移形", () => {
    expect(canDeleteNotes({ authKind: "session", tokenScope: null })).toBe(true);
    expect(canDeleteNotes({ authKind: "token", tokenScope: R })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RW })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RWM })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RWD })).toBe(true);
    expect(canDeleteNotes({ authKind: "token", tokenScope: RWMD })).toBe(true);
    // CHECK 漂移形：有 delete 沒 write → 不得放行（同 canMoveNotes）。
    expect(canDeleteNotes({ authKind: "token", tokenScope: "notes:read notes:delete" as TokenScope })).toBe(false);
    expect(canDeleteNotes({ authKind: "token", tokenScope: "notes:read notes:move notes:delete" as TokenScope })).toBe(false);
  });
});

describe("#181 D requireDeleteScope", () => {
  it("session：放行，且 tokenWrite 一格都沒動", () => {
    const tw = oneShot();
    const ctx = ctxWith({ authKind: "session", tokenScope: null, tokenWrite: tw });
    expect(requireDeleteScope(ctx)).toBeNull();
    expect(requireDeleteScope(ctx)).toBeNull();
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it("唯讀憑證：insufficient_scope＋write 的處置句，且不啃 tokenWrite", () => {
    const tw = oneShot();
    const err = requireDeleteScope(ctxWith({ authKind: "token", tokenScope: R, tokenWrite: tw }));
    expect(err?.structuredContent).toEqual({ code: "insufficient_scope", message: INSUFFICIENT_SCOPE_MESSAGE });
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it.each<TokenScope>([RW, RWM])("%s：insufficient_scope＋DELETE_SCOPE_MESSAGE，且不啃 tokenWrite", (scope) => {
    const tw = oneShot();
    const err = requireDeleteScope(ctxWith({ authKind: "token", tokenScope: scope, tokenWrite: tw }));
    expect(err?.structuredContent).toEqual({ code: "insufficient_scope", message: DELETE_SCOPE_MESSAGE });
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it.each<TokenScope>([RWD, RWMD])("%s：放行，且 `token:${userId}` 那一格被扣掉", (scope) => {
    const tw = oneShot();
    expect(requireDeleteScope(ctxWith({ authKind: "token", tokenScope: scope, tokenWrite: tw }))).toBeNull();
    expect(tw.consume(`token:${USER_ID}`)).toBe(false);
  });
  it("桶 key 逐字是 `token:${userId}`：REST 那一側先用掉唯一一格 → too_many_requests", () => {
    const tw = oneShot();
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
    const err = requireDeleteScope(ctxWith({ authKind: "token", tokenScope: RWD, tokenWrite: tw }));
    expect(err?.structuredContent.code).toBe("too_many_requests");
  });
});

// U3：move_note_to_group 的 scope 分支在 HTTP 上到不了（未註冊），這是它唯一的守衛。
// `ctxWith` 沒有 `db`：若實作在 scope 檢查之前碰了 DB，這案會炸 `undefined`——這正是要釘的順序。
describe("#239 U3 moveNoteToGroupTool", () => {
  it("讀寫憑證直接呼叫 → insufficient_scope、訊息逐字 (e)，在碰 DB 之前", async () => {
    const r = await moveNoteToGroupTool(
      { note_id: "11111111-1111-4111-8111-111111111111", group_id: "22222222-2222-4222-8222-222222222222" },
      ctxWith({ authKind: "token", tokenScope: "notes:read notes:write", tokenWrite: oneShot() }),
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({
      code: "insufficient_scope",
      message: MOVE_NEEDS_MOVE_MESSAGE,
    });
  });
});

// #181 D（同 U3）：delete_note／restore_note 的第一個動作是 requireDeleteScope——DELETE_SCOPE_MESSAGE 的「nothing was changed」
// 與 tokenWrite 拒絕的零副作用都靠這個順序。`db`／`limiters.edit` 是一碰就記下並丟錯的探針：scope 或 tokenWrite 拒絕時一次都不得碰。
describe("#181 D 兩支垃圾桶工具：requireDeleteScope 在任何 DB 存取與 edit 桶之前", () => {
  const NOTE = { note_id: "33333333-3333-4333-8333-333333333333" };
  function probeCtx(tokenScope: TokenScope, tokenWrite: FixedWindowLimiter) {
    const touched: string[] = [];
    const trap = (label: string) =>
      new Proxy({}, { get: (_t, key) => { touched.push(`${label}.${String(key)}`); throw new Error(`touched ${label}.${String(key)}`); } });
    const ctx = { ...ctxWith({ authKind: "token", tokenScope, tokenWrite }), db: trap("db") } as McpToolCtx;
    (ctx.limiters as Record<string, unknown>).edit = trap("edit");
    return { ctx, touched };
  }
  const tools = [["delete_note", deleteNoteTool], ["restore_note", restoreNoteTool]] as const;
  it.each(tools)("%s：讀寫搬移（無 delete）→ insufficient_scope＋DELETE_SCOPE_MESSAGE，沒碰 db／edit、沒啃 tokenWrite", async (_n, tool) => {
    const tw = oneShot();
    const { ctx, touched } = probeCtx(RWM, tw);
    await expect(tool(NOTE, ctx)).resolves.toMatchObject({ isError: true, structuredContent: { code: "insufficient_scope", message: DELETE_SCOPE_MESSAGE } });
    expect(touched).toEqual([]);
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
  });
  it.each(tools)("%s：讀寫刪除但 tokenWrite 用罄 → too_many_requests，沒碰 db／edit", async (_n, tool) => {
    const tw = oneShot();
    expect(tw.consume(`token:${USER_ID}`)).toBe(true);
    const { ctx, touched } = probeCtx(RWD, tw);
    await expect(tool(NOTE, ctx)).resolves.toMatchObject({ isError: true, structuredContent: { code: "too_many_requests" } });
    expect(touched).toEqual([]);
  });
});
