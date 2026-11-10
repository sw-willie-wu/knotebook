import { describe, expect, it } from "vitest";
import { consistentTree, inRangeIds, layoutOf, type RangeNoteRow } from "../../src/transfer/range.js";

/** 資料夾、群組、筆記三支查詢之間的競態不得讓 buildLayout 丟錯（→ 500）。 */
const T0 = new Date("2026-01-01T00:00:00Z");
const G = "00000000-0000-4000-8000-0000000000aa";
const row = (id: string, extra: Partial<RangeNoteRow> = {}): RangeNoteRow => ({
  id,
  title: id,
  role: "owner",
  ownerHandle: "me",
  groupId: null,
  slug: id,
  viewerFolderId: null,
  createdAt: T0,
  space: "personal",
  ...extra,
});

describe("range 一致化", () => {
  // 情境：listMyGroupsQuery 先跑（那時還不是 G 的成員）、之後才被加進 G，listVisibleFolders／visibleNotes 看得到 G 的東西。
  const gFolder = { id: "00000000-0000-4000-8000-0000000000f1", name: "gf", parentId: null, createdAt: T0, space: { kind: "group" as const, groupId: G } };
  const myFolder = { id: "00000000-0000-4000-8000-0000000000f2", name: "mine", parentId: null, createdAt: T0, space: { kind: "personal" as const } };
  const notes = [
    row("00000000-0000-4000-8000-000000000001"),
    row("00000000-0000-4000-8000-000000000002", { role: "editor", ownerHandle: null, groupId: G, space: "group" }),
    row("00000000-0000-4000-8000-000000000003", { role: "editor", ownerHandle: null, groupId: G, space: "group", viewerFolderId: gFolder.id }),
  ];

  it("群組不在清單：群組筆記與群組資料夾濾掉、不丟錯；其他照常", () => {
    const L = layoutOf({ notes, folders: [gFolder, myFolder], groups: [] }, { kind: "all" });
    expect([...L.files.values()]).toEqual(["My notes/00000000-0000-4000-8000-000000000001.md"]);
    expect(L.dirs.map(d => d.path)).not.toContain("Groups/gf");
    expect(L.dirs.map(d => d.path)).toContain("My notes/mine");
  });

  it("範圍所指的群組／資料夾在一致化後不在 → 丟錯（呼叫端必須先 rangeGone；寧可 500 也不回空包）", () => {
    expect(() => layoutOf({ notes, folders: [gFolder], groups: [] }, { kind: "group", groupId: G })).toThrow(/rangeGone/);
    expect(() => layoutOf({ notes, folders: [gFolder], groups: [] }, { kind: "folder", folderId: gFolder.id })).toThrow(/rangeGone/);
  });

  it("inRangeIds 走同一道過濾", () => {
    expect([...inRangeIds(notes, { folders: [gFolder], groups: [] }, { kind: "all" })]).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("consistentTree：群組在清單時群組資料夾保留", () => {
    const groups = [{ id: G, name: "G", createdAt: T0 }];
    expect(consistentTree({ folders: [gFolder, myFolder], groups }).folders).toHaveLength(2);
    expect(consistentTree({ folders: [gFolder, myFolder], groups: [] }).folders).toEqual([myFolder]);
    expect(layoutOf({ notes, folders: [gFolder], groups }, { kind: "all" }).files.size).toBe(3);
  });
});
