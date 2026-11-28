/**
 * #93: guards the description's "Attachments are not searched.": no code under src/ (comments stripped) writes `'attachment'`;
 * its only occurrence is the CHECK in db/schema.ts (reserved value).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");
const walk = (d: string): string[] => readdirSync(d).flatMap(f => { const p = path.join(d, f); return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : []; });
const code = (p: string) => readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("#93 attachments are not searched", () => {
  it("the 'attachment' literal appears only in db/schema.ts (and uploads/service.ts, where it is the Content-Disposition type)", () => {
    const hits = walk(SRC).filter(p => /["'`]attachment["'`]/.test(code(p))).map(p => path.relative(SRC, p).replace(/\\/g, "/"));
    expect(hits.sort()).toEqual(["db/schema.ts", "uploads/service.ts"]);
  });
});
