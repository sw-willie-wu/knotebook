/**
 * 資料夾測試共用的種子與量測工具。測試檔不受結構守衛管轄，可直寫 `folders`／`note_placements`／
 * `notes.folder_id`。名稱預設隨機（同層不分大小寫唯一）。
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Db } from "../src/db/index.js";
import { folders } from "../src/db/schema.js";

export type SeedSpace = { personal: string } | { shared: string } | { group: string };

export async function seedFolder(
  db: Db,
  space: SeedSpace,
  opts: { parentId?: string; name?: string; id?: string; createdBy?: string | null } = {},
): Promise<{ id: string; name: string }> {
  const owner = "group" in space
    ? { kind: "group", groupId: space.group, ownerId: null }
    : "personal" in space
      ? { kind: "personal", ownerId: space.personal, groupId: null }
      : { kind: "shared", ownerId: space.shared, groupId: null };
  const [f] = await db
    .insert(folders)
    .values({
      ...(opts.id !== undefined ? { id: opts.id } : {}),
      ...owner,
      parentId: opts.parentId ?? null,
      name: opts.name ?? `f-${randomUUID().slice(0, 12)}`,
      createdBy: opts.createdBy !== undefined ? opts.createdBy : owner.ownerId,
    })
    .returning({ id: folders.id, name: folders.name });
  return { id: f!.id, name: f!.name };
}

/** 由根到葉建一串（names[0] 在 opts.parentId 或根層）；回 id（同序）。 */
export async function seedFolderChain(db: Db, space: SeedSpace, names: readonly string[], opts: { parentId?: string } = {}): Promise<string[]> {
  const ids: string[] = [];
  let parentId = opts.parentId;
  for (const name of names) {
    const f = await seedFolder(db, space, { name, ...(parentId !== undefined ? { parentId } : {}) });
    ids.push(f.id);
    parentId = f.id;
  }
  return ids;
}

export async function setNoteFolder(pool: Pool, noteId: string, folderId: string | null): Promise<void> {
  await pool.query("update notes set folder_id = $2 where id = $1", [noteId, folderId]);
}

export async function setSnapshot(pool: Pool, noteId: string, path: readonly string[] | null): Promise<void> {
  await pool.query("update notes set trash_folder_path = $2::jsonb where id = $1", [noteId, path === null ? null : JSON.stringify(path)]);
}

export async function seedPlacement(pool: Pool, userId: string, noteId: string, folderId: string): Promise<void> {
  await pool.query("insert into note_placements (user_id, note_id, folder_id) values ($1, $2, $3)", [userId, noteId, folderId]);
}

export async function noteFolderCols(pool: Pool, noteId: string): Promise<{ folder_id: string | null; trash_folder_path: string[] | null } | undefined> {
  const { rows } = await pool.query("select folder_id, trash_folder_path from notes where id = $1", [noteId]);
  return rows[0];
}

export async function folderRow(pool: Pool, id: string): Promise<{
  id: string; kind: string; owner_id: string | null; group_id: string | null; parent_id: string | null; name: string; created_by: string | null;
} | undefined> {
  const { rows } = await pool.query("select id, kind, owner_id, group_id, parent_id, name, created_by from folders where id = $1", [id]);
  return rows[0];
}

export async function placementOf(pool: Pool, userId: string, noteId: string): Promise<string | null> {
  const { rows } = await pool.query<{ folder_id: string }>("select folder_id from note_placements where user_id = $1 and note_id = $2", [userId, noteId]);
  return rows[0]?.folder_id ?? null;
}

/** 以 generate_series 一句建 n 篇放在 folderId 的筆記（大子樹案用）；回 id（升冪）。 */
export async function seedManyNotesInFolder(pool: Pool, owner: { ownerId: string } | { groupId: string }, folderId: string, n: number): Promise<string[]> {
  const tag = randomUUID().slice(0, 12);
  const [ownerId, groupId] = "groupId" in owner ? [null, owner.groupId] : [owner.ownerId, null];
  const { rows } = await pool.query<{ id: string }>(
    `insert into notes (owner_id, group_id, title, slug, folder_id)
     select $1::uuid, $2::uuid, 'T' || g, 'many-' || $3 || '-' || g, $4::uuid from generate_series(1, $5::int) g
     returning id`,
    [ownerId, groupId, tag, folderId, n],
  );
  return rows.map(r => r.id).sort();
}

/** xmin（判「沒有寫」用：UPDATE 一定換 xmin）。 */
export async function xminOf(pool: Pool, table: "notes" | "folders", id: string): Promise<string> {
  const { rows } = await pool.query<{ x: string }>(`select xmin::text as x from ${table} where id = $1`, [id]);
  return rows[0]!.x;
}
