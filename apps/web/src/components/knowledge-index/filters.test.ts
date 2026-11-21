import { describe, expect, it } from "vitest";
import { KNOWLEDGE_INDEX_TAG_FILTER_MAX } from "@knotebook/shared";
import { readIndexFilters, writeIndexFilters } from "./filters";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const read = (qs: string) => readIndexFilters(new URLSearchParams(qs));

describe("readIndexFilters", () => {
  it("defaults: folder grouping, no tags, no status, no evidence; unknown values fall back to defaults", () => {
    const defaults = { groupBy: "folder", tagIds: [], status: null, evidence: null };
    expect(read("")).toEqual(defaults);
    expect(read("group=folder&status=bogus&evidence=nope&tags=")).toEqual(defaults);
    expect(read("group=Tag&status=verified")).toEqual(defaults);
  });

  it("reads group=tag, a status and an evidence value", () => {
    expect(read("group=tag&status=needsReview&evidence=tested")).toEqual({ groupBy: "tag", tagIds: [], status: "needsReview", evidence: "tested" });
  });

  it("tags keeps at most 20 distinct lowercased uuids in the given order and drops anything else", () => {
    const many = Array.from({ length: 25 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(read(`tags=${A.toUpperCase()},nope,${B},${A},,${B}`).tagIds).toEqual([A, B]);
    expect(read(`tags=${many.join(",")}`).tagIds).toEqual(many.slice(0, KNOWLEDGE_INDEX_TAG_FILTER_MAX));
  });

  it("a repeated parameter uses its first value", () => {
    expect(read(`status=outdated&status=needsReview&tags=${A}&tags=${B}`)).toMatchObject({ status: "outdated", tagIds: [A] });
  });
});

describe("writeIndexFilters", () => {
  it("omits defaults and orders keys group, tags, status, evidence; read(write(x)) equals x", () => {
    expect(writeIndexFilters({ groupBy: "folder", tagIds: [], status: null, evidence: null }).toString()).toBe("");
    const full = { groupBy: "tag" as const, tagIds: [A, B], status: "outdated" as const, evidence: "docs" as const };
    expect(writeIndexFilters(full).toString()).toBe(`group=tag&tags=${A}%2C${B}&status=outdated&evidence=docs`);
    expect(readIndexFilters(writeIndexFilters(full))).toEqual(full);
  });
});
