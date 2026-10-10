/**
 * #108 D-C：`McpServer` 的三個宣告字串。
 *
 * ⚠ `MCP_SERVER_VERSION` 這條**守不到 dist／`/out` 佈局**——它只證明「在 `src` 下解析得到
 * `apps/server/package.json`」。deploy 根目錄那一份是 plan 階段一次性人工驗證過的，沒有
 * 持續守衛（誰改了 `docker/Dockerfile` 的 deploy 形或把 `mcp/` 搬深一層，都不會有東西變紅）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpInstructions, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../../src/mcp/server-info.js";

/** 測試自己從 repo 路徑讀一次——與實作的路徑運算各走各的，才有對照面。 */
const pkgVersion = (
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
  ) as { version: string }
).version;

describe("#108 MCP server-info", () => {
  it("name 逐字是 knotebook（與 docs/mcp.md 教使用者填的設定鍵名同字）", () => {
    expect(MCP_SERVER_NAME).toBe("knotebook");
  });

  it("version 逐字等於 apps/server/package.json 的 version（不是寫死、也不是退場的 0.0.0）", () => {
    expect(MCP_SERVER_VERSION).toBe(pkgVersion);
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  // #108 D-Q：兩支是**二選一**不是相加，所以兩支都要各自量、各自過禁令詞。
  // ⚠ 餘裕還剩多少**只有 `server-info.ts` 的檔內註解一份**——這裡刻意不再抄一次數字
  //   （#146：抄的那份寫「約 20」，實際是 40，早就過期了）。撞牆時先縮字，不要調大這個上限。
  it.each([
    ["讀寫", true],
    ["唯讀", false],
  ])("instructions（%s 憑證）≤ 1000 UTF-16 code unit（每一次 initialize 都進模型脈絡）", (_label, canWrite) => {
    const text = mcpInstructions(canWrite as boolean);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(1000);
  });

  it.each([
    ["讀寫", true],
    ["唯讀", false],
  ])("instructions（%s 憑證）不含 §15.3 的禁令詞（不得暗示指紋是「讀過了嗎」的檢查）", (_label, canWrite) => {
    // ⚠ 這個正則必須與 Task 5 掃 `apps/server/src/mcp/` 的那組 grep 同源。
    expect(mcpInstructions(canWrite as boolean)).not.toMatch(
      /without reading|has not read|cannot .*overwrite|must .*read|requires .*read|only after reading/i
    );
  });

  // 「二選一」本身：兩支共用同一段 BASE，尾巴不同。寫成同一個常數兩邊都回的話，只有這一案紅。
  it("兩支 instructions 共用同一段開頭、尾巴不同（D-Q）", () => {
    const rw = mcpInstructions(true);
    const ro = mcpInstructions(false);
    expect(rw).not.toBe(ro);
    expect(rw.startsWith("Knotebook notes over MCP.")).toBe(true);
    expect(ro.startsWith("Knotebook notes over MCP.")).toBe(true);
    expect(rw).toContain("edit_note");
    expect(ro).not.toContain("edit_note");
    expect(ro).not.toContain("create_note");
  });

  it.each([
    ["讀寫", true],
    ["唯讀", false],
  ])("#175：instructions（%s 憑證）的可見性句涵蓋群組、欄位名是 owner", (_label, canWrite) => {
    const text = mcpInstructions(canWrite as boolean);
    expect(text).toContain("Notes you can see include ones shared with you and your groups' notes:");
    expect(text).toContain("result carries `owner` and `role` so you can tell whose content you are reading.");
    expect(text).not.toContain("ones other people shared with you");
    // #175 §9.1：欄位改名成 `owner`——舊名留在 instructions 裡就是叫模型去讀一把不存在的鍵。
    expect(text).not.toContain("ownerHandle");
  });

  // #177：截斷改按 JSON 逃脫後的長度計（`limits.ts` 的 `truncateText`）。舊句「cut at 200 characters.」對
  // 含 `"`／`\`／C0 的標題是假話（101 個 `"` 就會被截到 100），所以兩條一起釘：新句在、舊句不在。
  it.each([
    ["讀寫", true],
    ["唯讀", false],
  ])("#177：instructions（%s 憑證）講的是逃脫後的 200，不是原長度的 200", (_label, canWrite) => {
    const text = mcpInstructions(canWrite as boolean);
    expect(text).toContain("Headings and titles are cut at 200 characters as written in JSON.");
    expect(text).not.toContain("cut at 200 characters.");
  });

  it("#239 唯讀版 instructions：處置是建一支勾了「Create and edit notes」的 token 並用它連線；≤ 1000", () => {
    const ro = mcpInstructions(false);
    expect(ro).toContain('create a token with "Create and edit notes" (notes:write) ticked');
    expect(ro).toContain("and connect with it");
    expect(ro.length).toBeLessThanOrEqual(1000);
  });
});

describe("#180 U5：讀寫版 instructions 改為 six ops", () => {
  it("含「six ops; all but append and rename need」、不含「five ops」；唯讀版不動", () => {
    const rw = mcpInstructions(true);
    expect(rw).toContain("six ops; all but append and rename need");
    expect(rw).not.toContain("five ops");
    expect(mcpInstructions(false)).not.toContain("rename");
  });
});
