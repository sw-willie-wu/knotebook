import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/index.js";
import { buildNoteSearchQuery } from "../../src/notes/search-sql.js";
import { GOLDEN_PARAMS, GOLDEN_SQL, GOLDEN_USER } from "./search-sql-golden.js";

const pool = new pg.Pool({ connectionString: "postgres://u:p@127.0.0.1:1/none" });
const db = createDb(pool);
afterAll(async () => {
  await pool.end();
});

const A = randomUUID();
const B = randomUUID();
const base = { userId: GOLDEN_USER, query: "q", limit: 20 };

describe("search SQL with tag ids", () => {
  it("without tagIds, and with an empty list, the SQL and params are byte-identical to the untagged query", () => {
    for (const opts of [base, { ...base, tagIds: [] }]) {
      const { sql, params } = buildNoteSearchQuery(db, opts).toSQL();
      expect(sql).toBe(GOLDEN_SQL);
      expect(params).toEqual(GOLDEN_PARAMS);
    }
  });

  it("with tagIds each of the three branches carries the tag count subquery with the space match", () => {
    const { sql, params } = buildNoteSearchQuery(db, { ...base, tagIds: [A, B] }).toSQL();
    expect(sql.split('"note_tags" nt').length - 1).toBe(3);
    expect(sql.split('is not distinct from "notes"."owner_id"').length - 1).toBe(3);
    expect(sql.split('is not distinct from "notes"."group_id"').length - 1).toBe(3);
    expect(params.filter((p) => p === A)).toHaveLength(3);
    expect(params.filter((p) => p === B)).toHaveLength(3);
  });

  it("tag ids are bound as parameters, never written into the SQL text", () => {
    const { sql } = buildNoteSearchQuery(db, { ...base, tagIds: [A] }).toSQL();
    expect(sql).not.toContain(A);
  });
});
