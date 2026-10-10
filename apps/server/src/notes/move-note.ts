/**
 * #180 spec §3.2：移入群組的本體——REST `POST /api/notes/:id/move` 與 MCP `move_note_to_group` 共用。
 * 入口 `noteId.toLowerCase()`（MCP 的 `NOTE_ID` 與 REST 的 app 層 `lowercaseUuidParams` 送進來已是小寫；這裡保留作防禦——
 * 踢線與 live doc 以小寫字串為鍵，gate r1 I1）。順序逐條＝原路由（F26）：`resolveNoteAccess` → `none` →
 * `!permissions.moveToGroup` → `UUID_RE.test(groupId)`（MCP 的 GROUP_ID 已擋非 uuid，這一關對 MCP 永不觸發，留著為 REST）→
 * `groupId.toLowerCase()` → 交易 → catch 分類（`TxAbort`（含 `StorageQuotaExceeded`）→ `aborted`、FK → `group_not_found`
 * （防禦縱深）、`isRetryableTxError` → `busy`、其餘 rethrow）→ **commit 成功後**依序：`versions.relocated([noteId])`（版本歷史
 * §9：重建載入中筆記的版本狀態；commit 失敗的 catch 分支不呼叫）→ 踢線（被清分享者 ∪ 呼叫者）→ `moved`。
 * 交易內清版本由 `notes/tx/move.ts` 的 `resetNoteVersionsInTx` 自動跟著走。
 * 含 `.transaction(` ⇒ 在 S14 的 `ROUTE_FILES`。
 */
import type { CollabHooks } from "../collab/hooks.js";
import type { VersionService } from "../collab/versions.js";
import type { Db } from "../db/index.js";
import { isForeignKeyViolation, isRetryableTxError } from "../db/pg-errors.js";
import type { GroupTestHook } from "../groups/test-hook.js";
import { TxAbort } from "../http/tx-abort.js";
import { resolveNoteAccess, UUID_RE } from "./service.js";
import { moveNoteToGroupInTx } from "./tx/move.js";

export interface MoveNoteDeps {
  db: Db;
  collabHooks: CollabHooks;
  versions: VersionService;
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
}

export type MoveOutcome =
  | { kind: "moved" }
  /** `resolveNoteAccess` 為 none。 */
  | { kind: "not_found" }
  /** `!permissions.moveToGroup`（只有個人筆記的 owner 為真，F28）。 */
  | { kind: "forbidden" }
  /** 非 UUID，或交易外 FK 23503（防禦縱深）。 */
  | { kind: "group_not_found" }
  /** 交易內的 `TxAbort`（含子類 `StorageQuotaExceeded`）——原樣交給呼叫端。 */
  | { kind: "aborted"; err: TxAbort }
  | { kind: "busy" };

export async function moveNoteToGroup(
  deps: MoveNoteDeps,
  input: { noteId: string; userId: string; userHandle: string; groupId: string },
): Promise<MoveOutcome> {
  const noteId = input.noteId.toLowerCase();
  const access = await resolveNoteAccess(deps.db, input.userId, noteId);
  if (access.role === "none") return { kind: "not_found" };
  if (!access.permissions.moveToGroup) return { kind: "forbidden" };
  if (!UUID_RE.test(input.groupId)) return { kind: "group_not_found" };
  // S14：callback 整段就是 `moveNoteToGroupInTx(tx, …)`，引數是交易前備好的純資料與測試縫。
  const txInput = {
    noteId, userId: input.userId, userHandle: input.userHandle, groupId: input.groupId.toLowerCase(), lockTimeoutMs: deps.storageLockTimeoutMs,
  };
  let moved;
  try {
    moved = await deps.db.transaction(tx => moveNoteToGroupInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    // 先判子類（StorageQuotaExceeded extends TxAbort）：呼叫端要先判子類才拿得到數字；數字可見性在交易外判（儲存配額 §8.1）。
    if (err instanceof TxAbort) return { kind: "aborted", err };
    // 防禦縱深：(1) 已持目標群組列的 KEY SHARE，群組在交易中刪不掉、UPDATE 不會撞 FK 23503；撞到也回同一條 group_not_found（catch 在交易外）。
    if (isForeignKeyViolation(err)) return { kind: "group_not_found" };
    // 儲存配額 §6.9：空間鎖逾時（55P03）／死結（40P01，含既有 T3×T6 在 note_redirects 的形）／40001 → busy（REST 409 server_busy）。
    if (isRetryableTxError(err)) return { kind: "busy" };
    throw err;
  }
  deps.versions.relocated([noteId]);
  deps.collabHooks.onGroupAccessChanged([noteId], [...new Set([...moved.removedShareUserIds, input.userId])]);
  return { kind: "moved" };
}
