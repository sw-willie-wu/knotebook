/**
 * The CHECK constraints on note_knowledge must accept exactly what shared's constants allow, so a value the extractor keeps can never be refused by the database.
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { BLOCK_ANCHOR_RE, KNOWLEDGE_EVIDENCE, KNOWLEDGE_ICON_KINDS, KNOWLEDGE_ID_RE, KNOWLEDGE_STATUSES } from "@knotebook/shared";
import { noteKnowledge } from "../../src/db/schema.js";

const dialect = new PgDialect();
function checkSql(name: string): string {
  const c = getTableConfig(noteKnowledge).checks.find((x) => x.name === name);
  if (!c) throw new Error(`no check ${name}`);
  return dialect.sqlToQuery(c.value).sql;
}
const listed = (sqlText: string): string[] => [...sqlText.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
const pattern = (sqlText: string): string => /~ '([^']*)'/.exec(sqlText)![1]!;

describe("note_knowledge checks match shared constants", () => {
  it("nk_evidence_chk lists '' and exactly KNOWLEDGE_EVIDENCE", () => {
    expect(listed(checkSql("nk_evidence_chk"))).toEqual(["", ...KNOWLEDGE_EVIDENCE]);
  });
  it("nk_status_chk lists '' and exactly KNOWLEDGE_STATUSES", () => {
    expect(listed(checkSql("nk_status_chk"))).toEqual(["", ...KNOWLEDGE_STATUSES]);
  });
  it("nk_icon_chk lists exactly KNOWLEDGE_ICON_KINDS", () => {
    expect(listed(checkSql("nk_icon_chk")).sort()).toEqual([...KNOWLEDGE_ICON_KINDS].sort());
  });
  it("nk_knowledge_id_chk's pattern accepts and rejects the same ids as KNOWLEDGE_ID_RE", () => {
    const re = new RegExp(pattern(checkSql("nk_knowledge_id_chk")));
    for (const id of ["k_0123abcd", "k_0123ABCD", "k_0123abc", "x_0123abcd", "k_0123abcde", ""]) expect(re.test(id)).toBe(KNOWLEDGE_ID_RE.test(id));
  });
  it("nk_superseded_chk uses the same id pattern", () => {
    expect(pattern(checkSql("nk_superseded_chk"))).toBe(pattern(checkSql("nk_knowledge_id_chk")));
  });
  it("nk_block_id_chk's pattern is BLOCK_ANCHOR_RE's source", () => {
    expect(pattern(checkSql("nk_block_id_chk"))).toBe(BLOCK_ANCHOR_RE.source);
  });
});
