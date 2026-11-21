import { describe, expect, it } from "vitest";
import { consistentTree, inRangeIds, layoutOf, type RangeNoteRow } from "../../src/transfer/range.js";

/** Races between the folder, group and note queries must not make buildLayout throw (-> 500). */
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
  tagNames: [],
  createdAt: T0,
  space: "personal",
  ...extra,
});

describe("range consistency", () => {
  // Scenario: listMyGroupsQuery runs first (not yet a member of G), then the person is added to G, and listVisibleFolders / visibleNotes see G's things.
  const gFolder = { id: "00000000-0000-4000-8000-0000000000f1", name: "gf", parentId: null, createdAt: T0, space: { kind: "group" as const, groupId: G } };
  const myFolder = { id: "00000000-0000-4000-8000-0000000000f2", name: "mine", parentId: null, createdAt: T0, space: { kind: "personal" as const } };
  const notes = [
    row("00000000-0000-4000-8000-000000000001"),
    row("00000000-0000-4000-8000-000000000002", { role: "editor", ownerHandle: null, groupId: G, space: "group" }),
    row("00000000-0000-4000-8000-000000000003", { role: "editor", ownerHandle: null, groupId: G, space: "group", viewerFolderId: gFolder.id }),
  ];

  it("group not in the list: group notes and group folders are filtered out without throwing; the rest as usual", () => {
    const L = layoutOf({ notes, folders: [gFolder, myFolder], groups: [] }, { kind: "all" });
    expect([...L.files.values()]).toEqual(["My notes/00000000-0000-4000-8000-000000000001.md"]);
    expect(L.dirs.map(d => d.path)).not.toContain("Groups/gf");
    expect(L.dirs.map(d => d.path)).toContain("My notes/mine");
  });

  it("the group/folder the range points to is gone after reconciling -> throws (the caller must call rangeGone first; a 500 is better than returning an empty bundle)", () => {
    expect(() => layoutOf({ notes, folders: [gFolder], groups: [] }, { kind: "group", groupId: G })).toThrow(/rangeGone/);
    expect(() => layoutOf({ notes, folders: [gFolder], groups: [] }, { kind: "folder", folderId: gFolder.id })).toThrow(/rangeGone/);
  });

  it("inRangeIds goes through the same filter", () => {
    expect([...inRangeIds(notes, { folders: [gFolder], groups: [] }, { kind: "all" })]).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("consistentTree: a group folder is kept when the group is in the list", () => {
    const groups = [{ id: G, name: "G", createdAt: T0 }];
    expect(consistentTree({ folders: [gFolder, myFolder], groups }).folders).toHaveLength(2);
    expect(consistentTree({ folders: [gFolder, myFolder], groups: [] }).folders).toEqual([myFolder]);
    expect(layoutOf({ notes, folders: [gFolder], groups }, { kind: "all" }).files.size).toBe(3);
  });
});
