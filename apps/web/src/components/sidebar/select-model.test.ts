import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { customRole, groupDto, memberRole } from "@/test/fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { __resetCollapseForTests, setCollapsed } from "./collapse";
import { isEmptyDestination, type DestSource, type DestTarget } from "./destination-level";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";
import { __resetFolderSortForTests } from "./folder-sort";
import {
  batchDestSource,
  buildDestinationTree,
  dedupeByAncestor,
  destinationBody,
  isSameSpace,
  partitionEligible,
  partitionTargets,
  SELECT_ACTIONS,
  selectedTabNotes,
  selectedTargets,
  selectionResultTitle,
  tabNotes,
  visibleNoteKeys,
  visibleSelectionKeys,
  type ResultTally,
  type SelectionTarget,
} from "./select-model";
import { buildTabNodes } from "./tree";

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const G1: GroupDto = groupDto({ id: "g1", name: "Group 1" }, memberRole());
const G2: GroupDto = groupDto({ id: "g2", name: "Group 2" }, memberRole());
const G1A = groupNote({ id: "g1a", title: "G1 A", group: G1 });
const G1B = groupNote({ id: "g1b", title: "G1 B", group: G1 });
const G2A = groupNote({ id: "g2a", title: "G2 A", group: G2 });
const G2B = groupNote({ id: "g2b", title: "G2 B", group: G2 });
const WORKSPACE = buildTabNodes("workspace", [G1A, G1B, G2A, G2B], [G1, G2], EMPTY_FOLDER_INDEX);

const A = personalNote({ id: "a", title: "A" });
const B = personalNote({ id: "b", title: "B" });
const MY_NOTES = buildTabNodes("myNotes", [A, B], [], EMPTY_FOLDER_INDEX);

const ids = (notes: readonly { id: string }[]) => notes.map((n) => n.id);

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

describe("SMd1 SELECT_ACTIONS＝spec §6.11 的表", () => {
  it("四個 tab", () => {
    expect(SELECT_ACTIONS).toEqual({
      recent: ["copy", "delete"],
      myNotes: ["move", "copy", "delete"],
      workspace: ["copy", "delete"],
      shared: ["copy"],
    });
  });
});

describe("SMd2 tabNotes", () => {
  it("工作坊兩群組各兩篇 → 樹序四篇", () => {
    expect(ids(tabNotes(WORKSPACE))).toEqual(["g1a", "g1b", "g2a", "g2b"]);
  });
});

describe("SMd3 visibleNoteKeys", () => {
  it("group:g1 收合 → 只有 g2 的兩篇", () => {
    expect(visibleNoteKeys(WORKSPACE, (key) => key === "group:g1")).toEqual(["note:g2a", "note:g2b"]);
  });

  it("全不收合 → 四篇", () => {
    expect(visibleNoteKeys(WORKSPACE, () => false)).toEqual(["note:g1a", "note:g1b", "note:g2a", "note:g2b"]);
  });

  it("平面 tab → 全部", () => {
    expect(visibleNoteKeys(MY_NOTES, () => true)).toEqual(["note:a", "note:b"]);
  });
});

describe("SMd-F visibleNoteKeys × 資料夾", () => {
  const P1 = personalNote({ id: "p1", title: "P1", folderId: "A" });
  const P3 = personalNote({ id: "p3", title: "P3" });
  const nodes = buildTabNodes("myNotes", [P1, P3], [], indexFolders([folderDto({ id: "A", name: "A" })]));

  it("folder:A 收合 → 只剩根層 p3", () => {
    expect(visibleNoteKeys(nodes, (key) => key === "folder:A")).toEqual(["note:p3"]);
  });

  it("全不收合 → 樹序兩篇", () => {
    expect(visibleNoteKeys(nodes, () => false)).toEqual(["note:p1", "note:p3"]);
  });

  it("只有 group:A 收合 → 兩篇都在（資料夾查的不是 group: 鍵）", () => {
    expect(visibleNoteKeys(nodes, (key) => key === "group:A")).toEqual(["note:p1", "note:p3"]);
  });
});

describe("SMd4 selectedTabNotes", () => {
  it("依樹序、不在樹的鍵不算", () => {
    expect(ids(selectedTabNotes(MY_NOTES, new Set(["note:b", "note:a", "note:zzz"])))).toEqual(["a", "b"]);
  });

  it("收合群組裡已勾的仍回（不看收合）", () => {
    setCollapsed("group:g1", true);
    expect(ids(selectedTabNotes(WORKSPACE, new Set(["note:g1a"])))).toEqual(["g1a"]);
  });
});

describe("SMd5 partitionEligible", () => {
  it("delete：看 permissions.delete", () => {
    const cannot = groupNote({ id: "nd", title: "No delete", group: G1, delete: false });
    const result = partitionEligible("delete", [A, cannot, G1A]);
    expect(ids(result.eligible)).toEqual(["a", "g1a"]);
    expect(result.skipped).toBe(1);
  });

  it("move：moveToGroup 且 groupId === null", () => {
    const groupWithMove = groupNote({ id: "gm", title: "Group w/ move", group: G1, permissions: { ...G1A.permissions, moveToGroup: true } });
    const shared = sharedNote({ id: "s", title: "Shared" });
    const result = partitionEligible("move", [A, groupWithMove, shared]);
    expect(ids(result.eligible)).toEqual(["a"]);
    expect(result.skipped).toBe(2);
  });

  it("copy：一律可", () => {
    const shared = sharedNote({ id: "s", title: "Shared", role: "viewer" });
    const cannot = groupNote({ id: "nd", title: "No delete", group: G1, edit: false, delete: false });
    const result = partitionEligible("copy", [A, shared, cannot]);
    expect(ids(result.eligible)).toEqual(["a", "s", "nd"]);
    expect(result.skipped).toBe(0);
  });
});

describe("SMd6 buildDestinationTree", () => {
  const GA = groupDto({ id: "ga", name: "A" }, customRole({ permissions: { ...customRole().permissions, create: true, edit: true } }));
  const GB = groupDto({ id: "gb", name: "B" }, customRole({ permissions: { ...customRole().permissions, create: true } }));
  const GC = groupDto({ id: "gc", name: "C" }, customRole({ permissions: { ...customRole().permissions, edit: true } }));
  const groups = [GA, GB, GC];

  it("move：只有可移入的群組（create 且 edit），不列我的筆記", () => {
    const tree = buildDestinationTree({ mode: "move", groups, t });
    expect(tree.map((n) => n.label)).toEqual(["A"]);
    expect(tree[0]).toMatchObject({ key: "g:ga", destination: { kind: "group", groupId: "ga", name: "A" }, accessibleName: "A" });
  });

  it("copy：我的筆記在前＋可用群組；children 都 []、disabled 都 false", () => {
    const tree = buildDestinationTree({ mode: "copy", groups, t });
    expect(tree.map((n) => n.label)).toEqual(["My notes", "A"]);
    expect(tree[0]).toMatchObject({ key: "personal", destination: { kind: "personal" }, accessibleName: "My notes" });
    for (const node of tree) {
      expect(node.children).toEqual([]);
      expect(node.disabled).toBe(false);
    }
  });
});

describe("SMd7 destinationBody", () => {
  it("personal → 沒有任何鍵", () => {
    expect(Object.keys(destinationBody({ kind: "personal" })).length).toBe(0);
  });

  it("group → { groupId }", () => {
    expect(destinationBody({ kind: "group", groupId: "g1", name: "Group 1" })).toEqual({ groupId: "g1" });
  });
});

/** ResultTally 的底稿：只寫每案在意的欄位。 */
function tally(o: Partial<ResultTally> & Pick<ResultTally, "action">): ResultTally {
  return {
    tab: "myNotes",
    notesDone: 0,
    foldersDone: 0,
    trashedViaFolders: 0,
    notesSkipped: 0,
    foldersSkipped: 0,
    foldersBlocked: 0,
    foldersGone: 0,
    destinationName: null,
    sameSpace: false,
    destination: null,
    copySource: null,
    ...o,
  };
}

const PERSONAL_ROOT: DestTarget = { kind: "place", space: { kind: "personal" }, folder: null };
const groupRoot = (groupId: string, name: string): DestTarget => ({ kind: "place", space: { kind: "group", groupId, name }, folder: null });

describe("SMd8 selectionResultTitle（PR-2c 案，改寫成 ResultTally；預期字不變）", () => {
  const GROUP_A = groupRoot("ga", "A");

  it("delete (3, 0)", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 3 }), t)).toBe("Moved 3 notes to the trash");
  });

  it("delete (1, 2)：接略過後綴", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 1, notesSkipped: 2 }), t)).toBe(
      "Moved 1 note to the trash, 2 skipped (no permission, or they no longer exist)",
    );
  });

  it("delete (0, 2)：沒有處理任何筆記", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesSkipped: 2 }), t)).toBe(
      "Nothing was done; 2 skipped (no permission, or they no longer exist)",
    );
  });

  it("move (2, 0, A)", () => {
    expect(selectionResultTitle(tally({ action: "move", notesDone: 2, destination: GROUP_A, destinationName: "A" }), t)).toBe('Moved 2 notes into "A"');
  });

  it("copy personal (1, 0)", () => {
    expect(selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: PERSONAL_ROOT, destinationName: "My notes" }), t)).toBe(
      "Copied 1 note to My notes",
    );
  });

  it("copy group (2, 0, A)", () => {
    expect(selectionResultTitle(tally({ action: "copy", notesDone: 2, destination: GROUP_A, destinationName: "A" }), t)).toBe('Copied 2 notes into "A"');
  });

  it("move (0, 1, A)：沒有處理任何筆記（不只 delete）", () => {
    expect(selectionResultTitle(tally({ action: "move", notesSkipped: 1, destination: GROUP_A, destinationName: "A" }), t)).toBe(
      "Nothing was done; 1 skipped (no permission, or it no longer exists)",
    );
  });

  it("move／copy 沒有目的地 → throw（契約錯誤，不出空群組名）", () => {
    for (const action of ["move", "copy"] as const) {
      expect(() => selectionResultTitle(tally({ action, notesDone: 1 }), t)).toThrow(`${action} needs a destination`);
    }
  });

  it("I-B-1 destination 是 makeCopy、copySource 為 null → throw", () => {
    expect(() => selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: { kind: "makeCopy" } }), t)).toThrow(
      "makeCopy needs a copySource",
    );
  });

  it("zh-TW delete (2, 1)", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(selectionResultTitle(tally({ action: "delete", notesDone: 2, notesSkipped: 1 }), t)).toBe("已移到垃圾桶 2 篇，1 篇略過（沒有權限或已不存在）");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});

// ── PR-3b-2 T5：資料夾與筆記同列選取（資料夾 spec §6.10） ──

/** 我的筆記：A ⊃ A1；p1 在 A、p2 在 A1、p3 在根層。樹序：A、A1、p2、p1、p3。 */
const FA = folderDto({ id: "A", name: "A" });
const FA1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const P1 = personalNote({ id: "p1", title: "P1", folderId: "A" });
const P2 = personalNote({ id: "p2", title: "P2", folderId: "A1" });
const P3 = personalNote({ id: "p3", title: "P3" });
const MY_INDEX = indexFolders([FA, FA1]);
const MY_TREE = buildTabNodes("myNotes", [P1, P2, P3], [], MY_INDEX);

const noteT = (note: NoteDto): SelectionTarget => ({ kind: "note", note });
const folderT = (folder: FolderDto): SelectionTarget => ({ kind: "folder", folder });
const keysOf = (targets: readonly SelectionTarget[]): string[] =>
  targets.map((target) => (target.kind === "note" ? `note:${target.note.id}` : `folder:${target.folder.id}`));

/** batchDestSource 回 "mixedGroups" 時測試直接紅。 */
function asSource(value: DestSource | "mixedGroups"): DestSource {
  if (value === "mixedGroups") throw new Error("unexpected mixedGroups");
  return value;
}

describe("SMf2 visibleSelectionKeys", () => {
  it("全不收合：資料夾列在其子項之前（樹序）", () => {
    expect(visibleSelectionKeys(MY_TREE, () => false)).toEqual(["folder:A", "folder:A1", "note:p2", "note:p1", "note:p3"]);
  });

  it("收合 folder:A → A 本身在、整個子樹跳過", () => {
    expect(visibleSelectionKeys(MY_TREE, (key) => key === "folder:A")).toEqual(["folder:A", "note:p3"]);
  });

  it("收合 folder:A1 → A1 在、A1 的子項跳過、A 的其餘照列", () => {
    expect(visibleSelectionKeys(MY_TREE, (key) => key === "folder:A1")).toEqual(["folder:A", "folder:A1", "note:p1", "note:p3"]);
  });

  it("收合群組照舊（群組列本身不可選）", () => {
    expect(visibleSelectionKeys(WORKSPACE, (key) => key === "group:g1")).toEqual(["note:g2a", "note:g2b"]);
    expect(visibleSelectionKeys(WORKSPACE, () => false)).toEqual(["note:g1a", "note:g1b", "note:g2a", "note:g2b"]);
  });
});

describe("SMf3 selectedTargets", () => {
  it("先勾 A 內 p1 再收合 A → 仍在（不看收合）；樹序、不在樹的鍵不算", () => {
    const keys = new Set(["note:p1", "folder:A1", "note:zzz"]);
    expect(keysOf(selectedTargets(MY_TREE, keys))).toEqual(["folder:A1", "note:p1"]);
    setCollapsed("folder:A", true);
    expect(keysOf(selectedTargets(MY_TREE, keys))).toEqual(["folder:A1", "note:p1"]);
  });
});

describe("SMf4 dedupeByAncestor", () => {
  it("選 A、A 內 p1、A1 → 只剩 A", () => {
    expect(keysOf(dedupeByAncestor([folderT(FA), noteT(P1), folderT(FA1)], MY_INDEX))).toEqual(["folder:A"]);
  });

  it("A1 與根層 p3 → 兩者", () => {
    expect(keysOf(dedupeByAncestor([folderT(FA1), noteT(P3)], MY_INDEX))).toEqual(["folder:A1", "note:p3"]);
  });

  it("A1 與 A1 內 p2、A 內 p1 → A1 與 p1（p1 不在 A1 子樹）", () => {
    expect(keysOf(dedupeByAncestor([folderT(FA1), noteT(P2), noteT(P1)], MY_INDEX))).toEqual(["folder:A1", "note:p1"]);
  });

  it("去重的子項不算略過：partitionTargets 收去重後的結果，略過數為 0", () => {
    const deduped = dedupeByAncestor([folderT(FA), noteT(P1), folderT(FA1)], MY_INDEX);
    const out = partitionTargets("move", deduped, { tab: "myNotes", index: MY_INDEX, notes: [P1, P2, P3], groupIds: new Set() });
    expect(out).toEqual({ eligible: [folderT(FA)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });
});

describe("SMf5 partitionTargets(delete)", () => {
  const GG1 = new Set(["g1"]);

  it("子樹有活筆記且 deleteNotes:false → foldersBlocked 1", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", delete: false });
    const inside = groupNote({ id: "gn", title: "GN", group: G1, folderId: "GF" });
    const out = partitionTargets("delete", [folderT(gf)], { tab: "workspace", index: indexFolders([gf]), notes: [inside], groupIds: GG1 });
    expect(out).toEqual({ eligible: [], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 1 });
  });

  it("子樹有活筆記、deleteNotes:true → 照刪（不是一律擋）", () => {
    const out = partitionTargets("delete", [folderT(FA)], { tab: "myNotes", index: MY_INDEX, notes: [P1, P2, P3], groupIds: new Set() });
    expect(out).toEqual({ eligible: [folderT(FA)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("子樹沒有活筆記、deleteNotes:false → 照刪", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", delete: false });
    const out = partitionTargets("delete", [folderT(gf)], { tab: "workspace", index: indexFolders([gf]), notes: [G1A], groupIds: GG1 });
    expect(out).toEqual({ eligible: [folderT(gf)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("manage:false → foldersSkipped 1", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", edit: false });
    const out = partitionTargets("delete", [folderT(gf)], { tab: "workspace", index: indexFolders([gf]), notes: [], groupIds: GG1 });
    expect(out).toEqual({ eligible: [], notesSkipped: 0, foldersSkipped: 1, foldersBlocked: 0 });
  });

  it("筆記看 permissions.delete", () => {
    const cannot = groupNote({ id: "nd", title: "No delete", group: G1, delete: false });
    const out = partitionTargets("delete", [noteT(G1A), noteT(cannot)], { tab: "workspace", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: GG1 });
    expect(out).toEqual({ eligible: [noteT(G1A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("shared tab 混筆記 → 筆記全算 notesSkipped（含 permissions.delete 為 true 的），資料夾照判", () => {
    const sf = sharedFolder({ id: "SF", name: "SF" });
    const s1 = sharedNote({ id: "s1", title: "S1" });
    const s2 = sharedNote({ id: "s2", title: "S2", permissions: { ...s1.permissions, delete: true } });
    const out = partitionTargets("delete", [folderT(sf), noteT(s1), noteT(s2)], {
      tab: "shared",
      index: indexFolders([sf]),
      notes: [s1, s2],
      groupIds: new Set(),
    });
    expect(out).toEqual({ eligible: [folderT(sf)], notesSkipped: 2, foldersSkipped: 0, foldersBlocked: 0 });
  });
});

describe("SMf6 partitionTargets(move)", () => {
  it("workspace 看 permissions.edit（不看 moveToGroup）", () => {
    const viewer = groupNote({ id: "gv", title: "GV", group: G1, edit: false });
    expect(G1A.permissions.moveToGroup).toBe(false);
    const out = partitionTargets("move", [noteT(G1A), noteT(viewer)], { tab: "workspace", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set(["g1"]) });
    expect(out).toEqual({ eligible: [noteT(G1A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("shared 筆記恆可（viewer 也可）", () => {
    const viewer = sharedNote({ id: "sv", title: "SV", role: "viewer" });
    const out = partitionTargets("move", [noteT(viewer)], { tab: "shared", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set() });
    expect(out).toEqual({ eligible: [noteT(viewer)], notesSkipped: 0, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("myNotes 照 PR-2c：moveToGroup 且 groupId === null", () => {
    const noMove = personalNote({ id: "nm", title: "NM", permissions: { ...A.permissions, moveToGroup: false } });
    const out = partitionTargets("move", [noteT(A), noteT(noMove)], { tab: "myNotes", index: EMPTY_FOLDER_INDEX, notes: [], groupIds: new Set() });
    expect(out).toEqual({ eligible: [noteT(A)], notesSkipped: 1, foldersSkipped: 0, foldersBlocked: 0 });
  });

  it("資料夾看 manage", () => {
    const can = groupFolder({ id: "GF1", name: "GF1", groupId: "g1" });
    const cannot = groupFolder({ id: "GF2", name: "GF2", groupId: "g1", edit: false });
    const out = partitionTargets("move", [folderT(can), folderT(cannot)], {
      tab: "workspace",
      index: indexFolders([can, cannot]),
      notes: [],
      groupIds: new Set(["g1"]),
    });
    expect(out).toEqual({ eligible: [folderT(can)], notesSkipped: 0, foldersSkipped: 1, foldersBlocked: 0 });
  });
});

describe("SMf7 batchDestSource", () => {
  const GR: GroupDto = groupDto({ id: "gr", name: "Readers" }, customRole());
  const GROUPS = [G1, G2, GR];
  const IDS = new Set(["g1", "g2", "gr"]);
  const PERSONAL = { kind: "personal" } as const;
  const G1S = { kind: "group", groupId: "g1", name: "Group 1" } as const;
  const G2S = { kind: "group", groupId: "g2", name: "Group 2" } as const;

  it("workspace 兩群組 move → mixedGroups", () => {
    expect(batchDestSource({ tab: "workspace", mode: "move", eligible: [noteT(G1A), noteT(G2A)], groups: GROUPS, groupIds: IDS })).toBe("mixedGroups");
  });

  it("workspace 兩群組 copy → current null、others [personal, …候選]", () => {
    const src = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [noteT(G1A), noteT(G2A)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("單群組 G（候選）copy → current G、makeCopy true、others [personal, H]", () => {
    const src = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [noteT(G1A), noteT(G1B)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: G1S, makeCopy: true, others: [PERSONAL, G2S] });
  });

  it("單群組 G 不是候選 → current null、makeCopy false", () => {
    const readerNote = groupNote({ id: "rn", title: "RN", group: GR, edit: false });
    const src = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [noteT(readerNote)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("workspace 單群組 move（含該群組的資料夾）→ current G、沒有下半部", () => {
    const gf = groupFolder({ id: "GF", name: "GF", groupId: "g1", parentId: null });
    const src = asSource(batchDestSource({ tab: "workspace", mode: "move", eligible: [noteT(G1A), folderT(gf)], groups: GROUPS, groupIds: IDS }));
    expect(src).toEqual({ mode: "move", current: G1S, makeCopy: false, others: [], locations: [null, null], movingFolders: [gf] });
  });

  it("workspace 單群組但 G 不在 groups（全是資料夾，沒有筆記可借名）→ 沒有上半部，不出空群組名", () => {
    const orphan = groupFolder({ id: "OF", name: "OF", groupId: "g9" });
    const ids = new Set([...IDS, "g9"]);
    const move = asSource(batchDestSource({ tab: "workspace", mode: "move", eligible: [folderT(orphan)], groups: GROUPS, groupIds: ids }));
    expect(move).toMatchObject({ current: null, makeCopy: false, others: [] });
    const copy = asSource(batchDestSource({ tab: "workspace", mode: "copy", eligible: [folderT(orphan)], groups: GROUPS, groupIds: ids }));
    expect(copy).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("recent copy → current null", () => {
    const src = asSource(batchDestSource({ tab: "recent", mode: "copy", eligible: [noteT(A), noteT(G1A)], groups: GROUPS, groupIds: IDS }));
    expect(src).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });

  it("myNotes：current 個人；move 下半部＝候選群組、copy 另有建立副本；locations 照各自位置", () => {
    const move = asSource(batchDestSource({ tab: "myNotes", mode: "move", eligible: [noteT(P1), noteT(P3)], groups: GROUPS, groupIds: IDS }));
    expect(move).toEqual({ mode: "move", current: PERSONAL, makeCopy: false, others: [G1S, G2S], locations: ["A", null], movingFolders: [] });
    const copy = asSource(batchDestSource({ tab: "myNotes", mode: "copy", eligible: [noteT(P1)], groups: GROUPS, groupIds: IDS }));
    expect(copy).toMatchObject({ current: PERSONAL, makeCopy: true, others: [G1S, G2S] });
  });

  it("shared：move＝共享私人、沒有下半部；copy 沒有上半部", () => {
    const s = sharedNote({ id: "s", title: "S" });
    const move = asSource(batchDestSource({ tab: "shared", mode: "move", eligible: [noteT(s)], groups: GROUPS, groupIds: IDS }));
    expect(move).toMatchObject({ current: { kind: "shared" }, makeCopy: false, others: [] });
    const copy = asSource(batchDestSource({ tab: "shared", mode: "copy", eligible: [noteT(s)], groups: GROUPS, groupIds: IDS }));
    expect(copy).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL, G1S, G2S] });
  });
});

describe("SMf8 movingFolders 與第一層為空（I2）", () => {
  it("myNotes move 選了資料夾 → movingFolders 非空（只 move；locations 用 parentId）", () => {
    const move = asSource(batchDestSource({ tab: "myNotes", mode: "move", eligible: [folderT(FA1), noteT(P3)], groups: [G1], groupIds: new Set(["g1"]) }));
    expect(move.movingFolders).toEqual([FA1]);
    expect(move.locations).toEqual(["A", null]);
    const copy = asSource(batchDestSource({ tab: "myNotes", mode: "copy", eligible: [folderT(FA1)], groups: [G1], groupIds: new Set(["g1"]) }));
    expect(copy.movingFolders).toEqual([]);
  });

  it("shared move、全在根層、沒有共享資料夾 → isEmptyDestination 為 true；有共享資料夾 → false", () => {
    const s = sharedNote({ id: "s", title: "S" });
    const src = asSource(batchDestSource({ tab: "shared", mode: "move", eligible: [noteT(s)], groups: [], groupIds: new Set() }));
    expect(isEmptyDestination(src, EMPTY_FOLDER_INDEX, t)).toBe(true);
    expect(isEmptyDestination(src, indexFolders([sharedFolder({ id: "SF", name: "SF" })]), t)).toBe(false);
  });
});

describe("SMf9 isSameSpace", () => {
  const personalSource = asSource(batchDestSource({ tab: "myNotes", mode: "move", eligible: [noteT(P3)], groups: [G1], groupIds: new Set(["g1"]) }));
  const groupSource = asSource(batchDestSource({ tab: "workspace", mode: "move", eligible: [noteT(G1A)], groups: [G1], groupIds: new Set(["g1"]) }));
  const recentSource = asSource(batchDestSource({ tab: "recent", mode: "copy", eligible: [noteT(P3)], groups: [G1], groupIds: new Set(["g1"]) }));

  it("個人資料夾／個人根層 vs current 個人 → true", () => {
    expect(isSameSpace({ kind: "place", space: { kind: "personal" }, folder: FA }, personalSource)).toBe(true);
    expect(isSameSpace(PERSONAL_ROOT, personalSource)).toBe(true);
  });

  it("群組根層 vs current 個人 → false（跨空間）", () => {
    expect(isSameSpace(groupRoot("g1", "Group 1"), personalSource)).toBe(false);
  });

  it("同群組 → true；別的群組 → false", () => {
    expect(isSameSpace(groupRoot("g1", "Group 1"), groupSource)).toBe(true);
    expect(isSameSpace(groupRoot("g2", "Group 2"), groupSource)).toBe(false);
  });

  it("makeCopy、或沒有上半部 → false", () => {
    expect(isSameSpace({ kind: "makeCopy" }, personalSource)).toBe(false);
    expect(isSameSpace(PERSONAL_ROOT, recentSource)).toBe(false);
  });
});

describe("SMf10 selectionResultTitle（資料夾）", () => {
  const GF = groupFolder({ id: "GF", name: "GF", groupId: "g", parentId: null });
  const INTO_A: DestTarget = { kind: "place", space: { kind: "personal" }, folder: FA };

  it("move 同空間 (notes 1, folders 1, A) → Moved 2 items", () => {
    expect(
      selectionResultTitle(tally({ action: "move", notesDone: 1, foldersDone: 1, sameSpace: true, destination: INTO_A, destinationName: "A" }), t),
    ).toBe("Moved 2 items to “A”");
  });

  it("delete (folders 2, via 3)", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 2, trashedViaFolders: 3 }), t)).toBe("2 folders deleted; 3 notes moved to the trash");
  });

  it("delete 資料夾＋另選的筆記：後綴篇數＝連帶＋另選", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 1, trashedViaFolders: 1, notesDone: 1 }), t)).toBe(
      "1 folder deleted; 2 notes moved to the trash",
    );
  });

  it("delete 空資料夾 → 沒有筆記後綴", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 1 }), t)).toBe("1 folder deleted");
  });

  it("shared delete → foldersRemoved", () => {
    expect(selectionResultTitle(tally({ action: "delete", tab: "shared", foldersDone: 1 }), t)).toBe(
      "1 folder removed; its shared notes moved back to the top level",
    );
  });

  it("blocked 1＋gone 1 → 兩後綴依序（擋下在前、已不存在在後）", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersDone: 1, foldersBlocked: 1, foldersGone: 1 }), t)).toBe(
      "1 folder deleted, 1 folder wasn't deleted (it holds notes you can't delete), 1 folder no longer exists",
    );
  });

  it("筆記略過在資料夾略過之前", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 1, notesSkipped: 1, foldersSkipped: 2 }), t)).toBe(
      "Moved 1 note to the trash, 1 skipped (no permission, or it no longer exists), 2 folders skipped (no permission, or they no longer exist)",
    );
  });

  it("全 0 只有 blocked → Nothing was done＋擋下後綴", () => {
    expect(selectionResultTitle(tally({ action: "delete", foldersBlocked: 1 }), t)).toBe(
      "Nothing was done, 1 folder wasn't deleted (it holds notes you can't delete)",
    );
  });

  it("全 0、筆記略過 1、資料夾略過 1 → noneDone＋資料夾後綴", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesSkipped: 1, foldersSkipped: 1 }), t)).toBe(
      "Nothing was done; 1 skipped (no permission, or it no longer exists), 1 folder skipped (no permission, or it no longer exists)",
    );
  });

  it("m6 delete foldersDone 0、notesDone 1 → trashed", () => {
    expect(selectionResultTitle(tally({ action: "delete", notesDone: 1 }), t)).toBe("Moved 1 note to the trash");
  });

  describe("copy（I-B：沿用既有鍵）", () => {
    it("個人根層 1 篇 → copiedToPersonal", () => {
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: PERSONAL_ROOT, destinationName: "My notes" }), t)).toBe(
        "Copied 1 note to My notes",
      );
    });

    it("個人資料夾 A 2 篇 → copiedToGroup（完整路徑）", () => {
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 2, destination: INTO_A, destinationName: "My notes › A" }), t)).toBe(
        'Copied 2 notes into "My notes › A"',
      );
    });

    it("群組根層 → copiedToGroup", () => {
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 2, destination: groupRoot("g", "G"), destinationName: "G" }), t)).toBe(
        'Copied 2 notes into "G"',
      );
    });

    it("群組資料夾 → copiedToGroup（完整路徑）", () => {
      const destination: DestTarget = { kind: "place", space: { kind: "group", groupId: "g", name: "G" }, folder: GF };
      expect(selectionResultTitle(tally({ action: "copy", notesDone: 1, destination, destinationName: "G › GF" }), t)).toBe('Copied 1 note into "G › GF"');
    });

    it("建立副本、來源個人 → copiedToPersonal", () => {
      expect(
        selectionResultTitle(tally({ action: "copy", notesDone: 1, destination: { kind: "makeCopy" }, copySource: { kind: "personal" } }), t),
      ).toBe("Copied 1 note to My notes");
    });

    it("建立副本、來源群組 G → copiedToGroup（群組名）", () => {
      expect(
        selectionResultTitle(
          tally({ action: "copy", notesDone: 2, destination: { kind: "makeCopy" }, copySource: { kind: "group", groupId: "g", name: "G" } }),
          t,
        ),
      ).toBe('Copied 2 notes into "G"');
    });
  });

  it("zh-TW 兩案：同空間移動、刪資料夾", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(
        selectionResultTitle(tally({ action: "move", notesDone: 1, foldersDone: 1, sameSpace: true, destination: INTO_A, destinationName: "A" }), t),
      ).toBe("已移 2 項到「A」");
      expect(selectionResultTitle(tally({ action: "delete", foldersDone: 2, trashedViaFolders: 3, foldersBlocked: 1 }), t)).toBe(
        "已刪除 2 個資料夾，3 篇筆記已移到垃圾桶，1 個資料夾沒有刪除（裡面有你不能刪除的筆記）",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
