import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import "@/i18n/knowledge-strings";
import "@/i18n/knowledge-index-strings";
import { IndexSection } from "./IndexSection";
import { buildIndexSections } from "./sections";
import { indexDto, indexEntry, indexNote } from "./test-support";

const ORIGINAL = indexNote({ id: "11111111-1111-4111-8111-111111111111", title: "Original", path: "/n/alice/original" });
const COPY = indexNote({ id: "22222222-2222-4222-8222-222222222222", title: "Original (copy)", path: "/n/alice/original-copy" });
const KIDS = ["k_one", "k_two", "k_three"];

// A copied note keeps its knowledge ids, so two notes in one section can hold the same ids.
const entriesOf = (noteId: string, keep: (id: string) => boolean = () => true) =>
  KIDS.filter(keep).map((knowledgeId, ord) =>
    indexEntry({ noteId, knowledgeId, ord, when: "w", blockId: `b_${knowledgeId}`, parentKnowledgeId: knowledgeId === "k_three" ? "k_one" : null }),
  );

const section = (entries: ReturnType<typeof entriesOf>) =>
  buildIndexSections({ dto: indexDto({ notes: [ORIGINAL, COPY], entries }), groupBy: "folder", scopeTitle: "Space", untaggedTitle: "No tag" })[0]!;

const hrefs = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

describe("IndexSection", () => {
  it("rows from two notes sharing knowledge ids stay correct when a filter narrows the rows and clears again", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const all = [...entriesOf(ORIGINAL.id), ...entriesOf(COPY.id)];
    const filtered = [...entriesOf(ORIGINAL.id, (id) => id !== "k_two"), ...entriesOf(COPY.id, (id) => id === "k_two")];
    const view = (s: ReturnType<typeof section>) => (
      <MemoryRouter>
        <IndexSection section={s} />
      </MemoryRouter>
    );
    const expectedAll = [
      "/n/alice/original#b-b_k_one",
      "/n/alice/original#b-b_k_three",
      "/n/alice/original#b-b_k_two",
      "/n/alice/original-copy#b-b_k_one",
      "/n/alice/original-copy#b-b_k_three",
      "/n/alice/original-copy#b-b_k_two",
    ];
    const { rerender } = render(view(section(all)));
    expect(hrefs()).toEqual(expect.arrayContaining(expectedAll));
    expect(hrefs()).toHaveLength(6);
    rerender(view(section(filtered)));
    expect(hrefs().sort()).toEqual(["/n/alice/original#b-b_k_one", "/n/alice/original#b-b_k_three", "/n/alice/original-copy#b-b_k_two"]);
    rerender(view(section(all)));
    expect(hrefs().sort()).toEqual([...expectedAll].sort());
    expect(errors.mock.calls.filter((c) => String(c[0]).includes("same key"))).toEqual([]);
    errors.mockRestore();
  });
});
