import { describe, expect, it } from "vitest";
import { isNoteRoutePath } from "./phone-list";

describe("isNoteRoutePath", () => {
  it.each([
    ["/n/alice/my-note", true],
    ["/g/9f3c/my-note", true],
    ["/notes/abc", true],
    ["/", false],
    ["/groups/9f3c", false],
    ["/groups/9f3c/roles", false],
    ["/settings/account", false],
    ["/admin/users", false],
    ["/something/unknown", false],
    ["/n/alice", false],
    ["/n/alice/a/b", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isNoteRoutePath(pathname)).toBe(expected);
  });
});
