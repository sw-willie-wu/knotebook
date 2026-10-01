/**
 * #103／#175 的群組測試注入縫（比照 `slugUpdateTestHook`／`noteCreateHooks`）：生產不注入＝零成本。
 * 每個點都標在兩步之間的窗口——「鎖已取得、寫入尚未發生」，或「授權之後、取列／寫入之前」——整合測試在那裡
 * 讓另一條請求插進來（`test/groups-v2-race.test.ts`、`groups-members.test.ts`、`groups-v2-notes-write.test.ts`、
 * `groups-v2-urls.test.ts`），把 spec gate 實跑過的交錯形變成決定性的測試。
 */
export type GroupRacePoint =
  /** `GET /api/notes/:ref`：授權之後、取列之前。 */
  | "ref-authorized"
  /** `POST /api/notes {groupId}`：成員與 `can_create` 檢查之後、建立筆記之前（#103 的 `PUT …/group` 換群組也用過這個點，那支端點 #175 已移除）。 */
  | "membership-checked"
  /** `PUT /api/notes/:id/shares`：授權之後、交易之前（#175：S5 的「授權後被移進群組」窗）。 */
  | "share-authorized"
  /** public-link 的 token PUT 與別名 PUT：授權之後、UPDATE 之前（#175 C13／C14）。 */
  | "public-link-authorized"
  /** `PUT /api/notes/:id/shares`：`FOR SHARE` 讀到 `group_id IS NULL` 之後、upsert 之前。 */
  | "share-group-checked"
  /**
   * T9／T10／T11（`groups/tx/members.ts`）：`lockGroup` 鎖住 `groups` 列、完成該支的檢查之後、寫入 `group_members` 之前。
   * 檢查各支不同：T9 只解析角色（`already_member` 由之後的 INSERT 判定）；T10 解析新角色、確認成員，從內建管理員換走時
   * 做 S1 計數——角色不變時提早回傳、不經過此點；T11 確認成員，移的是內建管理員時做 S1 計數。
   */
  | "group-members-checked"
  /** #175 PR2 T3（`notes/tx/move.ts`）：(0) `FOR UPDATE` 鎖住筆記列、(1) 目標群組檢查通過之後、刪逐人分享之前。 */
  | "note-move-locked"
  /** #175 PR2 T3：每輪 slug 探測之後、savepoint 寫入之前（ctx.slug＝本輪候選）。 */
  | "note-move-slug-candidate"
  /** #175 PR2 T4（`notes/tx/copy.ts`，只在目標是群組時）：(g) 目標 `groups` 列 `FOR KEY SHARE`＋成員重驗通過之後、鎖來源之前。 */
  | "note-copy-target-locked"
  /** #175 PR2 T4（`notes/tx/copy.ts`）：(0) `FOR KEY SHARE` 鎖住來源之後（目標是群組時 (g) 也已持鎖）、讀附件與建副本之前。 */
  | "note-copy-locked"
  /** #175 PR2 T4：附件檔已複製、uploads 列已寫、`note_states` 尚未寫入之前（測試在這裡丟錯模擬 DB 失敗）。 */
  | "note-copy-files-copied"
  /** T5 `DELETE /api/groups/:id`（`groups/tx/delete-group.ts`）：`lockGroup` 並數過筆記為 0 之後、`DELETE groups` 之前。 */
  | "group-delete-locked";

export type GroupTestHook = (point: GroupRacePoint, ctx: { noteId?: string; groupId?: string; slug?: string }) => Promise<void>;
