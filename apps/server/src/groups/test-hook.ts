/**
 * #103 的測試注入縫（比照 `slugUpdateTestHook`／`noteCreateHooks`）：生產不注入＝零成本。
 * 每個點都標在「鎖已取得、寫入尚未發生」（或「授權與取列之間」）的位置——整合測試在那裡讓另一條
 * 請求撞上同一把鎖（`test/groups-race.test.ts`），把 spec gate r2／r3 實跑過的交錯形變成決定性的測試。
 */
export type GroupRacePoint =
  /** `GET /api/notes/:ref`：授權之後、取列之前。 */
  | "ref-authorized"
  /** `PUT`／`DELETE /api/notes/:id/group`：交易第一步 (0) `FOR UPDATE` 之後。 */
  | "note-group-locked"
  /** `PUT /api/notes/:id/group` 換群組那一支、`POST /api/notes {groupId}`：成員檢查之後、寫入之前。 */
  | "membership-checked"
  /** `PUT /api/notes/:id/group`：UPDATE 之後、commit 之前。 */
  | "note-group-written"
  /** `PUT /api/notes/:id/shares`：`FOR SHARE` 讀到 `group_id IS NULL` 之後、upsert 之前。 */
  | "share-group-checked"
  /** 成員異動（`PUT`／`PATCH`／`DELETE …/members`）：鎖 `groups` 列並完成 S1 計數之後、寫入之前。 */
  | "group-members-checked"
  /** `DELETE /api/groups/:id`：鎖完 `groups` 列與所屬筆記列之後、物化 INSERT 之前。 */
  | "group-delete-locked";

export type GroupTestHook = (point: GroupRacePoint, ctx: { noteId?: string; groupId?: string }) => Promise<void>;
