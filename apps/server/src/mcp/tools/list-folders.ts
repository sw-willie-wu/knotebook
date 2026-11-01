/**
 * 資料夾 PR-3d（folders spec §5.12）`list_folders`：呼叫者看得到的資料夾（個人、`can_read` 群組、自己的 shared），keyset 分頁。
 * 可見性與 REST `GET /api/folders` 同一個述詞（`folders/queries.ts` 的 `visibleFolderWhere`），排序依 keyset（kind、空間、id），不是樹序。
 * 讀取類：不做 scope 檢查、不扣桶。`group_id` 看不到（非成員、`can_read = false`）與不存在同句 `group_not_found`＋FM2（Q1）。
 * 依 wire 預算截頁只是兜底：每項最壞約 2 563，50 項遠在預算內（plan 讀碼發現 19），所以 description 不宣稱「fewer when」。
 */
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FOLDER_KINDS, listVisibleFoldersPage, type FolderKind, type FolderPageKey } from "../../folders/queries.js";
import { loadCreateTarget } from "../../notes/create-target.js";
import { GROUP_ID } from "../../notes/schemas.js";
import { UUID_RE } from "../../notes/service.js";
import { folderForModel, folderForModelSchema } from "../folder-fields.js";
import { FOLDER_GROUP_NOT_FOUND_MESSAGE } from "../folder-messages.js";
import { BAD_CURSOR_MESSAGE, decodeKeysetCursor, encodeKeysetCursor } from "../keyset-cursor.js";
import { MCP_FOLDER_PAGE_MAX } from "../limits.js";
import { NEXT_CURSOR_DESCRIBE, PAGE_CUT_SHORT_DESCRIBE } from "../paging-strings.js";
import { toolError, toolResult } from "../tool-result.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../wire-budget.js";
import type { McpToolCtx } from "../context.js";

/** D-LF（逐字照 plan「待確認字串」）。 */
export const LIST_FOLDERS_DESCRIPTION =
  "List the folders you can see: your personal folders, the folders of your groups where your role can read notes, " +
  "and your folders for notes others shared with you, which only you can see. " +
  "Each folder has its `space` and its `path` — the folder names from the top level down, ending with its own; " +
  "a long path is cut from the top, with `pathTruncated`. Pass `group_id` to list one group's folders. " +
  "Folders come grouped by space, not in tree order; use `parentId` to see the tree. " +
  `Up to ${MCP_FOLDER_PAGE_MAX} per call: pass \`nextCursor\` back as \`cursor\` for the next page, until it is null. ` +
  "Paging reads live data, not a snapshot, so a folder created while you page may not appear. " +
  "Each note in list_notes and search_notes carries, as `folder`, the folder it is filed in for you.";

export const LF_GROUP_ID_DESCRIBE =
  "The id of one of your groups, to list only its folders. A group's id is the `id` in the `owner` of its notes in list_notes or search_notes, " +
  "or the `groupId` in a folder's `space`.";
export const LF_CURSOR_DESCRIBE = "Opaque cursor from a previous call's `nextCursor`. Omit it to start at the first page.";
export const LF_FOLDERS_DESCRIBE = "This page of folders, grouped by space.";

/** 註冊為 `z.object(listFoldersInput).strict()`。 */
export const listFoldersInput = {
  group_id: GROUP_ID.optional().describe(LF_GROUP_ID_DESCRIBE),
  cursor: z.string().min(1).max(200).optional().describe(LF_CURSOR_DESCRIBE),
};

export const listFoldersOutput = {
  folders: z.array(folderForModelSchema).describe(LF_FOLDERS_DESCRIBE),
  nextCursor: z.string().nullable().describe(NEXT_CURSOR_DESCRIBE),
  pageCutShort: z.literal(true).optional().describe(PAGE_CUT_SHORT_DESCRIBE),
};

export interface ListFoldersArgs {
  group_id?: string;
  cursor?: string;
}

/** 游標：base64url(`f|<kind>|<空間 id>|<資料夾 id>`)。 */
function encodeFolderCursor(key: FolderPageKey): string {
  return encodeKeysetCursor("f", [key.kind, key.spaceId, key.id]);
}

/** 不是本站發的（字元集、NUL、tag、段數）、kind 不在三種之內、兩個 id 段不是 UUID → null。 */
function decodeFolderCursor(raw: string): FolderPageKey | null {
  const parts = decodeKeysetCursor(raw, "f", 3);
  if (parts === null) return null;
  const [kind, spaceId, id] = parts as [string, string, string];
  if (!(FOLDER_KINDS as readonly string[]).includes(kind)) return null;
  if (!UUID_RE.test(spaceId) || !UUID_RE.test(id)) return null;
  return { kind: kind as FolderKind, spaceId: spaceId.toLowerCase(), id: id.toLowerCase() };
}

/** 預算的固定部分：空頁＋長度最長的佔位游標（kind 取最長的 personal）＋`pageCutShort` 的保留。 */
const FOLDER_CURSOR_PLACEHOLDER = encodeFolderCursor({
  kind: "personal",
  spaceId: "00000000-0000-0000-0000-000000000000",
  id: "00000000-0000-0000-0000-000000000000",
});
export const FOLDER_BASE_COST = wireCost({ folders: [], nextCursor: FOLDER_CURSOR_PLACEHOLDER }) + PAGE_CUT_RESERVE;

export async function listFolders(args: ListFoldersArgs, ctx: McpToolCtx): Promise<CallToolResult> {
  let after: FolderPageKey | null = null;
  if (args.cursor !== undefined) {
    after = decodeFolderCursor(args.cursor);
    if (after === null) return toolError("invalid_body", BAD_CURSOR_MESSAGE);
  }
  let groupId: string | undefined;
  if (args.group_id !== undefined) {
    groupId = args.group_id.toLowerCase(); // GROUP_ID 不轉小寫（plan 讀碼發現 33）
    const target = await loadCreateTarget(ctx.db, ctx.userId, groupId);
    if (target === undefined || !target.canRead) return toolError("group_not_found", FOLDER_GROUP_NOT_FOUND_MESSAGE);
  }
  const page = await listVisibleFoldersPage(ctx.db, ctx.userId, {
    limit: MCP_FOLDER_PAGE_MAX,
    after,
    ...(groupId === undefined ? {} : { groupId }),
  });
  const items = page.rows.map(folderForModel);
  // 預算兜底（實務上不可達，見檔頭）：截了就從被收的最後一項接著翻。
  const kept = countWithinWireBudget(items.map(wireCost), FOLDER_BASE_COST);
  const cut = kept < items.length;
  const lastKey = cut ? page.rows[kept - 1]!.key : page.hasMore ? page.rows[page.rows.length - 1]!.key : undefined;
  return toolResult({
    folders: cut ? items.slice(0, kept) : items,
    nextCursor: lastKey === undefined ? null : encodeFolderCursor(lastKey),
    ...(cut ? { pageCutShort: true as const } : {}),
  });
}
