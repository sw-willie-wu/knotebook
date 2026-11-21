import { describe, expect, it } from "vitest";
import type { NoteTagDto } from "@knotebook/shared";
import { personalNote } from "@/test/select-fixtures";
import { countedTagOptionsForNotes, tagOptionsForNotes } from "./note-tag-options";

const WORK: NoteTagDto = { id: "t-work", name: "work", color: "blue" };
const BOOKS: NoteTagDto = { id: "t-books", name: "Books", color: "green" };
const ARCHIVE: NoteTagDto = { id: "t-archive", name: "archive", color: "gray" };

describe("note tag options", () => {
  it("tagOptionsForNotes returns each tag once, sorted by name case-insensitively", () => {
    const notes = [
      personalNote({ id: "n1", title: "One", tags: [WORK, BOOKS] }),
      personalNote({ id: "n2", title: "Two", tags: [ARCHIVE, WORK] }),
      personalNote({ id: "n3", title: "Three" }),
    ];
    expect(tagOptionsForNotes(notes).map((tag) => tag.name)).toEqual(["archive", "Books", "work"]);
    expect(tagOptionsForNotes(notes)[0]).toEqual(ARCHIVE);
  });

  it("counts how many of the notes carry each tag", () => {
    const notes = [
      personalNote({ id: "n1", title: "One", tags: [WORK, BOOKS] }),
      personalNote({ id: "n2", title: "Two", tags: [WORK] }),
    ];
    expect(countedTagOptionsForNotes(notes).map((tag) => [tag.name, tag.count])).toEqual([
      ["Books", 1],
      ["work", 2],
    ]);
  });
});
