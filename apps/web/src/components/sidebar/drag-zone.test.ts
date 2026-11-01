import { beforeEach, describe, expect, it } from "vitest";
import type { GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { groupDto, memberRole } from "@/test/fixtures";
import { folderChain, folderDto, groupFolder, sharedFolder } from "@/test/folder-fixtures";
import { groupNote, personalNote, sharedNote } from "@/test/select-fixtures";
import {
  buildDropLookup,
  canDragNote,
  dropScopeKey,
  evaluateDragOver,
  isDragEnabled,
  readDragTarget,
  stackFolderName,
  type DragOverResult,
  type DragSource,
  type DragTab,
  type DragTarget,
  type DropLookup,
  type HoldAction,
} from "./drag-zone";
import { indexFolders } from "./folder-index";
import { buildTabNodes } from "./tree";

/**
 * 拖曳的區域落點、可拖判準、疊資料夾取名（資料夾 spec §6.13；PR-3c T2）。
 * fixture：個人 F ⊃ F1、X ⊃ Z、空資料夾 E、鏈 C1 ⊃ … ⊃ C5；根層筆記 A、R、O（folderId 指向不存在的資料夾）；F 裡 N1、N2；Z 裡 Z1；
 * C4 裡 B4、C5 裡 B5；群組 G（edit）有 GF、根層 g1、GF 裡 g2、唯讀 gr；群組 H 有 HF、h1；共享 SF、共享筆記 s1、兜底群組筆記 sg（群組 K 不在 groupIds）。
 * 樹一律以 buildTabNodes 建再 buildDropLookup，不手寫 lookup。斷言形 `[zone kind, 落點 folderId, scope 鍵, row, hold]`。
 */

const t = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

const G: GroupDto = groupDto({ id: "G", name: "G" }, memberRole());
const H: GroupDto = groupDto({ id: "H", name: "H" }, memberRole());
const K: GroupDto = groupDto({ id: "K", name: "K" }, memberRole());
const GROUPS: GroupDto[] = [G, H];
const GROUP_IDS: ReadonlySet<string> = new Set(GROUPS.map((group) => group.id));

const INDEX = indexFolders([
  folderDto({ id: "F", name: "F" }),
  folderDto({ id: "F1", name: "F1", parentId: "F" }),
  folderDto({ id: "X", name: "X" }),
  folderDto({ id: "Z", name: "Z", parentId: "X" }),
  folderDto({ id: "E", name: "E" }),
  ...folderChain("C", 5),
  groupFolder({ id: "GF", name: "GF", groupId: "G" }),
  groupFolder({ id: "HF", name: "HF", groupId: "H" }),
  sharedFolder({ id: "SF", name: "SF" }),
]);

const NOTES: NoteDto[] = [
  personalNote({ id: "A", title: "A" }),
  personalNote({ id: "R", title: "R" }),
  personalNote({ id: "O", title: "O", folderId: "ghost" }),
  personalNote({ id: "N1", title: "N1", folderId: "F" }),
  personalNote({ id: "N2", title: "N2", folderId: "F" }),
  personalNote({ id: "Z1", title: "Z1", folderId: "Z" }),
  personalNote({ id: "B4", title: "B4", folderId: "C4" }),
  personalNote({ id: "B5", title: "B5", folderId: "C5" }),
  groupNote({ id: "g1", title: "g1", group: G }),
  groupNote({ id: "g2", title: "g2", group: G, folderId: "GF" }),
  groupNote({ id: "gr", title: "gr", group: G, edit: false }),
  groupNote({ id: "h1", title: "h1", group: H }),
  sharedNote({ id: "s1", title: "s1", role: "viewer" }),
  sharedNote({ id: "s2", title: "s2", folderId: "SF" }),
  groupNote({ id: "sg", title: "sg", group: K }),
];

function lookupOf(tab: DragTab): DropLookup {
  return buildDropLookup(buildTabNodes(tab, NOTES, GROUPS, INDEX), tab, GROUP_IDS);
}

const LOOKUP: Record<DragTab, DropLookup> = { myNotes: lookupOf("myNotes"), workspace: lookupOf("workspace"), shared: lookupOf("shared") };

function sourceOf(tab: DragTab, noteId: string): DragSource {
  const entry = LOOKUP[tab].notes.get(noteId);
  if (entry === undefined) throw new Error(`no ${noteId} in ${tab}`);
  return { noteId, space: entry.space, folderId: entry.folderId, title: entry.title };
}

type Shape = [string | null, string | null | undefined, string | null, string | null, HoldAction | null];

function shape(result: DragOverResult): Shape {
  const { zone } = result;
  return [zone?.kind ?? null, zone?.kind === "place" ? zone.folderId : undefined, zone === null ? null : dropScopeKey(zone.scope), result.row, result.hold];
}

function over(tab: DragTab, sourceId: string, target: DragTarget, o: { collapsed?: readonly string[]; previewAnchor?: string | null } = {}): Shape {
  const collapsed = new Set(o.collapsed ?? []);
  return shape(
    evaluateDragOver({
      source: sourceOf(tab, sourceId),
      target,
      lookup: LOOKUP[tab],
      tab,
      isCollapsed: (folderId) => collapsed.has(folderId),
      previewAnchor: o.previewAnchor ?? null,
    }),
  );
}

const note = (id: string): DragTarget => ({ kind: "note", id });
const folder = (id: string): DragTarget => ({ kind: "folder", id });
const group = (id: string): DragTarget => ({ kind: "group", id });
const BLANK: DragTarget = { kind: "blank" };
const OUTSIDE: DragTarget = { kind: "outside" };
const PREVIEW: DragTarget = { kind: "preview" };
const stack = (anchorNoteId: string, parentFolderId: string | null): HoldAction => ({ kind: "stack", anchorNoteId, parentFolderId });
const NONE: Shape = [null, undefined, null, null, null];

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("evaluateDragOver：我的筆記", () => {
  it("DZ1 根層 A 拖到展開的資料夾列 F → 落點 F、標示 F 的範圍、不計時", () => {
    expect(over("myNotes", "A", folder("F"))).toEqual(["place", "F", "folder:F", "folder:F", null]);
  });

  it("DZ2 A 拖到 F 裡的 N1 → 落點 F；停留可疊（母層 F）", () => {
    expect(over("myNotes", "A", note("N1"))).toEqual(["place", "F", "folder:F", "note:N1", stack("N1", "F")]);
  });

  it("DZ3 F 裡的 N1 拖到根層 R → 落點根目錄（整份清單）；停留可疊（母層根層）", () => {
    expect(over("myNotes", "N1", note("R"))).toEqual(["place", null, "list", "note:R", stack("R", null)]);
  });

  it("DZ4 空白處：N1 → 根目錄；A 已在根層 → 不是落點；離開樹容器 → 全空", () => {
    expect(over("myNotes", "N1", BLANK)).toEqual(["place", null, "list", null, null]);
    expect(over("myNotes", "A", BLANK)).toEqual(NONE);
    expect(over("myNotes", "N1", OUTSIDE)).toEqual(NONE);
  });

  it("DZ5 原處不是落點：N1 → 同資料夾的 N2 仍可疊；N1 → F 列、A → 自己都什麼都沒有", () => {
    expect(over("myNotes", "N1", note("N2"))).toEqual([null, undefined, null, "note:N2", stack("N2", "F")]);
    expect(over("myNotes", "N1", folder("F"))).toEqual([null, undefined, null, "folder:F", null]);
    expect(over("myNotes", "A", note("A"))).toEqual([null, undefined, null, "note:A", null]);
  });

  it("DZ6 巢狀取最近：A → Z 裡的筆記、A → Z 列 → 落點都是 Z", () => {
    expect(over("myNotes", "A", note("Z1"))).toEqual(["place", "Z", "folder:Z", "note:Z1", stack("Z1", "Z")]);
    expect(over("myNotes", "A", folder("Z"))).toEqual(["place", "Z", "folder:Z", "folder:Z", null]);
  });

  it("DZ7 空資料夾 E 的「沒有筆記」行 → readDragTarget 讀出 folder E → 落點 E", () => {
    const container = document.createElement("div");
    container.innerHTML = '<ul><li data-node-kind="folder" data-node-id="E"><button type="button">E</button><ul><li><p>No notes</p></li></ul></li></ul>';
    const empty = container.querySelector("p");
    const target = readDragTarget(empty, container);
    expect(target).toEqual({ kind: "folder", id: "E" });
    expect(over("myNotes", "A", target)).toEqual(["place", "E", "folder:E", "folder:E", null]);
  });

  it("DZ9 預覽塊 → 建新資料夾；previewAnchor 那一列（同一輪 dragover 還指到舊列）視同預覽", () => {
    const preview: Shape = ["stack", undefined, "preview", "preview", null];
    expect(over("myNotes", "A", PREVIEW)).toEqual(preview);
    expect(over("myNotes", "A", note("N2"), { previewAnchor: "N2" })).toEqual(preview);
    expect(over("myNotes", "A", note("N1"), { previewAnchor: "N2" })).toEqual(["place", "F", "folder:F", "note:N1", stack("N1", "F")]);
  });

  it("DZ10 B 所在資料夾深度 = FOLDER_DEPTH_MAX → 不疊、只照區域；深度 4 → 可疊", () => {
    expect(over("myNotes", "A", note("B5"))).toEqual(["place", "C5", "folder:C5", "note:B5", null]);
    expect(over("myNotes", "A", note("B4"))).toEqual(["place", "C4", "folder:C4", "note:B4", stack("B4", "C4")]);
  });

  it("DZ11 彈簧：同空間收合的資料夾 → spring；展開 → 不計時", () => {
    expect(over("myNotes", "A", folder("F"), { collapsed: ["F"] })).toEqual(["place", "F", "folder:F", "folder:F", { kind: "spring", folderId: "F" }]);
    expect(over("myNotes", "A", folder("F"))).toEqual(["place", "F", "folder:F", "folder:F", null]);
  });
});

describe("evaluateDragOver：群組", () => {
  it("DZ8 本群組列／根層筆記／空白處 → 群組根目錄；別群組任何列 → 不是落點", () => {
    expect(over("workspace", "g2", group("G"))).toEqual(["place", null, "group:G", null, null]);
    expect(over("workspace", "g1", group("G"))).toEqual(NONE);
    expect(over("workspace", "g2", group("H"))).toEqual(NONE);
    expect(over("workspace", "g2", note("h1"))).toEqual([null, undefined, null, "note:h1", null]);
    expect(over("workspace", "g2", folder("HF"), { collapsed: ["HF"] })).toEqual(NONE);
    expect(over("workspace", "g2", BLANK)).toEqual(["place", null, "group:G", null, null]);
    expect(over("workspace", "g2", note("g1"))).toEqual(["place", null, "group:G", "note:g1", stack("g1", null)]);
  });

  it("DZ11 別群組的收合資料夾不展開", () => {
    expect(over("workspace", "g1", folder("HF"), { collapsed: ["HF"] })).toEqual(NONE);
    expect(over("workspace", "g1", folder("GF"), { collapsed: ["GF"] })).toEqual(["place", "GF", "folder:GF", "folder:GF", { kind: "spring", folderId: "GF" }]);
  });

  it("DZ12 B 不可放置（同群組唯讀）→ 不疊", () => {
    expect(over("workspace", "g1", note("gr"))).toEqual([null, undefined, null, "note:gr", null]);
  });
});

describe("evaluateDragOver：與我共享", () => {
  it("DZ12 B 是兜底的群組筆記 → 不疊；共享資料夾列照常是落點", () => {
    expect(over("shared", "s1", note("sg"))).toEqual([null, undefined, null, "note:sg", null]);
    expect(over("shared", "s1", folder("SF"))).toEqual(["place", "SF", "folder:SF", "folder:SF", null]);
  });

  it("DZ4 共享資料夾 SF 裡的 s2 拖到空白處 → 根目錄（整份清單）", () => {
    expect(over("shared", "s2", BLANK)).toEqual(["place", null, "list", null, null]);
  });
});

describe("canDragNote", () => {
  it("DZ13 個人＝可；群組看 permissions.edit；共享 editor／viewer 可、兜底群組筆記不可", () => {
    expect(canDragNote(personalNote({ id: "p", title: "p" }), "personal")).toBe(true);
    expect(canDragNote(groupNote({ id: "ge", title: "ge", group: G }), "group:G")).toBe(true);
    expect(canDragNote(groupNote({ id: "gv", title: "gv", group: G, edit: false }), "group:G")).toBe(false);
    expect(canDragNote(sharedNote({ id: "sv", title: "sv", role: "viewer" }), "shared")).toBe(true);
    expect(canDragNote(sharedNote({ id: "se", title: "se", role: "editor" }), "shared")).toBe(true);
    expect(canDragNote(groupNote({ id: "sg", title: "sg", group: K }), "shared")).toBe(false);
  });
});

describe("readDragTarget", () => {
  function tree(): { container: HTMLElement; outside: HTMLElement } {
    const root = document.createElement("div");
    root.innerHTML =
      '<div data-sidebar-header=""><span>header</span></div>' +
      '<div data-sidebar-list="">' +
      '<ul><li data-node-kind="note" data-node-id="N1"><a href="/n/n1"><span>N1 title</span></a></li>' +
      '<li data-node-kind="preview"><div><span>New folder</span></div>' +
      '<ul><li data-node-kind="note" data-node-id="N2"><a href="/n/n2"><span>N2</span></a></li></ul></li></ul>' +
      "</div>";
    const container = root.querySelector<HTMLElement>("[data-sidebar-list]");
    const outside = root.querySelector<HTMLElement>("[data-sidebar-header] span");
    if (container === null || outside === null) throw new Error("fixture");
    return { container, outside };
  }

  it("DZ14 <a> 內的元素與文字節點 → note；容器本身 → blank；容器外與 null → outside；預覽塊內任何一處 → preview", () => {
    const { container, outside } = tree();
    const span = container.querySelector('[data-node-id="N1"] span');
    expect(readDragTarget(span, container)).toEqual({ kind: "note", id: "N1" });
    expect(readDragTarget(span?.firstChild ?? null, container)).toEqual({ kind: "note", id: "N1" });
    expect(readDragTarget(container, container)).toEqual({ kind: "blank" });
    expect(readDragTarget(outside, container)).toEqual({ kind: "outside" });
    expect(readDragTarget(null, container)).toEqual({ kind: "outside" });
    expect(readDragTarget(container.querySelector('[data-node-kind="preview"] > div > span'), container)).toEqual({ kind: "preview" });
    expect(readDragTarget(container.querySelector('[data-node-id="N2"] span'), container)).toEqual({ kind: "preview" });
  });

  it("DZ14 認不得的 data-node-kind、缺 data-node-id → outside（不是落點）", () => {
    const container = document.createElement("div");
    container.innerHTML = '<ul><li data-node-kind="weird" data-node-id="W"><span>w</span></li><li data-node-kind="note"><span>no id</span></li></ul>';
    const [weird, noId] = Array.from(container.querySelectorAll("span"));
    expect(readDragTarget(weird ?? null, container)).toEqual({ kind: "outside" });
    expect(readDragTarget(noId ?? null, container)).toEqual({ kind: "outside" });
  });
});

describe("stackFolderName", () => {
  it("DZ15 同層既有名不分大小寫，挑第一個沒被用的；skip 再跳一號", () => {
    expect(stackFolderName([], t)).toBe("New folder");
    expect(stackFolderName(["New folder"], t)).toBe("New folder 2");
    expect(stackFolderName(["new folder", "New Folder 2"], t)).toBe("New folder 3");
    expect(stackFolderName(["new folder", "New Folder 2"], t, new Set(["New folder 3"]))).toBe("New folder 4");
    expect(stackFolderName(["new folder", "New Folder 2"], t, new Set(["NEW FOLDER 3"]))).toBe("New folder 4");
  });

  it("DZ15 字串壞掉（每次回同一個字）→ 最多試 taken.size + 1 次就停，回最後一個候選", () => {
    let calls = 0;
    const stuck = (): string => {
      calls += 1;
      if (calls > 50) throw new Error("runaway loop");
      return "Same";
    };
    expect(stackFolderName(["same"], stuck)).toBe("Same");
    expect(calls).toBe(2);
  });

  it("DZ15 zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(stackFolderName([], t)).toBe("新資料夾");
    expect(stackFolderName(["新資料夾"], t)).toBe("新資料夾 2");
  });
});

describe("buildDropLookup", () => {
  it("DZ16 位置取樹上（兜底後）的：不存在的資料夾 → 根層深度 0；GF 裡的筆記深度 1、空間 group:G", () => {
    expect(LOOKUP.myNotes.notes.get("O")).toEqual({ space: "personal", folderId: null, folderDepth: 0, placeable: true, title: "O" });
    expect(LOOKUP.workspace.notes.get("g2")).toEqual({ space: "group:G", folderId: "GF", folderDepth: 1, placeable: true, title: "g2" });
    expect(LOOKUP.workspace.folders.get("GF")).toEqual({ space: "group:G", depth: 1 });
    expect(LOOKUP.myNotes.folders.get("Z")).toEqual({ space: "personal", depth: 2 });
  });

  it("DZ16 群組 tab 只收 groupIds 裡的群組", () => {
    const lookup = buildDropLookup(buildTabNodes("workspace", NOTES, GROUPS, INDEX), "workspace", new Set(["G"]));
    expect(lookup.notes.has("g1")).toBe(true);
    expect(lookup.notes.has("h1")).toBe(false);
    expect(lookup.folders.has("HF")).toBe(false);
  });
});

describe("isDragEnabled", () => {
  const ok = { finePointer: true, tab: "myNotes", selectionActive: false, creating: false, nodesReady: true } as const;

  it("DZ17 五項全可 → true；任一項不可 → false；群組、與我共享也可", () => {
    expect(isDragEnabled(ok)).toBe(true);
    expect(isDragEnabled({ ...ok, tab: "workspace" })).toBe(true);
    expect(isDragEnabled({ ...ok, tab: "shared" })).toBe(true);
    expect(isDragEnabled({ ...ok, finePointer: false })).toBe(false);
    expect(isDragEnabled({ ...ok, tab: "recent" })).toBe(false);
    expect(isDragEnabled({ ...ok, tab: "trash" })).toBe(false);
    expect(isDragEnabled({ ...ok, selectionActive: true })).toBe(false);
    expect(isDragEnabled({ ...ok, creating: true })).toBe(false);
    expect(isDragEnabled({ ...ok, nodesReady: false })).toBe(false);
  });
});
