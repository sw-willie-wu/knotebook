/**
 * 儲存配額的「空間」（spec 2026-10-08 §5.2）：個人空間＝某使用者的個人筆記全體，群組空間＝某群組的筆記全體。
 * 純資料與「只組不執行」的 SQL 片段——沒有 DB 存取，`tx/` 與非 tx 模組都可 import。
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { notes, uploads } from "../db/schema.js";

export type StorageSpace = { kind: "user"; id: string } | { kind: "group"; id: string };

export const STORAGE_QUOTA_EXCEEDED_MESSAGE = "儲存空間已滿";

/** 筆記的空間：`notes_owner_xor_group_chk` 保證恰一個非 NULL。 */
export function spaceOfNote(n: { ownerId: string | null; groupId: string | null }): StorageSpace {
  if (n.groupId !== null) return { kind: "group", id: n.groupId };
  if (n.ownerId !== null) return { kind: "user", id: n.ownerId };
  throw new Error("spaceOfNote: owner_id 與 group_id 皆為 NULL（違反 notes_owner_xor_group_chk）");
}

/**
 * advisory 鎖鍵的字串（spec §5.2；SQL 端 `hashtextextended(<本字串>, 0)`）。id 一律小寫（Review Focus RF1：同一個 UUID 的大小寫
 * 變體必須是同一把鎖）。碰撞只會多序列化、不影響正確性。
 */
export function spaceLockKey(space: StorageSpace): string {
  return `knotebook.storage:${space.kind}:${space.id.toLowerCase()}`;
}

/**
 * `coalesce(sum(uploads.size), 0)::bigint`，以 `mapWith(Number)` 轉回 number（node-postgres 的 int8 是字串——spec §4.3 m8）。
 * **每次呼叫現造**（drizzle 的 SQL 片段不得跨查詢重用——[[g:drizzle-query-builder-gotchas]]）。
 */
export function sumUploadSizeSql(): SQL<number> {
  return sql<number>`coalesce(sum(${uploads.size}), 0)::bigint`.mapWith(Number);
}

/** 「屬於這個空間的筆記」述詞（JOIN notes 後用）：個人走 `notes_owner_idx`，群組走 `notes_group_slug_idx`（S9 以 EXPLAIN 驗）。 */
export function spaceNotesWhere(space: StorageSpace): SQL {
  return space.kind === "user" ? eq(notes.ownerId, space.id) : eq(notes.groupId, space.id);
}
