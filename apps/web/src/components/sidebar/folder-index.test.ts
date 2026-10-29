import { afterEach, describe, expect, it } from "vitest";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { baseNote } from "@/test/select-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "./collapse";
import { __resetFolderSortForTests } from "./folder-sort";
import type { NoteDto } from "@knotebook/shared";
import {
  EMPTY_FOLDER_INDEX,
  expandFolderChain,
  folderDepth,
  folderPath,
  indexFolders,
  isInSubtree,
  liveNotesUnder,
  subtreeFolderIds,
  subtreeHeight,
  type FolderSpaceKey,
} from "./folder-index";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

const ids = (list: readonly { id: string }[]) => list.map((item) => item.id);
/** 測試用的筆記空間：群組筆記 → group:<id>、其餘 → personal（產品碼由 tree.ts 的 noteSpaceKey 給）。 */
const spaceOf = (note: NoteDto): FolderSpaceKey => (note.groupId === null ? "personal" : `group:${note.groupId}`);

describe("indexFolders", () => {
  it("FI1 三空間各兩層、輸入打亂 → children 依名稱（numeric：第 2 章在第 10 章前；sensitivity base：a／A 相等時維持輸入序）", () => {
    const index = indexFolders([
      folderDto({ id: "p10", name: "第 10 章" }),
      sharedFolder({ id: "sZ", name: "Zed" }),
      folderDto({ id: "pUpper", name: "A" }),
      groupFolder({ id: "gChildB", name: "Beta", groupId: "g1", parentId: "gZ" }),
      folderDto({ id: "p2", name: "第 2 章" }),
      groupFolder({ id: "gZ", name: "Zed", groupId: "g1" }),
      folderDto({ id: "pLower", name: "a" }),
      sharedFolder({ id: "sChildB", name: "Beta", parentId: "sA" }),
      folderDto({ id: "c2", name: "Beta", parentId: "p2" }),
      groupFolder({ id: "gA", name: "Ann", groupId: "g1" }),
      sharedFolder({ id: "sA", name: "Ann" }),
      folderDto({ id: "c1", name: "Alpha", parentId: "p2" }),
      groupFolder({ id: "gChildA", name: "Alpha", groupId: "g1", parentId: "gZ" }),
      sharedFolder({ id: "sChildA", name: "Alpha", parentId: "sA" }),
    ]);
    // zh-Hant collator：漢字排在拉丁字母前
    expect(ids(index.children("personal", null))).toEqual(["p2", "p10", "pUpper", "pLower"]);
    expect(ids(index.children("personal", "p2"))).toEqual(["c1", "c2"]);
    expect(ids(index.children("group:g1", null))).toEqual(["gA", "gZ"]);
    expect(ids(index.children("group:g1", "gZ"))).toEqual(["gChildA", "gChildB"]);
    expect(ids(index.children("shared", null))).toEqual(["sA", "sZ"]);
    expect(ids(index.children("shared", "sA"))).toEqual(["sChildA", "sChildB"]);
    expect(index.byId.get("c1")?.name).toBe("Alpha");
  });

  it("FI2 parentId 指向不存在的 id → 出現在該空間根層", () => {
    const index = indexFolders([folderDto({ id: "root", name: "Root" }), folderDto({ id: "lost", name: "Lost", parentId: "missing" })]);
    expect(ids(index.children("personal", null))).toEqual(["lost", "root"]);
  });

  it("FI3 parentId 指向別空間的資料夾 → 根層（不掛在別空間的父層下）", () => {
    const index = indexFolders([groupFolder({ id: "gf", name: "Group folder", groupId: "g1" }), folderDto({ id: "mine", name: "Mine", parentId: "gf" })]);
    expect(ids(index.children("personal", null))).toEqual(["mine"]);
    expect(ids(index.children("group:g1", "gf"))).toEqual([]);
    expect(ids(index.children("personal", "gf"))).toEqual([]);
  });

  it("FI4 環（A.parent=B、B.parent=A）：不掛；folderPath 名稱不重複、subtreeFolderIds id 不重複，長度 ≤ 資料夾數", () => {
    const folders = [folderDto({ id: "cA", name: "Cyc A", parentId: "cB" }), folderDto({ id: "cB", name: "Cyc B", parentId: "cA" })];
    const index = indexFolders(folders);
    const path = folderPath(index, "cA");
    expect(path).not.toBeNull();
    expect(new Set(path).size).toBe(path!.length);
    expect(path!.length).toBeLessThanOrEqual(folders.length);
    expect(path!.at(-1)).toBe("Cyc A");
    const subtree = subtreeFolderIds(index, "cA");
    expect(new Set(subtree).size).toBe(subtree.length);
    expect(subtree.length).toBeLessThanOrEqual(folders.length);
    expect(subtree[0]).toBe("cA");
  });

  it("EMPTY_FOLDER_INDEX：沒有資料夾、任何 children 都是 []", () => {
    expect(EMPTY_FOLDER_INDEX.byId.size).toBe(0);
    expect(EMPTY_FOLDER_INDEX.children("personal", null)).toEqual([]);
  });
});

describe("folderPath／subtreeFolderIds／liveNotesUnder", () => {
  it("FI5 三層 → [A, B, C]；不存在 → null", () => {
    const index = indexFolders(folderChain("L", 3).map((folder, i) => ({ ...folder, name: ["A", "B", "C"][i]! })));
    expect(folderPath(index, "L3")).toEqual(["A", "B", "C"]);
    expect(folderPath(index, "L1")).toEqual(["A"]);
    expect(folderPath(index, "nope")).toBeNull();
  });

  it("FI6 subtreeFolderIds：含自己、含孫、不含兄弟", () => {
    const index = indexFolders([
      folderDto({ id: "A", name: "A" }),
      folderDto({ id: "B", name: "B", parentId: "A" }),
      folderDto({ id: "C", name: "C", parentId: "B" }),
      folderDto({ id: "B2", name: "B2", parentId: "A" }),
      folderDto({ id: "S", name: "S" }),
    ]);
    const subtree = subtreeFolderIds(index, "A");
    expect([...subtree].sort()).toEqual(["A", "B", "B2", "C"]);
    expect(subtree).not.toContain("S");
    expect(subtreeFolderIds(index, "B")).toEqual(["B", "C"]);
  });

  it("FI7 liveNotesUnder：子樹內兩篇＋孫資料夾一篇 → 三篇；子樹外與根層不算", () => {
    const index = indexFolders([
      folderDto({ id: "A", name: "A" }),
      folderDto({ id: "B", name: "B", parentId: "A" }),
      folderDto({ id: "C", name: "C", parentId: "B" }),
      folderDto({ id: "S", name: "S" }),
    ]);
    const notes = [
      baseNote({ id: "inA", title: "in A", folderId: "A" }),
      baseNote({ id: "outS", title: "out S", folderId: "S" }),
      baseNote({ id: "inB", title: "in B", folderId: "B" }),
      baseNote({ id: "root", title: "root", folderId: null }),
      baseNote({ id: "inC", title: "in C", folderId: "C" }),
    ];
    expect(ids(liveNotesUnder(index, "A", notes, spaceOf))).toEqual(["inA", "inB", "inC"]);
  });

  it("FI7b liveNotesUnder 比對空間：筆記空間與資料夾空間不符（快取錯亂）→ 不算（與樹的兜底一致）", () => {
    const index = indexFolders([groupFolder({ id: "gf", name: "Group folder", groupId: "g1" })]);
    const notes = [
      baseNote({ id: "groupIn", title: "group in", groupId: "g1", group: { id: "g1", name: "G1" }, folderId: "gf" }),
      baseNote({ id: "personalCross", title: "personal cross", folderId: "gf" }),
    ];
    expect(ids(liveNotesUnder(index, "gf", notes, spaceOf))).toEqual(["groupIn"]);
  });

  it("FI9 環與自指：斷環後 parentOf、folderPath、expandFolderChain 一致（環入口當根層、其餘照原父層）", () => {
    // D 先出現：從 D 往上走，第一個重複的是 cA → 在 cA 斷開；D 仍掛在 cA 下
    const index = indexFolders([
      folderDto({ id: "D", name: "D", parentId: "cA" }),
      folderDto({ id: "cA", name: "Cyc A", parentId: "cB" }),
      folderDto({ id: "cB", name: "Cyc B", parentId: "cA" }),
      folderDto({ id: "self", name: "Self", parentId: "self" }),
    ]);
    expect(index.parentOf("cA")).toBeNull();
    expect(index.parentOf("cB")).toBe("cA");
    expect(index.parentOf("D")).toBe("cA");
    expect(index.parentOf("self")).toBeNull();
    expect(ids(index.children("personal", null))).toEqual(["cA", "self"]);
    expect(folderPath(index, "cA")).toEqual(["Cyc A"]);
    expect(folderPath(index, "cB")).toEqual(["Cyc A", "Cyc B"]);
    expect(folderPath(index, "self")).toEqual(["Self"]);
    for (const id of ["cA", "cB", "D"]) setCollapsed(`folder:${id}`, true);
    expandFolderChain(index, "cA");
    expect(isCollapsed("folder:cA")).toBe(false);
    expect(isCollapsed("folder:cB")).toBe(true);
    expandFolderChain(index, "D");
    expect(isCollapsed("folder:D")).toBe(false);
    expect(isCollapsed("folder:cB")).toBe(true);
  });
});

describe("expandFolderChain", () => {
  it("FI8 三層都收合 → 呼叫後三層皆展開、兄弟不受影響；id 不在索引 → 只寫自己那把鍵、不丟錯", () => {
    const index = indexFolders([...folderChain("L", 3), folderDto({ id: "sib", name: "Sibling", parentId: "L1" })]);
    for (const id of ["L1", "L2", "L3", "sib"]) setCollapsed(`folder:${id}`, true);
    expandFolderChain(index, "L3");
    expect(isCollapsed("folder:L1")).toBe(false);
    expect(isCollapsed("folder:L2")).toBe(false);
    expect(isCollapsed("folder:L3")).toBe(false);
    expect(isCollapsed("folder:sib")).toBe(true);

    setCollapsed("folder:ghost", true);
    expect(() => expandFolderChain(index, "ghost")).not.toThrow();
    expect(isCollapsed("folder:ghost")).toBe(false);
    expect(isCollapsed("folder:sib")).toBe(true);
  });
});

describe("深度與子樹", () => {
  it("FI-D1 folderDepth：根層 1、第 3 層 3、不存在 0", () => {
    const index = indexFolders(folderChain("A", 3));
    expect(folderDepth(index, "A1")).toBe(1);
    expect(folderDepth(index, "A3")).toBe(3);
    expect(folderDepth(index, "nope")).toBe(0);
  });

  it("FI-D2 subtreeHeight：葉 1、3 層鏈的根 3、較淺的兄弟不影響", () => {
    const index = indexFolders([...folderChain("A", 3), folderDto({ id: "S", name: "S", parentId: "A1" })]);
    expect(subtreeHeight(index, "A3")).toBe(1);
    expect(subtreeHeight(index, "S")).toBe(1);
    expect(subtreeHeight(index, "A1")).toBe(3);
  });

  it("FI-D3 isInSubtree：自己與孫 true；兄弟與祖先 false", () => {
    const index = indexFolders([...folderChain("A", 3), folderDto({ id: "S", name: "S", parentId: "A1" })]);
    expect(isInSubtree(index, "A2", "A2")).toBe(true);
    expect(isInSubtree(index, "A1", "A3")).toBe(true);
    expect(isInSubtree(index, "A2", "S")).toBe(false);
    expect(isInSubtree(index, "A2", "A1")).toBe(false);
  });
});
