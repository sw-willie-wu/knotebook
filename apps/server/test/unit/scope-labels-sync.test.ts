/** #239 W3：模型面字串引號內的 UI 名稱 ≡ 標籤（web 的 management.en.json）（W10）；說明文字引用的名稱 ≡ 標籤。#181 起 zh-TW 的標籤與引用也在這裡釘。 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/copy-note.js";
import { MOVE_NEEDS_MOVE_MESSAGE } from "../../src/mcp/tools/move-note-to-group.js";
import { DELETE_SCOPE_MESSAGE, INSUFFICIENT_SCOPE_MESSAGE } from "../../src/mcp/write-scope.js";
import { mcpInstructions } from "../../src/mcp/server-info.js";

type Messages = { settings: { account: Record<string, string>; authorization: { mcp: Record<string, string> } } };
// settings.account.* 與 settings.authorization.* 在 web 的 lazy 字串包（management.*.json），不在主檔。
const load = (file: string) =>
  JSON.parse(
    readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../web/src/i18n/${file}`), "utf8")
  ) as Messages;
const en = load("management.en.json");
const zh = load("management.zh-TW.json");
const EDIT = en.settings.account.apiTokensScopeEdit!;
const MOVE = en.settings.account.apiTokensScopeMove!;
const DELETE = en.settings.account.apiTokensScopeDelete!;
const ZH_EDIT = zh.settings.account.apiTokensScopeEdit!;
const ZH_MOVE = zh.settings.account.apiTokensScopeMove!;
const ZH_DELETE = zh.settings.account.apiTokensScopeDelete!;

describe("#239 W3", () => {
  it("標籤字面值（W10）", () => {
    expect(EDIT).toBe("Create and edit notes");
    expect(MOVE).toBe("Move or copy notes into groups");
    expect(DELETE).toBe("Move notes to the trash and restore them");
  });
  it("模型面字串引用的名稱與標籤逐字一致", () => {
    expect(COPY_NEEDS_MOVE_MESSAGE).toContain(`turn on "${MOVE}"`);
    expect(MOVE_NEEDS_MOVE_MESSAGE).toContain(`turn on "${MOVE}"`);
    expect(DELETE_SCOPE_MESSAGE).toContain(`turn on "${DELETE}"`);
    expect(INSUFFICIENT_SCOPE_MESSAGE).toContain(`"${EDIT}"`);
    expect(mcpInstructions(false)).toContain(`"${EDIT}"`);
  });
  it("說明文字引用的名稱與標籤逐字一致", () => {
    expect(en.settings.account.apiTokensScopeMoveHint).toContain(`"${EDIT}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`"${EDIT}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`"${MOVE}"`);
    expect(en.settings.account.apiTokensDescription).toContain(`also needs "${DELETE}"`);
  });
  // #181 T7 fix round 1 m1：刪除的說明比照搬移，以同一句「需同時勾選編輯」收尾（S2 本身不改，由模板接在後面）。
  it("搬移、刪除說明都以同一句「需同時勾選編輯」收尾", () => {
    const tail = `Requires "${EDIT}".`;
    expect(en.settings.account.apiTokensScopeMoveHint!.endsWith(` ${tail}`)).toBe(true);
    expect(en.settings.account.apiTokensScopeDeleteHintRequiresEdit).toBe(`{{hint}} ${tail}`);
  });
});

describe("#181 zh-TW 標籤與引用", () => {
  it("zh 標籤字面（spec §6.8.2）與說明句引用一致", () => {
    expect(ZH_DELETE).toBe("移到垃圾桶與還原");
    for (const l of [ZH_EDIT, ZH_MOVE, ZH_DELETE]) expect(zh.settings.account.apiTokensDescription).toContain(`「${l}」`);
    expect(zh.settings.account.apiTokensScopeMoveHint).toContain(`「${ZH_EDIT}」`);
  });
  it("zh 搬移、刪除說明都以同一句「需同時勾選編輯」收尾（T7 fix round 1 m1）", () => {
    const tail = `需同時勾選「${ZH_EDIT}」。`;
    expect(zh.settings.account.apiTokensScopeMoveHint!.endsWith(`。${tail}`)).toBe(true);
    expect(zh.settings.account.apiTokensScopeDeleteHintRequiresEdit).toBe(`{{hint}}${tail}`);
  });
});

// 總管裁定（T3 review r1 m2）：刪除權的說明不得讓人讀成「不會有永久的資料損失」——
// 留在垃圾桶的筆記之後仍可能被永久刪除（站台設定或網頁上的人）。兩語系各釘新句、並釘舊的封口句不再出現。
describe("#181 刪除權說明：提到垃圾桶裡的筆記仍可能被永久刪除", () => {
  it("toggle 說明（S2）", () => {
    expect(en.settings.account.apiTokensScopeDeleteHint).toBe(
      "Can't delete notes permanently, but notes left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app."
    );
    expect(zh.settings.account.apiTokensScopeDeleteHint).toBe(
      "不能永久刪除筆記；但留在垃圾桶的筆記之後仍可能被永久刪除（依站台的垃圾桶設定，或有人在網頁上刪除）。"
    );
  });
  // 也釘 fix round 1 的「過了保留期就會」不再出現：站台不自動清空（保留天數 NULL）時它是假的。
  it("連線指南的權限摘要（S4）", () => {
    expect(en.settings.authorization.mcp.scopes).toContain(
      "no tool here deletes a note permanently, but a note left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app."
    );
    expect(en.settings.authorization.mcp.scopes).not.toContain("nothing here deletes a note permanently");
    expect(en.settings.authorization.mcp.scopes).not.toContain("once the site's trash period passes");
    expect(zh.settings.authorization.mcp.scopes).toContain(
      "這裡沒有工具會永久刪除筆記，但留在垃圾桶的筆記之後仍可能被永久刪除——依站台的垃圾桶設定，或有人在網頁上刪除）"
    );
    expect(zh.settings.authorization.mcp.scopes).not.toContain("這裡沒有任何工具會永久刪除筆記）");
    expect(zh.settings.authorization.mcp.scopes).not.toContain("過了站台的保留期會被永久刪除");
  });
});
