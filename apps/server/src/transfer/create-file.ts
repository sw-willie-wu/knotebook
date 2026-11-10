/**
 * bulk transfer：沒有 `id` 的檔＝新增筆記。這裡是兩支純判斷：去重鍵 `fileShaOf`、落點
 * `resolveCreateDest`。佇列、扣桶、建列與 `transfer_creates` 的 upsert 在 `NoteWriteService.createFromFile`。
 *
 * 落點（照順序）：`shared` 範圍 → 403（只含分享給你的筆記的權杖不能建）；給了 `folder_id` → 看不到 → 404 `folder_not_found`、
 * 在分享給你的空間 → 403（不能放新筆記）、群組資料夾 → 要 `canCreate` 且 `canEdit`；沒給 → 範圍最上層（folder → 該資料夾；
 * group → 群組最上層〔要 `canCreate`〕；all／personal → 我的筆記最上層）。目的地不在範圍（folder 範圍要在子樹、group 範圍要在該
 * 群組、personal 範圍要在個人空間）→ 403。判「在不在子樹」用路由已取的 `visibleTree` 經 `consistentTree`、沿 `parentId` 往上走，
 * 不另寫可見性 SQL。
 */
import type { BulkRange } from "../auth/transfer-token.js";
import type { Db } from "../db/index.js";
import { FOLDER_NOT_FOUND_MESSAGE, NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE } from "../folders/messages.js";
import { resolveFolderAccess } from "../folders/queries.js";
import { loadCreateTarget } from "../notes/create-target.js";
import type { SlugScope } from "../notes/slug.js";
import { hmacOf } from "./base-hash.js";
import type { LayoutFolder, LayoutGroup } from "./paths.js";
import { consistentTree } from "./range.js";

export const CREATE_IN_SHARED_FORBIDDEN_MESSAGE = "A transfer token for only notes shared with you can't create notes.";
export const DEST_NOT_IN_RANGE_MESSAGE = "The new note's location isn't in this transfer token's range.";
export const SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE = "New notes can't go in your folders for notes shared with you.";
/** 同 REST `POST /api/notes` 的群組新建判準句。 */
export const GROUP_CREATE_FORBIDDEN_MESSAGE = "Your role in this group can't create notes.";

/** `HMAC-SHA256(K, user_id ‖ 正規化後整個檔)`。正規化＝`normalizeBody(整個檔)`（呼叫端做）。 */
export function fileShaOf(key: Buffer, userId: string, normalizedFile: string): Buffer {
  return hmacOf(key, Buffer.from(userId, "utf8"), normalizedFile);
}

export type CreateDest =
  | { ok: true; scope: SlugScope; folderId: string | null }
  | { ok: false; status: 403 | 404; code: "forbidden" | "folder_not_found"; message: string };

const forbidden = (message: string): CreateDest => ({ ok: false, status: 403, code: "forbidden", message });

/** `folderId`（已小寫）在不在 `rootId` 的子樹裡（含自己）；以一致化之後的可見樹沿 `parentId` 往上走。 */
function inSubtree(folders: LayoutFolder[], folderId: string, rootId: string): boolean {
  const byId = new Map(folders.map(f => [f.id, f]));
  const seen = new Set<string>();
  for (let cur: string | null = folderId; cur !== null && !seen.has(cur); cur = byId.get(cur)?.parentId ?? null) {
    if (cur === rootId) return true;
    seen.add(cur);
  }
  return false;
}

export async function resolveCreateDest(
  db: Db,
  userId: string,
  range: BulkRange,
  folderId: string | undefined,
  tree: { folders: LayoutFolder[]; groups: LayoutGroup[] },
): Promise<CreateDest> {
  if (range.kind === "shared") return forbidden(CREATE_IN_SHARED_FORBIDDEN_MESSAGE);
  const t = consistentTree(tree);
  const target = folderId ?? (range.kind === "folder" ? range.folderId : undefined);
  if (target !== undefined) {
    const access = await resolveFolderAccess(db, userId, target);
    if (access === null) return { ok: false, status: 404, code: "folder_not_found", message: FOLDER_NOT_FOUND_MESSAGE };
    const fid = access.folder.id;
    if (access.space.kind === "shared") return forbidden(SHARED_FOLDER_CREATE_FORBIDDEN_MESSAGE);
    let scope: SlugScope;
    if (access.space.kind === "group") {
      const m = await loadCreateTarget(db, userId, access.space.groupId);
      if (!m || !m.canCreate) return forbidden(GROUP_CREATE_FORBIDDEN_MESSAGE);
      if (!m.canEdit) return forbidden(NOTE_FOLDER_ROLE_FORBIDDEN_MESSAGE);
      scope = { groupId: access.space.groupId };
    } else {
      scope = { ownerId: userId };
    }
    const inRange =
      range.kind === "all" ||
      (range.kind === "personal" && access.space.kind === "personal") ||
      (range.kind === "group" && access.space.kind === "group" && access.space.groupId === range.groupId) ||
      (range.kind === "folder" && t.folders.some(f => f.id === fid) && inSubtree(t.folders, fid, range.folderId));
    if (!inRange) return forbidden(DEST_NOT_IN_RANGE_MESSAGE);
    return { ok: true, scope, folderId: fid };
  }
  if (range.kind === "group") {
    const m = await loadCreateTarget(db, userId, range.groupId);
    if (!m || !m.canCreate) return forbidden(GROUP_CREATE_FORBIDDEN_MESSAGE);
    return { ok: true, scope: { groupId: range.groupId }, folderId: null };
  }
  return { ok: true, scope: { ownerId: userId }, folderId: null };
}
