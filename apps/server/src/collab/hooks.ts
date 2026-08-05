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
}

export const noopCollabHooks: CollabHooks = {
  onShareChanged: () => {},
  onUserRevoked: () => {},
  beforeNoteDeleted: async () => {},
};
