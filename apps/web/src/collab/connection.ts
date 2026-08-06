import { COLLAB_CLOSE_NOTE_DELETED, COLLAB_CLOSE_REVOKED, type Role } from "@knotebook/shared";

/**
 * 共編連線狀態（spec §5 client 端 + N4/N7，逐字）。
 *
 * - `connecting`：尚未（或暫時未）連上。provider 內建退避重連中，非終態。
 * - `connected`：已通過 `onAuthenticate`；`role` 來自**最近一次 token endpoint 回應的
 *   頂層 `role` 欄位**（絕不解 JWT——那是 server 與 Hocuspocus 之間的憑證）。
 * - `reconnecting-once`：收到第一發撤權 close，正在「重取 token 連一次」的觀察窗內。
 * - `kicked` / `deleted`：終態，收任何事件都不再轉移（見 `collabReducer` 第一段）。
 */
export type CollabState =
  | { phase: "connecting" }
  | { phase: "connected"; role: Role }
  | { phase: "reconnecting-once" }
  | { phase: "kicked" }
  | { phase: "deleted" };

/**
 * 驅動狀態機的三種事件。
 *
 * - `open`：provider 的 `onAuthenticated`（握手完成）。`role` 取自最近一次 token 回應。
 * - `close`：provider 的 `onClose`。**close code 由 Hocuspocus 硬寫 1000，一律只看
 *   `reason` 字串**（見 `apps/server/src/collab/server.ts` 的 `APP_CLOSE_CODE`）。
 *   同一個回呼也會收到底層 WebSocket 的 close（reason 通常是空字串）。
 * - `token-role`：每次 token function 取回 body 的 `role`。這是**權限恢復
 *   （server 端 `setReadOnly(false)`）唯一會傳到 client 的訊號**——server 對「恢復」
 *   不另送通知，只有下一次 token 往返會帶回新角色。
 */
export type CollabEvent = { type: "open"; role: Role } | { type: "close"; reason: string } | { type: "token-role"; role: Role };

export const INITIAL_COLLAB_STATE: CollabState = { phase: "connecting" };

/** 終態＝不會再有任何轉移的狀態；呼叫端據此停止重連並跑一次性的 toast + 導頁。 */
export function isTerminal(state: CollabState): boolean {
  return state.phase === "kicked" || state.phase === "deleted";
}

/** 這個角色能不能編輯內容（`editor.isEditable` / `BlockNoteView editable` 的唯一判準）。 */
export function canEdit(role: Role): boolean {
  return role === "owner" || role === "editor";
}

/**
 * 共編連線狀態機（純函式，spec §5 的轉移表逐條落地）。
 *
 * 判定順序即為優先序，順序本身是契約的一部分：
 *
 * 1. **終態凍結**：`kicked`/`deleted` 收任何事件一律回傳原物件。放在最前面，
 *    所以連 `close(NOTE_DELETED)` 也不會把 `kicked` 蓋成 `deleted`（先到先定）。
 * 2. `close(NOTE_DELETED)` → `deleted`（任何非終態皆然）。
 * 3. `close(REVOKED)`：`reconnecting-once` → `kicked`（第二擊）；其餘非終態 →
 *    `reconnecting-once`（第一擊，呼叫端據此 `disconnect()` 後重取 token 連一次）。
 *    `connecting` 也算第一擊——雖然實務上要連上才收得到應用層 CLOSE，但把它歸到
 *    「還沒用掉那一次重連機會」這一側才是安全的方向。
 * 4. `close(其他 reason)`（網路斷線＝空字串、`"Reset Connection"` 廣播…）→
 *    `connecting`。非終態，provider 自己會退避重連。**注意這會重置
 *    `reconnecting-once` 的觀察窗**：網路問題不是撤權訊號，不該被算成第二擊；
 *    真的被撤權時，下一次連上仍會再收到 REVOKED，流程一樣收斂到 `kicked`。
 * 5. `token-role`：
 *    - `reconnecting-once` + `'none'` → `kicked`。**這是撤權流程實際會走的那條路**：
 *      重連時 server 的 `onAuthenticate` 對 `'none'` token 是丟 permission-denied
 *      而不是再送一則 CLOSE(REVOKED)，所以第二擊多半由我們自己取回的 role 判定。
 *    - `connected` → 就地換角色，**留在 connected**（N4 降級：editor→viewer 只是
 *      `editor.isEditable=false` + toast，連線不斷）。`'none'` 也照樣留在 connected
 *      （角色 `'none'` ⇒ `canEdit` 為 false ⇒ 唯讀），踢出與否交給 server 的
 *      REVOKED close 裁決——client 不自行推斷授權結果。
 *    - 其餘狀態不轉移（`connecting` 的角色要等 `open` 才落定）。
 * 6. `open` → `connected`（帶事件裡的 role）。`reconnecting-once` + `open` 代表那一次
 *    重連成功，回到正常態。
 *
 * 角色沒變時一律回傳**原本的 state 物件**（`Object.is` 相等），讓 `useReducer`
 * 不會為了無意義的事件觸發 re-render。
 */
export function collabReducer(state: CollabState, event: CollabEvent): CollabState {
  if (isTerminal(state)) return state;

  if (event.type === "close") {
    if (event.reason === COLLAB_CLOSE_NOTE_DELETED) return { phase: "deleted" };
    if (event.reason === COLLAB_CLOSE_REVOKED) {
      return state.phase === "reconnecting-once" ? { phase: "kicked" } : { phase: "reconnecting-once" };
    }
    return state.phase === "connecting" ? state : { phase: "connecting" };
  }

  if (event.type === "token-role") {
    if (state.phase === "reconnecting-once") {
      return event.role === "none" ? { phase: "kicked" } : state;
    }
    if (state.phase === "connected") {
      return state.role === event.role ? state : { phase: "connected", role: event.role };
    }
    return state;
  }

  // event.type === 'open'
  if (state.phase === "connected" && state.role === event.role) return state;
  return { phase: "connected", role: event.role };
}
