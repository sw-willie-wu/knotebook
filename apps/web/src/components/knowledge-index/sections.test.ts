import { describe, expect, it } from "vitest";
import { INDEX_COLLATOR_LOCALE, INDEX_COLLATOR_OPTIONS, orderIndexNotes } from "@knotebook/shared";
import { FOLDER_COLLATOR } from "@/components/sidebar/folder-index";
import { buildIndexSections, type IndexRowModel } from "./sections";
import { indexDto, indexEntry, indexNote, tag } from "./test-support";

const N1 = "11111111-1111-4111-8111-111111111111";
const N2 = "22222222-2222-4222-8222-222222222222";
const N3 = "33333333-3333-4333-8333-333333333333";
const base = { scopeTitle: "Space", untaggedTitle: "No tag" };

const flat = (rows: IndexRowModel[]): string[] => rows.flatMap((r) => [r.entry.knowledgeId, ...flat(r.nested)]);

describe("folder grouping", () => {
  const folders = [
    { id: "fb", name: "beta", parentId: null },
    { id: "fa", name: "alpha", parentId: null },
    { id: "fa1", name: "inner", parentId: "fa" },
  ];

  it("orders notes exactly as orderIndexNotes and titles each subfolder section with the path relative to the scope", () => {
    const notes = [
      indexNote({ id: N1, title: "Zed", folderId: "fa1" }),
      indexNote({ id: N2, title: "Mid", folderId: "fb" }),
      indexNote({ id: N3, title: "Top", folderId: null }),
    ];
    const entries = notes.map((n) => indexEntry({ noteId: n.id, knowledgeId: `k_${n.title}` }));
    const dto = indexDto({ folders, notes, entries });
    const sections = buildIndexSections({ dto, groupBy: "folder", ...base });
    expect(sections.map((s) => s.title)).toEqual(["Space", "alpha / inner", "beta"]);
    const expected = orderIndexNotes({ notes, folders, rootFolderId: null }).map((id) => notes.find((n) => n.id === id)!.title);
    expect(sections.flatMap((s) => s.rows.map((r) => r.note.title))).toEqual(expected);
  });

  it("a section lists the capped notes whose rows it holds, in display order, and no others", () => {
    const notes = [
      indexNote({ id: N1, title: "Zed", folderId: "fb", capped: true }),
      indexNote({ id: N2, title: "Mid", folderId: "fb" }),
      indexNote({ id: N3, title: "Top", folderId: null, capped: true }),
    ];
    const entries = notes.map((n) => indexEntry({ noteId: n.id, knowledgeId: `k_${n.title}` }));
    const sections = buildIndexSections({ dto: indexDto({ folders, notes, entries }), groupBy: "folder", ...base });
    expect(sections.map((s) => [s.title, s.cappedNotes.map((n) => n.title)])).toEqual([["Space", ["Top"]], ["beta", ["Zed"]]]);
  });

  it("a capped note is listed in every tag section that holds its rows", () => {
    const notes = [indexNote({ id: N1, title: "Zed", capped: true, tags: [tag("t1", "a"), tag("t2", "b")] }), indexNote({ id: N2, title: "Mid", tags: [tag("t1", "a")] })];
    const entries = notes.map((n) => indexEntry({ noteId: n.id, knowledgeId: `k_${n.title}` }));
    const sections = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "tag", ...base });
    expect(sections.map((s) => [s.title, s.cappedNotes.map((n) => n.title)])).toEqual([["a", ["Zed"]], ["b", ["Zed"]]]);
  });

  it("FOLDER_COLLATOR resolves to INDEX_COLLATOR_LOCALE and INDEX_COLLATOR_OPTIONS, so the server cut and the page order agree", () => {
    const resolved = FOLDER_COLLATOR.resolvedOptions();
    const reference = new Intl.Collator(INDEX_COLLATOR_LOCALE, INDEX_COLLATOR_OPTIONS).resolvedOptions();
    expect(resolved).toEqual(reference);
  });

  it("a folder index's first section is the folder's own notes, titled with the scope title", () => {
    const notes = [indexNote({ id: N1, title: "Own", folderId: "root" }), indexNote({ id: N2, title: "Deep", folderId: "child" })];
    const dto = indexDto({
      scope: { kind: "folder", groupId: null, groupName: null, folderId: "root", folderPath: ["root"] },
      folders: [
        { id: "root", name: "root", parentId: "outside" },
        { id: "child", name: "child", parentId: "root" },
      ],
      notes,
      entries: notes.map((n) => indexEntry({ noteId: n.id, knowledgeId: `k_${n.title}` })),
    });
    const sections = buildIndexSections({ dto, groupBy: "folder", ...base, scopeTitle: "root" });
    expect(sections.map((s) => s.title)).toEqual(["root", "child"]);
    expect(sections[0]!.rows[0]!.note.title).toBe("Own");
  });

  it("a note whose folder isn't in dto.folders goes to the first section", () => {
    const notes = [indexNote({ id: N1, folderId: "gone" }), indexNote({ id: N2, folderId: "fb" })];
    const dto = indexDto({ folders, notes, entries: notes.map((n) => indexEntry({ noteId: n.id, knowledgeId: `k_${n.id.slice(0, 2)}` })) });
    const sections = buildIndexSections({ dto, groupBy: "folder", ...base });
    expect(sections[0]!.title).toBe("Space");
    expect(sections[0]!.rows.map((r) => r.note.id)).toEqual([N1]);
  });

  it("within a section notes sort by title then id, entries by ord", () => {
    const notes = [indexNote({ id: N2, title: "B" }), indexNote({ id: N1, title: "B" }), indexNote({ id: N3, title: "A" })];
    const entries = [
      indexEntry({ noteId: N3, knowledgeId: "k_a2", ord: 2, when: "x" }),
      indexEntry({ noteId: N3, knowledgeId: "k_a1", ord: 1, when: "x" }),
      indexEntry({ noteId: N1, knowledgeId: "k_b1", when: "x" }),
      indexEntry({ noteId: N2, knowledgeId: "k_b2", when: "x" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "folder", ...base });
    expect(flat(section!.rows)).toEqual(["k_a1", "k_a2", "k_b1", "k_b2"]);
  });

  it("empty sections are dropped", () => {
    const notes = [indexNote({ id: N1, folderId: "fb" })];
    const sections = buildIndexSections({ dto: indexDto({ folders, notes, entries: [indexEntry({ noteId: N1, knowledgeId: "k_1" })] }), groupBy: "folder", ...base });
    expect(sections.map((s) => s.title)).toEqual(["beta"]);
  });
});

describe("tag grouping", () => {
  it("lists a note under each of its tags by tag name, and notes without tags in a last No tag section", () => {
    const red = tag("t1", "Red");
    const blue = tag("t2", "blue");
    const notes = [indexNote({ id: N1, tags: [red, blue] }), indexNote({ id: N2, tags: [red] }), indexNote({ id: N3 })];
    const entries = notes.map((n) => indexEntry({ noteId: n.id, knowledgeId: `k_${n.id.slice(0, 2)}` }));
    const sections = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "tag", ...base });
    expect(sections.map((s) => s.title)).toEqual(["blue", "Red", "No tag"]);
    expect(sections.map((s) => s.count)).toEqual([1, 2, 1]);
    expect(sections[0]!.tag).toEqual(blue);
    expect(sections[2]!.tag).toBeUndefined();
  });
});

describe("rows", () => {
  const notes = [indexNote({ id: N1 })];

  it("an entry with empty when whose parent is in the result nests under it with its own nested children; with when filled, or a missing parent, it is a top-level row", () => {
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "k_p", ord: 1, when: "w" }),
      indexEntry({ noteId: N1, knowledgeId: "k_c", ord: 2, parentKnowledgeId: "k_p" }),
      indexEntry({ noteId: N1, knowledgeId: "k_g", ord: 3, parentKnowledgeId: "k_c" }),
      indexEntry({ noteId: N1, knowledgeId: "k_f", ord: 4, parentKnowledgeId: "k_p", when: "own" }),
      indexEntry({ noteId: N1, knowledgeId: "k_o", ord: 5, parentKnowledgeId: "k_missing" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "folder", ...base });
    expect(section!.rows.map((r) => r.entry.knowledgeId)).toEqual(["k_p", "k_f", "k_o"]);
    const parent = section!.rows[0]!;
    expect(parent.nested.map((r) => r.entry.knowledgeId)).toEqual(["k_c"]);
    expect(parent.nested[0]!.nested.map((r) => r.entry.knowledgeId)).toEqual(["k_g"]);
  });

  it("a parent cycle in bad data leaves every row on the page", () => {
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "k_a", ord: 1, parentKnowledgeId: "k_b" }),
      indexEntry({ noteId: N1, knowledgeId: "k_b", ord: 2, parentKnowledgeId: "k_a" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "folder", ...base });
    expect(flat(section!.rows).sort()).toEqual(["k_a", "k_b"]);
  });

  it("outdated top-level rows move to the end of their section keeping their order; nested rows don't move", () => {
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "k_old1", ord: 1, when: "w", icon: "outdated", status: "outdated" }),
      indexEntry({ noteId: N1, knowledgeId: "k_ok", ord: 2, when: "w" }),
      indexEntry({ noteId: N1, knowledgeId: "k_old2", ord: 3, when: "w", icon: "outdated" }),
      indexEntry({ noteId: N1, knowledgeId: "k_new", ord: 4, when: "w" }),
      indexEntry({ noteId: N1, knowledgeId: "k_n1", ord: 5, parentKnowledgeId: "k_ok", icon: "outdated" }),
      indexEntry({ noteId: N1, knowledgeId: "k_n2", ord: 6, parentKnowledgeId: "k_ok" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "folder", ...base });
    expect(section!.rows.map((r) => r.entry.knowledgeId)).toEqual(["k_ok", "k_new", "k_old1", "k_old2"]);
    expect(section!.rows[0]!.nested.map((r) => r.entry.knowledgeId)).toEqual(["k_n1", "k_n2"]);
  });

  it("count includes nested rows", () => {
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "k_p", ord: 1, when: "w" }),
      indexEntry({ noteId: N1, knowledgeId: "k_c", ord: 2, parentKnowledgeId: "k_p" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "folder", ...base });
    expect(section!.count).toBe(2);
  });

  it("replacement: found from dto.replacements, missing for a same-note ref, otherNote for another note's ref, null unless the entry itself is outdated", () => {
    const refFound = `${N2}#k_aaaaaaaa`;
    const refOther = `${N3}#k_bbbbbbbb`;
    const refSame = `${N1}#k_cccccccc`;
    const target = { noteId: N2, knowledgeId: "k_aaaaaaaa", blockId: "b_aaaaaaaa", heading: "New", noteTitle: "Other", path: "/n/alice/other" };
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "k_1", ord: 1, when: "w", status: "outdated", icon: "outdated", supersededBy: refFound }),
      indexEntry({ noteId: N1, knowledgeId: "k_2", ord: 2, when: "w", status: "outdated", icon: "outdated", supersededBy: refOther }),
      indexEntry({ noteId: N1, knowledgeId: "k_3", ord: 3, when: "w", status: "outdated", icon: "outdated", supersededBy: refSame }),
      indexEntry({ noteId: N1, knowledgeId: "k_4", ord: 4, when: "w", icon: "outdated", supersededBy: null }),
      indexEntry({ noteId: N1, knowledgeId: "k_5", ord: 5, when: "w", status: "", supersededBy: refFound }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries, replacements: { [refFound]: target } }), groupBy: "folder", ...base });
    const byId = new Map(section!.rows.map((r) => [r.entry.knowledgeId, r.replacement]));
    expect(byId.get("k_1")).toEqual({ state: "found", target });
    expect(byId.get("k_2")).toEqual({ state: "otherNote" });
    expect(byId.get("k_3")).toEqual({ state: "missing" });
    expect(byId.get("k_4")).toBeNull();
    expect(byId.get("k_5")).toBeNull();
  });
});

describe("outdated rows across notes", () => {
  const notes = [indexNote({ id: N1, title: "A" }), indexNote({ id: N2, title: "B" })];

  it("in a folder section, an earlier note's outdated rows come after a later note's current rows", () => {
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "a_old", ord: 1, when: "w", icon: "outdated" }),
      indexEntry({ noteId: N1, knowledgeId: "a_ok", ord: 2, when: "w" }),
      indexEntry({ noteId: N2, knowledgeId: "b_old", ord: 1, when: "w", icon: "outdated" }),
      indexEntry({ noteId: N2, knowledgeId: "b_ok", ord: 2, when: "w" }),
      indexEntry({ noteId: N1, knowledgeId: "a_child", ord: 3, parentKnowledgeId: "a_old", icon: "verified" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes, entries }), groupBy: "folder", ...base });
    expect(section!.rows.map((r) => r.entry.knowledgeId)).toEqual(["a_ok", "b_ok", "a_old", "b_old"]);
    expect(section!.rows[2]!.nested.map((r) => r.entry.knowledgeId)).toEqual(["a_child"]);
  });

  it("in a tag section, the same holds", () => {
    const t1 = tag("t1", "x");
    const tagged = notes.map((n) => ({ ...n, tags: [t1] }));
    const entries = [
      indexEntry({ noteId: N1, knowledgeId: "a_old", ord: 1, when: "w", icon: "outdated" }),
      indexEntry({ noteId: N2, knowledgeId: "b_ok", ord: 1, when: "w" }),
    ];
    const [section] = buildIndexSections({ dto: indexDto({ notes: tagged, entries }), groupBy: "tag", ...base });
    expect(section!.rows.map((r) => r.entry.knowledgeId)).toEqual(["b_ok", "a_old"]);
  });
});
