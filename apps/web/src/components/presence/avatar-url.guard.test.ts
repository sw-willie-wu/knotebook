import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 來源層守衛（#293 N-a）：頭貼網址只由 shared 的 `avatarUrl` 組出，web 任何非測試原始檔都不得手組 `/api/avatars/`。
 *
 * 真正的結構防線是 `Avatar` 的 prop 型別只收 `AvatarRef`、`presencePeople` 一律先跑 `parseAvatarRef`；
 * 本守衛是補強——擋的是有人繞過 `Avatar` 自己拼網址。掃描數有下限，確保不是空掃（路徑或排除規則壞了會先紅）。
 *
 * 掃 `src/` 下的 ts／tsx／js／mjs／css／html 與 `index.html`；needle 不帶尾斜線（`/api/avatars?…`、`"/api/avatars" + "/"` 也算），
 * 不會誤中 `/api/auth/avatars`。
 *
 * 守不到的：把 `/api/avatars` 本身拆開串接的字面（`"/api/" + "avatars"`）、測試檔與 `src/test/` 內的寫法。
 */

const WEB_ROOT = process.cwd();
const WEB_SRC = join(WEB_ROOT, "src");
const SHARED_SRC = join(WEB_ROOT, "..", "..", "packages", "shared", "src");
const NEEDLE = "/api/avatars";
/** 實數 244（含 index.html 為 245）的 80%。 */
const MIN_WEB_FILES = 196;
const SOURCE_RE = /\.(?:tsx?|m?js|css|html)$/;

function sourceFiles(dir: string, skipDirs: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.includes(full)) out.push(...sourceFiles(full, skipDirs));
    } else if (SOURCE_RE.test(entry.name) && !entry.name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("頭貼網址只經 avatarUrl（N-a）", () => {
  it("G1 web 的非測試原始檔都不含 /api/avatars", () => {
    const files = [...sourceFiles(WEB_SRC, [join(WEB_SRC, "test")]), join(WEB_ROOT, "index.html")];
    expect(files.length).toBeGreaterThanOrEqual(MIN_WEB_FILES);
    const hits = files.filter((f) => readFileSync(f, "utf8").includes(NEEDLE)).map((f) => relative(WEB_ROOT, f).split(sep).join("/"));
    expect(hits).toEqual([]);
  });

  it("G2 shared 的非測試原始檔中恰 1 處，且在 avatar.ts", () => {
    const hits = sourceFiles(SHARED_SRC)
      .map((f) => ({ file: relative(SHARED_SRC, f).split(sep).join("/"), n: count(readFileSync(f, "utf8"), NEEDLE) }))
      .filter((h) => h.n > 0);
    expect(hits).toEqual([{ file: "avatar.ts", n: 1 }]);
  });
});
