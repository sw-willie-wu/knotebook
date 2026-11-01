import { beforeEach, describe, expect, it } from "vitest";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import en from "@/i18n/en.json";
import zhTW from "@/i18n/zh-TW.json";
import { customRole, groupDto, memberRole } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import {
  buildDestinationLevel,
  destinationPathLabel,
  destinationShortLabel,
  isEmptyDestination,
  noteDestSource,
  spaceKey,
  type DestItem,
  type DestMode,
  type DestPathStep,
  type DestSource,
  type DestSpace,
} from "./destination-level";
import { EMPTY_FOLDER_INDEX, indexFolders, type FolderIndex } from "./folder-index";

/**
 * 逐層目的地清單（資料夾 spec §6.11.1–§6.11.3、§6.10「批次的目的地」；PR-3b-2 T2）。
 * fixture：個人資料夾 A ⊃ A1、B；群組 G（member：create＋edit）有 GF ⊃ GF1；群組 H（member）無資料夾；群組 R（只讀）；共享資料夾 SF。
 * 斷言形一律比 `[kind, label, 有沒有 drill, disabled]`。
 */

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const G: GroupDto = groupDto({ id: "g", name: "G" }, memberRole());
const H: GroupDto = groupDto({ id: "h", name: "H" }, memberRole());
const R: GroupDto = groupDto({ id: "r", name: "R" }, customRole());
const GROUPS: readonly GroupDto[] = [G, H, R];

const A = folderDto({ id: "A", name: "A" });
const A1 = folderDto({ id: "A1", name: "A1", parentId: "A" });
const B = folderDto({ id: "B", name: "B" });
const GF = groupFolder({ id: "GF", name: "GF", groupId: "g" });
const GF1 = groupFolder({ id: "GF1", name: "GF1", groupId: "g", parentId: "GF" });
const SF = sharedFolder({ id: "SF", name: "SF" });
const INDEX = indexFolders([A, A1, B, GF, GF1, SF]);

const PERSONAL: DestSpace = { kind: "personal" };
const SHARED: DestSpace = { kind: "shared" };
const G_SPACE: DestSpace = { kind: "group", groupId: "g", name: "G" };
const H_SPACE: DestSpace = { kind: "group", groupId: "h", name: "H" };

type Shape = [DestItem["kind"], string, boolean, string | null];

function shape(items: readonly DestItem[]): Shape[] {
  return items.map((item): Shape => {
    if (item.kind === "separator") return ["separator", "", false, null];
    if (item.kind === "back") return ["back", item.label, false, null];
    const drill = "drill" in item && item.drill !== null;
    return [item.kind, item.label, drill, item.disabled];
  });
}

function level(source: DestSource, path: readonly DestPathStep[] = [], index: FolderIndex = INDEX): DestItem[] {
  return buildDestinationLevel({ source, path, index, t });
}

function noteLevel(note: NoteDto, mode: DestMode, path: readonly DestPathStep[] = [], index: FolderIndex = INDEX): Shape[] {
  return shape(level(noteDestSource(note, mode, GROUPS), path, index));
}

function batch(o: Partial<DestSource> & { movingFolders?: readonly FolderDto[] }): DestSource {
  return { mode: "move", current: PERSONAL, makeCopy: false, others: [G_SPACE, H_SPACE], locations: [null], movingFolders: [], ...o };
}

const SEP: Shape = ["separator", "", false, null];
const BACK: Shape = ["back", "Back", false, null];

const mine = (folderId: string | null = null) => personalNote({ id: "n1", title: "N", folderId });
const inG = (folderId: string | null = null, edit = true) => groupNote({ id: "g1", title: "GN", group: G, edit, folderId });
const shared = (folderId: string | null = null) => sharedNote({ id: "s1", title: "SN", folderId });

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("DL1 個人筆記在根、move、第一層", () => {
  it("[folder A ›, folder B, sep, space G ›, space H]：沒有根目錄、沒有 R", () => {
    expect(noteLevel(mine(), "move")).toEqual([
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("目標與 drill：資料夾＝放進它、空間＝它的根層；drill 指向下一層", () => {
    const items = level(noteDestSource(mine(), "move", GROUPS));
    const a = items[0]!;
    const b = items[1]!;
    const g = items[3]!;
    const h = items[4]!;
    expect(a).toMatchObject({ kind: "folder", target: { kind: "place", space: PERSONAL, folder: A }, drill: { kind: "folder", folderId: "A" } });
    expect(b).toMatchObject({ kind: "folder", target: { kind: "place", space: PERSONAL, folder: B }, drill: null });
    expect(g).toMatchObject({ kind: "space", target: { kind: "place", space: G_SPACE, folder: null }, drill: { kind: "space", space: G_SPACE } });
    expect(h).toMatchObject({ kind: "space", target: { kind: "place", space: H_SPACE, folder: null }, drill: null });
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });
});

describe("DL2 同一篇在 A1、move", () => {
  it("第一層多「根目錄」在最前", () => {
    expect(noteLevel(mine("A1"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
    expect(level(noteDestSource(mine("A1"), "move", GROUPS))[0]).toMatchObject({ target: { kind: "place", space: PERSONAL, folder: null } });
  });
});

describe("DL3 點進 A", () => {
  const PATH: DestPathStep[] = [{ kind: "folder", folderId: "A" }];

  it("筆記在 A1：[back, here, folder A1]、無分隔線、here 不反灰；A1 就是所在處且沒有子資料夾 → current", () => {
    expect(noteLevel(mine("A1"), "move", PATH)).toEqual([BACK, ["here", "Move here", false, null], ["folder", "A1", false, "current"]]);
    expect(level(noteDestSource(mine("A1"), "move", GROUPS), PATH)[1]).toMatchObject({ target: { kind: "place", space: PERSONAL, folder: A } });
  });

  it("筆記在 A：here → current", () => {
    expect(noteLevel(mine("A"), "move", PATH)).toEqual([BACK, ["here", "Move here", false, "current"], ["folder", "A1", false, null]]);
  });
});

describe("DL4 點進 G", () => {
  it("[back, root, folder GF ›]：根目錄恆顯示、指 G 的根層", () => {
    const path: DestPathStep[] = [{ kind: "space", space: G_SPACE }];
    expect(noteLevel(mine(), "move", path)).toEqual([BACK, ["root", "Top level", false, null], ["folder", "GF", true, null]]);
    const items = level(noteDestSource(mine(), "move", GROUPS), path);
    expect(items[1]).toMatchObject({ target: { kind: "place", space: G_SPACE, folder: null } });
    expect(items[2]).toMatchObject({ target: { kind: "place", space: G_SPACE, folder: GF }, drill: { kind: "folder", folderId: "GF" } });
  });

  it("再點進 GF：[back, here, folder GF1]", () => {
    const path: DestPathStep[] = [{ kind: "space", space: G_SPACE }, { kind: "folder", folderId: "GF" }];
    expect(noteLevel(mine(), "move", path)).toEqual([BACK, ["here", "Move here", false, null], ["folder", "GF1", false, null]]);
  });
});

describe("DL5 就是所在處、又沒有子資料夾的資料夾項", () => {
  it("筆記在 B → B current、A 不反灰", () => {
    expect(noteLevel(mine("B"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, "current"],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });
});

describe("DL6 群組筆記 move", () => {
  it("edit：在根 → [folder GF ›]、無下半部；在 GF1 → [root, folder GF ›]", () => {
    expect(noteLevel(inG(), "move")).toEqual([["folder", "GF", true, null]]);
    expect(noteLevel(inG("GF1"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "GF", true, null],
    ]);
    expect(noteDestSource(inG(), "move", GROUPS)).toMatchObject({ current: G_SPACE, others: [], locations: [null] });
  });

  it("edit: false → isEmptyDestination 為 true", () => {
    expect(isEmptyDestination(noteDestSource(inG(null, false), "move", GROUPS), INDEX, t)).toBe(true);
    expect(isEmptyDestination(noteDestSource(inG(), "move", GROUPS), INDEX, t)).toBe(false);
  });
});

describe("DL7 共享筆記 move", () => {
  it("沒放置 → [folder SF]；放在 SF → [root, folder SF current]", () => {
    expect(noteLevel(shared(), "move")).toEqual([["folder", "SF", false, null]]);
    expect(noteLevel(shared("SF"), "move")).toEqual([
      ["root", "Top level", false, null],
      ["folder", "SF", false, "current"],
    ]);
    expect(level(noteDestSource(shared(), "move", GROUPS))[0]).toMatchObject({ target: { kind: "place", space: SHARED, folder: SF } });
  });

  it("沒有共享資料夾也沒有放置 → 空；有共享資料夾 → 不空", () => {
    const noShared = indexFolders([A, A1, B, GF, GF1]);
    expect(isEmptyDestination(noteDestSource(shared(), "move", GROUPS), noShared, t)).toBe(true);
    expect(isEmptyDestination(noteDestSource(shared(), "move", GROUPS), INDEX, t)).toBe(false);
  });
});

describe("DL8 copy 三形", () => {
  it("個人筆記 → [makeCopy, folder A ›, folder B, sep, space G ›, space H]（下半部不含我的筆記）", () => {
    expect(noteLevel(mine(), "copy")).toEqual([
      ["makeCopy", "Make a copy", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
    expect(level(noteDestSource(mine(), "copy", GROUPS))[0]).toMatchObject({ target: { kind: "makeCopy" } });
  });

  it("群組筆記（G 是候選）→ [makeCopy, folder GF ›, sep, space 我的筆記 ›, space H]", () => {
    expect(noteLevel(inG(), "copy")).toEqual([
      ["makeCopy", "Make a copy", false, null],
      ["folder", "GF", true, null],
      SEP,
      ["space", "My notes", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("共享筆記 → [space 我的筆記 ›, space G ›, space H]（無上半部、無分隔線）", () => {
    expect(noteLevel(shared("SF"), "copy")).toEqual([
      ["space", "My notes", true, null],
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("R 的只讀筆記 copy → [space 我的筆記 ›, space G ›, space H]", () => {
    const readOnly = groupNote({ id: "r1", title: "RN", group: R, edit: false });
    expect(noteLevel(readOnly, "copy")).toEqual([
      ["space", "My notes", true, null],
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
  });

  it("copy 的 here 與資料夾項在來源位置不反灰", () => {
    expect(noteLevel(mine("B"), "copy")).toEqual([
      ["makeCopy", "Make a copy", false, null],
      ["root", "Top level", false, null],
      ["folder", "A", true, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", true, null],
      ["space", "H", false, null],
    ]);
    expect(noteLevel(mine("A"), "copy", [{ kind: "folder", folderId: "A" }])).toEqual([
      BACK,
      ["here", "Copy here", false, null],
      ["folder", "A1", false, null],
    ]);
  });
});

describe("DL9 批次 move 帶資料夾", () => {
  it("movingFolders=[A] → A self 無 drill；下半部 G、H crossSpace 無 drill", () => {
    expect(shape(level(batch({ movingFolders: [A] })))).toEqual([
      ["folder", "A", false, "self"],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", false, "crossSpace"],
      ["space", "H", false, "crossSpace"],
    ]);
  });

  it("點進 B 的 here 可按", () => {
    expect(shape(level(batch({ movingFolders: [A] }), [{ kind: "folder", folderId: "B" }]))).toEqual([
      BACK,
      ["here", "Move here", false, null],
    ]);
  });

  it("子孫也是 self（路徑已在 A 裡，例如快取更新前點進）", () => {
    expect(shape(level(batch({ movingFolders: [A] }), [{ kind: "folder", folderId: "A" }]))).toEqual([
      BACK,
      ["here", "Move here", false, "self"],
      ["folder", "A1", false, "self"],
    ]);
  });
});

describe("DL10 深度上限（server：parentDepth + height > FOLDER_DEPTH_MAX）", () => {
  const D = folderChain("D", 4);
  const DEEP = indexFolders([A, A1, B, ...D]);
  const source = batch({ movingFolders: [A] }); // A 高度 2

  it("點進 D1 › D2 › D3：here（D3，3＋2＝5）可按、D4（4＋2＝6）tooDeep", () => {
    const path: DestPathStep[] = ["D1", "D2", "D3"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, path, DEEP))).toEqual([BACK, ["here", "Move here", false, null], ["folder", "D4", false, "tooDeep"]]);
  });

  it("點進 D1 › D2：D3 可按且帶 drill", () => {
    const path: DestPathStep[] = ["D1", "D2"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, path, DEEP))).toEqual([BACK, ["here", "Move here", false, null], ["folder", "D3", true, null]]);
  });

  it("tooDeep 的資料夾即使有子資料夾也不帶 drill；它的 here 也 tooDeep", () => {
    const D5 = folderChain("D", 5);
    const deeper = indexFolders([A, A1, B, ...D5]);
    const path: DestPathStep[] = ["D1", "D2", "D3"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, path, deeper))).toEqual([BACK, ["here", "Move here", false, null], ["folder", "D4", false, "tooDeep"]]);
    const inD4: DestPathStep[] = ["D1", "D2", "D3", "D4"].map((folderId) => ({ kind: "folder", folderId }));
    expect(shape(level(source, inD4, deeper))[1]).toEqual(["here", "Move here", false, "tooDeep"]);
  });
});

describe("DL11 全部已在該處才反灰（批次）", () => {
  const FLAT = indexFolders([A, B]); // A 沒有子資料夾的版本

  it("一在 A、一在根 → A 不反灰", () => {
    expect(shape(level(batch({ locations: ["A", null] }), [], FLAT))).toEqual([
      ["root", "Top level", false, null],
      ["folder", "A", false, null],
      ["folder", "B", false, null],
      SEP,
      ["space", "G", false, null],
      ["space", "H", false, null],
    ]);
  });

  it("兩項都在 A → A current", () => {
    expect(shape(level(batch({ locations: ["A", "A"] }), [], FLAT))[1]).toEqual(["folder", "A", false, "current"]);
  });
});

describe("DL12 資料夾未載到（EMPTY_FOLDER_INDEX）", () => {
  it("只有根目錄與空間項、全部無 drill", () => {
    expect(noteLevel(mine("A1"), "move", [], EMPTY_FOLDER_INDEX)).toEqual([
      ["root", "Top level", false, null],
      SEP,
      ["space", "G", false, null],
      ["space", "H", false, null],
    ]);
    expect(noteLevel(shared(), "copy", [], EMPTY_FOLDER_INDEX)).toEqual([
      ["space", "My notes", false, null],
      ["space", "G", false, null],
      ["space", "H", false, null],
    ]);
  });
});

describe("DL13 path 指到不存在的資料夾", () => {
  it("A1 已不在 → 回到 A 那層", () => {
    const noA1 = indexFolders([A, B, GF, GF1, SF]);
    const path: DestPathStep[] = [{ kind: "folder", folderId: "A" }, { kind: "folder", folderId: "A1" }];
    expect(noteLevel(mine(), "move", path, noA1)).toEqual([BACK, ["here", "Move here", false, null]]);
  });

  it("第一步就不在 → 回到第一層（後面仍存在的步也丟掉）", () => {
    const path: DestPathStep[] = [{ kind: "folder", folderId: "gone" }, { kind: "folder", folderId: "A1" }];
    expect(noteLevel(mine(), "move", path)).toEqual(noteLevel(mine(), "move"));
  });

  it("點進的空間已不在 source（群組清單重抓後消失）→ 回到第一層", () => {
    const path: DestPathStep[] = [{ kind: "space", space: { kind: "group", groupId: "x", name: "X" } }];
    expect(noteLevel(mine(), "move", path)).toEqual(noteLevel(mine(), "move"));
  });
});

describe("DL14 可及名稱與路徑字串", () => {
  it("en：drill 項「A, open」、back「Back」、其餘＝label", () => {
    const items = level(noteDestSource(mine(), "move", GROUPS));
    expect(items[0]).toMatchObject({ label: "A", accessibleName: "A, open" });
    expect(items[1]).toMatchObject({ label: "B", accessibleName: "B" });
    expect(items[3]).toMatchObject({ label: "G", accessibleName: "G, open" });
    const inner = level(noteDestSource(mine(), "move", GROUPS), [{ kind: "folder", folderId: "A" }]);
    expect(inner[0]).toMatchObject({ kind: "back", label: "Back", accessibleName: "Back" });
    expect(inner[1]).toMatchObject({ accessibleName: "Move here" });
  });

  it("zh-TW：drill 項「A，開啟下一層」、back「返回」", async () => {
    await i18n.changeLanguage("zh-TW");
    const items = level(noteDestSource(mine(), "move", GROUPS));
    expect(items[0]).toMatchObject({ accessibleName: "A，開啟下一層" });
    const inner = level(noteDestSource(mine(), "move", GROUPS), [{ kind: "folder", folderId: "A" }]);
    expect(inner[0]).toMatchObject({ label: "返回", accessibleName: "返回" });
  });

  it("destinationPathLabel：個人 A1、群組根、共享 SF", () => {
    expect(destinationPathLabel(PERSONAL, A1, INDEX, t)).toBe("My notes › A › A1");
    expect(destinationPathLabel(G_SPACE, null, INDEX, t)).toBe("G");
    expect(destinationPathLabel(SHARED, SF, INDEX, t)).toBe("Shared with me › SF");
    expect(destinationPathLabel(PERSONAL, null, INDEX, t)).toBe("My notes");
  });

  it("destinationShortLabel：資料夾名；根層＝Top level／根目錄", async () => {
    expect(destinationShortLabel(A1, t)).toBe("A1");
    expect(destinationShortLabel(null, t)).toBe("Top level");
    await i18n.changeLanguage("zh-TW");
    expect(destinationShortLabel(null, t)).toBe("根目錄");
  });
});

describe("noteDestSource 與 spaceKey", () => {
  it("spaceKey 三形", () => {
    expect(spaceKey(PERSONAL)).toBe("personal");
    expect(spaceKey(SHARED)).toBe("shared");
    expect(spaceKey(G_SPACE)).toBe("group:g");
  });

  it("locations＝[note.folderId]、movingFolders 恆空；群組名取自 groups", () => {
    expect(noteDestSource(mine("A1"), "copy", GROUPS)).toEqual({
      mode: "copy",
      current: PERSONAL,
      makeCopy: true,
      others: [G_SPACE, H_SPACE],
      locations: ["A1"],
      movingFolders: [],
    });
    expect(noteDestSource(inG(), "copy", GROUPS)).toEqual({
      mode: "copy",
      current: G_SPACE,
      makeCopy: true,
      others: [PERSONAL, H_SPACE],
      locations: [null],
      movingFolders: [],
    });
    expect(noteDestSource(shared("SF"), "move", GROUPS)).toMatchObject({ current: SHARED, makeCopy: false, others: [], locations: ["SF"] });
  });

  it("群組改名後筆記快取還是舊名 → 空間名以 groups 為準；groups 裡沒有才用 note.group.name", () => {
    const stale = groupNote({ id: "g2", title: "GN", group: { ...G, name: "Old G" } });
    expect(noteDestSource(stale, "move", GROUPS).current).toEqual(G_SPACE);
    expect(noteDestSource(stale, "move", []).current).toEqual({ kind: "group", groupId: "g", name: "Old G" });
  });

  it("群組只讀筆記 move → current null、others 空（第一層必空）", () => {
    const readOnly = groupNote({ id: "r1", title: "RN", group: R, edit: false });
    expect(noteDestSource(readOnly, "move", GROUPS)).toMatchObject({ current: null, others: [] });
    expect(isEmptyDestination(noteDestSource(readOnly, "move", GROUPS), INDEX, t)).toBe(true);
  });

  it("groups 未到（[]）：個人 move 只剩本空間；群組筆記 copy 退成沒有上半部", () => {
    expect(noteDestSource(mine(), "move", [])).toMatchObject({ current: PERSONAL, others: [] });
    expect(noteDestSource(inG(), "copy", [])).toMatchObject({ current: null, makeCopy: false, others: [PERSONAL] });
  });
});

describe("字串（spec §6.16 逐字）", () => {
  const get = (obj: unknown, path: string): unknown =>
    path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);

  it.each([
    ["folders.dest.topLevel", "根目錄", "Top level"],
    ["folders.dest.back", "返回", "Back"],
    ["folders.dest.moveHere", "移動到這裡", "Move here"],
    ["folders.dest.copyHere", "複製到這裡", "Copy here"],
    ["folders.dest.openLevel", "{{name}}，開啟下一層", "{{name}}, open"],
  ])("%s", (key, zh, enText) => {
    expect(get(zhTW, key)).toBe(zh);
    expect(get(en, key)).toBe(enText);
  });
});
