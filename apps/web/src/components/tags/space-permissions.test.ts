import { describe, expect, it } from "vitest";
import { canManageSpaceTags } from "./space-permissions";

const groups = [
  { id: "g1", canManageGroup: true },
  { id: "g2", canManageGroup: false },
];

describe("canManageSpaceTags", () => {
  it("lets the owner of a personal note manage the list and keeps an edit share out", () => {
    expect(canManageSpaceTags({ groupId: null, role: "owner" }, undefined)).toBe(true);
    expect(canManageSpaceTags({ groupId: null, role: "editor" }, undefined)).toBe(false);
    expect(canManageSpaceTags({ groupId: null, role: "viewer" }, undefined)).toBe(false);
  });

  it("follows canManageGroup for a group note, and says no while the groups list has not loaded", () => {
    expect(canManageSpaceTags({ groupId: "g1", role: "editor" }, groups)).toBe(true);
    expect(canManageSpaceTags({ groupId: "g2", role: "owner" }, groups)).toBe(false);
    expect(canManageSpaceTags({ groupId: "g3", role: "owner" }, groups)).toBe(false);
    expect(canManageSpaceTags({ groupId: "g1", role: "owner" }, undefined)).toBe(false);
  });
});
