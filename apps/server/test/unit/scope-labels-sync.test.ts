/** #239 W3：模型面字串引號內的 UI 名稱 ≡ en.json 的標籤（W10）；說明文字引用的名稱 ≡ 標籤。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/copy-note.js";
import { MOVE_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/move-note-to-group.js";
import { INSUFFICIENT_SCOPE_MESSAGE } from "../../src/mcp/write-scope.js";
import { mcpInstructions } from "../../src/mcp/server-info.js";

const en = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../web/src/i18n/en.json"), "utf8")
) as { settings: { account: Record<string, string> } };
const EDIT = en.settings.account.apiTokensScopeEdit!;
const MOVE = en.settings.account.apiTokensScopeMove!;

describe("#239 W3", () => {
  it("標籤字面值（W10）", () => {
    expect(EDIT).toBe("Create and edit notes");
    expect(MOVE).toBe("Move or copy notes into groups");
  });
  it("模型面字串引用的名稱與標籤逐字一致", () => {
    expect(COPY_NEEDS_MOVE_MESSAGE).toContain(`"${EDIT}" and "${MOVE}"`);
    expect(MOVE_NEEDS_MOVE_MESSAGE).toContain(`"${EDIT}" and "${MOVE}"`);
    expect(INSUFFICIENT_SCOPE_MESSAGE).toContain(`"${EDIT}"`);
    expect(mcpInstructions(false)).toContain(`"${EDIT}"`);
  });
  it("說明文字引用的名稱與標籤逐字一致", () => {
    expect(en.settings.account.apiTokensScopeMoveHint).toContain(`"${EDIT}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`"${EDIT}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`"${MOVE}"`);
  });
});
