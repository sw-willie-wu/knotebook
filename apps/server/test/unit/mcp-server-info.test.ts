/**
 * #108：`McpServer` 的三個宣告字串。
 *
 * ⚠ `MCP_SERVER_VERSION` 這條**守不到 dist／`/out` 佈局**——它只證明「在 `src` 下解析得到
 * `apps/server/package.json`」。deploy 根目錄那一份是一次性人工驗證過的，沒有
 * 持續守衛（誰改了 `docker/Dockerfile` 的 deploy 形或把 `mcp/` 搬深一層，都不會有東西變紅）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpInstructions, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../../src/mcp/server-info.js";
import { listNotesInput } from "../../src/mcp/tools/list-notes.js";
import { searchNotesInput } from "../../src/mcp/tools/search-notes.js";

/** 測試自己從 repo 路徑讀一次——與實作的路徑運算各走各的，才有對照面。 */
const pkgVersion = (
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
  ) as { version: string }
).version;

/** #417：讀寫／唯讀各再依 `open_notes_as_files` 在不在清單上分兩形，共四形；每一條對全部形都成立的斷言跑四次。 */
const ALL_FORMS = [
  ["讀寫＋檔案", true, true],
  ["讀寫", true, false],
  ["唯讀＋檔案", false, true],
  ["唯讀", false, false],
] as const;
const READ_ONLY_FORMS = [false, true].map(files => mcpInstructions(false, files));

const FILES_HINT_WRITE = "If you have a shell, use open_notes_as_files to change much of a note, or many notes.";
const FILES_HINT_READ_ONLY = "If you have a shell, use open_notes_as_files to read many or whole notes.";

describe("#108 MCP server-info", () => {
  it("name 逐字是 knotebook（與 docs/mcp.md 教使用者填的設定鍵名同字）", () => {
    expect(MCP_SERVER_NAME).toBe("knotebook");
  });

  it("version 逐字等於 apps/server/package.json 的 version（不是寫死、也不是退場的 0.0.0）", () => {
    expect(MCP_SERVER_VERSION).toBe(pkgVersion);
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // #108：讀寫／唯讀是**二選一**不是相加，#417 起每支再分有無檔案那一句，所以四形都要各自量、各自過禁令詞。
  // ⚠ 餘裕還剩多少**只有 `server-info.ts` 的檔內註解一份**——這裡刻意不再抄一次數字
  //   （#146：抄的那份寫「約 20」，實際是 40，早就過期了）。撞牆時先縮字，不要調大這個上限。
  it.each(ALL_FORMS)("instructions（%s）≤ 1000 UTF-16 code unit（每一次 initialize 都進模型脈絡）", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it.each(ALL_FORMS)("instructions（%s）不含禁令詞（不得暗示指紋是「讀過了嗎」的檢查）", (_label, canWrite, files) => {
    // ⚠ 這個正則必須與掃 `apps/server/src/mcp/` 的那組 grep 同源。
    expect(mcpInstructions(canWrite, files)).not.toMatch(
      /without reading|has not read|cannot .*overwrite|must .*read|requires .*read|only after reading/i
    );
  });

  // 「二選一」本身：兩支共用同一段 BASE，尾巴不同。寫成同一個常數兩邊都回的話，只有這一案紅。
  it.each([true, false])("兩支 instructions 共用同一段開頭、尾巴不同（檔案那一句 %s）", files => {
    const rw = mcpInstructions(true, files);
    const ro = mcpInstructions(false, files);
    expect(rw).not.toBe(ro);
    expect(rw.startsWith("Knotebook notes over MCP.")).toBe(true);
    expect(ro.startsWith("Knotebook notes over MCP.")).toBe(true);
    expect(rw).toContain("edit_note");
    expect(ro).not.toContain("edit_note");
    expect(ro).not.toContain("create_note");
  });

  it.each(ALL_FORMS)("#175：instructions（%s）的可見性句涵蓋群組、欄位名是 owner", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Notes you can see include ones shared with you and your groups' notes:");
    expect(text).toContain("result carries `owner` and `role` so you can tell whose content you are reading.");
    expect(text).not.toContain("ones other people shared with you");
    // #175：欄位改名成 `owner`——舊名留在 instructions 裡就是叫模型去讀一把不存在的鍵。
    expect(text).not.toContain("ownerHandle");
  });

  // #177：截斷改按 JSON 逃脫後的長度計（`limits.ts` 的 `truncateText`）。舊句「cut at 200 characters.」對
  // 含 `"`／`\`／C0 的標題是假話（101 個 `"` 就會被截到 100），所以兩條一起釘：新句在、舊句不在。
  it.each(ALL_FORMS)("#177：instructions（%s）講的是逃脫後的 200，不是原長度的 200", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Headings and titles are cut at 200 characters as written in JSON.");
    expect(text).not.toContain("cut at 200 characters.");
  });

  it("#247 唯讀版 instructions：處置是在設定 → 授權的 token 列（鉛筆）開啟「Create and edit notes」並重連；≤ 1000", () => {
    for (const ro of READ_ONLY_FORMS) {
      expect(ro).toContain('turn on "Create and edit notes" (notes:write) for this credential via the pencil on its row in Settings → Authorization');
      expect(ro).toContain("then reconnect so the writing tools appear");
      expect(ro).not.toContain("Settings → Account");
      expect(ro).not.toContain("create a token");
      expect(ro.length).toBeLessThanOrEqual(1000);
    }
  });
});

describe("#180：讀寫版 instructions 改為 six ops", () => {
  // #381：rename 也要 `if_match` 了——句子改成「all but append need」，舊句「append and rename」釘不在。
  it.each([true, false])("含「six ops; all but append need `if_match`」、不含「five ops」與「all but append and rename」；唯讀版不動（檔案那一句 %s）", files => {
    const rw = mcpInstructions(true, files);
    expect(rw).toContain("six ops; all but append need `if_match`, the fingerprint of what you replace");
    expect(rw).not.toContain("all but append and rename");
    expect(rw).not.toContain("five ops");
    expect(mcpInstructions(false, files)).not.toContain("rename");
  });
});

// #181：垃圾桶句進兩版共用的 BASE（list_trash 唯讀憑證也有）；換預算縮掉的兩處舊字一起釘「不在」。
// 不依 notes:delete 分版——兩支工具可能不存在，所以兩版都不得提它們的名字。
describe("#181：instructions 的垃圾桶句", () => {
  it.each(ALL_FORMS)("%s版含 list_trash 句、不含縮掉的舊字、不提 delete_note／restore_note", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Only list_trash lists notes in the trash.");
    expect(text).not.toContain("there is no tool that returns a whole");
    expect(text).not.toContain("(id, heading, length)");
    expect(text).not.toContain("delete_note");
    expect(text).not.toContain("restore_note");
  });
});

describe("bulk transfer：instructions 第一句只講工具", () => {
  it.each(ALL_FORMS)("%s版以「Tools read notes in sections: none returns a whole note.」開頭；不含舊句「Reading is always sectioned」", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files).replace(/\s+/g, " ");
    expect(text.startsWith("Knotebook notes over MCP. Tools read notes in sections: none returns a whole note. ")).toBe(true);
    expect(text).not.toContain("Reading is always sectioned");
  });
});

// 資料夾：資料夾句進兩版共用的 BASE（list_folders 任何憑證都註冊）；換預算刪掉的 outline 上限句一起釘「不在」
// （上限仍在 read_note_outline 的 description）。資料夾寫入工具可能不存在（唯讀、沒 notes:delete），所以兩版都不得提它們的名字。
describe("資料夾：instructions 的資料夾句", () => {
  it.each(ALL_FORMS)("%s版含資料夾句、不含 outline 上限句、不提資料夾寫入工具", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files);
    expect(text).toContain("Notes can sit in folders; list_folders shows their paths.");
    expect(text).not.toContain("an outline at most 100 sections");
    expect(text).not.toContain("create_folder");
    expect(text).not.toContain("delete_folder");
    expect(text).not.toContain("move_note_to_folder");
  });
});

// #417：list_notes／search_notes 的每次上限句換出空間給檔案那一句；兩個上限仍在各自 `limit` 的 `.describe()`，
// 兩邊一起釘：instructions 裡不在、`.describe()` 裡在（數字照抄寫死，常數改了這裡要跟著紅）。
describe("#417：list_notes／search_notes 的上限只在各自的 limit 說明", () => {
  it.each(ALL_FORMS)("%s版不含上限句；limit 的 .describe() 寫著 1 to 100／1 to 50", (_label, canWrite, files) => {
    const text = mcpInstructions(canWrite, files).replace(/\s+/g, " ");
    expect(text).not.toContain("list_notes returns at most 100 notes per call");
    expect(text).not.toContain("search_notes at most 50");
    expect(listNotesInput.limit.description).toContain("1 to 100.");
    expect(searchNotesInput.limit.description).toContain("1 to 50.");
  });
});

// #417：`open_notes_as_files` 在清單上（token＋collab＋editing）才接那一句，讀寫／唯讀各一句、不互串；
// 不在清單上的兩形一個字都不提它（清單與 instructions 同一支判準，wire 上的對照在 `mcp-open-notes-as-files.test.ts`）。
describe("#417：instructions 的檔案那一句", () => {
  it("讀寫＋檔案：接在讀寫尾段之後；不含唯讀那句", () => {
    const text = mcpInstructions(true, true);
    expect(text.endsWith(` ${FILES_HINT_WRITE}`)).toBe(true);
    expect(text).not.toContain(FILES_HINT_READ_ONLY);
  });

  it("唯讀＋檔案：只講讀、接在唯讀尾段之前；不含改的那句", () => {
    const text = mcpInstructions(false, true);
    expect(text).toContain(`${FILES_HINT_READ_ONLY} This credential is read-only`);
    expect(text).not.toContain(FILES_HINT_WRITE);
    expect(text).not.toContain("change much of");
  });

  it.each([true, false])("沒有這支工具（canWrite %s）：不提 open_notes_as_files", canWrite => {
    expect(mcpInstructions(canWrite, false)).not.toContain("open_notes_as_files");
  });

  it.each(ALL_FORMS)("%s版不提舊工具名", (_label, canWrite, files) => {
    expect(mcpInstructions(canWrite, files)).not.toContain("bulk_transfer");
  });
});
