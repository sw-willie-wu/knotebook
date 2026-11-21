import { describe, expect, it } from "vitest";
import { isNoteRoutePath, isPageRoutePath } from "./phone-list";

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

describe("isPageRoutePath", () => {
  it.each([
    ["/n/alice/my-note", true],
    ["/g/9f3c/my-note", true],
    ["/notes/abc", true],
    ["/knowledge/me", true],
    ["/knowledge/g/9f3c", true],
    ["/knowledge/f/9f3c", true],
    ["/", false],
    ["/groups/x", false],
    ["/settings/account", false],
    ["/knowledge", false],
    ["/knowledge/g", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isPageRoutePath(pathname)).toBe(expected);
  });
});
