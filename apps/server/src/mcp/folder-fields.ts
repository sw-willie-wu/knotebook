/**
 * 資料夾 PR-3d（spec §5.12）：回給模型的資料夾欄位——輸入 id 的驗證、名稱與路徑的截斷、名稱與路徑的查詢。
 * 截斷一律走 `limits.ts` 的逃脫後計價（`truncateText`／`escapedLength`），旗標只在真的截時才有鍵。
 */
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { folders } from "../db/schema.js";
import type { DbOrTx } from "../db/tx.js";
import type { FolderAccess } from "../folders/queries.js";
import { folderPathJsonSql } from "../folders/sql.js";
import { noNul } from "../notes/schemas.js";
import { UUID_RE } from "../notes/service.js";
import { MCP_FOLDER_NAME_MAX, MCP_FOLDER_PATH_MAX, MCP_TEXT_MAX, escapedLength, truncateText } from "./limits.js";

/** 與 `NOTE_ID`（notes/schemas.ts）同形，各自一份物件：非 UUID 是輸入驗證錯誤（plan 讀碼發現 12）。 */
export const FOLDER_ID = z.string().regex(UUID_RE).refine(noNul).transform(s => s.toLowerCase());

export const folderRefSchema = z.object({
  id: z.string(),
  name: z.string().max(MCP_FOLDER_NAME_MAX),
  nameTruncated: z.literal(true).optional(),
});
export type FolderRefForModel = z.infer<typeof folderRefSchema>;

export function folderRefForModel(id: string, name: string): FolderRefForModel {
  const cut = truncateText(name, MCP_FOLDER_NAME_MAX);
  return { id, name: cut.text, ...(cut.truncated ? { nameTruncated: true as const } : {}) };
}

/**
 * `list_folders` 的一項（spec §5.12）。personal／shared 不輸出 owner id（只有本人看得到，同 REST 的 `toFolderSpaceDto`）；
 * 群組名照群組 `owner.name` 的上限截（`MCP_TEXT_MAX`）。（作者決定）不帶 `permissions`／`createdAt`。
 */
export const folderForModelSchema = z.object({
  id: z.string(),
  name: z.string().max(MCP_FOLDER_NAME_MAX),
  nameTruncated: z.literal(true).optional(),
  parentId: z.string().nullable(),
  space: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("personal") }),
    z.object({ kind: z.literal("shared") }),
    z.object({
      kind: z.literal("group"),
      groupId: z.string(),
      groupName: z.string().max(MCP_TEXT_MAX),
      groupNameTruncated: z.literal(true).optional(),
    }),
  ]),
  path: z.array(z.string().max(MCP_FOLDER_NAME_MAX)),
  pathTruncated: z.literal(true).optional(),
});
export type FolderForModel = z.infer<typeof folderForModelSchema>;

export function folderForModel(row: { access: FolderAccess; path: string[]; groupName: string | null }): FolderForModel {
  const f = row.access.folder;
  const sp = row.access.space;
  const name = truncateText(f.name, MCP_FOLDER_NAME_MAX);
  let space: FolderForModel["space"];
  if (sp.kind === "group") {
    const g = truncateText(row.groupName ?? "", MCP_TEXT_MAX);
    space = { kind: "group", groupId: sp.groupId, groupName: g.text, ...(g.truncated ? { groupNameTruncated: true as const } : {}) };
  } else {
    space = { kind: sp.kind };
  }
  const path = truncateFolderPath(row.path);
  return {
    id: f.id,
    name: name.text,
    ...(name.truncated ? { nameTruncated: true as const } : {}),
    parentId: f.parentId,
    space,
    path: path.path,
    ...(path.truncated ? { pathTruncated: true as const } : {}),
  };
}

/** 陣列 JSON 去掉兩端方括號的長度：Σ(段的逃脫後長度＋2)＋段數−1；空陣列 0。 */
export function folderPathCost(names: readonly string[]): number {
  if (names.length === 0) return 0;
  let cost = names.length - 1;
  for (const name of names) cost += escapedLength(name) + 2;
  return cost;
}

/**
 * 每段先以 MCP_FOLDER_NAME_MAX 截；成本 > MCP_FOLDER_PATH_MAX 時從根端整段丟（至少留 1 段）。truncated＝有任何一段被截或被丟。
 * 單段截後最多 82（80＋引號），所以留下的那一段永遠在上限內。
 */
export function truncateFolderPath(names: readonly string[]): { path: string[]; truncated: boolean } {
  const cuts = names.map(name => truncateText(name, MCP_FOLDER_NAME_MAX));
  let truncated = cuts.some(c => c.truncated);
  let path = cuts.map(c => c.text);
  while (path.length > 1 && folderPathCost(path) > MCP_FOLDER_PATH_MAX) {
    path = path.slice(1);
    truncated = true;
  }
  return { path, truncated };
}

/**
 * 一句 `select id, name from folders where id in (…)`；null／重複 id 先濾掉；空集合不發查詢。
 * 不判可見性：呼叫端傳的是對呼叫者可見的 `viewerFolderId`（plan 讀碼發現 5）。查不到的 id 不在 Map 裡（兩句之間被刪）。
 */
export async function loadFolderNames(db: DbOrTx, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))];
  const out = new Map<string, string>();
  if (wanted.length === 0) return out;
  const rows = await db.select({ id: folders.id, name: folders.name }).from(folders).where(inArray(folders.id, wanted));
  for (const row of rows) out.set(row.id, row.name);
  return out;
}

/** `folderPathJsonSql`（folders/sql.ts）根 → 葉；資料夾不在 → null。 */
export async function loadFolderPath(db: DbOrTx, folderId: string): Promise<string[] | null> {
  const result = await db.execute<{ path: string[] | null }>(sql`select ${folderPathJsonSql(sql`${folderId}::uuid`)} as path`);
  return result.rows[0]?.path ?? null;
}
