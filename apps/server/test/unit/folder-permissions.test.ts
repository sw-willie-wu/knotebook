import { describe, expect, it } from "vitest";
import type { FolderPermissionsDto } from "@knotebook/shared";
import { folderPermissions, type FolderRoleFlags } from "../../src/folders/permissions.js";

const ME = "0b6f3a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const OTHER = "ffffffff-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const G = "aaaaaaaa-1c4d-4e5f-8a9b-0c1d2e3f4a5b";

const flags = (f: Partial<FolderRoleFlags>): FolderRoleFlags => ({
  canRead: false,
  canCreate: false,
  canEdit: false,
  canDelete: false,
  ...f,
});

/** 角色展開表的五欄（看／建改搬／刪空／刪含筆記／建筆記），由 DTO 推出。 */
function columns(p: FolderPermissionsDto | null): [boolean, boolean, boolean, boolean, boolean] {
  if (p === null) return [false, false, false, false, false];
  return [true, p.manage, p.manage, p.manage && p.deleteNotes, p.createNote];
}

describe("PM-1 群組資料夾權限（角色展開表；sixRoleScene 的旗標＋create-only＋全 false）", () => {
  const rows: Array<[string, FolderRoleFlags | null, FolderPermissionsDto | null, [boolean, boolean, boolean, boolean, boolean]]> = [
    // 內建管理員七旗標全真；資料夾只看四旗。
    ["admin", flags({ canRead: true, canCreate: true, canEdit: true, canDelete: true }), { manage: true, deleteNotes: true, createNote: true }, [true, true, true, true, true]],
    ["member（讀建編）", flags({ canRead: true, canCreate: true, canEdit: true }), { manage: true, deleteNotes: false, createNote: true }, [true, true, true, false, true]],
    ["editDelete（無 can_create）", flags({ canRead: true, canEdit: true, canDelete: true }), { manage: true, deleteNotes: true, createNote: false }, [true, true, true, true, false]],
    ["deleteOnly", flags({ canRead: true, canDelete: true }), { manage: false, deleteNotes: true, createNote: false }, [true, false, false, false, false]],
    ["editOnly", flags({ canRead: true, canEdit: true }), { manage: true, deleteNotes: false, createNote: false }, [true, true, true, false, false]],
    ["readOnly", flags({ canRead: true }), { manage: false, deleteNotes: false, createNote: false }, [true, false, false, false, false]],
    ["create-only（讀＋建）", flags({ canRead: true, canCreate: true }), { manage: false, deleteNotes: false, createNote: false }, [true, false, false, false, false]],
    ["全 false", flags({}), null, [false, false, false, false, false]],
    ["非成員（flags null）", null, null, [false, false, false, false, false]],
    ["沒有 can_read（其他全真）", flags({ canCreate: true, canEdit: true, canDelete: true }), null, [false, false, false, false, false]],
  ];
  it.each(rows)("%s", (_label, f, dto, cols) => {
    const p = folderPermissions({ kind: "group", groupId: G }, ME, f);
    expect(p).toEqual(dto);
    expect(columns(p)).toEqual(cols);
  });
});

describe("PM-2 personal／shared：只看 owner，不看 flags", () => {
  const allTrue = flags({ canRead: true, canCreate: true, canEdit: true, canDelete: true });
  it("personal owner → 全真（flags 為 null／全 false 也一樣）", () => {
    const full = { manage: true, deleteNotes: true, createNote: true };
    expect(folderPermissions({ kind: "personal", ownerId: ME }, ME, null)).toEqual(full);
    expect(folderPermissions({ kind: "personal", ownerId: ME }, ME, flags({}))).toEqual(full);
  });
  it("personal 非 owner → null（flags 全真也一樣）", () => {
    expect(folderPermissions({ kind: "personal", ownerId: OTHER }, ME, allTrue)).toBeNull();
  });
  it("shared owner → 可管、可刪，不能建筆記", () => {
    expect(folderPermissions({ kind: "shared", ownerId: ME }, ME, null)).toEqual({ manage: true, deleteNotes: true, createNote: false });
  });
  it("shared 非 owner → null", () => {
    expect(folderPermissions({ kind: "shared", ownerId: OTHER }, ME, allTrue)).toBeNull();
  });
});
