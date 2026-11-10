/**
 * #181 垃圾桶整合測試共用的種子與量測。**只在測試裡直寫 `deleted_at`**（不經 `trashNotesInTx`）——`test/` 不受 src 的守衛管轄。
 *
 */
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import type { Db } from "../src/db/index.js";
import { groupMembers } from "../src/db/schema.js";
import { cookieOf, seedGroup, seedRole, seedUser, type SeededUser } from "./group-helpers.js";

/** 測試用直接移入（不經 trashNotesInTx）：deleted_at = now() - $ago::interval、deleted_by = $by。 */
export async function markTrashed(pool: Pool, noteId: string, by: string | null, ago = "0 seconds"): Promise<void> {
  const { rowCount } = await pool.query(
    `update notes set deleted_at = now() - $2::interval, deleted_by = $3 where id = $1`,
    [noteId, ago, by],
  );
  if (rowCount !== 1) throw new Error(`markTrashed: ${noteId} 命中 ${rowCount} 列`);
}

export async function markRestored(pool: Pool, noteId: string): Promise<void> {
  const { rowCount } = await pool.query(`update notes set deleted_at = null, deleted_by = null where id = $1`, [noteId]);
  if (rowCount !== 1) throw new Error(`markRestored: ${noteId} 命中 ${rowCount} 列`);
}

/** 兩欄現值；`deleted_at` 取文字形（微秒精度）。筆記不存在 → undefined。 */
export async function trashCols(pool: Pool, noteId: string): Promise<{ deleted_at: string | null; deleted_by: string | null } | undefined> {
  const { rows } = await pool.query<{ deleted_at: string | null; deleted_by: string | null }>(
    `select deleted_at::text as deleted_at, deleted_by from notes where id = $1`,
    [noteId],
  );
  return rows[0];
}

export interface SixRoleScene {
  groupId: string;
  admin: SeededUser;      // 內建管理員（七旗標）
  member: SeededUser;     // 內建一般成員（讀＋建＋編，無刪）
  editDelete: SeededUser; // 自訂 { canRead, canEdit, canDelete }
  deleteOnly: SeededUser; // 自訂 { canRead, canDelete }
  editOnly: SeededUser;   // 自訂 { canRead, canEdit }
  readOnly: SeededUser;   // 自訂 { canRead }
  outsider: SeededUser;   // 非成員
}

/** 第二張表的六種角色＋非成員，同一個群組。 */
export async function sixRoleScene(db: Db): Promise<SixRoleScene> {
  const admin = await seedUser(db);
  const member = await seedUser(db);
  const editDelete = await seedUser(db);
  const deleteOnly = await seedUser(db);
  const editOnly = await seedUser(db);
  const readOnly = await seedUser(db);
  const outsider = await seedUser(db);
  const g = await seedGroup(db, "SixRoles", [
    { userId: admin.id, role: "admin" },
    { userId: member.id, role: "member" },
  ]);
  const custom: Array<[SeededUser, Parameters<typeof seedRole>[3]]> = [
    [editDelete, { canRead: true, canEdit: true, canDelete: true }],
    [deleteOnly, { canRead: true, canDelete: true }],
    [editOnly, { canRead: true, canEdit: true }],
    [readOnly, { canRead: true }],
  ];
  for (const [u, flags] of custom) {
    const roleId = await seedRole(db, g.id, `role-${u.id.slice(0, 8)}`, flags);
    await db.insert(groupMembers).values({ groupId: g.id, userId: u.id, roleId });
  }
  return { groupId: g.id, admin, member, editDelete, deleteOnly, editOnly, readOnly, outsider };
}

/** `app.inject` 的簡寫：`userId` 為 null ＝不帶 cookie。 */
export const inject = async (
  app: FastifyInstance,
  method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT",
  url: string,
  userId: string | null,
  payload?: unknown,
): Promise<LightMyRequestResponse> =>
  app.inject({
    method,
    url,
    ...(userId === null ? {} : { cookies: await cookieOf(userId) }),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
