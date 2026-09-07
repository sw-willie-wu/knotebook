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
import { MCP_INSTRUCTIONS, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../../src/mcp/server-info.js";

/** 測試自己從 repo 路徑讀一次——與實作的路徑運算各走各的，才有對照面。 */
const pkgVersion = (
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")
  ) as { version: string }
).version;

describe("#108 MCP server-info", () => {
  it("name 逐字是 knotebook（與 docs/api-tokens.md 教使用者填的設定鍵名同字）", () => {
    expect(MCP_SERVER_NAME).toBe("knotebook");
  });

  it("version 逐字等於 apps/server/package.json 的 version（不是寫死、也不是退場的 0.0.0）", () => {
    expect(MCP_SERVER_VERSION).toBe(pkgVersion);
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("instructions ≤ 1000 UTF-16 code unit（每一次 initialize 都進模型脈絡）", () => {
    expect(MCP_INSTRUCTIONS.length).toBeGreaterThan(0);
    expect(MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(1000);
  });

  it("instructions 不含 §15.3 的禁令詞（不得暗示指紋是「讀過了嗎」的檢查）", () => {
    // ⚠ 這個正則必須與 Task 5 掃 `apps/server/src/mcp/` 的那組 grep 同源。
    expect(MCP_INSTRUCTIONS).not.toMatch(
      /without reading|has not read|cannot .*overwrite|must .*read|requires .*read|only after reading/i
    );
  });
});
