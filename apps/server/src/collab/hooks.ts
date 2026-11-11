/**
 * CollabHooks：REST 路由與即時協作（Hocuspocus）之間的接縫。
 * 路由只依賴這個介面；`noopCollabHooks` 是什麼都不做的預設實作，真正實作由協作伺服器提供。
 */
/**
 * 一次刪除所開的閘門。交易失敗時 `release()`——閘門開著的期間這篇筆記的**新連線**會被
 * 告知「筆記已刪除」並被導離（client 收到 `note-deleting` 就收斂終態），交易若其實 rollback
 * 了那句話是錯的，而閘門的 TTL 有兩分鐘（`DELETING_GATE_TTL_MS`）。
 *
 * ⚠ 它救不回**當時在線**的那些人：`beforeNoteDeleted` 在交易之前就把他們 close 掉了，那些
 * 分頁已經收斂終態並導離頁面。一次 rollback 掉的刪除仍然會把所有在編輯的人踢出去，這是已知
 * 的殘留缺陷（見 docs/known-limitations.md），不是 `release()` 能補的。
 *
 * `release()` 是 fire-and-forget、且**只收得掉自己開的那一道門**（併發的另一次刪除若已經
 * 成功，這次的 release 不會把它的閘門關掉）。不得 throw：呼叫點正在處理另一個錯誤。
 */
export interface NoteDeleteGate {
  release(): void;
}

export interface CollabHooks {
  /**
   * 分享變更時對該使用者定向 requestToken + 5s deadline，逼迫其重新驗證權限。
   * 實作不得同步 throw（fire-and-forget；throw 會使 API 在 DB commit 後回 500）。
   */
  onShareChanged(noteId: string, userId: string): void;
  /**
   * 使用者被撤銷（停用/改密碼）時，依 userId 跨所有開啟中的文件重驗連線。
   * 實作不得同步 throw（fire-and-forget；throw 會使 API 在 DB commit 後回 500）。
   */
  onUserRevoked(userId: string): void;
  /**
   * #388：某台裝置登出（`sessions` 那一列刪了）——只重驗該使用者「由這個 session 換得 token」的連線（`ConnectionHandle.sessionId`）。
   * 比照 `onShareChanged`：同一個人其他裝置的連線不受影響、不必重新出示 token。重驗時 `gate.check` 查不到那一列 → 關閉。
   * 實作不得同步 throw（fire-and-forget；throw 會使 API 在 DB commit 後回 500）。
   */
  onSessionRevoked(userId: string, sessionId: string): void;
  /**
   * #103：群組來源或筆記歸屬造成的權限變動時，對 (noteIds × userIds) 的既有連線重驗（升級也要：
   * `onTokenSync` 會解除唯讀）。重驗結果由 `resolveRole` 決定——只靠群組取得存取的人被關、owner 或
   * 另有來源的人續留或降為唯讀。一律在交易 commit 之後呼叫。
   * 實作不得同步 throw（fire-and-forget；throw 會使 API 在 DB commit 後回 500）。
   */
  onGroupAccessChanged(noteIds: readonly string[], userIds: readonly string[]): void;
  /**
   * 刪除 note 前 close→flush→unload→輪詢，確保無進行中連線；呼叫方必須在刪除交易前
   * await。回傳的 handle 代表「這一次刪除開的那道閘門」——**交易失敗時必須 `release()`**。
   */
  beforeNoteDeleted(noteId: string): Promise<NoteDeleteGate>;
  /**
   * #181：還原 commit 後呼叫——對每篇收掉刪除閘門（unmarkDeleting）並清 TTL 計時器。同步、不 throw、不借連線。
   *
   * ⚠ 它**不看 epoch**、一律收門，正確性押在呼叫端兩條規則上：
   *   1. 只傳還原交易**實際還原**的 id——傳進別的 id 等於讓 restore 端點收掉別人移入中的閘門；
   *   2. commit 之後**同步**呼叫，中間不得有其他 await——否則窗口內開始的新移入會被收門、清掉 timer，
   *      unload 輪詢期間重連的人會留在垃圾桶筆記上繼續寫。
   * 殘留的窄窗：兩個 DELETE 併發、先到的已移入，後到的還在 unload 輪詢（≤5 秒）時就被還原——後到那次的閘門會被收掉，
   * 它接著的移入就沒有閘門（實務上可忽略）。
   */
  onNotesRestored(noteIds: readonly string[]): void;
  /**
   * wikilink 索引器的同步點——委派 `CollabServer.linkSyncState`。`ok:false` 涵蓋
   * 「文件不在記憶體裡」與「該使用者在這篇筆記上沒有開啟中的連線」兩種情況；呼叫方一律回
   * 409 `not_loaded`，收斂交由 client 重試與載入後自我修復——沒有 `note_states` 回退路徑。
   */
  linkSyncGate(noteId: string, userId: string): { ok: true; clock: number } | { ok: false };
}

export const noopCollabHooks: CollabHooks = {
  onShareChanged: () => {},
  onUserRevoked: () => {},
  onSessionRevoked: () => {},
  onGroupAccessChanged: () => {},
  beforeNoteDeleted: async () => ({ release: () => {} }),
  onNotesRestored: () => {},
  linkSyncGate: () => ({ ok: false }),
};
