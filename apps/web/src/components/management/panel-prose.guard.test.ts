import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * #247 §4.5（Willie W24）：三個管理面板內的說明文字**不限寬**——面板內容樹不得出現 `max-w-prose`
 * （連同它的搭檔 `text-justify hyphens-auto`）。對**原始文字含註解**掃描（比照 card.guard.test.ts）：
 * 字樣常先被抄進註解再被抄回 class；§4.5 也要求相關註解一併改寫。
 * 掃描集（spec §11.1）：settings/*.tsx、components/management/*.tsx、components/groups/Group*.tsx、
 * components/admin/*.tsx（後者 Part 3 才建立，不存在時略過）；一律排除 *.test.*。
 * 筆記內文的 `text-align: justify`（index.css，theme.justify-wordbreak-guard.test.ts 守著）不在範圍內。
 */
const SRC = join(process.cwd(), "src");
const SCAN: Array<{ dir: string; match: (name: string) => boolean }> = [
  { dir: "settings", match: (n) => n.endsWith(".tsx") },
  { dir: "components/management", match: (n) => n.endsWith(".tsx") },
  { dir: "components/groups", match: (n) => /^Group.*\.tsx$/.test(n) },
  { dir: "components/admin", match: (n) => n.endsWith(".tsx") },
];

function scannedFiles(): string[] {
  const out: string[] = [];
  for (const { dir, match } of SCAN) {
    const abs = join(SRC, dir);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      if (name.includes(".test.")) continue;
      if (match(name)) out.push(`${dir}/${name}`);
    }
  }
  return out;
}

describe("面板內容不得含 max-w-prose（#247 §4.5、§11.1）", () => {
  it("掃描集確實走到各目錄（防路徑寫錯而空真）", () => {
    const files = scannedFiles();
    expect(files).toContain("settings/SettingsLayout.tsx");
    expect(files).toContain("settings/AutoVersionsSwitch.tsx");
    expect(files).toContain("components/management/ManagementShell.tsx");
    expect(files).toContain("components/groups/GroupMenu.tsx");
  });

  it("沒有任何一檔含 max-w-prose（含註解）", () => {
    const offenders = scannedFiles().filter((f) => readFileSync(join(SRC, f), "utf8").includes("max-w-prose"));
    expect(offenders).toEqual([]);
  });

  it("沒有任何一檔含 text-justify（左右對齊隨限寬一起拿掉）", () => {
    const offenders = scannedFiles().filter((f) => readFileSync(join(SRC, f), "utf8").includes("text-justify"));
    expect(offenders).toEqual([]);
  });
});
