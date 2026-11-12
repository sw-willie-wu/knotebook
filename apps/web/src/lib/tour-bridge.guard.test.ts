import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// `lib/tour-bridge.ts` 在首包（AppShell、NoteEditor 都 import 它）。從它出發、沿著執行期的 import 走下去，
// 不得碰到編輯器的套件：tiptap、ProseMirror 一進來，首包就多出整條編輯器鏈（`scripts/check-bundle-size.mjs` 的 entry 上限擋的是結果，
// 這裡擋的是原因，而且不必 build）。`import type` 編譯後消失，不算。

const SRC = `${process.cwd().replace(/\\/g, "/")}/src`;
const EDITOR_PACKAGES = /^(@tiptap\/|prosemirror-|y-prosemirror|@blocknote\/)/;

/** 執行期的 import／re-export 來源（不含 `import type`、`export type`）。 */
function runtimeSpecifiers(code: string): string[] {
  const out: string[] = [];
  const re = /^\s*(import|export)\s+(?!type\s)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) out.push(m[2]!);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]!);
  return out;
}

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `${SRC}/${spec.slice(2)}`;
  else if (spec.startsWith(".")) base = new URL(spec, `file:///${fromFile}`).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  throw new Error(`resolve failed: ${spec} from ${fromFile}`);
}

function closure(entry: string): { files: string[]; packages: string[] } {
  const files: string[] = [];
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.includes(file)) continue;
    files.push(file);
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const local = resolveLocal(spec, file);
      if (local === null) packages.add(spec);
      else queue.push(local);
    }
  }
  return { files: files.map((f) => f.slice(SRC.length + 1)), packages: [...packages] };
}

describe("tour-bridge 留在首包時不拉進編輯器套件", () => {
  const { files, packages } = closure(`${SRC}/lib/tour-bridge.ts`);

  it("走得到開關模組（防正則或路徑壞掉而靜默全過）", () => {
    expect(files).toContain("lib/tour-bridge.ts");
    expect(files).toContain("collab/tour-filter-flag.ts");
  });

  it("執行期 import 的套件裡沒有 tiptap、ProseMirror、y-prosemirror、BlockNote；也沒走到過濾外掛本體", () => {
    expect(packages.filter((p) => EDITOR_PACKAGES.test(p))).toEqual([]);
    expect(files).not.toContain("collab/tour-transaction-filter.ts");
  });

  it("對照：同一套走法從過濾外掛本體出發，會看到 tiptap（證明偵測有效）", () => {
    expect(closure(`${SRC}/collab/tour-transaction-filter.ts`).packages).toContain("@tiptap/core");
  });
});
