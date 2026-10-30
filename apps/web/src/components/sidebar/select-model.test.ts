import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GroupDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { customRole, groupDto, memberRole } from "@/test/fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import { folderDto } from "@/test/folder-fixtures";
import { __resetCollapseForTests, setCollapsed } from "./collapse";
import { EMPTY_FOLDER_INDEX, indexFolders } from "./folder-index";
import { __resetFolderSortForTests } from "./folder-sort";
import {
  buildDestinationTree,
  destinationBody,
  partitionEligible,
  SELECT_ACTIONS,
  selectedTabNotes,
  selectionResultTitle,
  tabNotes,
  visibleNoteKeys,
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

describe("SMd8 selectionResultTitle", () => {
  const GROUP_A = { kind: "group", groupId: "ga", name: "A" } as const;

  it("delete (3, 0)", () => {
    expect(selectionResultTitle({ action: "delete", done: 3, skipped: 0, destination: null }, t)).toBe("Moved 3 notes to the trash");
  });

  it("delete (1, 2)：接略過後綴", () => {
    expect(selectionResultTitle({ action: "delete", done: 1, skipped: 2, destination: null }, t)).toBe(
      "Moved 1 note to the trash, 2 skipped (no permission, or they no longer exist)",
    );
  });

  it("delete (0, 2)：沒有處理任何筆記", () => {
    expect(selectionResultTitle({ action: "delete", done: 0, skipped: 2, destination: null }, t)).toBe(
      "Nothing was done; 2 skipped (no permission, or they no longer exist)",
    );
  });

  it("move (2, 0, A)", () => {
    expect(selectionResultTitle({ action: "move", done: 2, skipped: 0, destination: GROUP_A }, t)).toBe('Moved 2 notes into "A"');
  });

  it("copy personal (1, 0)", () => {
    expect(selectionResultTitle({ action: "copy", done: 1, skipped: 0, destination: { kind: "personal" } }, t)).toBe("Copied 1 note to My notes");
  });

  it("copy group (2, 0, A)", () => {
    expect(selectionResultTitle({ action: "copy", done: 2, skipped: 0, destination: GROUP_A }, t)).toBe('Copied 2 notes into "A"');
  });

  it("move (0, 1, A)：沒有處理任何筆記（不只 delete）", () => {
    expect(selectionResultTitle({ action: "move", done: 0, skipped: 1, destination: GROUP_A }, t)).toBe(
      "Nothing was done; 1 skipped (no permission, or it no longer exists)",
    );
  });

  it("move／copy 沒有目的地 → throw（契約錯誤，不出空群組名）", () => {
    for (const action of ["move", "copy"] as const) {
      expect(() => selectionResultTitle({ action, done: 1, skipped: 0, destination: null }, t)).toThrow(`${action} needs a destination`);
    }
  });

  it("zh-TW delete (2, 1)", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      expect(selectionResultTitle({ action: "delete", done: 2, skipped: 1, destination: null }, t)).toBe("已移到垃圾桶 2 篇，1 篇略過（沒有權限或已不存在）");
    } finally {
      await i18n.changeLanguage("en");
    }
  });
});
