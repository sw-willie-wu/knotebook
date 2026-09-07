/**
 * #108：兩支內容工具（`read_note_outline`／`read_note_section`）共用的前置。
 *
 * **三步的順序是契約**：L3 角色（`resolveRole`）→ `contentRead` 桶 → presence。
 * 桶排在角色**之後**，所以 `role === "none"` 的「找不到」**不啃桶**（與 REST 的
 * `GET /api/notes/:id/content` 同紀律）；presence 排在最後，被 429 擋下的請求
 * 一個痕跡都不留（M6）。收在同一支是為了讓這個順序只有一份實作。
 *
 * **三道順序各有一個守衛，三條突變都實跑過**（`mcp-content.test.ts`）：
 * 把 `consume` 移到 `resolveRole` 之前 → 案 31 前半紅；把 presence 移到 `consume` 之前 →
 * 案 31 後半（429 那一發的 awareness clock）紅；把 presence 移到 `role === "none"` 的
 * early return 之前 → 「拒絕路徑不 touch presence」那一案紅。
 * ⚠ **第三道守的是 M2 與 M6 的交界**：`touch` 只看文件有沒有載入、**不看角色**——順序寫反，
 * 任何持 PAT 的人只要猜得到 note id，就能讓自己的名牌出現在真正協作者的畫面上。
 *
 * ⚠ `role === "none"` 一律當「找不到」，訊息不得洩漏「存在但你沒權限」（M2／案 17）。
 * ⚠ presence 目標一律走既有的 `presenceTargetForRead(...)`，**不得自組 `PresenceTarget`
 *   字面量**（M8 的讀取側）。顯示名走 `presenceIdentity(...)`——**server 端 presence 顯示名的
 *   唯一組字點**（#108 PR2 收成一份；`presence.ts` 的原文措辭準確，這裡不是複製貼上）。
 *   web 端 `LastEditedLabel.tsx`／`AiEditsDialog.tsx` 各自另有一份同形的
 *   `${byHandle} (${agentLabel})`——那兩處是**修改紀錄的顯示**，不是 presence，故意不共用這支。
 *   「它組得對不對」的唯一守衛仍是 `mcp-content.test.ts` 的 presence 那一案。
 */
import type { Role } from "@knotebook/shared";
import { currentAgentLabel } from "../auth/agent-label.js";
import { presenceIdentity, presenceTargetForRead } from "../notes/editing/presence.js";
import { resolveRole } from "../notes/service.js";
import { toolError, type ToolErrorResult } from "./tool-result.js";
import type { McpToolCtx } from "./context.js";

/** 「你沒有這篇筆記」與「這篇筆記不存在」共用的**同一個**字串（案 17 逐位元組同形）。
 *  export 是因為 `read_note_outline` 的「查完角色又被刪掉」競態路徑也要用它——那條路寫成
 *  另一個字串，兩種「找不到」在 wire 上就分得出來了。
 *  ⚠ **誠實記下**：案 17 守的是**角色**那條路；**競態那條路沒有守衛**（要造出「resolveRole
 *  說有、下一句 re-select 說沒有」的視窗才測得到）。突變實測：把競態那處改成另一個字串，
 *  全族 21 條照樣綠。 */
export const NOTE_NOT_FOUND_MESSAGE = "No note with that id. It may not exist, or it may not be shared with you.";
const RATE_LIMITED_MESSAGE = "Too many note reads right now. Wait a moment before reading more.";

export type NoteReadAccess = { ok: true; role: Role } | { ok: false; error: ToolErrorResult };

/**
 * `section` ＝ `undefined` 代表整篇讀（presence 落文件開頭），給定值則落該段第一顆。
 * 回 `{ ok: false, error }` 時呼叫端**直接回傳那個 error**，不得再做任何事。
 */
export async function authorizeNoteRead(
  ctx: McpToolCtx,
  noteId: string,
  section: string | undefined
): Promise<NoteReadAccess> {
  const role = await resolveRole(ctx.db, ctx.userId, noteId);
  if (role === "none") return { ok: false, error: toolError("not_found", NOTE_NOT_FOUND_MESSAGE) };
  if (!ctx.limiters.contentRead.consume(ctx.userId)) {
    return { ok: false, error: toolError("too_many_requests", RATE_LIMITED_MESSAGE) };
  }
  // cookie session（`tokenId` 為 null）不現身：那是使用者本人在用瀏覽器，規格 §12.2 明講
  // 不設 presence。`touch` 內部只對已載入的文件動作，沒人在線時是 no-op，讀路徑「零副作用」
  // 的不變量仍成立。
  if (ctx.tokenId !== null) {
    const label = await currentAgentLabel(ctx.db, ctx.tokenId);
    if (label !== null) {
      ctx.presence?.touch(noteId, ctx.tokenId, presenceIdentity(ctx.userHandle, label), presenceTargetForRead(section));
    }
  }
  return { ok: true, role };
}
