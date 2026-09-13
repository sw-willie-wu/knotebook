/**
 * #108 §10.2 D23／不變量 M13：需要 `notes:write` 的工具**唯一**的執行許可入口。
 *
 * 三件事**不可分割**——scope 檢查、session 跳過、`tokenWrite` 扣點——所以收成一支，每一支
 * 寫入工具的**第一個動作**就是呼叫它。目的：讓「token 寫入 60 次／10 分鐘」這條既有承諾
 * （`docs/api-tokens.md` 逐字）對 MCP 也成立；L1 的 preHandler 宣告的是 `notes:read`，所以
 * 它恆扣 `tokenRead`、永不扣 `tokenWrite`（`auth/bearer.ts` 的桶由 `required` 決定）。
 *
 * **順序是刻意的**：整支排在 `resolveRole` **之前**——REST 的 `tokenWrite` 在 preHandler 扣，
 * 也就是在 `resolveRole` 之前，所以 `role === "none"` 的 404 在 REST 上一樣啃 `tokenWrite`
 * （plan 階段實跑確認）。MCP 對齊 REST。`edit` 桶維持在**角色檢查之後**扣。
 * 桶 key 逐字 `token:${userId}`，與 `auth/bearer.ts` 同形——寫成裸 userId 會讓 MCP 與 REST
 * 各記一本帳（守衛＝`test/unit/mcp-write-scope.test.ts` 最後那一發）。
 *
 * ⚠ **第 2 步（scope 檢查）在 HTTP 上是死碼**：`McpServer` 的「清單」就是「註冊表」，
 * `register.ts` 已經按 scope 過濾，所以唯讀憑證根本沒有寫入工具可以呼叫（`tools/call` 走 SDK
 * 的未知工具名分支，永遠到不了這裡）；HTTP 上到得了第 2 步的只有 session，而 session 在第 1 步
 * 就 return 了。**唯一的守衛是 `test/unit/mcp-write-scope.test.ts` 的第 2 發**——不得寫成
 * 「案 10 守著」，那一案釘的是 SDK 的「Tool not found」形。保留它的理由：(a) 日後有人拿掉
 * 註冊時過濾（規格 D6(b) 要防的正是這件事），它是唯一的網；(b) 三件事收成一支，第七支工具的
 * 作者照抄時不會只抄到扣桶那一半。
 * ⚠ **誠實缺口**：`insufficient_scope` 這條路上**模型永遠看不到**下面那段處置訊息——D7 的
 * 意圖改由 per-request 的 `instructions` 承接（唯讀憑證那一版逐字寫了同樣的處置，D-Q）。
 * ⚠ **M13 是紀律不是繞不過的事實**：第七支寫入工具漏呼叫它不會有任何測試變紅（今天全部的
 * 守衛是「兩支工具各跑一次」那一族）。要變成繞不過就得走註冊器形，規格 §10.2 已延後。
 */
import { hasScope } from "@knotebook/shared";
import { toolError, type ToolErrorResult } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";

/** 模型看得到的字串一律英文。處置字樣與 `docs/api-tokens.md` 教使用者的路徑同字。 */
const INSUFFICIENT_SCOPE_MESSAGE =
  "This credential cannot change notes. Create a token with the notes:write scope in Settings → Account → API tokens.";
const RATE_LIMITED_MESSAGE = "Too many writes with this credential right now. Wait a few minutes before writing again.";

/**
 * 「這份憑證寫得動筆記嗎」——**三個呼叫點共用一份判準**：`register.ts` 的註冊時過濾、
 * `routes/mcp.ts` 挑 per-request `instructions`（D-Q）、以及下面的 `requireWriteScope`。
 * 三份各寫各的話，最難看見的漂移是「清單裡有工具但 instructions 說你是唯讀的」。
 * `?? "notes:read"` 是 fail-closed 的退路（token 路徑必有 scope）。
 */
export function canWriteNotes(auth: Pick<McpToolCtx, "authKind" | "tokenScope">): boolean {
  return auth.authKind === "session" || hasScope(auth.tokenScope ?? "notes:read", "notes:write");
}

/** 回 `null` ＝放行；回 `ToolErrorResult` ＝呼叫端**直接回傳它**，不得再做任何事（M6：拒絕零副作用）。 */
export function requireWriteScope(ctx: McpToolCtx): ToolErrorResult | null {
  // 1. session ＝完整身分：不檢查 scope、不吃 token 桶（比照 `auth/bearer.ts` 的既有紀律）。
  if (ctx.authKind === "session") return null;
  // 2. HTTP 上是死碼（見檔頭）。
  if (!canWriteNotes(ctx)) {
    return toolError("insufficient_scope", INSUFFICIENT_SCOPE_MESSAGE);
  }
  // 3. 扣點在 scope 檢查**通過之後**——403 不啃桶。
  if (!ctx.limiters.tokenWrite.consume(`token:${ctx.userId}`)) {
    return toolError("too_many_requests", RATE_LIMITED_MESSAGE);
  }
  return null;
}
