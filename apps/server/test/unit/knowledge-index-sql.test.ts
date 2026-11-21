import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import type { Db } from "../../src/db/index.js";
import { knowledgeFilterSql, noteHasKnowledgeSql, scopedNoteBranch } from "../../src/knowledge/index-sql.js";
import type { KnowledgeScope } from "../../src/knowledge/scope.js";

const U = "00000000-0000-4000-8000-0000000000a1";
const G = "00000000-0000-4000-8000-0000000000b1";
const F = "00000000-0000-4000-8000-0000000000c1";
const T1 = "00000000-0000-4000-8000-0000000000d1";

const db = drizzle.mock() as unknown as Db;
const dialect = new PgDialect();
const render = (q: { toSQL(): { sql: string; params: unknown[] } }) => q.toSQL();

const personal: KnowledgeScope = { kind: "personal", ownerId: U };
const group: KnowledgeScope = { kind: "group", groupId: G, groupName: "G" };
const groupFolder: KnowledgeScope = { kind: "folder", folderId: F, space: { kind: "group", groupId: G, groupName: "G" }, path: ["a"] };
const personalFolder: KnowledgeScope = { kind: "folder", folderId: F, space: { kind: "personal", ownerId: U }, path: ["a"] };

describe("knowledge index SQL fragments", () => {
  it("noteHasKnowledgeSql qualifies the outer note id", () => {
    const { sql } = dialect.sqlToQuery(noteHasKnowledgeSql().getSQL());
    expect(sql).toContain('"notes"."id"');
    expect(sql).toContain("exists");
  });

  it("scopedNoteBranch builds fresh selects: two calls render identical SQL and the first is unchanged afterwards", () => {
    const first = scopedNoteBranch(db, U, personal);
    const before = render(first);
    const second = scopedNoteBranch(db, U, personal, { extraWhere: knowledgeFilterSql({ tagIds: [], status: "outdated", evidence: null }) });
    expect(render(first)).toEqual(before);
    expect(render(scopedNoteBranch(db, U, personal))).toEqual(before);
    expect(render(second).sql).not.toEqual(before.sql);
  });

  it("the personal scope reads only the owned branch and the group scope only the grouped branch", () => {
    const own = render(scopedNoteBranch(db, U, personal)).sql;
    expect(own).toContain('"notes"."owner_id" = $1');
    expect(own).not.toContain("note_shares");
    expect(own).not.toContain("group_members");
    const grp = render(scopedNoteBranch(db, U, group));
    expect(grp.sql).toContain("group_members");
    expect(grp.sql).not.toContain("note_shares");
    expect(grp.params).toContain(G);
  });

  it("the folder scope condition uses the table-qualified folder_id and the subtree CTE", () => {
    for (const scope of [groupFolder, personalFolder]) {
      const q = render(scopedNoteBranch(db, U, scope));
      expect(q.sql).toContain('"notes"."folder_id" in (');
      expect(q.sql).toContain("kf_sub");
      expect(q.params).toContain(F);
    }
    expect(render(scopedNoteBranch(db, U, groupFolder)).params).toContain(G);
  });

  it("an empty tag list adds no tag condition and no parameter", () => {
    const none = render(scopedNoteBranch(db, U, personal, { extraWhere: knowledgeFilterSql({ tagIds: [], status: null, evidence: null }) }));
    const noFilter = render(scopedNoteBranch(db, U, personal, { extraWhere: knowledgeFilterSql({ tagIds: [], status: null, evidence: null }) }));
    expect(none).toEqual(noFilter);
    expect(none.sql).not.toContain("note_tags");
    const tagged = render(scopedNoteBranch(db, U, personal, { extraWhere: knowledgeFilterSql({ tagIds: [T1], status: null, evidence: null }) }));
    expect(tagged.sql).toContain("note_tags");
    expect(tagged.params).toContain(T1);
  });

  it("status and evidence conditions map to the icon and evidence columns; unconfirmed means an empty evidence", () => {
    const outdated = render(scopedNoteBranch(db, U, personal, { extraWhere: knowledgeFilterSql({ tagIds: [], status: "outdated", evidence: "unconfirmed" }) }));
    expect(outdated.sql).toContain("nk.icon = $");
    expect(outdated.sql).toContain("nk.evidence = $");
    expect(outdated.params).toContain("outdated");
    expect(outdated.params).toContain("");
  });
});
