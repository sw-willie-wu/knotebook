/**
 * #93 M8：description 的「Attachments are not searched.」的守衛——src/ 內（剝註解後）沒有任何碼寫 `'attachment'`，
 * 唯一出現處是 db/schema.ts 的 CHECK（預留值）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("#93 附件不搜", () => {
  it("'attachment' 字面只出現在 db/schema.ts", () => {
    const hits = walk(SRC).filter(p => /["'`]attachment["'`]/.test(code(p))).map(p => path.relative(SRC, p).replace(/\\/g, "/"));
    expect(hits).toEqual(["db/schema.ts"]);
  });
});
