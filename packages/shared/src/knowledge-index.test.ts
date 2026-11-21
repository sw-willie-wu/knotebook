import { describe, expect, expectTypeOf, it } from "vitest";
import { KNOWLEDGE_EVIDENCE } from "./knowledge.js";
import type { KnowledgeIconKind } from "./knowledge-list.js";
import {
  INDEX_COLLATOR_LOCALE,
  INDEX_COLLATOR_OPTIONS,
  KNOWLEDGE_ICON_KINDS,
  KNOWLEDGE_INDEX_EVIDENCE_FILTERS,
  KNOWLEDGE_INDEX_HEADING_MAX,
  KNOWLEDGE_INDEX_MAX,
  KNOWLEDGE_INDEX_NOTE_MAX,
  KNOWLEDGE_INDEX_STATUS_FILTERS,
  KNOWLEDGE_INDEX_TAG_FILTER_MAX,
  KNOWLEDGE_REFS_LIMIT,
  isKnowledgeIndexEvidenceFilter,
  isKnowledgeIndexStatusFilter,
  orderIndexNotes,
  type KnowledgeIndexFolderDto,
} from "./knowledge-index.js";

const folder = (id: string, name: string, parentId: string | null = null): KnowledgeIndexFolderDto => ({ id, name, parentId });
const note = (id: string, title: string, folderId: string | null = null) => ({ id, title, folderId });

describe("knowledge index constants and guards", () => {
  it("KNOWLEDGE_ICON_KINDS lists every KnowledgeIconKind exactly once", () => {
    expectTypeOf<Exclude<KnowledgeIconKind, (typeof KNOWLEDGE_ICON_KINDS)[number]>>().toEqualTypeOf<never>();
    expect(new Set(KNOWLEDGE_ICON_KINDS).size).toBe(4);
  });
  it("status filters are the three non-verified icon kinds", () => {
    expect([...KNOWLEDGE_INDEX_STATUS_FILTERS]).toEqual(["noVerifiedDate", "needsReview", "outdated"]);
    expect(KNOWLEDGE_INDEX_STATUS_FILTERS.every((s) => (KNOWLEDGE_ICON_KINDS as readonly string[]).includes(s))).toBe(true);
  });
  it("evidence filters are KNOWLEDGE_EVIDENCE plus unconfirmed", () => {
    expect([...KNOWLEDGE_INDEX_EVIDENCE_FILTERS]).toEqual([...KNOWLEDGE_EVIDENCE, "unconfirmed"]);
  });
  it("the guards accept only listed values", () => {
    expect(isKnowledgeIndexStatusFilter("needsReview")).toBe(true);
    expect(isKnowledgeIndexStatusFilter("verified")).toBe(false);
    expect(isKnowledgeIndexEvidenceFilter("unconfirmed")).toBe(true);
    expect(isKnowledgeIndexEvidenceFilter("")).toBe(false);
    expect(isKnowledgeIndexStatusFilter(undefined)).toBe(false);
  });
  it("limits", () => {
    expect([KNOWLEDGE_INDEX_MAX, KNOWLEDGE_INDEX_NOTE_MAX, KNOWLEDGE_INDEX_HEADING_MAX, KNOWLEDGE_INDEX_TAG_FILTER_MAX, KNOWLEDGE_REFS_LIMIT]).toEqual([
      5000, 2000, 200, 20, 20,
    ]);
  });
  it("collator settings are the sidebar's", () => {
    expect(INDEX_COLLATOR_LOCALE).toBe("zh-Hant");
    expect(INDEX_COLLATOR_OPTIONS).toEqual({ numeric: true, sensitivity: "base" });
  });
});

describe("orderIndexNotes", () => {
  it("a space puts notes without a folder (or with a folder not in folders) first, then folders depth-first, siblings by name with numeric order, then id", () => {
    const folders = [folder("f10", "10"), folder("f9", "9"), folder("fb", "b"), folder("fB", "B"), folder("f9a", "a", "f9")];
    const notes = [
      note("n-b", "x", "fb"),
      note("n-B", "x", "fB"),
      note("n-10", "x", "f10"),
      note("n-9a", "x", "f9a"),
      note("n-9", "x", "f9"),
      note("n-root", "x", null),
      note("n-orphan", "x", "missing"),
    ];
    // "b" and "B" compare equal under sensitivity base, so the folder id decides: "fB" < "fb".
    expect(orderIndexNotes({ notes, folders, rootFolderId: null })).toEqual(["n-orphan", "n-root", "n-9", "n-9a", "n-10", "n-B", "n-b"]);
  });
  it("a folder scope puts the root folder's own notes first and never lists notes outside its subtree first", () => {
    const folders = [folder("r", "r"), folder("c1", "b", "r"), folder("c2", "a", "r")];
    const notes = [note("n-c1", "t", "c1"), note("n-out", "t", "elsewhere"), note("n-r", "t", "r"), note("n-c2", "t", "c2")];
    expect(orderIndexNotes({ notes, folders, rootFolderId: "r" })).toEqual(["n-r", "n-c2", "n-c1", "n-out"]);
  });
  it("within a folder notes sort by title (case- and accent-insensitive, numeric), then id; a parent cycle in folders terminates", () => {
    const notes = [note("3", "Note 10"), note("2", "note 9"), note("1", "Éa"), note("0", "ea"), note("c", "cyc", "fa")];
    const folders = [folder("fa", "a", "fb"), folder("fb", "b", "fa")];
    const out = orderIndexNotes({ notes, folders, rootFolderId: null });
    expect(out).toEqual(["0", "1", "2", "3", "c"]);
  });
  it("lists every note exactly once", () => {
    const folders = [folder("fa", "a", "fb"), folder("fb", "b", "fa"), folder("g", "g")];
    const notes = Array.from({ length: 30 }, (_, i) => note(`n${i}`, `t${i % 3}`, ["fa", "fb", "g", null, "zz"][i % 5]!));
    const out = orderIndexNotes({ notes, folders, rootFolderId: null });
    expect([...out].sort()).toEqual(notes.map((n) => n.id).sort());
  });
  it("handles a deep folder chain without recursion", () => {
    const folders = Array.from({ length: 50_000 }, (_, i) => folder(`f${i}`, `n${i}`, i === 0 ? null : `f${i - 1}`));
    const notes = [note("deep", "t", "f49999")];
    expect(orderIndexNotes({ notes, folders, rootFolderId: null })).toEqual(["deep"]);
  });
});
