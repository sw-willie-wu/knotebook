import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GroupDto, NoteDto, NotePermissions } from "@knotebook/shared";
import i18n from "@/i18n";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS, VIEWER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests } from "./collapse";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";
import { __resetFolderSortForTests, type FolderSort } from "./folder-sort";
import {
  buildTabNodes,
  hasSelectableNodes,
  noteBucket,
  noteLocationLabel,
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

// ── TR1：歸類（#175 spec §8.2 四列）──純函式，每列一案。
describe("partitionNotes／noteBucket（#175 §8.2）", () => {
  it("第 1 列：群組筆記且群組在 groups → 該群組段（不進我的筆記／與我共享）", () => {
    const parts = partitionNotes([MY_GROUP_NOTE], [GROUP_A]);
    expect(parts.byGroup.get(GROUP_A.id)?.map((n) => n.id)).toEqual([MY_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.shared).toEqual([]);
  });

  it("第 2 列：群組筆記但群組不在 groups → 與我共享（兜底）", () => {
    const parts = partitionNotes([ORPHAN_GROUP_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([ORPHAN_GROUP_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
    expect(parts.byGroup.get(GROUP_A.id)).toEqual([]);
  });

  it("第 3 列：role === owner（個人筆記）→ 我的筆記", () => {
    const parts = partitionNotes([OWNER_NOTE], [GROUP_A]);
    expect(parts.myNotes.map((n) => n.id)).toEqual([OWNER_NOTE.id]);
    expect(parts.shared).toEqual([]);
  });

  it("第 4 列：其餘（逐人分享給我的個人筆記）→ 與我共享", () => {
    const parts = partitionNotes([SHARED_NOTE], [GROUP_A]);
    expect(parts.shared.map((n) => n.id)).toEqual([SHARED_NOTE.id]);
    expect(parts.myNotes).toEqual([]);
  });

  it("回傳物件的鍵只有 byGroup／myNotes／shared（沒有 recent）", () => {
    expect(Object.keys(partitionNotes([OWNER_NOTE], [GROUP_A])).sort()).toEqual(["byGroup", "myNotes", "shared"]);
  });

  it("noteBucket：四列各回對應的桶", () => {
    const ids = new Set([GROUP_A.id]);
    expect(noteBucket(MY_GROUP_NOTE, ids)).toEqual({ kind: "group", groupId: GROUP_A.id });
    expect(noteBucket(ORPHAN_GROUP_NOTE, ids)).toEqual({ kind: "shared" });
    expect(noteBucket(OWNER_NOTE, ids)).toEqual({ kind: "myNotes" });
    expect(noteBucket(SHARED_NOTE, ids)).toEqual({ kind: "shared" });
  });
});

// ── TR2：最近
describe("recentNotes", () => {
  it("依 lastEdited.at ?? updatedAt 新到舊交錯排序", () => {
    const a = note("A", { updatedAt: "2026-10-01T00:00:00.000Z", lastEdited: { at: "2026-10-05T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    const b = note("B", { updatedAt: "2026-10-07T00:00:00.000Z", lastEdited: null });
    const c = note("C", { updatedAt: "2026-10-01T00:00:00.000Z", lastEdited: { at: "2026-10-06T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    expect(recentNotes([a, b, c]).map((n) => n.id)).toEqual(["B", "C", "A"]);
  });

  it("同 key 保持輸入順序；無法解析的時間排最後", () => {
    const same = "2026-10-05T00:00:00.000Z";
    const bad = note("bad", { updatedAt: "2026-12-01T00:00:00.000Z", lastEdited: { at: "not-a-date", byHandle: "x", agentLabel: null } });
    const p = note("p", { updatedAt: same });
    const q = note("q", { updatedAt: same });
    const r = note("r", { updatedAt: same });
    expect(recentNotes([bad, q, p, r]).map((n) => n.id)).toEqual(["q", "p", "r", "bad"]);
  });

  it("25 篇 → 20 篇且是 key 最大的 20 篇；輸入陣列不被就地排序", () => {
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

// ── TR3：節點樹
describe("buildTabNodes", () => {
  const notes = [OWNER_NOTE, SHARED_NOTE, MY_GROUP_NOTE, ORPHAN_GROUP_NOTE];
  const groups = [GROUP_A, GROUP_B];

  it("recent／myNotes／shared 各回對應筆記的 note 節點", () => {
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

  it("workspace：group 節點順序同 groups，空群組 children 為 []", () => {
    const nodes = buildTabNodes("workspace", notes, groups, EMPTY_FOLDER_INDEX);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({ kind: "group", id: GROUP_A.id, children: [{ kind: "note", id: MY_GROUP_NOTE.id }] });
    expect(nodes[1]).toMatchObject({ kind: "group", id: GROUP_B.id, children: [] });
  });

  it("孤兒群組筆記只出現在 shared", () => {
    const where = (tab: "recent" | "myNotes" | "shared" | "workspace") =>
      JSON.stringify(buildTabNodes(tab, [ORPHAN_GROUP_NOTE], groups, EMPTY_FOLDER_INDEX)).includes(ORPHAN_GROUP_NOTE.id);
    expect(where("shared")).toBe(true);
    expect(where("myNotes")).toBe(false);
    expect(where("workspace")).toBe(false);
  });

  it("TR5：trash → []（垃圾桶不從 notes 組樹；不落入工作坊兜底）", () => {
    expect(groups.length).toBeGreaterThan(0);
    expect(buildTabNodes("trash", notes, groups, EMPTY_FOLDER_INDEX)).toEqual([]);
  });
});

// ── TR4：位置標籤
describe("noteLocationLabel", () => {
  const ids = new Set([GROUP_A.id]);
  const label = (n: NoteDto) => noteLocationLabel(n, { groupIds: ids, folders: EMPTY_FOLDER_INDEX }, (k, o) => i18n.t(k, o));

  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  it("en：個人／群組／共享（editor、viewer）／孤兒群組", () => {
    expect(label(OWNER_NOTE)).toBe("My notes");
    expect(label(MY_GROUP_NOTE)).toBe("Workspace › Workshop A");
    expect(label(SHARED_NOTE)).toBe("Shared with me · Editor");
    expect(label(VIEWER_SHARED_NOTE)).toBe("Shared with me · Viewer");
    expect(label(ORPHAN_GROUP_NOTE)).toBe("Shared with me · Editor");
  });

  it("zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(label(MY_GROUP_NOTE)).toBe("工作坊 › Workshop A");
      expect(label(SHARED_NOTE)).toBe("與我共享 · 可編輯");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

// ── TR6：位置段落（spec §9-2，垃圾桶第二行也經它）
describe("noteLocationSegments", () => {
  it("群組筆記＝[群組名]；個人＝[]", () => {
    expect(noteLocationSegments({ group: { name: "Workshop A" } }, [])).toEqual(["Workshop A"]);
    expect(noteLocationSegments({ group: null }, [])).toEqual([]);
  });
});

// ── TR7：樹裡有沒有可勾的節點（「選取」鈕可不可按；PR-3b-2 T6a 起資料夾也算）
describe("hasSelectableNodes", () => {
  it("[] → false", () => {
    expect(hasSelectableNodes([])).toBe(false);
  });

  it("只有空群組 → false", () => {
    expect(hasSelectableNodes(buildTabNodes("workspace", [], [GROUP_A, GROUP_B], EMPTY_FOLDER_INDEX))).toBe(false);
  });

  it("群組下一篇 → true", () => {
    expect(hasSelectableNodes(buildTabNodes("workspace", [MY_GROUP_NOTE], [GROUP_A, GROUP_B], EMPTY_FOLDER_INDEX))).toBe(true);
  });

  it("平面一篇 → true", () => {
    expect(hasSelectableNodes(buildTabNodes("myNotes", [OWNER_NOTE], [], EMPTY_FOLDER_INDEX))).toBe(true);
  });

  it("FT-S1 只有空資料夾 → true；只有空群組 → false；空群組裡一個空資料夾 → true", () => {
    const personal = indexFolders([folderDto({ id: "E", name: "Empty" })]);
    expect(hasSelectableNodes(buildTabNodes("myNotes", [], [], personal))).toBe(true);
    expect(hasSelectableNodes(buildTabNodes("workspace", [], [GROUP_A, GROUP_B], personal))).toBe(false);
    const grouped = indexFolders([groupFolder({ id: "gE", name: "Group empty", groupId: GROUP_A.id })]);
    expect(hasSelectableNodes(buildTabNodes("workspace", [], [GROUP_A, GROUP_B], grouped))).toBe(true);
  });
});

// ── 資料夾（PR-3b-1 T1）：建樹、排序、兜底、路徑行
afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

/** 節點樹的骨架：資料夾 `F:<id>@<depth>[…]`、群組 `G:<id>[…]`、筆記 id。 */
function shape(nodes: readonly SidebarNode[]): unknown[] {
  return nodes.map((node) => {
    if (node.kind === "note") return node.id;
    if (node.kind === "folder") return { [`F:${node.id}@${node.depth}`]: shape(node.children) };
    return { [`G:${node.id}`]: shape(node.children) };
  });
}

const GONE = { id: "99999999-9999-9999-9999-999999999999", name: "Gone" };

describe("buildTabNodes × 資料夾（spec §6.2）", () => {
  it("FT1 我的筆記：資料夾在前且依名稱、根層筆記維持 server 序；資料夾內依 sortOf", () => {
    const folders = indexFolders([folderDto({ id: "B", name: "B" }), folderDto({ id: "A", name: "A" })]);
    // n1 比 n2 新、標題排名較前、sizeBytes 較大：三種排序都會把 n1 排在 n2 前
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

  it("FT2 工作坊：群組 → [根層資料夾…, 根層筆記…]，子資料夾 depth 正確", () => {
    const folders = indexFolders([
      groupFolder({ id: "gWeekly", name: "Weekly", groupId: GROUP_A.id, parentId: "gReports" }),
      groupFolder({ id: "gReports", name: "Reports", groupId: GROUP_A.id }),
    ]);
    const rootNote = groupNote("g-root", GROUP_A, "editor");
    const inner = { ...groupNote("g-in", GROUP_A, "editor"), folderId: "gWeekly" };
    const nodes = buildTabNodes("workspace", [rootNote, inner], [GROUP_A, GROUP_B], folders);
    expect(shape(nodes)).toEqual([{ [`G:${GROUP_A.id}`]: [{ "F:gReports@1": [{ "F:gWeekly@2": ["g-in"] }] }, "g-root"] }, { [`G:${GROUP_B.id}`]: [] }]);
  });

  it("FT3 與我共享：shared 資料夾＋沒有放置的共享筆記在根；放置指向的資料夾下掛該筆記", () => {
    const folders = indexFolders([sharedFolder({ id: "sx", name: "X" })]);
    const loose = note("s1", { ownerId: "u9", role: "viewer", permissions: VIEWER_PERMS });
    const placed = note("s2", { ownerId: "u9", role: "viewer", permissions: VIEWER_PERMS, folderId: "sx" });
    expect(shape(buildTabNodes("shared", [loose, placed], [], folders))).toEqual([{ "F:sx@1": ["s2"] }, "s1"]);
  });

  it("FT4 最近 tab 照舊扁平（有資料夾也一樣）", () => {
    const folders = indexFolders([folderDto({ id: "A", name: "A" })]);
    const inA = note("inA", { folderId: "A", updatedAt: "2026-02-01T00:00:00.000Z" });
    const root = note("root", { updatedAt: "2026-01-01T00:00:00.000Z" });
    expect(shape(buildTabNodes("recent", [root, inA], [], folders))).toEqual(["inA", "root"]);
  });

  it("FT5 兜底：folderId 不存在 → 根層；個人筆記指向群組資料夾 → 根層；移出群組的群組筆記指向群組資料夾 → 與我共享根層", () => {
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

  it("FT6 空資料夾也是節點（children []）；只有空資料夾的樹 hasSelectableNodes → true（PR-3b-2 T6a：資料夾可勾）", () => {
    const folders = indexFolders([folderDto({ id: "E", name: "Empty" })]);
    const nodes = buildTabNodes("myNotes", [], [], folders);
    expect(nodes).toEqual([{ kind: "folder", id: "E", folder: folders.byId.get("E"), depth: 1, children: [] }]);
    expect(hasSelectableNodes(nodes)).toBe(true);
    expect(hasSelectableNodes(buildTabNodes("myNotes", [note("x", { folderId: "E" })], [], folders))).toBe(true);
  });

  it("FT11 環 A↔B 與自指：資料夾與裡面的筆記都在樹上，路徑行與樹一致", async () => {
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

  it("FT8 EMPTY_FOLDER_INDEX：對既有 fixture 與 T1 前逐節點相同", () => {
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

describe("sortFolderNotes（spec §6.7）", () => {
  const titles = (list: readonly NoteDto[]) => list.map((x) => x.title);

  it("FT9 name：依 collator（numeric；zh-Hant 漢字在拉丁字母前）", () => {
    const list = [note("a", { title: "筆記 10" }), note("c", { title: "Apple" }), note("b", { title: "筆記 2" })];
    expect(titles(sortFolderNotes(list, "name"))).toEqual(["筆記 2", "筆記 10", "Apple"]);
  });

  it("FT9 recent：lastEdited.at 優先於 updatedAt、新到舊、不可解析的最後", () => {
    const edited = note("edited", { updatedAt: "2026-01-01T00:00:00.000Z", lastEdited: { at: "2026-05-01T00:00:00.000Z", byHandle: "x", agentLabel: null } });
    const updated = note("updated", { updatedAt: "2026-03-01T00:00:00.000Z" });
    const bad = note("bad", { updatedAt: "2026-12-01T00:00:00.000Z", lastEdited: { at: "not-a-date", byHandle: "x", agentLabel: null } });
    expect(sortFolderNotes([bad, updated, edited], "recent").map((x) => x.id)).toEqual(["edited", "updated", "bad"]);
  });

  it("FT9 size：大到小、缺的當 0", () => {
    const missing = note("missing");
    const big = note("big", { sizeBytes: 300 });
    const small = note("small", { sizeBytes: 100 });
    expect(sortFolderNotes([missing, small, big], "size").map((x) => x.id)).toEqual(["big", "small", "missing"]);
  });

  it("FT9 同值：三種都保持輸入序；不改動輸入陣列", () => {
    const p = note("p", { title: "same", sizeBytes: 5 });
    const q = note("q", { title: "SAME", sizeBytes: 5 });
    const r = note("r", { title: "Same", sizeBytes: 5 });
    const input = [q, r, p];
    for (const sort of ["name", "recent", "size"] as const) expect(sortFolderNotes(input, sort).map((x) => x.id)).toEqual(["q", "r", "p"]);
    expect(input.map((x) => x.id)).toEqual(["q", "r", "p"]);
  });
});

describe("noteSpaceKey", () => {
  it("FT10 owner → personal；群組在 groupIds → group:<id>；群組不在 → shared；viewer → shared", () => {
    const groupIds = new Set([GROUP_A.id]);
    expect(noteSpaceKey(OWNER_NOTE, groupIds)).toBe("personal");
    expect(noteSpaceKey(MY_GROUP_NOTE, groupIds)).toBe(`group:${GROUP_A.id}`);
    expect(noteSpaceKey(ORPHAN_GROUP_NOTE, groupIds)).toBe("shared");
    expect(noteSpaceKey(VIEWER_SHARED_NOTE, groupIds)).toBe("shared");
  });
});

describe("noteLocationLabel × 資料夾（spec §6.9）", () => {
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

  it("FT7 en：個人 A › B、群組 G › A、共享無放置／有放置、根層照舊", () => {
    expect(label(inB)).toBe("My notes › A › B");
    expect(label(inGroupA)).toBe("Workspace › Workshop A › A");
    expect(label(VIEWER_SHARED_NOTE)).toBe("Shared with me · Viewer");
    expect(label(placedViewer)).toBe("Shared with me › X · Viewer");
    expect(label(OWNER_NOTE)).toBe("My notes");
    expect(label(MY_GROUP_NOTE)).toBe("Workspace › Workshop A");
    // 快取錯亂：個人筆記指向群組資料夾 → 不帶路徑
    expect(label(note("cross", { folderId: "gA" }))).toBe("My notes");
  });

  it("FT7 zh-TW：與我共享 › X · 檢視者", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(label(placedViewer)).toBe("與我共享 › X · 檢視者");
      expect(label(inB)).toBe("我的筆記 › A › B");
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("noteLocationSegments：[群組名?, ...路徑]", () => {
    expect(noteLocationSegments({ group: { name: "G" } }, ["A", "B"])).toEqual(["G", "A", "B"]);
    expect(noteLocationSegments({ group: null }, ["A"])).toEqual(["A"]);
  });
});
