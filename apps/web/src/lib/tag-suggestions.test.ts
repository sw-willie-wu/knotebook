import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { tagSuggestions } from "./tag-suggestions";

const tEn = i18n.getFixedT("en");
const tZh = i18n.getFixedT("zh-TW");
const none: ReadonlySet<string> = new Set();

describe("tagSuggestions", () => {
  it("lists the eight suggestions in order for en and for zh-TW", () => {
    expect(tagSuggestions(tEn, { query: "", existingKeys: none })).toEqual([
      "To do", "Reference", "Meeting notes", "Decision", "Idea", "Draft", "Important", "Archive",
    ]);
    expect(tagSuggestions(tZh, { query: "", existingKeys: none })).toEqual([
      "待辦", "參考", "會議紀錄", "決策", "想法", "草稿", "重要", "封存",
    ]);
  });

  it("leaves out names the space already has, in any case, and keeps only those containing the query", () => {
    const left = tagSuggestions(tEn, { query: "", existingKeys: new Set(["to do", "idea"]) });
    expect(left).not.toContain("To do");
    expect(left).not.toContain("Idea");
    expect(left).toHaveLength(6);
    expect(tagSuggestions(tEn, { query: "DR", existingKeys: none })).toEqual(["Draft"]);
    expect(tagSuggestions(tEn, { query: "refer", existingKeys: new Set(["reference"]) })).toEqual([]);
  });
});
