import { describe, expect, it } from "vitest";
import type { SpaceTagDto } from "@knotebook/shared";
import { tagOptions } from "./tag-options";

const tag = (id: string, name: string): SpaceTagDto => ({ id, name, color: "blue", noteCount: 1 });
const spaceTags = [tag("1", "Budget"), tag("2", "AWS"), tag("3", "Cloud budget"), tag("4", "Notes")];

describe("tagOptions", () => {
  it("prefix matches before substring matches, notes' own tags left out", () => {
    const options = tagOptions({ query: "bud", spaceTags, noteTagIds: new Set(["1"]), suggestions: [] });
    expect(options.map((o) => (o.kind === "existing" ? o.tag.name : `${o.kind}:${o.name}`))).toEqual(["Cloud budget", "create:bud"]);
    const both = tagOptions({ query: "bud", spaceTags, noteTagIds: new Set(), suggestions: [] });
    expect(both.filter((o) => o.kind === "existing").map((o) => (o as { tag: SpaceTagDto }).tag.name)).toEqual(["Budget", "Cloud budget"]);
  });

  it("offers create only when no existing name equals the query in any case", () => {
    const equal = tagOptions({ query: " aws ", spaceTags, noteTagIds: new Set(), suggestions: [] });
    expect(equal.some((o) => o.kind === "create")).toBe(false);
    const equalAttached = tagOptions({ query: "AWS", spaceTags, noteTagIds: new Set(["2"]), suggestions: [] });
    expect(equalAttached.some((o) => o.kind === "create")).toBe(false);
    const fresh = tagOptions({ query: "aw", spaceTags, noteTagIds: new Set(), suggestions: [] });
    expect(fresh.at(-1)).toEqual({ kind: "create", name: "aw" });
  });

  it("an empty query lists existing tags then suggestions and no create", () => {
    const options = tagOptions({ query: "  ", spaceTags, noteTagIds: new Set(["4"]), suggestions: ["Draft"] });
    expect(options.map((o) => o.kind)).toEqual(["existing", "existing", "existing", "suggestion"]);
    expect(options.some((o) => o.kind === "existing" && o.tag.id === "4")).toBe(false);
  });

  it("offers no create for a query that is not a valid name", () => {
    const options = tagOptions({ query: "x".repeat(41), spaceTags, noteTagIds: new Set(), suggestions: [] });
    expect(options).toEqual([]);
  });
});
