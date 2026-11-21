import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FavoriteDto, GroupDto, NoteDto, NotePermissions } from "@knotebook/shared";
import i18n from "@/i18n";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests } from "./collapse";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";
import { __resetFolderSortForTests, type FolderSort } from "./folder-sort";
import {
  buildTabNodes,
  favoriteNotes,
  filterNodesByTags,
  hasSelectableNodes,
  noteBucket,
  noteLocationLabel,
  noteLocationParts,
  noteLocationSegments,
  noteSpaceKey,
  partitionNotes,
  recentNotes,
  sortFolderNotes,
  type SidebarNode,
} from "./tree";

function note(id: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id,
    title: `Note ${id}`,
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: `note-${id}`,
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "owner-one",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

const GROUP_A: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());
const GROUP_B: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Workshop B" }, adminRole());

function groupNote(
  id: string,
  group: { id: string; name: string },
  role: "editor" | "viewer",
  perms: NotePermissions = { ...OWNER_PERMS, manageShares: false, moveToGroup: false },
): NoteDto {
  return note(id, { ownerId: null, ownerHandle: null, role, groupId: group.id, group, permissions: perms });
}

const OWNER_NOTE = note("owner");
const SHARED_NOTE = note("shared", { ownerId: "u9", role: "editor", ownerHandle: "owner-nine", permissions: EDITOR_PERMS });
const VIEWER_SHARED_NOTE = note("shared-viewer", { ownerId: "u9", role: "viewer", ownerHandle: "owner-nine", permissions: VIEWER_PERMS });
const MY_GROUP_NOTE = groupNote("mine-in-a", GROUP_A, "editor");
const ORPHAN_GROUP_NOTE = groupNote("orphan", { id: "99999999-9999-9999-9999-999999999999", name: "Gone" }, "editor", { ...EDITOR_PERMS });

describe("partitionNotes / noteBucket (#175)", () => {
  it("group note whose group is in groups -> that group's section (not My notes / Shared with me)", () => {
    const parts = partitionNotes([MY_GROUP_NOTE], [GROUP_A]);
    expect(parts.byGroup.get(GROUP_A.id)?.map((n) => n.id)).toEqual([MY_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.shared).toEqual([]);
  });

  it("group note whose group is not in groups -> Shared with me (fallback)", () => {
    const parts = partitionNotes([ORPHAN_GROUP_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([ORPHAN_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.byGroup.get(GROUP_A.id)).toEqual([]);
  });

  it("role === owner (personal note) -> My notes", () => {
    const parts = partitionNotes([OWNER_NOTE], [GROUP_A]);
    expect(parts.myNotes.map((n) => n.id)).toEqual([OWNER_NOTE.id]);
    expect(parts.shared).toEqual([]);
  });

  it("everything else (personal notes shared with me individually) -> Shared with me", () => {
    const parts = partitionNotes([SHARED_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([SHARED_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
  });

  it("the returned object has the keys byGroup / myNotes / shared (no recent)", () => {
    expect(Object.keys(partitionNotes([OWNER_NOTE], [GROUP_A])).sort()).toEqual(["byGroup", "myNotes", "shared"]);
  });

  it("noteBucket: each of the four cases returns its own bucket", () => {
    const ids = new Set([GROUP_A.id]);
    expect(noteBucket(MY_GROUP_NOTE, ids)).toEqual({ kind: "group", groupId: GROUP_A.id });
    expect(noteBucket(ORPHAN_GROUP_NOTE, ids)).toEqual({ kind: "shared" });
    expect(noteBucket(OWNER_NOTE, ids)).toEqual({ kind: "myNotes" });
    expect(noteBucket(SHARED_NOTE, ids)).toEqual({ kind: "shared" });
  });
});

describe("recentNotes", () => {
  it("sorted newest first by lastEdited.at ?? updatedAt, interleaving sources", () => {
    const a = note("A", { updatedAt: "2026-10-01T00:00:00.000Z", lastEdited: { at: "2026-10-05T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    const b = note("B", { updatedAt: "2026-10-07T00:00:00.000Z", lastEdited: null });
    const c = note("C", { updatedAt: "2026-10-01T00:00:00.000Z", lastEdited: { at: "2026-10-06T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    expect(recentNotes([a, b, c]).map((n) => n.id)).toEqual(["B", "C", "A"]);
  });

  it("equal keys keep input order; unparseable times sort last", () => {
    const same = "2026-10-05T00:00:00.000Z";
    const bad = note("bad", { updatedAt: "2026-12-01T00:00:00.000Z", lastEdited: { at: "not-a-date", byHandle: "x", agentLabel: null } });
    const p = note("p", { updatedAt: same });
    const q = note("q", { updatedAt: same });
    const r = note("r", { updatedAt: same });
    expect(recentNotes([bad, q, p, r]).map((n) => n.id)).toEqual(["q", "p", "r", "bad"]);
  });

  it("25 notes -> 20 notes, the 20 with the largest keys; the input array is not sorted in place", () => {
    const notes = Array.from({ length: 25 }, (_, i) =>
      note(`n${String(i).padStart(2, "0")}`, { updatedAt: new Date(Date.UTC(2026, 0, 1 + ((i * 7) % 25))).toISOString() }),
    );
    const before = [...notes];
    const out = recentNotes(notes);
    expect(out).toHaveLength(20);
    expect(notes).toEqual(before);
    const top = [...notes].sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt)).slice(0, 20);
    expect(out.map((n) => n.id)).toEqual(top.map((n) => n.id));
  });
});

describe("buildTabNodes", () => {
  const notes = [OWNER_NOTE, SHARED_NOTE, MY_GROUP_NOTE, ORPHAN_GROUP_NOTE];
  const groups = [GROUP_A, GROUP_B];

  it("recent / myNotes / shared each return note nodes for their notes", () => {
    const old = note("old", { updatedAt: "2026-01-01T00:00:00.000Z" });
    const fresh = note("fresh", { updatedAt: "2026-02-01T00:00:00.000Z" });
    expect(buildTabNodes("recent", [old, fresh], groups, EMPTY_FOLDER_INDEX)).toMatchObject([
      { kind: "note", id: "fresh" },
      { kind: "note", id: "old" },
    ]);
    expect(buildTabNodes("myNotes", notes, groups, EMPTY_FOLDER_INDEX)).toMatchObject([{ kind: "note", id: OWNER_NOTE.id }]);
    expect(buildTabNodes("shared", notes, groups, EMPTY_FOLDER_INDEX)).toMatchObject([
      { kind: "note", id: SHARED_NOTE.id },
      { kind: "note", id: ORPHAN_GROUP_NOTE.id },
    ]);
  });

  it("workspace: group nodes follow the order of groups, an empty group has children []", () => {
    const nodes = buildTabNodes("workspace", notes, groups, EMPTY_FOLDER_INDEX);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "group", id: GROUP_A.id, children: [{ kind: "note", id: MY_GROUP_NOTE.id }] });
    expect(nodes[1]).toMatchObject({ kind: "group", id: GROUP_B.id, children: [] });
  });

  it("orphan group notes appear only in shared", () => {
    const where = (tab: "recent" | "myNotes" | "shared" | "workspace") =>
      JSON.stringify(buildTabNodes(tab, [ORPHAN_GROUP_NOTE], groups, EMPTY_FOLDER_INDEX)).includes(ORPHAN_GROUP_NOTE.id);
    expect(where("shared")).toBe(true);
    expect(where("myNotes")).toBe(false);
    expect(where("workspace")).toBe(false);
  });

  it("trash -> [] (the trash tree is not built from notes; it does not hit the group fallback)", () => {
    expect(groups.length).toBeGreaterThan(0);
    expect(buildTabNodes("trash", notes, groups, EMPTY_FOLDER_INDEX)).toEqual([]);
  });
});

describe("favoriteNotes / buildTabNodes(favorites)", () => {
  const fav = (noteId: string, favoritedAt = "2026-01-01T00:00:00.000Z"): FavoriteDto => ({ noteId, favoritedAt });
  const a = note("a");
  const b = note("b");
  const c = note("c");

  it("output follows the favorites order, not the notes order", () => {
    expect(favoriteNotes([a, b, c], [fav("c"), fav("a"), fav("b")]).map((n) => n.id)).toEqual(["c", "a", "b"]);
  });

  it("ids in favorites but not in notes are skipped; notes missing from favorites do not appear", () => {
    expect(favoriteNotes([a, b], [fav("gone"), fav("b")]).map((n) => n.id)).toEqual(["b"]);
    expect(favoriteNotes([a, b, c], [fav("a")]).map((n) => n.id)).toEqual(["a"]);
    expect(favoriteNotes([a], [fav("gone")])).toEqual([]);
  });

  it("does not mutate the input arrays", () => {
    const notes = [a, b, c];
    const favorites = [fav("c"), fav("a")];
    const notesCopy = [...notes];
    const favoritesCopy = favorites.map((f) => ({ ...f }));
    favoriteNotes(notes, favorites);
    expect(notes).toEqual(notesCopy);
    expect(favorites).toEqual(favoritesCopy);
  });

  it("buildTabNodes(favorites) returns only note nodes: even for notes in folders or groups there are no group or folder nodes", () => {
    const folders = indexFolders([folderDto({ id: "A", name: "A" }), groupFolder({ id: "gf", name: "GF", groupId: GROUP_A.id })]);
    const inFolder = note("in-folder", { folderId: "A" });
    const inGroupFolder = { ...groupNote("in-group-folder", GROUP_A, "editor"), folderId: "gf" };
    const nodes = buildTabNodes("favorites", [inFolder, inGroupFolder, MY_GROUP_NOTE, SHARED_NOTE], [GROUP_A, GROUP_B], folders, undefined, [
      fav(SHARED_NOTE.id),
      fav("in-group-folder"),
      fav(MY_GROUP_NOTE.id),
      fav("in-folder"),
    ]);
    expect(nodes.every((node) => node.kind === "note")).toBe(true);
    expect(nodes.map((node) => node.id)).toEqual([SHARED_NOTE.id, "in-group-folder", MY_GROUP_NOTE.id, "in-folder"]);
  });

  it("buildTabNodes(favorites) without favorites -> [] (does not hit the group fallback)", () => {
    expect(buildTabNodes("favorites", [OWNER_NOTE, MY_GROUP_NOTE], [GROUP_A, GROUP_B], EMPTY_FOLDER_INDEX)).toEqual([]);
  });
});

describe("noteLocationLabel", () => {
  const ids = new Set([GROUP_A.id]);
  const label = (n: NoteDto) => noteLocationLabel(n, { groupIds: ids, folders: EMPTY_FOLDER_INDEX }, (k, o) => i18n.t(k, o));

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("en: personal / group / shared (editor, viewer) / orphan group", () => {
    expect(label(OWNER_NOTE)).toBe("My notes");
    expect(label(MY_GROUP_NOTE)).toBe("Groups › Workshop A");
    expect(label(SHARED_NOTE)).toBe("Shared with me · Editor");
    expect(label(VIEWER_SHARED_NOTE)).toBe("Shared with me · Viewer");
    expect(label(ORPHAN_GROUP_NOTE)).toBe("Shared with me · Editor");
  });

  it("zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(label(MY_GROUP_NOTE)).toBe("群組 › Workshop A");
      expect(label(SHARED_NOTE)).toBe("與我共享 · 可編輯");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("noteLocationSegments", () => {
  it("group note = [group name]; personal = []", () => {
    expect(noteLocationSegments({ group: { name: "Workshop A" } }, [])).toEqual(["Workshop A"]);
    expect(noteLocationSegments({ group: null }, [])).toEqual([]);
  });
});

describe("hasSelectableNodes", () => {
  it("[] -> false", () => {
    expect(hasSelectableNodes([])).toBe(false);
  });

  it("only an empty group -> false", () => {
    expect(hasSelectableNodes(buildTabNodes("workspace", [], [GROUP_A, GROUP_B], EMPTY_FOLDER_INDEX))).toBe(false);
  });

  it("one note under a group -> true", () => {
    expect(hasSelectableNodes(buildTabNodes("workspace", [MY_GROUP_NOTE], [GROUP_A, GROUP_B], EMPTY_FOLDER_INDEX))).toBe(true);
  });

  it("one flat note -> true", () => {
    expect(hasSelectableNodes(buildTabNodes("myNotes", [OWNER_NOTE], [], EMPTY_FOLDER_INDEX))).toBe(true);
  });

  it("only an empty folder -> true; only an empty group -> false; an empty folder inside an empty group -> true", () => {
    const personal = indexFolders([folderDto({ id: "E", name: "Empty" })]);
    expect(hasSelectableNodes(buildTabNodes("myNotes", [], [], personal))).toBe(true);
    expect(hasSelectableNodes(buildTabNodes("workspace", [], [GROUP_A, GROUP_B], personal))).toBe(false);
    const grouped = indexFolders([groupFolder({ id: "gE", name: "Group empty", groupId: GROUP_A.id })]);
    expect(hasSelectableNodes(buildTabNodes("workspace", [], [GROUP_A, GROUP_B], grouped))).toBe(true);
  });
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

/** Node tree skeleton: folder `F:<id>@<depth>[...]`, group `G:<id>[...]`, note id. */
function shape(nodes: readonly SidebarNode[]): unknown[] {
  return nodes.map((node) => {
    if (node.kind === "note") return node.id;
    if (node.kind === "folder") return { [`F:${node.id}@${node.depth}`]: shape(node.children) };
    return { [`G:${node.id}`]: shape(node.children) };
  });
}

const GONE = { id: "99999999-9999-9999-9999-999999999999", name: "Gone" };

describe("buildTabNodes with folders", () => {
  it("my notes: folders first, ordered by name; root notes keep server order; inside a folder, order follows sortOf", () => {
    const folders = indexFolders([folderDto({ id: "B", name: "B" }), folderDto({ id: "A", name: "A" })]);
    // n1 is newer than n2, ranks earlier by title and has the larger sizeBytes: all three sort orders put n1 before n2.
    const n2 = note("n2", { title: "Beta", updatedAt: "2026-01-01T00:00:00.000Z", sizeBytes: 100 });
    const n1 = note("n1", { title: "Alpha", updatedAt: "2026-02-01T00:00:00.000Z", sizeBytes: 500 });
    const a3 = note("a3", { title: "Zeta", folderId: "A", updatedAt: "2026-03-01T00:00:00.000Z" });
    const a1 = note("a1", { title: "Alpha", folderId: "A", updatedAt: "2026-01-01T00:00:00.000Z" });
    const a2 = note("a2", { title: "Mid", folderId: "A", updatedAt: "2026-02-01T00:00:00.000Z" });
    const notes = [n2, a3, n1, a1, a2];
    const byName = (id: string): FolderSort => (id === "A" ? "name" : "recent");
    expect(shape(buildTabNodes("myNotes", notes, [], folders, byName))).toEqual([{ "F:A@1": ["a1", "a2", "a3"] }, { "F:B@1": [] }, "n2", "n1"]);
    const recent = (): FolderSort => "recent";
    expect(shape(buildTabNodes("myNotes", notes, [], folders, recent))).toEqual([{ "F:A@1": ["a3", "a2", "a1"] }, { "F:B@1": [] }, "n2", "n1"]);
  });

  it("group tab: group -> [root folders..., root notes...] with correct subfolder depth", () => {
    const folders = indexFolders([
      groupFolder({ id: "gWeekly", name: "Weekly", groupId: GROUP_A.id, parentId: "gReports" }),
      groupFolder({ id: "gReports", name: "Reports", groupId: GROUP_A.id }),
    ]);
    const rootNote = groupNote("g-root", GROUP_A, "editor");
    const inner = { ...groupNote("g-in", GROUP_A, "editor"), folderId: "gWeekly" };
    const nodes = buildTabNodes("workspace", [rootNote, inner], [GROUP_A, GROUP_B], folders);
    expect(shape(nodes)).toEqual([{ [`G:${GROUP_A.id}`]: [{ "F:gReports@1": [{ "F:gWeekly@2": ["g-in"] }] }, "g-root"] }, { [`G:${GROUP_B.id}`]: [] }]);
  });

  it("shared with me: shared folders and unplaced shared notes at the root; a placed note hangs under its folder", () => {
    const folders = indexFolders([sharedFolder({ id: "sx", name: "X" })]);
    const loose = note("s1", { ownerId: "u9", role: "viewer", permissions: VIEWER_PERMS });
    const placed = note("s2", { ownerId: "u9", role: "viewer", permissions: VIEWER_PERMS, folderId: "sx" });
    expect(shape(buildTabNodes("shared", [loose, placed], [], folders))).toEqual([{ "F:sx@1": ["s2"] }, "s1"]);
  });

  it("recent tab stays flat as before (even with folders)", () => {
    const folders = indexFolders([folderDto({ id: "A", name: "A" })]);
    const inA = note("inA", { folderId: "A", updatedAt: "2026-02-01T00:00:00.000Z" });
    const root = note("root", { updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(shape(buildTabNodes("recent", [root, inA], [], folders))).toEqual(["inA", "root"]);
  });

  it("fallback: missing folderId -> root; personal note pointing at a group folder -> root; a group note moved out of its group pointing at a group folder -> Shared with me root", () => {
    const folders = indexFolders([
      groupFolder({ id: "gf", name: "Group folder", groupId: GROUP_A.id }),
      groupFolder({ id: "goneF", name: "Gone folder", groupId: GONE.id }),
    ]);
    const missing = note("p-missing", { folderId: "nope" });
    const cross = note("p-cross", { folderId: "gf" });
    const orphan = { ...groupNote("orphan-in-folder", GONE, "editor", { ...EDITOR_PERMS }), folderId: "goneF" };
    expect(shape(buildTabNodes("myNotes", [missing, cross, orphan], [GROUP_A], folders))).toEqual(["p-missing", "p-cross"]);
    expect(shape(buildTabNodes("shared", [missing, cross, orphan], [GROUP_A], folders))).toEqual(["orphan-in-folder"]);
  });

  it("an empty folder is a node too (children []); a tree with only an empty folder has hasSelectableNodes true (folders are tickable)", () => {
    const folders = indexFolders([folderDto({ id: "E", name: "Empty" })]);
    const nodes = buildTabNodes("myNotes", [], [], folders);
    expect(nodes).toEqual([{ kind: "folder", id: "E", folder: folders.byId.get("E"), depth: 1, children: [] }]);
    expect(hasSelectableNodes(nodes)).toBe(true);
    expect(hasSelectableNodes(buildTabNodes("myNotes", [note("x", { folderId: "E" })], [], folders))).toBe(true);
  });

  it("cycle A<->B and self-reference: folders and their notes are all in the tree, and the path line matches the tree", async () => {
    await i18n.changeLanguage("en");
    const folders = indexFolders([
      folderDto({ id: "cA", name: "Cyc A", parentId: "cB" }),
      folderDto({ id: "cB", name: "Cyc B", parentId: "cA" }),
      folderDto({ id: "self", name: "Self", parentId: "self" }),
    ]);
    const inA = note("inA", { folderId: "cA" });
    const inCycle = note("inCycle", { folderId: "cB" });
    const inSelf = note("inSelf", { folderId: "self" });
    const rootN = note("rootN");
    const nodes = buildTabNodes("myNotes", [inA, inCycle, inSelf, rootN], [], folders);
    expect(shape(nodes)).toEqual([{ "F:cA@1": [{ "F:cB@2": ["inCycle"] }, "inA"] }, { "F:self@1": ["inSelf"] }, "rootN"]);
    const ctx = { groupIds: new Set<string>(), folders };
    const label = (n: NoteDto) => noteLocationLabel(n, ctx, (k, o) => i18n.t(k, o));
    expect(label(inA)).toBe("My notes › Cyc A");
    expect(label(inCycle)).toBe("My notes › Cyc A › Cyc B");
    expect(label(inSelf)).toBe("My notes › Self");
  });

  it("EMPTY_FOLDER_INDEX: node-for-node identical on the existing fixtures", () => {
    const notes = [OWNER_NOTE, SHARED_NOTE, MY_GROUP_NOTE, ORPHAN_GROUP_NOTE];
    const groups = [GROUP_A, GROUP_B];
    const n = (x: NoteDto) => ({ kind: "note", id: x.id, note: x });
    expect(buildTabNodes("myNotes", notes, groups, EMPTY_FOLDER_INDEX)).toEqual([n(OWNER_NOTE)]);
    expect(buildTabNodes("shared", notes, groups, EMPTY_FOLDER_INDEX)).toEqual([n(SHARED_NOTE), n(ORPHAN_GROUP_NOTE)]);
    expect(buildTabNodes("recent", notes, groups, EMPTY_FOLDER_INDEX)).toEqual(notes.map(n));
    expect(buildTabNodes("workspace", notes, groups, EMPTY_FOLDER_INDEX)).toEqual([
      { kind: "group", id: GROUP_A.id, group: GROUP_A, children: [n(MY_GROUP_NOTE)] },
      { kind: "group", id: GROUP_B.id, group: GROUP_B, children: [] },
    ]);
    expect(buildTabNodes("trash", notes, groups, EMPTY_FOLDER_INDEX)).toEqual([]);
  });
});

describe("sortFolderNotes", () => {
  const titles = (list: readonly NoteDto[]) => list.map((x) => x.title);

  it("name: by collator (numeric; in zh-Hant, Han characters sort before Latin letters)", () => {
    const list = [note("a", { title: "筆記 10" }), note("c", { title: "Apple" }), note("b", { title: "筆記 2" })];
    expect(titles(sortFolderNotes(list, "name"))).toEqual(["筆記 2", "筆記 10", "Apple"]);
  });

  it("recent: lastEdited.at takes precedence over updatedAt, newest first, unparseable last", () => {
    const edited = note("edited", { updatedAt: "2026-01-01T00:00:00.000Z", lastEdited: { at: "2026-05-01T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    const updated = note("updated", { updatedAt: "2026-03-01T00:00:00.000Z" });
    const bad = note("bad", { updatedAt: "2026-12-01T00:00:00.000Z", lastEdited: { at: "not-a-date", byHandle: "x", agentLabel: null } });
    expect(sortFolderNotes([bad, updated, edited], "recent").map((x) => x.id)).toEqual(["edited", "updated", "bad"]);
  });

  it("size: largest first, missing counts as 0", () => {
    const missing = note("missing");
    const big = note("big", { sizeBytes: 300 });
    const small = note("small", { sizeBytes: 100 });
    expect(sortFolderNotes([missing, small, big], "size").map((x) => x.id)).toEqual(["big", "small", "missing"]);
  });

  it("equal values: all three orders keep input order; the input array is not mutated", () => {
    const p = note("p", { title: "same", sizeBytes: 5 });
    const q = note("q", { title: "SAME", sizeBytes: 5 });
    const r = note("r", { title: "Same", sizeBytes: 5 });
    const input = [q, r, p];
    for (const sort of ["name", "recent", "size"] as const) expect(sortFolderNotes(input, sort).map((x) => x.id)).toEqual(["q", "r", "p"]);
    expect(input.map((x) => x.id)).toEqual(["q", "r", "p"]);
  });
});

describe("noteSpaceKey", () => {
  it("owner -> personal; group in groupIds -> group:<id>; group not in groupIds -> shared; viewer -> shared", () => {
    const groupIds = new Set([GROUP_A.id]);
    expect(noteSpaceKey(OWNER_NOTE, groupIds)).toBe("personal");
    expect(noteSpaceKey(MY_GROUP_NOTE, groupIds)).toBe(`group:${GROUP_A.id}`);
    expect(noteSpaceKey(ORPHAN_GROUP_NOTE, groupIds)).toBe("shared");
    expect(noteSpaceKey(VIEWER_SHARED_NOTE, groupIds)).toBe("shared");
  });
});

describe("noteLocationLabel with folders", () => {
  const folders = indexFolders([
    folderDto({ id: "pA", name: "A" }),
    folderDto({ id: "pB", name: "B", parentId: "pA" }),
    groupFolder({ id: "gA", name: "A", groupId: GROUP_A.id }),
    sharedFolder({ id: "sX", name: "X" }),
  ]);
  const ctx = { groupIds: new Set([GROUP_A.id]), folders };
  const label = (n: NoteDto) => noteLocationLabel(n, ctx, (k, o) => i18n.t(k, o));
  const inB = note("inB", { folderId: "pB" });
  const inGroupA = { ...MY_GROUP_NOTE, folderId: "gA" };
  const placedViewer = { ...VIEWER_SHARED_NOTE, folderId: "sX" };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("en: personal A > B, group G > A, shared without/with placement, root as before", () => {
    expect(label(inB)).toBe("My notes › A › B");
    expect(label(inGroupA)).toBe("Groups › Workshop A › A");
    expect(label(VIEWER_SHARED_NOTE)).toBe("Shared with me · Viewer");
    expect(label(placedViewer)).toBe("Shared with me › X · Viewer");
    expect(label(OWNER_NOTE)).toBe("My notes");
    expect(label(MY_GROUP_NOTE)).toBe("Groups › Workshop A");
    // inconsistent cache: personal note pointing at a group folder -> no path
    expect(label(note("cross", { folderId: "gA" }))).toBe("My notes");
  });

  it("zh-TW: Shared with me > X, viewer", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(label(placedViewer)).toBe("與我共享 › X · 檢視者");
      expect(label(inB)).toBe("我的筆記 › A › B");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("noteLocationSegments: [group name?, ...path]", () => {
    expect(noteLocationSegments({ group: { name: "G" } }, ["A", "B"])).toEqual(["G", "A", "B"]);
    expect(noteLocationSegments({ group: null }, ["A"])).toEqual(["A"]);
  });
});

describe("noteLocationParts", () => {
  const folders = indexFolders([
    folderDto({ id: "pA", name: "A" }),
    folderDto({ id: "pB", name: "B", parentId: "pA" }),
    groupFolder({ id: "gA", name: "GA", groupId: GROUP_A.id }),
    sharedFolder({ id: "sX", name: "X" }),
  ]);
  const ctx = { groupIds: new Set([GROUP_A.id]), folders };
  const parts = (n: NoteDto) => noteLocationParts(n, ctx, (k, o) => i18n.t(k, o));

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("personal: root level and folder chain, tab is myNotes", () => {
    expect(parts(OWNER_NOTE)).toEqual({ segments: ["My notes"], suffix: null, tab: "myNotes", folderId: null, groupId: null });
    expect(parts(note("inB", { folderId: "pB" }))).toEqual({ segments: ["My notes", "A", "B"], suffix: null, tab: "myNotes", folderId: "pB", groupId: null });
  });

  it("group: starts with the group name, no 'Groups' prefix, tab is workspace", () => {
    expect(parts(MY_GROUP_NOTE)).toEqual({ segments: ["Workshop A"], suffix: null, tab: "workspace", folderId: null, groupId: GROUP_A.id });
    expect(parts({ ...MY_GROUP_NOTE, folderId: "gA" })).toEqual({
      segments: ["Workshop A", "GA"],
      suffix: null,
      tab: "workspace",
      folderId: "gA",
      groupId: GROUP_A.id,
    });
  });

  it("shared: starts with Shared with me, then my folders, suffix is @owner-handle, tab is shared", () => {
    expect(parts({ ...VIEWER_SHARED_NOTE, ownerHandle: "alice" })).toEqual({ segments: ["Shared with me"], suffix: "@alice", tab: "shared", folderId: null, groupId: null });
    expect(parts({ ...VIEWER_SHARED_NOTE, ownerHandle: "alice", folderId: "sX" })).toEqual({
      segments: ["Shared with me", "X"],
      suffix: "@alice",
      tab: "shared",
      folderId: "sX",
      groupId: null,
    });
  });

  it("no suffix when ownerHandle is null; orphan group notes count as shared and show no group name", () => {
    expect(parts({ ...VIEWER_SHARED_NOTE, ownerHandle: null }).suffix).toBeNull();
    expect(parts(ORPHAN_GROUP_NOTE)).toMatchObject({ segments: ["Shared with me"], tab: "shared" });
  });

  it("folder missing from the index or in another space -> no path, folderId is null", () => {
    expect(parts(note("gone", { folderId: "nope" }))).toMatchObject({ segments: ["My notes"], folderId: null });
    expect(parts(note("cross", { folderId: "gA" }))).toMatchObject({ segments: ["My notes"], folderId: null });
  });

  it("zh-TW segment names", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(parts(OWNER_NOTE).segments).toEqual(["我的筆記"]);
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

describe("filterNodesByTags", () => {
  const WORK = { id: "t-work", name: "work", color: "blue" as const };
  const TODO = { id: "t-todo", name: "todo", color: "red" as const };
  const nodeOf = (n: NoteDto): SidebarNode => ({ kind: "note", id: n.id, note: n });

  it("filterNodesByTags keeps notes having every tag, drops folders with no match below them, keeps their order", () => {
    const both = note("both", { tags: [WORK, TODO] });
    const onlyWork = note("only-work", { tags: [WORK] });
    const deepBoth = note("deep-both", { tags: [TODO, WORK] });
    const plain = note("plain");
    const nodes: SidebarNode[] = [
      { kind: "folder", id: "f1", folder: folderDto({ id: "f1", name: "F1" }), depth: 1, children: [nodeOf(onlyWork), nodeOf(deepBoth)] },
      { kind: "folder", id: "f2", folder: folderDto({ id: "f2", name: "F2" }), depth: 1, children: [nodeOf(onlyWork)] },
      nodeOf(plain),
      nodeOf(both),
    ];
    const kept = filterNodesByTags(nodes, [WORK.id, TODO.id]);
    expect(kept.map((n) => n.id)).toEqual(["f1", "both"]);
    expect((kept[0] as Extract<SidebarNode, { kind: "folder" }>).children.map((n) => n.id)).toEqual(["deep-both"]);
    expect(filterNodesByTags(nodes, [])).toBe(nodes);
  });
});
