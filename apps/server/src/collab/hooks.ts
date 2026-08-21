/**
 * CollabHooks：Plan 1 與 Plan 2（Hocuspocus 即時協作）之間的接縫。
 * Plan 1 一律注入 `noopCollabHooks`；Plan 2 才會提供真正實作。
 */
export interface CollabHooks {
  /**
   * Plan 2：分享變更時對該使用者定向 requestToken + 5s deadline，逼迫其重新驗證權限。
   * 實作不得同步 throw（fire-and-forget；throw 會使 API 在 DB commit 後回 500）。
   */
  onShareChanged(noteId: string, userId: string): void;
  /**
   * Plan 2：使用者被撤銷（停用/改密碼）時，依 userId 跨所有開啟中的文件重驗連線。
   * 實作不得同步 throw（fire-and-forget；throw 會使 API 在 DB commit 後回 500）。
   */
  onUserRevoked(userId: string): void;
  /** Plan 2：刪除 note 前 close→flush→unload→輪詢，確保無進行中連線；呼叫方必須在刪除交易前 await。 */
  beforeNoteDeleted(noteId: string): Promise<void>;
  /**
   * 刪除交易失敗時**必須**呼叫：`beforeNoteDeleted` 開的閘門要立刻收掉。
   *
   * 閘門開著的期間，這篇筆記的協作者會被告知「筆記已刪除」並被導離（client 收到
   * `note-deleting` 就收斂終態）——交易若其實 rollback 了，那句話是錯的，而閘門的 TTL
   * 有兩分鐘（`DELETING_GATE_TTL_MS`）。實作不得 throw（呼叫點正在處理另一個錯誤）。
   */
  afterNoteDeleteFailed(noteId: string): void;
  /**
   * Plan 3：wikilink 索引器的同步點——委派 `CollabServer.linkSyncState`。`ok:false` 涵蓋
   * 「文件不在記憶體裡」與「該使用者在這篇筆記上沒有開啟中的連線」兩種情況；呼叫方一律回
   * 409 `not_loaded`，收斂交由 client 重試與載入後自我修復——沒有 `note_states` 回退路徑。
   */
  linkSyncGate(noteId: string, userId: string): { ok: true; clock: number } | { ok: false };
}

export const noopCollabHooks: CollabHooks = {
  onShareChanged: () => {},
  onUserRevoked: () => {},
  beforeNoteDeleted: async () => {},
  afterNoteDeleteFailed: () => {},
  linkSyncGate: () => ({ ok: false }),
};
