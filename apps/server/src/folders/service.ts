/**
 * 資料夾的服務層（spec docs/superpowers/specs/2026-10-22-folders-design.md §5.5、§5.7、§5.11）：REST 與 PR-3d 的 MCP 共用的唯一入口。
 * 每支的形一律是「名稱 → 交易外快速判（§5.5 I2 入口順序）→ 扣 `edit` 桶 → 縫 → 交易（`folders/tx/*`，S14：callback 整段一個
 * `xInTx`）→ catch 映射」。失敗一律回 HTTP 對應的錯誤形（REST 直接送；MCP 之後以 code 映射）。HTTP 層訊息中文（附錄 C）。
 * 含 `.transaction(` ⇒ 在 S14 的 `ROUTE_FILES`（④ 計數）。
 */
import { and, asc, isNull, sql } from "drizzle-orm";
import type { ErrorCode, FolderDeleteResultDto, FolderDto, FolderSpaceDto, NoteDto } from "@knotebook/shared";
import type { CollabHooks, NoteDeleteGate } from "../collab/hooks.js";
import type { Db } from "../db/index.js";
import { notes } from "../db/schema.js";
import { foreignKeyViolationConstraint, isFolderSpaceViolation, isRetryableTxError, uniqueViolationConstraint } from "../db/pg-errors.js";
import { GROUP_NOT_FOUND_MESSAGE } from "../groups/queries.js";
import type { GroupHookCtx, GroupTestHook } from "../groups/test-hook.js";
import type { FixedWindowLimiter } from "../http/rate-limit.js";
import { TxAbort } from "../http/tx-abort.js";
import { loadCreateTarget } from "../notes/create-target.js";
import { loadNoteFields, toNoteDto } from "../notes/note-dto.js";
import { resolveNoteAccess, UUID_RE } from "../notes/service.js";
import {
  FOLDER_CROSS_SPACE_MESSAGE,
  FOLDER_DELETE_BLOCKED_MESSAGE,
  FOLDER_FORBIDDEN_MESSAGE,
  FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE,
  FOLDER_NOT_EMPTY_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  NOTE_NOT_FOUND_MESSAGE,
  NOTE_PLACE_FORBIDDEN_MESSAGE,
} from "./messages.js";
import { normalizeFolderName, type FolderNameResult } from "./names.js";
import { folderPermissions } from "./permissions.js";
import { listVisibleFolders, resolveFolderAccess, toFolderDto } from "./queries.js";
import { sameFolderSpace, type FolderSpace } from "./space.js";
import { subtreeFolderIdsSql } from "./sql.js";
import { createFolderInTx, type CreateFolderInput } from "./tx/create-folder.js";
import { deleteFolderInTx, type DeleteFolderInput } from "./tx/delete-folder.js";
import { placeNoteInTx, placeTargetSpace, type PlaceMode, type PlaceNoteInput } from "./tx/place-note.js";
import { updateFolderInTx, type UpdateFolderInput } from "./tx/update-folder.js";

const NAME_MESSAGES: Record<Extract<FolderNameResult, { ok: false }>["reason"], string> = {
  unstorable: "資料夾名稱含有無法儲存的字元",
  control: "名稱不能包含換行或控制字元",
  length: "資料夾名稱須為 1 到 80 個字",
};
const FOLDER_NAME_TAKEN_MESSAGE = "這裡已經有同名資料夾";
const TOO_MANY_REQUESTS_MESSAGE = "寫入過於頻繁";
const SERVER_BUSY_MESSAGE = "伺服器忙碌，請稍後再試";

export interface FolderServiceDeps {
  db: Db;
  collabHooks: CollabHooks;
  storageLockTimeoutMs: number;
  groupTestHook?: GroupTestHook;
  limiters: { edit: FixedWindowLimiter };
}

/** 一律回 HTTP 對應的錯誤形（REST 直接送，PR-3d 的 MCP 以 code 映射）。 */
export interface FolderFailure { kind: "error"; status: 400 | 403 | 404 | 409 | 429; code: ErrorCode; message: string }

const fail = (status: FolderFailure["status"], code: ErrorCode, message: string): FolderFailure => ({ kind: "error", status, code, message });

export async function listFolders(db: Db, userId: string): Promise<FolderDto[]> {
  return listVisibleFolders(db, userId);
}

/**
 * 建立（§5.7.1）。id（`parent.folderId`、`space.groupId`）由呼叫端轉小寫；這裡只驗 UUID 形。
 * 順序（§5.5 I2）：名稱 → 位置的可見性（404）→ 管理權（403）→ 扣 `edit` 桶 → `folder-authorized` 縫 → 交易（重判全部）。
 */
export async function createFolder(
  deps: FolderServiceDeps,
  input: { by: string; name: string; parent: { folderId: string } | { space: FolderSpaceDto } },
): Promise<{ kind: "ok"; folder: FolderDto } | FolderFailure> {
  const name = normalizeFolderName(input.name);
  if (!name.ok) return fail(400, "invalid_body", NAME_MESSAGES[name.reason]);

  let target: CreateFolderInput["target"];
  let hookCtx: GroupHookCtx;
  if ("folderId" in input.parent) {
    const folderId = input.parent.folderId;
    const access = await resolveFolderAccess(deps.db, input.by, folderId);
    if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
    target = { kind: "parent", folderId, space: access.space };
    hookCtx = { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) };
  } else {
    const requested = input.parent.space;
    let space: FolderSpace;
    if (requested.kind === "group") {
      // 非 UUID／不存在／非成員／角色無閱讀 → 同一個 404（S4 同形，m1）。
      if (!UUID_RE.test(requested.groupId)) return fail(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
      space = { kind: "group", groupId: requested.groupId };
      const m = await loadCreateTarget(deps.db, input.by, requested.groupId);
      // 與交易內同一個推導（folderPermissions）：null＝看不到、!manage＝角色不能編輯。
      const perms = m === undefined ? null : folderPermissions(space, input.by, m);
      if (perms === null) return fail(404, "group_not_found", GROUP_NOT_FOUND_MESSAGE);
      if (!perms.manage) return fail(403, "forbidden", FOLDER_GROUP_ROOT_FORBIDDEN_MESSAGE);
    } else {
      space = { kind: requested.kind, ownerId: input.by };
    }
    target = { kind: "root", space };
    hookCtx = space.kind === "group" ? { groupId: space.groupId } : {};
  }

  if (!deps.limiters.edit.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  await deps.groupTestHook?.("folder-authorized", hookCtx);

  const txInput: CreateFolderInput = { by: input.by, name: name.name, lockTimeoutMs: deps.storageLockTimeoutMs, target };
  let out: Awaited<ReturnType<typeof createFolderInTx>>;
  try {
    out = await deps.db.transaction(tx => createFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (uniqueViolationConstraint(err) === "folders_sibling_name_idx") return fail(409, "folder_name_taken", FOLDER_NAME_TAKEN_MESSAGE);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    // 防禦縱深：父子空間 trigger（KF002）只在預讀之後空間被改時才可能觸發，與看不到同形。
    if (isFolderSpaceViolation(err)) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    throw err;
  }
  return { kind: "ok", folder: toFolderDto(out.row, out.permissions) };
}

/**
 * 改名／搬移（§5.7.2、§5.7.3；只限同空間）。`folderId` 由 app 層 `lowercaseUuidParams`、`parentId` 由路由轉小寫；這裡只驗 UUID 形。
 * 順序（§5.7.3、§5.5 I2）：名稱 → 自己的可見性（404）→ 新父層的可見性（非 UUID 或看不到 → 404）→ 同空間（400）→ 管理權（403）
 * → 扣 `edit` 桶 → `folder-authorized` 縫 → 交易（重判全部，再成環、深度、撞名）。
 */
export async function updateFolder(
  deps: FolderServiceDeps,
  input: { by: string; folderId: string; name?: string; parentId?: string | null },
): Promise<{ kind: "ok"; folder: FolderDto } | FolderFailure> {
  let name: string | undefined;
  if (input.name !== undefined) {
    const normalized = normalizeFolderName(input.name);
    if (!normalized.ok) return fail(400, "invalid_body", NAME_MESSAGES[normalized.reason]);
    name = normalized.name;
  }

  const access = await resolveFolderAccess(deps.db, input.by, input.folderId);
  if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);

  let parentId: string | null | undefined = input.parentId;
  if (input.parentId !== undefined && input.parentId !== null) {
    const parent = await resolveFolderAccess(deps.db, input.by, input.parentId);
    if (parent === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!sameFolderSpace(parent.space, access.space)) return fail(400, "folder_cross_space", FOLDER_CROSS_SPACE_MESSAGE);
    parentId = parent.folder.id;
  }
  if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);

  if (!deps.limiters.edit.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  const folderId = access.folder.id;
  await deps.groupTestHook?.("folder-authorized", { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) });

  const txInput: UpdateFolderInput = {
    by: input.by,
    folderId,
    space: access.space,
    ...(name !== undefined ? { name } : {}),
    ...(parentId !== undefined ? { parentId } : {}),
    lockTimeoutMs: deps.storageLockTimeoutMs,
  };
  let out: Awaited<ReturnType<typeof updateFolderInTx>>;
  try {
    out = await deps.db.transaction(tx => updateFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (uniqueViolationConstraint(err) === "folders_sibling_name_idx") return fail(409, "folder_name_taken", FOLDER_NAME_TAKEN_MESSAGE);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    // 防禦縱深：同空間已在交易內判過；KF002 只在預讀之後空間被改時才可能觸發，與看不到同形。
    if (isFolderSpaceViolation(err)) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    throw err;
  }
  return { kind: "ok", folder: toFolderDto(out.row, out.permissions) };
}

/**
 * 刪資料夾（§5.7.4）。`folderId` 由 app 層 `lowercaseUuidParams` 轉小寫；這裡只驗 UUID 形。
 * 順序：可見性（404）→ 管理權（403）→（個人／群組）預讀子樹活筆記（述詞，M15），非空且無刪除權 → 403 `folder_delete_blocked`
 * → 扣 `edit` 桶 → `folder-authorized` 縫 → 對預讀到的每篇開共編閘門 → `folder-delete-gated` 縫 → 交易 →
 * **不論成功或失敗**全部 `release()`（M1：預讀後才搬出子樹的不收門會擋新連線到 TTL；`releaseDeletingGate` 只收活筆記）。
 * 共享私人：筆記不動（放置 CASCADE），不預讀、不開閘門（F7）。
 * `onlyIfEmpty`（§5.7.4「只刪空資料夾」）：預讀到活筆記 → 409 `folder_not_empty`（排在 `folder_delete_blocked` 之前，不扣桶、
 * 不開閘門）；過了這裡預讀必為空，所以一律不開閘門。子資料夾與放置只由交易內判（權威）。
 */
export async function deleteFolder(
  deps: FolderServiceDeps,
  input: { by: string; folderId: string; onlyIfEmpty?: boolean },
): Promise<{ kind: "ok"; result: FolderDeleteResultDto } | FolderFailure> {
  const access = await resolveFolderAccess(deps.db, input.by, input.folderId);
  if (access === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
  if (!access.permissions.manage) return fail(403, "forbidden", FOLDER_FORBIDDEN_MESSAGE);
  const folderId = access.folder.id;
  const onlyIfEmpty = input.onlyIfEmpty === true;

  let liveIds: string[] = [];
  if (access.space.kind !== "shared") {
    const rows = await deps.db
      .select({ id: notes.id })
      .from(notes)
      .where(and(sql`${notes.folderId} in (${subtreeFolderIdsSql(folderId)})`, isNull(notes.deletedAt)))
      .orderBy(asc(notes.id));
    liveIds = rows.map(r => r.id);
    if (onlyIfEmpty && liveIds.length > 0) return fail(409, "folder_not_empty", FOLDER_NOT_EMPTY_MESSAGE);
    if (liveIds.length > 0 && !access.permissions.deleteNotes) return fail(403, "folder_delete_blocked", FOLDER_DELETE_BLOCKED_MESSAGE);
  }

  if (!deps.limiters.edit.consume(input.by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  const hookCtx: GroupHookCtx = { folderId, ...(access.space.kind === "group" ? { groupId: access.space.groupId } : {}) };
  await deps.groupTestHook?.("folder-authorized", hookCtx);

  // allSettled（比照 `routes/groups.ts` 全刪）：閘門的契約是不 throw；萬一有一個 reject，其他已開的也要 release 再拋。
  const settled = await Promise.allSettled(liveIds.map(id => deps.collabHooks.beforeNoteDeleted(id)));
  const gates: NoteDeleteGate[] = settled.flatMap(s => (s.status === "fulfilled" ? [s.value] : []));
  const releaseAll = (): void => {
    for (const g of gates) g.release();
  };
  const rejected = settled.find((s): s is PromiseRejectedResult => s.status === "rejected");
  if (rejected) {
    releaseAll();
    throw rejected.reason;
  }

  const txInput: DeleteFolderInput = {
    by: input.by, folderId, space: access.space, gatedNoteIds: liveIds, lockTimeoutMs: deps.storageLockTimeoutMs, onlyIfEmpty,
  };
  let result: FolderDeleteResultDto;
  try {
    // 縫在 try 內：縫丟錯（測試）也走 finally 的 releaseAll。
    await deps.groupTestHook?.("folder-delete-gated", hookCtx);
    result = await deps.db.transaction(tx => deleteFolderInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    throw err;
  } finally {
    releaseAll();
  }
  return { kind: "ok", result };
}

/**
 * 把筆記放進／移出資料夾（§5.7.5）。`noteId` 由 app 層 `lowercaseUuidParams`、`folderId` 由路由轉小寫；這裡只驗 UUID 形。
 * 順序（§5.5：筆記授權排在資料夾之前）：筆記授權（404／群組筆記無編輯權 403）→ 模式 → 資料夾可見性（404）→ 空間（400）
 * → 扣 `edit` 桶 → `note-folder-authorized` 縫 → 交易（重判全部）→ 回呼叫者視角的 `NoteDto`。
 */
export async function placeNote(
  deps: FolderServiceDeps,
  input: { by: string; noteId: string; folderId: string | null },
): Promise<{ kind: "ok"; note: NoteDto } | FolderFailure> {
  const { by } = input;
  const noteAccess = await resolveNoteAccess(deps.db, by, input.noteId);
  if (noteAccess.role === "none") return fail(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  let mode: PlaceMode;
  if (noteAccess.role === "owner") mode = { kind: "owned" };
  else if (noteAccess.groupId !== null) {
    if (!noteAccess.permissions.edit) return fail(403, "forbidden", NOTE_PLACE_FORBIDDEN_MESSAGE);
    mode = { kind: "group", groupId: noteAccess.groupId };
  } else mode = { kind: "shared" };
  const noteId = input.noteId.toLowerCase();

  let folderId: string | null = null;
  if (input.folderId !== null) {
    const folder = await resolveFolderAccess(deps.db, by, input.folderId);
    if (folder === null) return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    if (!sameFolderSpace(folder.space, placeTargetSpace(mode, by))) return fail(400, "folder_cross_space", NOTE_FOLDER_CROSS_SPACE_MESSAGE);
    folderId = folder.folder.id;
  }

  if (!deps.limiters.edit.consume(by)) return fail(429, "too_many_requests", TOO_MANY_REQUESTS_MESSAGE);
  await deps.groupTestHook?.("note-folder-authorized", { noteId, ...(folderId !== null ? { folderId } : {}) });

  const txInput: PlaceNoteInput = { by, noteId, folderId, mode };
  try {
    await deps.db.transaction(tx => placeNoteInTx(tx, txInput, deps.groupTestHook));
  } catch (err) {
    if (err instanceof TxAbort) return fail(err.status as FolderFailure["status"], err.errCode, err.message);
    // r3 m-7：交易內重判之後、upsert 之前被撤分享（撤分享不鎖 notes）→ 與看不到這篇同形。
    const fk = foreignKeyViolationConstraint(err);
    if (fk === "note_placements_share_fk") return fail(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
    // 防禦縱深：資料夾已在交易內 KS 鎖住並判過空間；FK／trigger（KF001／KF003）只在那之外的漂移才觸發，與看不到同形。
    if (fk === "notes_folder_fk" || fk === "note_placements_folder_id_folders_id_fk" || isFolderSpaceViolation(err)) {
      return fail(404, "folder_not_found", FOLDER_NOT_FOUND_MESSAGE);
    }
    if (isRetryableTxError(err)) return fail(409, "server_busy", SERVER_BUSY_MESSAGE);
    throw err;
  }

  // 極窄競態：commit 之後、重讀之前被移走或降權 → 與看不到同形。
  const fields = await loadNoteFields(deps.db, noteId, by);
  const access = await resolveNoteAccess(deps.db, by, noteId);
  if (fields === undefined || access.role === "none") return fail(404, "not_found", NOTE_NOT_FOUND_MESSAGE);
  return { kind: "ok", note: toNoteDto(fields, access) };
}
