import { describe, expect, it } from "vitest";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import { adminRole, customRole, groupDto, memberRole, OWNER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { indexFolders } from "@/components/sidebar/folder-index";
import { createTargetFor } from "./note-create-target";

function note(over: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Plan",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "plan",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "alice",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

function groupNote(groupId: string, over: Partial<NoteDto> = {}): NoteDto {
  return note({ ownerId: null, ownerHandle: null, role: "editor", groupId, group: { id: groupId, name: "Team" }, ...over });
}

function ctx(groups: GroupDto[], folders: FolderDto[]) {
  return { groups, folders: indexFolders(folders) };
}

describe("createTargetFor", () => {
  const team = groupDto({ id: "g1", name: "Team" }, memberRole());
  const viewerGroup = groupDto({ id: "g2", name: "Readers" }, customRole());
  const createOnly = groupDto({ id: "g3", name: "Drop box" }, customRole({ permissions: { ...customRole().permissions, create: true } }));

  it("個人、根層：空目標（建在個人根層）", () => {
    expect(createTargetFor(note(), ctx([], []))).toEqual({});
  });

  it("個人、在資料夾：帶 folderId", () => {
    const folders = [folderDto({ id: "f1", name: "Projects" })];
    expect(createTargetFor(note({ folderId: "f1" }), ctx([], folders))).toEqual({ folderId: "f1" });
  });

  it("個人、資料夾不在索引（剛被刪、清單還沒重抓）：不顯示，不退回根層", () => {
    expect(createTargetFor(note({ folderId: "gone" }), ctx([], []))).toBeNull();
  });

  it("個人、資料夾的 createNote 為 false：不顯示", () => {
    const folders = [folderDto({ id: "f1", name: "Projects", permissions: { manage: true, deleteNotes: true, createNote: false } })];
    expect(createTargetFor(note({ folderId: "f1" }), ctx([], folders))).toBeNull();
  });

  it("群組根層：成員（能建能編）→ 帶 groupId", () => {
    expect(createTargetFor(groupNote("g1"), ctx([team], []))).toEqual({ groupId: "g1" });
  });

  it("群組根層：管理員 → 帶 groupId", () => {
    const admin = groupDto({ id: "g1", name: "Team" }, adminRole());
    expect(createTargetFor(groupNote("g1"), ctx([admin], []))).toEqual({ groupId: "g1" });
  });

  it("群組根層：檢視者角色 → null", () => {
    expect(createTargetFor(groupNote("g2", { permissions: { ...OWNER_PERMS, edit: false } }), ctx([viewerGroup], []))).toBeNull();
  });

  it("群組根層：自訂角色能建不能編 → null（與側欄群組「＋」同一條規則）", () => {
    expect(createTargetFor(groupNote("g3"), ctx([createOnly], []))).toBeNull();
  });

  it("群組、在資料夾：帶 groupId 與 folderId", () => {
    const folders = [groupFolder({ id: "gf1", name: "Specs", groupId: "g1" })];
    expect(createTargetFor(groupNote("g1", { folderId: "gf1" }), ctx([team], folders))).toEqual({ groupId: "g1", folderId: "gf1" });
  });

  it("群組、資料夾 createNote 為 false 或不在索引：null", () => {
    const folders = [groupFolder({ id: "gf1", name: "Specs", groupId: "g1", create: false })];
    expect(createTargetFor(groupNote("g1", { folderId: "gf1" }), ctx([team], folders))).toBeNull();
    expect(createTargetFor(groupNote("g1", { folderId: "gone" }), ctx([team], []))).toBeNull();
  });

  it("群組不在 groups（剛退出、清單還沒重抓）：null", () => {
    expect(createTargetFor(groupNote("g1"), ctx([], []))).toBeNull();
  });

  it("共享給我、根層：null", () => {
    expect(createTargetFor(note({ role: "editor", ownerId: "u2", ownerHandle: "bob" }), ctx([], []))).toBeNull();
  });

  it("共享給我、放在我的資料夾：仍是 null", () => {
    const folders = [sharedFolder({ id: "sf1", name: "From others" })];
    expect(createTargetFor(note({ role: "viewer", ownerId: "u2", ownerHandle: "bob", folderId: "sf1" }), ctx([], folders))).toBeNull();
  });
});
