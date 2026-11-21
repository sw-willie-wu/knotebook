/**
 * tags_color_chk accepts exactly TAG_PRESET_COLORS and CUSTOM_COLOR_RE, and the latest migration that writes it says the same as schema.ts,
 * so changing either list without regenerating the migration fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { CUSTOM_COLOR_RE, TAG_PRESET_COLORS } from "@knotebook/shared";
import { tags } from "../../src/db/schema.js";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

function schemaCheckSql(): string {
  const check = getTableConfig(tags).checks.find(c => c.name === "tags_color_chk");
  expect(check, "tags_color_chk is declared").toBeDefined();
  return new PgDialect().sqlToQuery(check!.value).sql;
}

/** The CHECK body of the last migration in journal order that adds tags_color_chk. */
function migrationCheckSql(): string {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const marker = `ADD CONSTRAINT "tags_color_chk" CHECK (`;
  const inline = `CONSTRAINT "tags_color_chk" CHECK (`;
  for (const entry of [...journal.entries].sort((a, b) => b.idx - a.idx)) {
    const text = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8");
    const at = text.includes(marker) ? text.indexOf(marker) + marker.length : text.includes(inline) ? text.indexOf(inline) + inline.length : -1;
    if (at < 0) continue;
    let depth = 1;
    let i = at;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    return text.slice(at, i - 1);
  }
  throw new Error("no migration adds tags_color_chk");
}

describe("tag colour: CHECK matches the shared colour rules", () => {
  it("tags_color_chk lists exactly TAG_PRESET_COLORS and otherwise requires CUSTOM_COLOR_RE", () => {
    const sql = schemaCheckSql();
    const match = /^"tags"\."color" in \(([^)]*)\) or "tags"\."color" ~ '([^']*)'$/.exec(sql);
    expect(match, sql).not.toBeNull();
    const values = [...match![1]!.matchAll(/'([^']*)'/g)].map(m => m[1]);
    expect(values).toHaveLength(TAG_PRESET_COLORS.length);
    expect(new Set(values)).toEqual(new Set(TAG_PRESET_COLORS));
    expect(match![2]).toBe(CUSTOM_COLOR_RE.source);
  });

  it("the latest migration that writes tags_color_chk has the same expression as schema.ts", () => {
    expect(migrationCheckSql()).toBe(schemaCheckSql());
  });
});
