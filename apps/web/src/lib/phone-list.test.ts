import { describe, expect, it } from "vitest";
import { isNoteRoutePath, isPageRoutePath, isTrashPreviewPath, trashPreviewPath } from "./phone-list";

describe("isNoteRoutePath", () => {
  it.each([
    ["/n/alice/my-note", true],
    ["/g/9f3c/my-note", true],
    ["/notes/abc", true],
    ["/trash/abc", false],
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

describe("isTrashPreviewPath", () => {
  it.each([
    ["/trash/abc", true],
    ["/trash/11111111-1111-4111-8111-111111111111", true],
    ["/trash", false],
    ["/trash/abc/extra", false],
    ["/notes/abc", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isTrashPreviewPath(pathname)).toBe(expected);
  });

  it("trashPreviewPath encodes id", () => {
    expect(trashPreviewPath("abc-123")).toBe("/trash/abc-123");
  });
});

describe("isPageRoutePath", () => {
  it.each([
    ["/n/alice/my-note", true],
    ["/g/9f3c/my-note", true],
    ["/notes/abc", true],
    ["/trash/abc", true],
    ["/knowledge/me", true],
    ["/knowledge/g/9f3c", true],
    ["/knowledge/f/9f3c", true],
    ["/", false],
    ["/trash", false],
    ["/groups/x", false],
    ["/settings/account", false],
    ["/knowledge", false],
    ["/knowledge/g", false],
  ])("%s -> %s", (pathname, expected) => {
    expect(isPageRoutePath(pathname)).toBe(expected);
  });
});
