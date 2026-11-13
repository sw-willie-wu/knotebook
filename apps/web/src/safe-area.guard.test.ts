import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SAFE_FRAME_PADDING,
  SAFE_INSETS,
  SAFE_PAGE_PADDING,
  SAFE_PAGE_PADDING_COMPACT,
} from "@/components/ui/safe-area";

/**
 * 來源層守衛：頁面邊緣的元件（整頁、貼邊的 fixed 層、貼底的浮層）必須避開瀏海、圓角與 Home 指示條。
 * `viewport-fit=cover` 之後內容會延伸到那些區域，只有用 `env(safe-area-inset-*)` 的位置才會退開。
 * jsdom 算不出 `env()`，所以這裡守的是來源字面：掃描所有非測試 `.tsx`，凡是有貼邊 class 的檔案，
 * 要嘛用了 `ui/safe-area` 的常數、要嘛 class 括號裡直接寫 `env(safe-area-inset-*)`，要嘛列在允許清單並寫明為什麼不需要。
 * 誠實邊界：以檔為單位——同一檔有兩處貼邊元件、只處理其中一處時抓不到（下面逐檔指名的表用出現次數補一部分）；
 * 其餘靠各元件的 class 斷言。
 */

/** 同一行同時有 `fixed` 與貼邊的定位 class（順序不拘），或整頁高度 class。 */
function isEdgeLine(line: string): boolean {
  if (/\bfixed\b/.test(line) && /\b(inset|inset-[xy]|top|bottom|left|right)-/.test(line)) return true;
  return /\b(min-)?h-(screen|dvh|svh|lvh)\b/.test(line);
}

/** 檔 → 為什麼不需要。 */
const ALLOWED: Record<string, string> = {
  "components/ui/dialog.tsx": "只有半透明背板（不放內容）與置中的對話框；panel 尺寸的寬度上限已避開左右 safe area",
};

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".tsx") || entry.name.includes(".test.")) continue;
    out.push(`${entry.parentPath}/${entry.name}`.replace(/\\/g, "/"));
  }
  return out;
}

const SRC = `${process.cwd().replace(/\\/g, "/")}/src/`;

function rel(file: string): string {
  return file.slice(file.indexOf("/src/") + 5);
}

const SAFE_CONSTANT = /\bSAFE_(FRAME_PADDING|PAGE_PADDING|PAGE_PADDING_COMPACT|INSETS)\b/;
const SAFE_IMPORT = /from "@\/components\/ui\/safe-area"/;
/** class 括號裡直接寫 env（不含註解裡提到的字面）。 */
const SAFE_ARBITRARY = /\[[^\]\s]*env\(safe-area-inset-/;

function usesSafeArea(source: string): boolean {
  return SAFE_CONSTANT.test(source) || SAFE_IMPORT.test(source) || SAFE_ARBITRARY.test(source);
}

function count(source: string, pattern: RegExp): number {
  return source.match(new RegExp(pattern.source, "g"))?.length ?? 0;
}

describe("safe area 來源層守衛", () => {
  it("掃描有遞迴到子目錄", () => {
    const files = listTsx(SRC).map(rel);
    expect(files).toContain("pages/LoginPage.tsx");
    expect(files).toContain("components/versions/VersionsSheet.tsx");
  });

  it("每個常數四邊都帶 env(safe-area-inset-*)", () => {
    for (const value of [SAFE_FRAME_PADDING, SAFE_PAGE_PADDING, SAFE_PAGE_PADDING_COMPACT, SAFE_INSETS]) {
      for (const side of ["top", "right", "bottom", "left"]) {
        expect(value).toContain(`env(safe-area-inset-${side})`);
      }
    }
  });

  it("貼邊的元件都處理了 safe area（或在允許清單）", () => {
    const missing: string[] = [];
    for (const file of listTsx(SRC)) {
      const source = readFileSync(file, "utf8");
      if (!source.split(/\r?\n/).some(isEdgeLine)) continue;
      const name = rel(file);
      if (name in ALLOWED) continue;
      if (!usesSafeArea(source)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  it("允許清單的檔真的還有貼邊 class（過期項目要刪）", () => {
    for (const name of Object.keys(ALLOWED)) {
      const source = readFileSync(`${SRC}${name}`, "utf8");
      expect(source.split(/\r?\n/).some(isEdgeLine)).toBe(true);
    }
  });

  it("邊緣偵測：順序不拘、涵蓋 dvh／svh／lvh", () => {
    expect(isEdgeLine('className="bottom-5 right-5 fixed z-30"')).toBe(true);
    expect(isEdgeLine('className="fixed inset-x-3 z-50"')).toBe(true);
    expect(isEdgeLine('className="min-h-dvh"')).toBe(true);
    expect(isEdgeLine('className="h-svh"')).toBe(true);
    expect(isEdgeLine('className="fixed z-50 flex"')).toBe(false);
  });

  // 逐檔指名：這些元件各有自己的邊要退。次數＝import 加上每個使用處；少一處（例如其中一個框退回舊內距）就紅。
  const REQUIRED: Array<[string, RegExp, number]> = [
    ["components/AppShell.tsx", /\bSAFE_FRAME_PADDING\b/, 2],
    ["components/PublicNoteShell.tsx", /\bSAFE_INSETS\b/, 2],
    ["components/versions/VersionsSheet.tsx", /\bSAFE_INSETS\b/, 2],
    ["present/PresentationShell.tsx", /\bSAFE_INSETS\b/, 2],
    ["components/ui/toast.tsx", /pb-\[max\(1rem,env\(safe-area-inset-bottom\)\)\]/, 1],
    ["components/CornerStack.tsx", /bottom-\[calc\(1\.25rem\+env\(safe-area-inset-bottom\)\)\]/, 1],
    ["components/versions/VersionsLazyBoundary.tsx", /bottom-\[calc\(1\.25rem\+env\(safe-area-inset-bottom\)\)\]/, 1],
    ["components/sidebar/SelectActionBar.tsx", /pb-\[env\(safe-area-inset-bottom\)\]/, 1],
    ["pages/LoginPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/RegisterPage.tsx", /\bSAFE_PAGE_PADDING\b/, 3],
    ["pages/ResetPasswordPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/LinkAccountPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/ChangePasswordPage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["pages/AuthorizePage.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["components/ErrorBoundary.tsx", /\bSAFE_PAGE_PADDING\b/, 2],
    ["components/ErrorBoundary.tsx", /\bSAFE_PAGE_PADDING_COMPACT\b/, 2],
    ["auth/guards.tsx", /\bSAFE_PAGE_PADDING\b/, 3],
  ];
  it.each(REQUIRED)("%s：%s 至少出現 %i 次", (name, pattern, min) => {
    expect(count(readFileSync(`${SRC}${name}`, "utf8"), pattern)).toBeGreaterThanOrEqual(min);
  });

  it("viewport meta 帶 viewport-fit=cover", () => {
    const html = readFileSync(`${SRC}../index.html`, "utf8");
    expect(html).toMatch(/<meta name="viewport"[^>]*viewport-fit=cover/);
  });
});
