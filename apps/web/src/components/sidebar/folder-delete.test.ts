import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { folderDto, sharedFolder } from "@/test/folder-fixtures";
import { baseNote } from "@/test/select-fixtures";
import { folderDeleteBody, folderDeleteFacts, type FolderDeleteFacts } from "./folder-delete";
import { indexFolders, type FolderSpaceKey } from "./folder-index";

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const spaceOf = (note: NoteDto): FolderSpaceKey => (note.groupId === null ? (note.role === "owner" ? "personal" : "shared") : `group:${note.groupId}`);
const facts = (subfolders: number, notes: number, shared = false): FolderDeleteFacts => ({
  subfolders,
  liveNotes: Array.from({ length: notes }, (_, i) => baseNote({ id: `n${i}`, title: `n${i}` })),
  shared,
  containsOpen: false,
});

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("folderDeleteFacts", () => {
  it("DF1 子資料夾數不含自己、活筆記含孫層、containsOpen；共享資料夾 shared", () => {
    const index = indexFolders([
      folderDto({ id: "A", name: "A" }),
      folderDto({ id: "A1", name: "A1", parentId: "A" }),
      folderDto({ id: "A2", name: "A2", parentId: "A1" }),
      folderDto({ id: "S", name: "S" }),
      sharedFolder({ id: "SF", name: "SF" }),
    ]);
    const notes = [
      baseNote({ id: "p1", title: "p1", folderId: "A" }),
      baseNote({ id: "p2", title: "p2", folderId: "A2" }),
      baseNote({ id: "out", title: "out", folderId: "S" }),
    ];
    const a = folderDeleteFacts(index, index.byId.get("A")!, notes, "p2", spaceOf);
    expect(a.subfolders).toBe(2);
    expect(a.liveNotes.map((n) => n.id)).toEqual(["p1", "p2"]);
    expect(a.shared).toBe(false);
    expect(a.containsOpen).toBe(true);
    expect(folderDeleteFacts(index, index.byId.get("A")!, notes, "out", spaceOf).containsOpen).toBe(false);
    expect(folderDeleteFacts(index, index.byId.get("A")!, notes, null, spaceOf).containsOpen).toBe(false);
    expect(folderDeleteFacts(index, index.byId.get("SF")!, notes, null, spaceOf).shared).toBe(true);
  });
});

describe("folderDeleteBody", () => {
  it("DF2 zh-TW 各情形逐字", async () => {
    await i18n.changeLanguage("zh-TW");
    expect(folderDeleteBody(facts(2, 3), 7, t)).toBe("資料夾（含 2 個子資料夾）會刪除，其中 3 篇筆記會移到垃圾桶，7 天後自動永久刪除。從垃圾桶還原時會照原路徑重建資料夾。");
    expect(folderDeleteBody(facts(0, 1), null, t)).toBe("資料夾會刪除，其中 1 篇筆記會移到垃圾桶，不會自動清除。從垃圾桶還原時會照原路徑重建資料夾。");
    expect(folderDeleteBody(facts(1, 0), 7, t)).toBe("這個資料夾（含 1 個子資料夾）會刪除，裡面沒有筆記。");
    expect(folderDeleteBody(facts(0, 0), 7, t)).toBe("這個資料夾會刪除，裡面沒有筆記。");
    expect(folderDeleteBody(facts(0, 2, true), 7, t)).toBe("資料夾會移除，裡面 2 篇共享筆記回到「與我共享」最上層，不會刪除任何筆記。");
    expect(folderDeleteBody(facts(0, 0, true), 7, t)).toBe("資料夾會移除，裡面沒有共享筆記。");
    expect(folderDeleteBody(facts(0, 1), undefined, t)).toBe("資料夾會刪除，其中 1 篇筆記會移到垃圾桶，保留期滿後自動永久刪除。從垃圾桶還原時會照原路徑重建資料夾。");
  });

  it("DF3 en 各情形逐字（每段完整句、單複數跟各段自己的 count）", () => {
    expect(folderDeleteBody(facts(2, 3), 7, t)).toBe(
      "The folder and its 2 subfolders will be deleted. The 3 notes in it will move to the trash. Notes in the trash are permanently deleted after 7 days. Restoring from the trash rebuilds the folders along the original path.",
    );
    expect(folderDeleteBody(facts(0, 1), 1, t)).toBe(
      "The folder will be deleted. The 1 note in it will move to the trash. Notes in the trash are permanently deleted after 1 day. Restoring from the trash rebuilds the folders along the original path.",
    );
    expect(folderDeleteBody(facts(1, 0), 7, t)).toBe("This folder and its 1 subfolder will be deleted. There are no notes in it.");
    expect(folderDeleteBody(facts(1, 2), null, t)).toBe(
      "The folder and its 1 subfolder will be deleted. The 2 notes in it will move to the trash. Notes in the trash aren't deleted automatically. Restoring from the trash rebuilds the folders along the original path.",
    );
    expect(folderDeleteBody(facts(0, 2), undefined, t)).toBe(
      "The folder will be deleted. The 2 notes in it will move to the trash. Notes in the trash are permanently deleted when the trash's keeping period ends. Restoring from the trash rebuilds the folders along the original path.",
    );
  });
});
