/**
 * tags_color_chk lists exactly TAG_COLORS. Reads the declaration in schema.ts, so adding a colour to the shared list without
 * regenerating the migration fails here.
 */
import { describe, expect, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { TAG_COLORS } from "@knotebook/shared";
import { tags } from "../../src/db/schema.js";

describe("tag colour: CHECK matches TAG_COLORS", () => {
  it("tags_color_chk lists exactly TAG_COLORS", () => {
    const check = getTableConfig(tags).checks.find(c => c.name === "tags_color_chk");
    expect(check, "tags_color_chk is declared").toBeDefined();
    const sql = new PgDialect().sqlToQuery(check!.value).sql;
    const values = [...sql.matchAll(/'([^']*)'/g)].map(m => m[1]);
    expect(values).toHaveLength(TAG_COLORS.length);
    expect(new Set(values)).toEqual(new Set(TAG_COLORS));
  });
});
