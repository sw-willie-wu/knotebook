import { describe, expect, it } from "vitest";
import { canonicalNotePath } from "@knotebook/shared";
import { matchesNoteRef } from "./note-ref";

const ID = "11111111-2222-3333-4444-555555555555";
const withSlug = { id: ID, slug: "my-note", title: "My Note" };
const noSlug = { id: ID, slug: null, title: "My Note" };
const symbolsOnlyTitle = { id: ID, slug: null, title: "!!!" };

describe("matchesNoteRef", () => {
  it("認得自訂 slug", () => {
    expect(matchesNoteRef("my-note", withSlug)).toBe(true);
  });

  it("認得 `<vanity>-<uuid>` 形式", () => {
    expect(matchesNoteRef(`my-note-${ID}`, noSlug)).toBe(true);
  });

  it("認得純 uuid（大小寫不敏感）", () => {
    expect(matchesNoteRef(ID, noSlug)).toBe(true);
    expect(matchesNoteRef(ID.toUpperCase(), noSlug)).toBe(true);
  });

  it("`canonicalNotePath` 產出的三種形式全部對得上", () => {
    for (const note of [withSlug, noSlug, symbolsOnlyTitle]) {
      const ref = canonicalNotePath(note).replace("/notes/", "");
      expect(matchesNoteRef(ref, note)).toBe(true);
    }
  });

  it("不同筆記不匹配", () => {
    expect(matchesNoteRef("99999999-2222-3333-4444-555555555555", noSlug)).toBe(false);
    expect(matchesNoteRef("other-slug", withSlug)).toBe(false);
  });

  it("undefined／空字串 ref（不在 /notes/:ref 路由上）一律 false", () => {
    expect(matchesNoteRef(undefined, noSlug)).toBe(false);
    expect(matchesNoteRef("", noSlug)).toBe(false);
  });

  it("slug 為 null 時不會被空字串 ref 誤判", () => {
    expect(matchesNoteRef("", { id: ID, slug: null })).toBe(false);
  });
});
