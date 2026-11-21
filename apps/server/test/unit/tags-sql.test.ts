import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { noteTagsJsonSql, notesHavingAllTagsSql } from "../../src/tags/queries.js";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

describe("tag SQL fragments", () => {
  it("noteTagsJsonSql qualifies the outer note columns and matches the tag's space", () => {
    const { sql } = new PgDialect().sqlToQuery(noteTagsJsonSql().getSQL());
    expect(sql).toContain('"notes"."id"');
    expect(sql).toContain('t.owner_id = "notes"."owner_id" or t.group_id = "notes"."group_id"');
  });

  it("notesHavingAllTagsSql: undefined for no ids; deduplicates ids and compares the count with the distinct number", () => {
    expect(notesHavingAllTagsSql([])).toBeUndefined();
    const q = new PgDialect().sqlToQuery(notesHavingAllTagsSql([A, A.toUpperCase(), B])!);
    expect(q.params).toEqual([A, B, 2]);
  });

  it("notesHavingAllTagsSql counts only tags of the note's own space", () => {
    const { sql } = new PgDialect().sqlToQuery(notesHavingAllTagsSql([A])!);
    expect(sql).toContain('is not distinct from "notes"."owner_id"');
    expect(sql).toContain('is not distinct from "notes"."group_id"');
  });
});
