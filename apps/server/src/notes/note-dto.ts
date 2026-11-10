/**
 * 單篇筆記的 `NoteDto` 組裝（#181：自 `routes/notes.ts` 原樣搬出——垃圾桶還原要回 `NoteDto`，`trash/` 不能 import 路由檔）。
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { NoteDto } from "@knotebook/shared";
import type { DbOrTx } from "../db/tx.js";
import { groups, notePlacements, noteStates, notes, uploads, users } from "../db/schema.js";
import { editor, lastEditedSelection } from "./list-query.js";
import type { NoteAccess } from "./service.js";

// 只列出 toNoteDto 實際會用到的欄位（而非完整 `typeof notes.$inferSelect`）：GET
// list 那支改走 UNION ALL 後，兩個分支各自的 select shape 只挑這幾欄 + role，不含
// linksClock/deletedAt——用這個窄介面讓「完整 note row」與「union 出來的窄 row」都能
// 結構相容地傳進來，不必為了餵同一個函式而多 select 用不到的欄位。
// `ownerHandle` 不在 notes 表上（#122）——各回填點自行帶入：JOIN users（list/:ref/
// by-path）、`request.user.handle`（POST——建立者即 owner，spec A12）、returning 後
// 補一次 SELECT users（PATCH——editor 改他人筆記時必須回 **owner 的** handle）。
// #106 D6 的三欄同樣不在 `notes` 表的 owner JOIN 上：`editorHandle` 來自**另一個** users
// 別名（`editor`，LEFT JOIN `last_edited_by`），與 `ownerHandle` 是不同的兩個人。各回填點
// 見下：list 兩支 union、`noteFieldsSelection`（:ref／by-path）、POST 帶 content 重讀、
// PATCH returning 後補查。
export interface NoteFields {
  id: string;
  title: string;
  ownerId: string | null;
  slug: string;
  slugIsCustom: boolean;
  prevSlug: string | null;
  ownerHandle: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastEditedAt: Date | null;
  lastEditedAgentLabel: string | null;
  editorHandle: string | null;
  /** #175：所屬群組兩欄——清單＝分支輸出欄（owned／shared 恆 null）；單篇＝LEFT JOIN groups；PATCH＝`groupNameOf` 補查。 */
  groupId: string | null;
  groupName: string | null;
  /**
   * 呼叫者視角的位置（AG-F1）：owner／群組成員＝`notes.folder_id`；被分享者＝自己的放置。刻意不叫 `folderId`：spread 一整列
   * `notes`（PATCH 的 returning）補不上它，tsc 逼出每個呼叫點——否則擁有者的資料夾會原樣送給被分享者。
   */
  viewerFolderId: string | null;
  /** 只有清單帶（`noteSizeBytesSql`）。 */
  sizeBytes?: number;
}

/**
 * #175 §6.1：`access` 由呼叫端傳入——清單＝`accessFromListRow(row)`；單篇＝`resolveNoteAccess`（Q22 一致之後）；
 * 建立＝建立路徑自己算（§6.2，不得寫死 `"owner"`——gate r1 I3）。改吃 `NoteAccess` 讓 tsc 逼出每個呼叫點，
 * **但只保證「會改」、不保證「改對」**——正確值由各路徑的測試釘。`group` 對看得到這篇的人都有值（B7：看得到
 * 群組筆記的只有成員）。
 */
export function toNoteDto(note: NoteFields, access: Pick<NoteAccess, "role" | "permissions">): NoteDto {
  return {
    id: note.id,
    title: note.title,
    ownerId: note.ownerId,
    role: access.role,
    slug: note.slug,
    slugIsCustom: note.slugIsCustom,
    prevSlug: note.prevSlug,
    ownerHandle: note.ownerHandle,
    groupId: note.groupId,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
    // 四欄同進同出：`last_edited_at` 是 null 就整個 lastEdited 為 null。編輯者帳號被刪
    // （FK `set null`）時 handle 落空 → 空字串（與 `read.ts` 的 `loadLastEdited` 同一形）。
    lastEdited: note.lastEditedAt
      ? { at: note.lastEditedAt.toISOString(), byHandle: note.editorHandle ?? "", agentLabel: note.lastEditedAgentLabel }
      : null,
    group: note.groupId !== null && note.groupName !== null ? { id: note.groupId, name: note.groupName } : null,
    permissions: access.permissions,
    folderId: note.viewerFolderId,
    ...(note.sizeBytes !== undefined ? { sizeBytes: note.sizeBytes } : {}),
  };
}

/** 呼叫者視角的資料夾欄（單篇取列用；要接 `placementJoinOn(viewerId)`）。外層欄位在 JOIN 形的 select 裡帶表名。 */
function viewerFolderIdSql(viewerId: string) {
  return sql<string | null>`case when ${notes.groupId} is not null or ${notes.ownerId} = ${viewerId} then ${notes.folderId} else ${notePlacements.folderId} end`;
}

/** 取列時接在 from(notes) 後：`LEFT JOIN note_placements ON note_id = notes.id AND user_id = $viewer`。 */
export function placementJoinOn(viewerId: string): SQL {
  return and(eq(notePlacements.noteId, notes.id), eq(notePlacements.userId, viewerId))!;
}

/**
 * 已有一整列時（PATCH 的 returning）的同一條規則：群組筆記或 owner 是 viewer → `note.folderId`；否則查呼叫者的放置。
 * ⚠ 對 `db` 發查詢——路由只在交易外呼叫（S14）。
 */
export async function viewerFolderIdFor(
  db: DbOrTx,
  note: { id: string; ownerId: string | null; groupId: string | null; folderId: string | null },
  viewerId: string,
): Promise<string | null> {
  if (note.groupId !== null || note.ownerId === viewerId) return note.folderId;
  const [row] = await db
    .select({ folderId: notePlacements.folderId })
    .from(notePlacements)
    .where(and(eq(notePlacements.noteId, note.id), eq(notePlacements.userId, viewerId)))
    .limit(1);
  return row?.folderId ?? null;
}

/**
 * 清單的 `sizeBytes`（spec D11 A）：Yjs 狀態位元組＋附件總和。兩個相關子查詢的外層欄寫成帶表名的字面——直接插 `${notes.id}`
 * 在單表 select 會渲染成裸 `"id"`，`uploads u` 子查詢裡的裸 `"id"` 解析成 `u.id`、靜默算錯；
 * 今天的三支都是 JOIN 形（會帶表名），字面讓它不依賴這件事。每次呼叫現造。
 */
export function noteSizeBytesSql(): SQL.Aliased<number> {
  const outerId = sql.raw('"notes"."id"');
  return sql<number>`(coalesce((select octet_length(s.ydoc) from ${noteStates} s where s.note_id = ${outerId}), 0) + coalesce((select sum(u.size) from ${uploads} u where u.note_id = ${outerId}), 0))`
    .mapWith(Number)
    .as("size_bytes");
}

/**
 * GET :ref 與 by-path 共用的「完整列＋ownerHandle」select shape（A5 同形的結構保證）。每次現造（帶呼叫者 id）；FROM 必須
 * `leftJoin(notePlacements, placementJoinOn(viewerId))`。
 */
export function noteFieldsSelection(viewerId: string) {
  return {
    id: notes.id,
    title: notes.title,
    ownerId: notes.ownerId,
    slug: notes.slug,
    slugIsCustom: notes.slugIsCustom,
    prevSlug: notes.prevSlug,
    ownerHandle: users.handle,
    createdAt: notes.createdAt,
    updatedAt: notes.updatedAt,
    ...lastEditedSelection,
    // #175：所屬群組兩欄——三個取列點（`loadNoteFields`、by-path 兩查）都 LEFT JOIN groups。
    groupId: notes.groupId,
    groupName: groups.name,
    viewerFolderId: viewerFolderIdSql(viewerId),
  };
}

/**
 * 授權後的完整列讀取：JOIN users 帶 ownerHandle。不帶 `deleted_at` 條件——呼叫端都在閘口之後。I2（審查）：授權判定完到
 * 這裡的 re-select 之間存在競態視窗——若同時有另一個請求把這篇 note 刪了，這裡會查不到列。呼叫端對 undefined 明確回
 * 404，不拿 non-null assertion 賭「授權說有就一定還在」。
 * #175：LEFT JOIN——群組筆記沒有 owner（INNER 會讓群組筆記重讀落空，帶 content 建立的回應就退回 insert 那一列）。
 * 資料夾：`viewerId` 決定 `viewerFolderId` 取哪一欄（AG-F1）。
 */
export async function loadNoteFields(db: DbOrTx, noteId: string, viewerId: string): Promise<NoteFields | undefined> {
  const [row] = await db
    .select(noteFieldsSelection(viewerId))
    .from(notes)
    .leftJoin(users, eq(users.id, notes.ownerId))
    .leftJoin(editor, eq(editor.id, notes.lastEditedBy))
    .leftJoin(groups, eq(groups.id, notes.groupId))
    .leftJoin(notePlacements, placementJoinOn(viewerId))
    .where(eq(notes.id, noteId))
    .limit(1);
  return row;
}
