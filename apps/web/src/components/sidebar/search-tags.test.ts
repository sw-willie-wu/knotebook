import { describe, expect, it } from "vitest";
import type { GroupDto, NoteDto, NoteTagDto } from "@knotebook/shared";
import { adminRole, EDITOR_PERMS, groupDto, OWNER_PERMS } from "@/test/fixtures";
import { mayHaveHash, notesMatchingTokens, type SearchTagToken } from "./search-tags";
import { addToken, filterableTagSpaces, hashFragmentAt, hashOptions, reconcileTokens, removeFragment, tokenFromTag } from "./search-tags-logic";

const GROUP: GroupDto = groupDto({ id: "g1", name: "Product" }, adminRole());
const PERSONAL = { kind: "personal" } as const;
const GROUP_SPACE = { kind: "group", groupId: "g1", groupName: "Product" } as const;

const tag = (id: string, name: string): NoteTagDto => ({ id, name, color: "blue" });
const WORK = tag("t-work", "Work");
const TODO = tag("t-todo", "Todo");
const MEETING = tag("t-meeting", "Meetings");
const DECISION = tag("t-decision", "Decisions");

function note(id: string, over: Partial<NoteDto> = {}): NoteDto {
  return {
    id, title: id, ownerId: "u1", role: "owner", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    slug: id, slugIsCustom: false, prevSlug: null, ownerHandle: "alice", lastEdited: null, group: null, groupId: null, folderId: null,
    permissions: OWNER_PERMS, ...over,
  };
}
const groupNote = (id: string, tags: NoteTagDto[]) =>
  note(id, { ownerId: null, ownerHandle: null, role: "editor", groupId: "g1", group: { id: "g1", name: "Product" }, permissions: EDITOR_PERMS, tags });
const sharedNote = (id: string, tags: NoteTagDto[]) => note(id, { ownerId: "u9", role: "editor", permissions: EDITOR_PERMS, tags });

const NOTES = [
  note("a", { tags: [WORK, TODO] }),
  note("b", { tags: [WORK] }),
  groupNote("c", [MEETING, DECISION]),
  groupNote("d", [MEETING]),
  sharedNote("e", [tag("t-shared", "Shared only")]),
  note("f"),
];

describe("mayHaveHash", () => {
  it("is true only for text with a half- or full-width #", () => {
    expect(mayHaveHash("plan #wo")).toBe(true);
    expect(mayHaveHash("＃會")).toBe(true);
    expect(mayHaveHash("plain text")).toBe(false);
  });
});

describe("hashFragmentAt", () => {
  it("finds # or ＃ at the start or after a space (also U+3000) and stops at whitespace", () => {
    expect(hashFragmentAt("#會", 2)).toEqual({ start: 0, end: 2, fragment: "會" });
    expect(hashFragmentAt("＃會", 2)).toEqual({ start: 0, end: 2, fragment: "會" });
    expect(hashFragmentAt("plan #wo", 8)).toEqual({ start: 5, end: 8, fragment: "wo" });
    expect(hashFragmentAt("plan　#wo", 8)).toEqual({ start: 5, end: 8, fragment: "wo" });
    expect(hashFragmentAt("#", 1)).toEqual({ start: 0, end: 1, fragment: "" });
    expect(hashFragmentAt("#wo rk", 6)).toBeNull();
  });

  it("does not trigger for a # inside a word", () => {
    expect(hashFragmentAt("C#", 2)).toBeNull();
    expect(hashFragmentAt("page#section", 12)).toBeNull();
    expect(hashFragmentAt("https://x.test/#top", 19)).toBeNull();
  });

  it("uses only the text before the caret and keeps a later # in the fragment", () => {
    expect(hashFragmentAt("#abc", 2)).toEqual({ start: 0, end: 2, fragment: "a" });
    expect(hashFragmentAt("#C#", 3)).toEqual({ start: 0, end: 3, fragment: "C#" });
    expect(hashFragmentAt("abc", 3)).toBeNull();
    expect(hashFragmentAt("", 0)).toBeNull();
  });
});

describe("filterableTagSpaces", () => {
  it("leaves out notes shared with me and counts notes per tag per space", () => {
    const spaces = filterableTagSpaces(NOTES, [GROUP]);
    expect(spaces.map((s) => s.space)).toEqual([PERSONAL, GROUP_SPACE]);
    expect(spaces[0]!.tags.map((t) => [t.name, t.count])).toEqual([["Todo", 1], ["Work", 2]]);
    expect(spaces[1]!.tags.map((t) => [t.name, t.count])).toEqual([["Decisions", 1], ["Meetings", 2]]);
  });

  it("is empty when no visible note has a tag", () => {
    expect(filterableTagSpaces([note("x"), sharedNote("y", [WORK])], [GROUP])).toEqual([]);
  });
});

describe("hashOptions", () => {
  const spaces = filterableTagSpaces(NOTES, [GROUP]);

  it("matches case-insensitively with prefix matches first", () => {
    const withMore = filterableTagSpaces([note("p", { tags: [tag("a1", "Backwork"), tag("a2", "work"), tag("a3", "Workshop")] })], []);
    const out = hashOptions(withMore, "WORK", []);
    expect(out[0]!.tags.map((t) => t.name)).toEqual(["work", "Workshop", "Backwork"]);
  });

  it("an empty fragment lists every tag of every space", () => {
    expect(hashOptions(spaces, "", []).map((s) => s.tags.length)).toEqual([2, 2]);
  });

  it("dims the other spaces when tokens exist and leaves out tags that are already tokens", () => {
    const token = tokenFromTag(WORK, PERSONAL);
    const out = hashOptions(spaces, "", [token]);
    expect(out[0]!.tags.map((t) => [t.name, t.dimmed])).toEqual([["Todo", false]]);
    expect(out[1]!.tags.every((t) => t.dimmed)).toBe(true);
  });

  it("returns nothing when no tag matches", () => {
    expect(hashOptions(spaces, "105", [])).toEqual([]);
  });
});

describe("notesMatchingTokens", () => {
  const groupIds = new Set(["g1"]);

  it("keeps only the token space's notes having every token, in list order", () => {
    const both = [tokenFromTag(MEETING, GROUP_SPACE), tokenFromTag(DECISION, GROUP_SPACE)];
    expect(notesMatchingTokens(NOTES, both, groupIds).map((n) => n.id)).toEqual(["c"]);
    expect(notesMatchingTokens(NOTES, [tokenFromTag(MEETING, GROUP_SPACE)], groupIds).map((n) => n.id)).toEqual(["c", "d"]);
    expect(notesMatchingTokens(NOTES, [tokenFromTag(WORK, PERSONAL)], groupIds).map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("never lists a note shared with me", () => {
    expect(notesMatchingTokens(NOTES, [tokenFromTag(tag("t-shared", "Shared only"), PERSONAL)], groupIds)).toEqual([]);
  });

  it("returns the list unchanged without tokens", () => {
    expect(notesMatchingTokens(NOTES, [], groupIds)).toHaveLength(NOTES.length);
  });
});

describe("token helpers", () => {
  const work = tokenFromTag(WORK, PERSONAL);
  const todo = tokenFromTag(TODO, PERSONAL);
  const meeting = tokenFromTag(MEETING, GROUP_SPACE);

  it("addToken appends in the same space, ignores a repeat, and replaces on another space", () => {
    expect(addToken([work], todo)).toEqual([work, todo]);
    expect(addToken([work], work)).toEqual([work]);
    expect(addToken([work, todo], meeting)).toEqual([meeting]);
    expect(addToken([], work)).toEqual([work]);
  });

  it("reconcileTokens drops vanished tags, refreshes a rename and keeps the array when nothing changed", () => {
    const spaces = filterableTagSpaces(NOTES, [GROUP]);
    const tokens: SearchTagToken[] = [work];
    expect(reconcileTokens(tokens, spaces)).toBe(tokens);
    const gone = tokenFromTag(tag("t-gone", "Gone"), PERSONAL);
    expect(reconcileTokens([work, gone], spaces)).toEqual([work]);
    const renamed = { ...work, name: "Old name" };
    expect(reconcileTokens([renamed], spaces)).toEqual([work]);
  });

  it("removeFragment drops the fragment and one of the two spaces around it", () => {
    expect(removeFragment("#wo", { start: 0, end: 3 })).toEqual({ text: "", caret: 0 });
    expect(removeFragment("abc #wo def", { start: 4, end: 7 })).toEqual({ text: "abc def", caret: 3 });
    expect(removeFragment("abc #wo", { start: 4, end: 7 })).toEqual({ text: "abc ", caret: 4 });
  });
});
