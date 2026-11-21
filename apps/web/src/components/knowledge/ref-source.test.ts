import { describe, expect, it } from "vitest";
import { localKnowledgeRefSource, rankKnowledgeMatches } from "./ref-source";
import { knowledgeEntries } from "./test-support";

const NOTE = "11111111-2222-3333-4444-555555555555";
const entries = knowledgeEntries([
  { id: "k_00000001", blockId: "b1", title: "Cache policy", props: { knowledgeConclusion: "keep ten minutes" } },
  { id: "k_00000002", blockId: "b2", title: "Logging", props: { knowledgeConclusion: "cache nothing here" } },
  { id: "k_00000003", blockId: "b3", title: "Disk cache", props: { knowledgeWhen: "unrelated" } },
]);

describe("rankKnowledgeMatches", () => {
  it("lists everything in document order for an empty query", () => {
    expect(rankKnowledgeMatches(entries, "  ").map((e) => e.blockId)).toEqual(["b1", "b2", "b3"]);
  });

  it("puts heading prefix matches before heading substring matches before conclusion matches", () => {
    expect(rankKnowledgeMatches(entries, "cache").map((e) => e.blockId)).toEqual(["b1", "b3", "b2"]);
  });

  it("matches case-insensitively and drops entries that match nothing", () => {
    expect(rankKnowledgeMatches(entries, "LOGG").map((e) => e.blockId)).toEqual(["b2"]);
    expect(rankKnowledgeMatches(entries, "zzz")).toEqual([]);
  });
});

describe("localKnowledgeRefSource", () => {
  const source = localKnowledgeRefSource(() => entries, NOTE);

  it("searches this note and stores bare ids", async () => {
    const found = await source.search("disk");
    expect(found.map((c) => c.ref)).toEqual(["k_00000003"]);
  });

  it("resolves a bare id and an id qualified with this note, but not another note", async () => {
    expect((await source.resolve("k_00000002"))?.heading).toBe("Logging");
    expect((await source.resolve(`${NOTE.toUpperCase()}#k_00000002`))?.heading).toBe("Logging");
    expect(await source.resolve("99999999-2222-3333-4444-555555555555#k_00000002")).toBeNull();
    expect(await source.resolve("k_ffffffff")).toBeNull();
    expect(await source.resolve("not a ref")).toBeNull();
  });
});
