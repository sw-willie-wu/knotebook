// The sentences about knowledge info in the tool strings are the ones in docs/mcp.md, word for word, and say only what the code does.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CREATE_KNOWLEDGE_OUTPUT_DESCRIBE, KNOWLEDGE_OUTPUT_DESCRIBE, knowledgeForModel, knowledgeOutputSchema } from "../../src/mcp/knowledge-output.js";
import {
  CREATE_KNOWLEDGE_SENTENCE,
  EDIT_TAG_SENTENCE,
  INVALID_KNOWLEDGE_ERROR_SENTENCE,
  OUTLINE_TAGS_DESCRIBE,
  READ_SECTION_KNOWLEDGE_SENTENCE,
  WRITE_KNOWLEDGE_SENTENCE,
} from "../../src/mcp/knowledge-strings.js";
import { MCP_PAGE_MAX } from "../../src/mcp/limits.js";
import { createNoteInput, createNoteOutput } from "../../src/mcp/tools/create-note.js";
import { editNoteInput, editNoteOutput } from "../../src/mcp/tools/edit-note.js";
import { READ_NOTE_SECTION_DESCRIPTION } from "../../src/mcp/tools/read-note-section.js";
import { readNoteOutlineOutput } from "../../src/mcp/tools/read-note-outline.js";
import { emptyKnowledgeReport } from "../../src/notes/editing/knowledge-write.js";

const docs = readFileSync(new URL("../../../../docs/mcp.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const describeOf = (schema: z.ZodTypeAny): string => schema.description ?? "";

describe("knowledge sentences in the tool strings", () => {
  it("each new sentence appears verbatim in docs/mcp.md", () => {
    for (const s of [
      READ_SECTION_KNOWLEDGE_SENTENCE,
      WRITE_KNOWLEDGE_SENTENCE,
      EDIT_TAG_SENTENCE,
      CREATE_KNOWLEDGE_SENTENCE,
      OUTLINE_TAGS_DESCRIBE,
      KNOWLEDGE_OUTPUT_DESCRIBE,
      CREATE_KNOWLEDGE_OUTPUT_DESCRIBE,
      INVALID_KNOWLEDGE_ERROR_SENTENCE,
    ]) {
      expect(docs, s.slice(0, 60)).toContain(s);
    }
  });

  it("they are the strings the tools carry", () => {
    expect(READ_NOTE_SECTION_DESCRIPTION.endsWith(` ${READ_SECTION_KNOWLEDGE_SENTENCE}`)).toBe(true);
    expect(describeOf(editNoteInput.markdown)).toContain(` ${WRITE_KNOWLEDGE_SENTENCE} ${EDIT_TAG_SENTENCE}`);
    expect(describeOf(createNoteInput.content)).toContain(` ${CREATE_KNOWLEDGE_SENTENCE}`);
    expect(describeOf(editNoteOutput.knowledge)).toBe(KNOWLEDGE_OUTPUT_DESCRIBE);
    expect(describeOf(createNoteOutput.knowledge)).toBe(CREATE_KNOWLEDGE_OUTPUT_DESCRIBE);
    expect(describeOf((readNoteOutlineOutput.note as unknown as z.ZodObject<{ tags: z.ZodTypeAny }>).shape.tags)).toBe(OUTLINE_TAGS_DESCRIBE);
  });

  it("edit_note's markdown description names every key and both status values, and does not say current is a status value", () => {
    for (const key of ["id", "when", "conclusion", "evidence", "verified", "status", "superseded_by"]) expect(WRITE_KNOWLEDGE_SENTENCE).toContain(key);
    expect(WRITE_KNOWLEDGE_SENTENCE).toContain("status (unverified, shown as Needs review, or outdated; leave it out for current)");
    expect(WRITE_KNOWLEDGE_SENTENCE).not.toMatch(/\bor current\b|\bcurrent or\b/);
    for (const v of ["tested", "docs", "inferred", "unconfirmed"]) expect(WRITE_KNOWLEDGE_SENTENCE).toContain(v);
  });

  it("the output's wording matches its limits: the list cap is the page size", () => {
    expect(KNOWLEDGE_OUTPUT_DESCRIBE).toContain(`at most ${MCP_PAGE_MAX} entries`);
  });
});

describe("knowledgeForModel", () => {
  const ref = (n: number, heading = `H${n}`) => ({ id: `k_${String(n).padStart(8, "0")}`, heading });

  it("cuts each list at 100 entries and says so", () => {
    const report = { ...emptyKnowledgeReport(), removed: Array.from({ length: 120 }, (_, i) => ref(i)) };
    const out = knowledgeForModel(report);
    expect(out.removed).toHaveLength(100);
    expect(out.kept).toHaveLength(0);
    expect(out.truncated).toBe(true);
    expect(knowledgeOutputSchema.safeParse(out).success).toBe(true);
  });

  it("is not truncated when every list fits, and carries from on renewed", () => {
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), renewed: [{ ...ref(1), from: "k_00000009" }], ignoredComments: 2 });
    expect(out).toEqual({ kept: [], created: [], removed: [], renewed: [{ id: "k_00000001", heading: "H1", from: "k_00000009" }], ignoredComments: 2, truncated: false });
  });

  it("cuts a heading at 200 characters as written in JSON and marks it, leaving short ones unmarked", () => {
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), created: [ref(1, "x".repeat(300)), ref(2, "short")] });
    expect(out.created[0]!.heading).toHaveLength(200);
    expect(out.created[0]!.headingTruncated).toBe(true);
    expect("headingTruncated" in out.created[1]!).toBe(false);
    const quoted = knowledgeForModel({ ...emptyKnowledgeReport(), created: [ref(1, '"'.repeat(150))] });
    expect(quoted.created[0]!.heading).toHaveLength(100);
  });

  it("an id counts toward a list's budget, so a very long id cuts the list short", () => {
    const longId = (n: number) => ({ id: `k_${String(n).padStart(8, "0")}${"z".repeat(5_000)}`, heading: "h" });
    const out = knowledgeForModel({ ...emptyKnowledgeReport(), kept: Array.from({ length: 100 }, (_, i) => longId(i)) });
    expect(out.truncated).toBe(true);
    expect(out.kept.length).toBeLessThanOrEqual(3);
    expect(JSON.stringify(out).length).toBeLessThan(13_000 + 1_000);
  });

  it("long headings use a list's wire budget before its 100 entries, so four full lists stay under the wire limit", () => {
    const long = (n: number) => ref(n, "y".repeat(200));
    const all = Array.from({ length: 100 }, (_, i) => long(i));
    const out = knowledgeForModel({ kept: all, created: all, removed: all, renewed: all.map(r => ({ ...r, from: "k_00000000" })), ignoredComments: 0 });
    expect(out.truncated).toBe(true);
    expect(JSON.stringify(out).length).toBeLessThan(56_000);
    for (const list of [out.kept, out.created, out.removed, out.renewed]) expect(list.length).toBeGreaterThan(40);
  });
});
