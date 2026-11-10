/**
 * #103／#175 的群組測試注入縫（比照 `slugUpdateTestHook`／`noteCreateHooks`）：生產不注入＝零成本。
 * 每個點都標在兩步之間的窗口——「鎖已取得、寫入尚未發生」，或「授權之後、取列／寫入之前」——整合測試在那裡
 * 讓另一條請求插進來（`test/groups-v2-race.test.ts`、`groups-members.test.ts`、`groups-v2-notes-write.test.ts`、
 * `groups-v2-urls.test.ts`），把會出問題的交錯形變成決定性的測試。
 */
export type GroupRacePoint =
  /** `GET /api/notes/:ref`：授權之後、取列之前。 */
  | "ref-authorized"
  /** `POST /api/notes {groupId}` 與 MCP `create_note {groupId}`：成員與 `can_create` 檢查之後、建立筆記之前（#103 的 `PUT …/group` 換群組也用過這個點，那支端點 #175 已移除）。 */
  | "membership-checked"
  /** `PUT /api/notes/:id/shares`：授權之後、交易之前（#175：「授權後被移進群組」窗）。 */
  | "share-authorized"
  /** public-link 的 token PUT、別名 PUT 與寬度 PUT（#297），及 token DELETE、別名 DELETE（#181）：授權之後、UPDATE 之前（#175）。 */
  | "public-link-authorized"
  /** `PUT /api/notes/:id/shares`：`FOR SHARE` 讀到 `group_id IS NULL` 之後、upsert 之前。 */
  | "share-group-checked"
  /**
   * #175（`groups/tx/roles.ts`）：`lockGroup` 鎖住 `groups` 列、角色已查到且通過內建檢查之後，
   * 寫入 `group_roles`／`group_members` 之前。
   */
  | "group-roles-checked"
  /**
   * T9／T10／T11（`groups/tx/members.ts`）：`lockGroup` 鎖住 `groups` 列、完成該支的檢查之後、寫入 `group_members` 之前。
   * 檢查各支不同：T9 只解析角色（`already_member` 由之後的 INSERT 判定）；T10 解析新角色、確認成員，從內建管理員換走時
   * 做管理員計數——角色不變時提早回傳、不經過此點；T11 確認成員，移的是內建管理員時做管理員計數。
   */
  | "group-members-checked"
  /** #175（`notes/tx/move.ts`）：(0) `FOR UPDATE` 鎖住筆記列、(1) 目標群組檢查通過之後、刪逐人分享之前。 */
  | "note-move-locked"
  /** #175：每輪 slug 探測之後、savepoint 寫入之前（ctx.slug＝本輪候選）。 */
  | "note-move-slug-candidate"
  /** #175（`notes/tx/copy.ts`，只在目標是群組時）：(g) 目標 `groups` 列 `FOR KEY SHARE`＋成員重驗通過之後、鎖來源之前。 */
  | "note-copy-target-locked"
  /** #175（`notes/tx/copy.ts`）：(0) `FOR KEY SHARE` 鎖住來源之後（目標是群組時 (g) 也已持鎖）、讀附件與建副本之前。 */
  | "note-copy-locked"
  /**
   * #175；儲存配額起：附件檔已複製（`copyFile` 迴圈之後）、取空間鎖與建副本之前（ctx.noteId＝**來源**——副本此時還沒建）；
   * 測試在這裡丟錯模擬失敗。
   */
  | "note-copy-files-copied"
  /** #175：by-path 兩形（/n/、/g/）取到列之後、授權（`authorizeRow`）之前——「取列後被移動」的窗。 */
  | "path-resolved"
  /** #175（`groups/tx/delete-group.ts` `transferGroupInTx`）：每篇的每輪 slug 探測之後、savepoint 寫入之前（ctx.noteId、ctx.slug＝本輪候選）。 */
  | "group-transfer-slug-candidate"
  /** #175 `DELETE /api/groups/:id` 全刪模式（路由，**交易外**）：gate 全部開完之後、`BEGIN` 之前——「gate 之後才進群組」與「另一位管理員的轉移先完成」的窗。 */
  | "group-delete-gated"
  /** 刪群組（`groups/tx/delete-group.ts`）：T6 轉移＝`lockGroup`＋transferTo 檢查通過之後、取成員與筆記之前；T7 全刪＝`lockGroup` 之後、取 L 之前。 */
  | "group-delete-locked"
  /**
   * 儲存配額（第 4a 步）：`assertSpaceRoomInTx` 取得空間 advisory 鎖、`lock_timeout` 已復原之後，讀配額與 SUM 之前。
   * 四支白名單交易（上傳 U-tx、T3 移動、T4 複製、T6 轉移）都經過它；ctx 由呼叫端帶（上傳 `{noteId}`、移動 `{noteId, groupId}`、
   * 複製 `{noteId: 來源, groupId?: 目標群組}`、轉移 `{groupId: 被刪的群組}`）。
   */
  | "storage-space-locked"
  /** #181（`notes/tx/trash.ts` `trashNotesInTx`）：`FOR UPDATE` 鎖住待移入的筆記列之後、交易內重判刪除權之前。 */
  | "note-trash-locked"
  /** #181（`restoreNotesInTx`）：`FOR UPDATE` 鎖住筆記列之後、分類與重判垃圾桶權之前。 */
  | "note-restore-locked"
  /** #181（`purgeTrashedNotesInTx`）：`FOR UPDATE` 鎖住筆記列之後、分類與重判垃圾桶權之前。 */
  | "note-purge-locked"
  /** #181（`purgeExpiredBatchInTx`）：到期列 `FOR UPDATE SKIP LOCKED` 選完之後、`deleteNotesInTx` 之前（ctx.noteId＝這批第一篇，空批不帶）。 */
  | "trash-purge-locked"
  /** #181：REST move／MCP `move_note_to_group`（`notes/move-note.ts`）授權之後、`.transaction(` 之前。 */
  | "note-move-authorized"
  /** #181：REST copy／MCP `copy_note`（`notes/copy-note.ts`）授權之後、`.transaction(` 之前（ctx.noteId＝來源）。 */
  | "note-copy-authorized"
  /** #181：`POST /api/notes/:id/uploads`（`routes/uploads.ts`）授權之後、`.transaction(` 之前。 */
  | "upload-authorized"
  /** 資料夾 T5／T6／T8（`folders/service.ts`）：交易外授權之後、閘門／`.transaction(` 之前。 */
  | "folder-authorized"
  /** 資料夾 T3（`folders/tx/lock.ts` `lockFolderSpacesInTx`）：取完所有結構鎖鍵、`lock_timeout` 已復原之後（鍵空不經過）。 */
  | "folder-structure-locked"
  /** 資料夾 T8（刪資料夾）：閘門全開之後、交易之前。 */
  | "folder-delete-gated"
  /** 資料夾 T8（`folders/tx/delete-folder.ts`）：一段式鎖完子樹筆記之後、分組之前。 */
  | "folder-delete-notes-locked"
  /** 資料夾 T9（放置）：交易外授權之後、交易之前。 */
  | "note-folder-authorized"
  /** 資料夾 T9（`folders/tx/place-note.ts`）：交易內鎖完筆記並重判之後、寫入之前。 */
  | "note-folder-locked"
  /** 資料夾 T10（`notes/tx/copy.ts` `copyNoteInTx`）：目標資料夾 `FOR KEY SHARE`＋重判之後、鎖來源之前。 */
  | "note-copy-folder-locked"
  /** 資料夾 T7（`trash/service.ts` `restoreTrashed`）：預判與預讀空間之後、交易之前。 */
  | "trash-restore-prejudged";

export interface GroupHookCtx { noteId?: string; groupId?: string; slug?: string; folderId?: string }

export type GroupTestHook = (point: GroupRacePoint, ctx: GroupHookCtx) => Promise<void>;
