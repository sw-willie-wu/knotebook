/**
 * 資料夾 PR-3d T1（plan docs/superpowers/plans/2026-10-28-folders-pr3d.md）：共用骨架的純函式與常數。
 * FF＝資料夾名稱與路徑的截法、WB＝wire 預算、KC＝keyset 游標、FM＝`FolderFailure` → MCP 錯誤的對照表與英文句。
 * 查詢（`loadFolderNames`／`loadFolderPath`）由 T2／T5 的整合測試守。
 */
import { describe, expect, it } from "vitest";
import { FOLDER_DEPTH_MAX, FOLDER_NAME_MAX, FOLDERS_PER_SPACE_MAX, type ErrorCode } from "@knotebook/shared";
import { FOLDER_ID, folderPathCost, folderRefForModel, truncateFolderPath } from "../../src/mcp/folder-fields.js";
import {
  CREATE_BUSY_MESSAGE,
  FOLDER_BUSY_MESSAGE,
  FOLDER_CONTENT_CHANGED_MESSAGE,
  FOLDER_CYCLE_MESSAGE,
  FOLDER_DELETE_BLOCKED_MESSAGE,
  FOLDER_GROUP_NOT_FOUND_MESSAGE,
  FOLDER_LIMIT_MESSAGE,
  FOLDER_MANAGE_FORBIDDEN_MESSAGE,
  FOLDER_MOVE_CROSS_SPACE_MESSAGE,
  FOLDER_NAME_CONTROL_MESSAGE,
  FOLDER_NAME_LENGTH_MESSAGE,
  FOLDER_NAME_TAKEN_MESSAGE,
  FOLDER_NAME_UNSTORABLE_MESSAGE,
  FOLDER_NEEDS_EDIT_MESSAGE,
  FOLDER_NOT_FOUND_MESSAGE,
  FOLDER_POSITION_AMBIGUOUS_MESSAGE,
  FOLDER_TOO_DEEP_MESSAGE,
  MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE,
  NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  NOTE_FILE_FORBIDDEN_MESSAGE,
  NOTE_FOLDER_CROSS_SPACE_MESSAGE,
  folderFailureToToolError,
  folderNameErrorMessage,
  type FolderTool,
} from "../../src/mcp/folder-messages.js";
import { BAD_CURSOR_MESSAGE, decodeKeysetCursor, encodeKeysetCursor, parseCursorTimestamp } from "../../src/mcp/keyset-cursor.js";
import { MCP_FOLDER_PATH_MAX } from "../../src/mcp/limits.js";
import { NOTE_NOT_FOUND_MESSAGE } from "../../src/mcp/note-read.js";
import { LIST_BASE_COST } from "../../src/mcp/tools/list-notes.js";
import { TRASH_BASE_COST } from "../../src/mcp/tools/list-trash.js";
import { PAGE_CUT_RESERVE, countWithinWireBudget, wireCost } from "../../src/mcp/wire-budget.js";
import { WRITE_RATE_LIMITED_MESSAGE } from "../../src/mcp/write-messages.js";

const Q = '"';
const EMOJI = String.fromCodePoint(0x1f600);
const NUL = String.fromCharCode(0);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const ID = "11111111-2222-4333-8444-555555555555";

describe("FF0 FOLDER_ID", () => {
  it("合法 UUID 轉小寫；非 UUID 是驗證錯誤", () => {
    const hexId = "abcdef01-2345-4678-89ab-cdef01234567";
    expect(FOLDER_ID.parse(hexId.toUpperCase())).toBe(hexId);
    expect(FOLDER_ID.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("FF1 名稱截法（folderRefForModel）", () => {
  it("80 個中文不截、無旗標", () => {
    const name = "資".repeat(80);
    expect(folderRefForModel(ID, name)).toEqual({ id: ID, name });
  });

  it("40 個 \" 不截（成本恰 80）", () => {
    const ref = folderRefForModel(ID, Q.repeat(40));
    expect(ref).toEqual({ id: ID, name: Q.repeat(40) });
  });

  it("41 個 \" 截成 40 個＋nameTruncated: true", () => {
    expect(folderRefForModel(ID, Q.repeat(41))).toEqual({ id: ID, name: Q.repeat(40), nameTruncated: true });
  });

  it("80 個 emoji 截成 40 個，不切開代理對", () => {
    const ref = folderRefForModel(ID, EMOJI.repeat(80));
    expect(ref.name).toBe(EMOJI.repeat(40));
    expect(ref.nameTruncated).toBe(true);
    expect(LONE_SURROGATE.test(ref.name)).toBe(false);
  });

  it("一般資料只有 id／name 兩把 key", () => {
    expect(Object.keys(folderRefForModel(ID, "Projects"))).toEqual(["id", "name"]);
    expect(Object.keys(folderRefForModel(ID, Q.repeat(40)))).toEqual(["id", "name"]);
  });
});

describe("FF2 路徑截法（truncateFolderPath／folderPathCost）", () => {
  it("[] → { path: [], truncated: false }", () => {
    expect(truncateFolderPath([])).toEqual({ path: [], truncated: false });
  });

  it("六段各 10 個中文不截", () => {
    const names = Array.from({ length: 6 }, () => "資".repeat(10));
    expect(truncateFolderPath(names)).toEqual({ path: names, truncated: false });
  });

  it("六段各 80 個 \" → 留最後 4 段（每段截成 40）、truncated、成本 ≤ 400", () => {
    const out = truncateFolderPath(Array.from({ length: 6 }, () => Q.repeat(80)));
    expect(out.path).toEqual(Array.from({ length: 4 }, () => Q.repeat(40)));
    expect(out.truncated).toBe(true);
    expect(folderPathCost(out.path)).toBeLessThanOrEqual(MCP_FOLDER_PATH_MAX);
  });

  // 上一案六段相同，分不出丟的是哪一端；這案每段開頭不同，留下的必須是葉端那 4 段。
  it("從根端丟：六段（各 1 個編號＋79 個 \"）留的是第 3–6 段", () => {
    const names = [1, 2, 3, 4, 5, 6].map(i => `${i}${Q.repeat(79)}`);
    const out = truncateFolderPath(names);
    expect(out.path).toEqual([3, 4, 5, 6].map(i => `${i}${Q.repeat(39)}`));
    expect(out.truncated).toBe(true);
  });

  it("八段各 27 個 \" → 留 7 段", () => {
    const out = truncateFolderPath(Array.from({ length: 8 }, () => Q.repeat(27)));
    expect(out.path).toEqual(Array.from({ length: 7 }, () => Q.repeat(27)));
    expect(out.truncated).toBe(true);
    expect(folderPathCost(out.path)).toBe(398);
  });

  it("五段 [33,40,40,40,41] 個 \" → 5 段全留、末段截成 40、成本恰 400、truncated", () => {
    const out = truncateFolderPath([33, 40, 40, 40, 41].map(n => Q.repeat(n)));
    expect(out.path).toEqual([33, 40, 40, 40, 40].map(n => Q.repeat(n)));
    expect(folderPathCost(out.path)).toBe(400);
    expect(out.truncated).toBe(true);
  });

  it("單段 80 個 emoji → 留 1 段（截成 40 個）＋truncated", () => {
    expect(truncateFolderPath([EMOJI.repeat(80)])).toEqual({ path: [EMOJI.repeat(40)], truncated: true });
  });

  it("成本恰 400 不截、401 截", () => {
    const at400 = ["a".repeat(78), "b".repeat(77), "c".repeat(77), "d".repeat(77), "e".repeat(77)];
    expect(folderPathCost(at400)).toBe(400);
    expect(truncateFolderPath(at400)).toEqual({ path: at400, truncated: false });
    const at401 = ["a".repeat(78), "b".repeat(78), "c".repeat(77), "d".repeat(77), "e".repeat(77)];
    expect(folderPathCost(at401)).toBe(401);
    expect(truncateFolderPath(at401)).toEqual({ path: at401.slice(1), truncated: true });
  });

  it("folderPathCost 逐字 ＝ JSON.stringify(陣列).length − 2", () => {
    expect(folderPathCost(["a", "b"])).toBe(JSON.stringify(["a", "b"]).length - 2);
    for (const names of [[], ["x"], [Q, "\\", EMOJI], ["資料", String.fromCharCode(1), "a b"]]) {
      expect(folderPathCost(names)).toBe(JSON.stringify(names).length - 2);
    }
  });
});

describe("WB1 countWithinWireBudget／wireCost", () => {
  it("costs 為空回 0", () => {
    expect(countWithinWireBudget([], 0)).toBe(0);
  });

  it("[10,10,10]、base 0、budget 24 → 2（12＋12）", () => {
    expect(countWithinWireBudget([10, 10, 10], 0, 24)).toBe(2);
  });

  // 上一案每項加不加 2 結果相同（12＋12＝24、10＋10＋10＝30 都停在 2）；這案分得出來。
  it("[10,10,10]、base 0、budget 30 → 2（每項另計兩個逗號；不計就會收 3 項）", () => {
    expect(countWithinWireBudget([10, 10, 10], 0, 30)).toBe(2);
  });

  it("budget 1 → 1（至少 1）", () => {
    expect(countWithinWireBudget([10, 10, 10], 0, 1)).toBe(1);
  });

  it("base 計入；budget 預設 240 000", () => {
    expect(countWithinWireBudget([10, 10], 240_000 - 24)).toBe(2);
    expect(countWithinWireBudget([10, 10], 240_000 - 23)).toBe(1);
  });

  it("wireCost 與 search-notes.ts 搬家前的寫法逐值相同", () => {
    const before = (v: unknown): number => {
      const j = JSON.stringify(v);
      return j.length + JSON.stringify(j).length;
    };
    for (const v of ["plain", { a: `x${Q}y`, b: "\\" }, [[1, [2, `${Q}\\`]], { c: null }]]) {
      expect(wireCost(v)).toBe(before(v));
    }
  });
});

describe("KC1 keyset 游標", () => {
  const T = "2026-10-28T01:02:03.456Z";

  it("encode → decode 來回", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor("t", [T, ID]), "t", 2)).toEqual([T, ID]);
    expect(decodeKeysetCursor(encodeKeysetCursor("f", ["group", ID, ID]), "f", 3)).toEqual(["group", ID, ID]);
  });

  // 來回測試對分隔字元不敏感（encode／decode 一起換也照樣過）；這案釘住線上格式本身。
  it("線上格式：手工組的 base64url(`t|<時間>|<id>`) 解得回兩段，encode 逐字相同", () => {
    const raw = Buffer.from(`t|${T}|${ID}`, "utf8").toString("base64url");
    expect(decodeKeysetCursor(raw, "t", 2)).toEqual([T, ID]);
    expect(encodeKeysetCursor("t", [T, ID])).toBe(raw);
  });

  it("tag 不符 → null", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor("t", [T, ID]), "f", 2)).toBeNull();
  });

  it("段數不符 → null", () => {
    const raw = encodeKeysetCursor("t", [T, ID]);
    expect(decodeKeysetCursor(raw, "t", 3)).toBeNull();
    expect(decodeKeysetCursor(raw, "t", 1)).toBeNull();
  });

  it("內含 NUL（接在最後一段後面）→ null", () => {
    const raw = Buffer.from(`t|${T}|${ID}${NUL}`, "utf8").toString("base64url");
    expect(decodeKeysetCursor(raw, "t", 2)).toBeNull();
  });

  it("非 base64url 垃圾 → null", () => {
    expect(decodeKeysetCursor("!!!not-a-cursor", "t", 2)).toBeNull();
    expect(decodeKeysetCursor("", "t", 2)).toBeNull();
    // Buffer 會略過字元集外的字元：插了 `!` 的合法游標照樣解得開，所以要自己擋。
    const raw = encodeKeysetCursor("t", [T, ID]);
    expect(decodeKeysetCursor(`${raw.slice(0, 4)}!${raw.slice(4)}`, "t", 2)).toBeNull();
  });

  it("BAD_CURSOR_MESSAGE 與 list_notes 原句同字", () => {
    expect(BAD_CURSOR_MESSAGE).toBe("The `cursor` value is not one this server issued. Omit it to start over.");
  });
});

describe("KC2 parseCursorTimestamp（T4 審查 N1）", () => {
  it("本站發的 toISOString 形 → Date；超範圍年份、年 0、寬鬆格式、溢位日期、非日期、接 NUL → null", () => {
    const ok = "2026-10-28T01:02:03.456Z";
    expect(parseCursorTimestamp(ok)!.toISOString()).toBe(ok);
    for (const bad of [
      "+275760-09-13T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "0000-01-01T00:00:00.000Z",
      "2026",
      "2026-10-28T01:02:03Z",
      "2026-02-30T00:00:00.000Z",
      "not-a-date",
      `${ok}${NUL}`,
    ]) {
      expect(parseCursorTimestamp(bad), bad).toBeNull();
    }
  });
});

describe("BC1 清單預算的固定部分（T4 審查 M2）", () => {
  // 拿掉佔位游標或 PAGE_CUT_RESERVE，回應就可能超出預算一點點（每項 +2 的上界吃掉大部分，殺不到）——這裡直接釘組成。
  it("LIST_BASE_COST＝空頁＋82 字元游標＋保留；不小於帶 pageCutShort 的最大空頁成本", () => {
    const realCursorLen = Buffer.from(`2026-10-28T01:02:03.456Z|${ID}`, "utf8").toString("base64url").length;
    expect(realCursorLen).toBe(82);
    expect(LIST_BASE_COST).toBe(wireCost({ notes: [], nextCursor: "x".repeat(82) }) + PAGE_CUT_RESERVE);
    expect(LIST_BASE_COST).toBeGreaterThanOrEqual(wireCost({ notes: [], nextCursor: "x".repeat(82), pageCutShort: true }));
  });

  it("TRASH_BASE_COST＝空頁＋84 字元游標＋truncated＋retentionDays 3650＋保留；不小於帶 pageCutShort 的最大空頁成本", () => {
    expect(encodeKeysetCursor("t", ["2026-10-28T01:02:03.456Z", ID])).toHaveLength(84);
    const empty = { retentionDays: 3650, items: [], truncated: true, nextCursor: "x".repeat(84) };
    expect(TRASH_BASE_COST).toBe(wireCost(empty) + PAGE_CUT_RESERVE);
    expect(TRASH_BASE_COST).toBeGreaterThanOrEqual(wireCost({ ...empty, pageCutShort: true }));
  });
});

describe("FM 英文句與 FolderFailure 對照表", () => {
  const TOOLS: FolderTool[] = ["create_folder", "rename_folder", "move_folder", "move_note_to_folder", "delete_folder"];
  const map = (tool: FolderTool, code: ErrorCode) => folderFailureToToolError(tool, { code }).structuredContent;

  it("字面（plan「待確認字串」逐字）", () => {
    expect(FOLDER_NOT_FOUND_MESSAGE).toBe(
      "No folder with that id that you can use here. For example, it may not exist, may have been deleted, or may be someone else's or in a group whose notes your role can't read; list_folders shows the folders you can see.",
    );
    expect(FOLDER_GROUP_NOT_FOUND_MESSAGE).toBe("No group with that id among your groups where your role can read notes.");
    expect(FOLDER_MANAGE_FORBIDDEN_MESSAGE).toBe(
      "Your role in that group can't change its folders — creating, renaming, moving and deleting them needs a role that can edit notes — so nothing was changed.",
    );
    expect(FOLDER_NAME_UNSTORABLE_MESSAGE).toBe(
      "That folder name contains a character that can't be stored (a NUL or an unpaired surrogate), so nothing was changed.",
    );
    expect(FOLDER_NAME_CONTROL_MESSAGE).toBe(
      "Folder names can't contain line breaks, tabs, or other control or text-direction characters, so nothing was changed.",
    );
    expect(FOLDER_NAME_LENGTH_MESSAGE).toBe(
      `Folder names must be 1 to ${FOLDER_NAME_MAX} characters once surrounding whitespace is removed, so nothing was changed.`,
    );
    expect(FOLDER_NAME_TAKEN_MESSAGE).toBe(
      "There is already a folder with that name in that place — names that differ only in letter case can count as the same — so nothing was changed.",
    );
    expect(FOLDER_TOO_DEEP_MESSAGE).toBe(
      `That would put a folder more than ${FOLDER_DEPTH_MAX} levels deep (a top-level folder is level 1), so nothing was changed.`,
    );
    expect(FOLDER_CYCLE_MESSAGE).toBe("A folder can't be moved into itself or into one of its own subfolders, so nothing was changed.");
    expect(FOLDER_LIMIT_MESSAGE).toBe(
      `That space already has the most folders it can hold (${FOLDERS_PER_SPACE_MAX}), so the folder was not created.`,
    );
    expect(FOLDER_BUSY_MESSAGE).toBe("The server was busy, so nothing was changed. Try again in a moment.");
    expect(NOTE_FILE_FORBIDDEN_MESSAGE).toBe(
      "Your access to this note doesn't allow filing it, so nothing was changed. Filing a group's notes into folders needs a role in that group that can edit notes.",
    );
    expect(FOLDER_NEEDS_EDIT_MESSAGE).toBe(
      "Your role in that group can create notes but not edit them, so it can't put a note in one of the group's folders. Leave out `folder_id` to put it at the group's top level.",
    );
    expect(NEW_NOTE_FOLDER_CROSS_SPACE_MESSAGE).toBe(
      "That folder can't hold this note: a personal folder takes a note without `group_id`, a group's folder needs that group's id as `group_id`, and your folders for notes shared with you don't hold new notes.",
    );
    expect(MOVE_TO_GROUP_FOLDER_CROSS_SPACE_MESSAGE).toBe(
      "That folder isn't one of the folders of the group you're moving the note into. Use one of that group's folders — list_folders with `group_id` shows them — or leave out `folder_id` for the group's top level.",
    );
    expect(NOTE_FOLDER_CROSS_SPACE_MESSAGE).toBe(
      "That folder isn't in this note's space. A note can only be filed among your personal folders if it is yours, its group's folders if it is a group note, or your folders for notes shared with you if someone shared it with you. Moving a personal note into a group is what move_note_to_group does; it needs the notes:move scope.",
    );
    expect(FOLDER_MOVE_CROSS_SPACE_MESSAGE).toBe(
      "A folder can only move within its own space — among your personal folders, within one group, or among your folders for notes shared with you — so nothing was changed. Pass `parent_id: null` to move it to the top level of its space.",
    );
    expect(FOLDER_DELETE_BLOCKED_MESSAGE).toBe(
      "That folder, or one inside it, holds notes your role can't move to the trash, so nothing was deleted.",
    );
    expect(FOLDER_CONTENT_CHANGED_MESSAGE).toBe("The folder's contents changed while it was being deleted, so nothing was deleted. Try again.");
    expect(FOLDER_POSITION_AMBIGUOUS_MESSAGE).toBe("Pass at most one of `parent_id`, `group_id` and `shared: true`, so nothing was created.");
    expect(CREATE_BUSY_MESSAGE).toBe("The server was busy, so no note was created. Try again in a moment.");
  });

  it("名稱三因 → FM4／FM5／FM6", () => {
    expect(folderNameErrorMessage("unstorable")).toBe(FOLDER_NAME_UNSTORABLE_MESSAGE);
    expect(folderNameErrorMessage("control")).toBe(FOLDER_NAME_CONTROL_MESSAGE);
    expect(folderNameErrorMessage("length")).toBe(FOLDER_NAME_LENGTH_MESSAGE);
  });

  it("folder_not_found → not_found＋FM1，五支工具逐字相同", () => {
    const results = TOOLS.map(t => map(t, "folder_not_found"));
    for (const r of results) expect(r).toEqual({ code: "not_found", message: FOLDER_NOT_FOUND_MESSAGE });
  });

  it("逐列對照（每支工具都適用的碼）", () => {
    for (const tool of TOOLS) {
      expect(map(tool, "group_not_found")).toEqual({ code: "group_not_found", message: FOLDER_GROUP_NOT_FOUND_MESSAGE });
      expect(map(tool, "folder_delete_blocked")).toEqual({ code: "forbidden", message: FOLDER_DELETE_BLOCKED_MESSAGE });
      expect(map(tool, "folder_name_taken")).toEqual({ code: "conflict", message: FOLDER_NAME_TAKEN_MESSAGE });
      expect(map(tool, "folder_too_deep")).toEqual({ code: "conflict", message: FOLDER_TOO_DEEP_MESSAGE });
      expect(map(tool, "folder_cycle")).toEqual({ code: "conflict", message: FOLDER_CYCLE_MESSAGE });
      expect(map(tool, "folder_limit")).toEqual({ code: "conflict", message: FOLDER_LIMIT_MESSAGE });
      expect(map(tool, "conflict")).toEqual({ code: "conflict", message: FOLDER_CONTENT_CHANGED_MESSAGE });
      expect(map(tool, "not_found")).toEqual({ code: "not_found", message: NOTE_NOT_FOUND_MESSAGE });
      expect(map(tool, "too_many_requests")).toEqual({ code: "too_many_requests", message: WRITE_RATE_LIMITED_MESSAGE });
      expect(map(tool, "server_busy")).toEqual({ code: "server_busy", message: FOLDER_BUSY_MESSAGE });
    }
  });

  it("forbidden：move_note_to_folder＝FM12，其餘＝FM3", () => {
    expect(map("move_note_to_folder", "forbidden")).toEqual({ code: "forbidden", message: NOTE_FILE_FORBIDDEN_MESSAGE });
    for (const tool of TOOLS.filter(t => t !== "move_note_to_folder")) {
      expect(map(tool, "forbidden")).toEqual({ code: "forbidden", message: FOLDER_MANAGE_FORBIDDEN_MESSAGE });
    }
  });

  it("folder_cross_space：move_folder＝FM17、move_note_to_folder＝FM16，其他三支 throw", () => {
    expect(map("move_folder", "folder_cross_space")).toEqual({ code: "invalid_body", message: FOLDER_MOVE_CROSS_SPACE_MESSAGE });
    expect(map("move_note_to_folder", "folder_cross_space")).toEqual({ code: "invalid_body", message: NOTE_FOLDER_CROSS_SPACE_MESSAGE });
    for (const tool of ["create_folder", "rename_folder", "delete_folder"] as const) {
      expect(() => map(tool, "folder_cross_space")).toThrow();
    }
  });

  it("invalid_body（名稱，呼叫端已預判）與未列的碼 → throw", () => {
    for (const tool of TOOLS) {
      expect(() => map(tool, "invalid_body")).toThrow();
      expect(() => map(tool, "internal")).toThrow();
      expect(() => map(tool, "in_trash")).toThrow();
    }
  });

  it("錯誤結果維持鏡像等式（isError、content[0].text＝JSON.stringify(structuredContent)）", () => {
    const r = folderFailureToToolError("delete_folder", { code: "folder_delete_blocked" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(JSON.stringify(r.structuredContent));
  });
});
