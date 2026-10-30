import { describe, expect, it } from "vitest";
import {
  folderSpaceLockKey,
  folderSpaceOfRow,
  newNoteFolderConsistent,
  noteFolderSpace,
  sameFolderSpace,
  sortedSpaceLockKeys,
  toFolderSpaceDto,
} from "../../src/folders/space.js";

const U = "0b6f3a2e-1c4d-4e5f-8a9b-0c1d2e3f4a5b";
const G = "ffffffff-1c4d-4e5f-8a9b-0c1d2e3f4a5b";

describe("SP-1 結構鎖鍵（spec §5.4 N2）", () => {
  it("大寫 id 與小寫 id 同鍵", () => {
    expect(folderSpaceLockKey({ kind: "personal", ownerId: U.toUpperCase() })).toBe(
      folderSpaceLockKey({ kind: "personal", ownerId: U }),
    );
    expect(folderSpaceLockKey({ kind: "group", groupId: G.toUpperCase() })).toBe(`knotebook.folders:group:${G}`);
  });
  it("三種前綴", () => {
    expect(folderSpaceLockKey({ kind: "personal", ownerId: U })).toBe(`knotebook.folders:personal:${U}`);
    expect(folderSpaceLockKey({ kind: "shared", ownerId: U })).toBe(`knotebook.folders:shared:${U}`);
    expect(folderSpaceLockKey({ kind: "group", groupId: G })).toBe(`knotebook.folders:group:${G}`);
  });
  it("sortedSpaceLockKeys 去重（含大小寫變體）且依鍵字串排序", () => {
    expect(
      sortedSpaceLockKeys([
        { kind: "personal", ownerId: U },
        { kind: "group", groupId: G },
        { kind: "personal", ownerId: U.toUpperCase() },
        { kind: "group", groupId: G },
      ]),
    ).toEqual([`knotebook.folders:group:${G}`, `knotebook.folders:personal:${U}`]);
  });
});

describe("SP-2 列與筆記的空間", () => {
  it("folderSpaceOfRow 三種 kind", () => {
    expect(folderSpaceOfRow({ kind: "personal", ownerId: U, groupId: null })).toEqual({ kind: "personal", ownerId: U });
    expect(folderSpaceOfRow({ kind: "shared", ownerId: U, groupId: null })).toEqual({ kind: "shared", ownerId: U });
    expect(folderSpaceOfRow({ kind: "group", ownerId: null, groupId: G })).toEqual({ kind: "group", groupId: G });
  });
  it("folderSpaceOfRow 不一致 → throw", () => {
    expect(() => folderSpaceOfRow({ kind: "group", ownerId: null, groupId: null })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "group", ownerId: U, groupId: G })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "personal", ownerId: null, groupId: null })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "personal", ownerId: U, groupId: G })).toThrow();
    expect(() => folderSpaceOfRow({ kind: "other", ownerId: U, groupId: null })).toThrow();
  });
  it("noteFolderSpace：個人筆記 → personal、群組筆記 → group", () => {
    expect(noteFolderSpace({ ownerId: U, groupId: null })).toEqual({ kind: "personal", ownerId: U });
    expect(noteFolderSpace({ ownerId: null, groupId: G })).toEqual({ kind: "group", groupId: G });
    expect(() => noteFolderSpace({ ownerId: null, groupId: null })).toThrow();
  });
  it("sameFolderSpace", () => {
    expect(sameFolderSpace({ kind: "personal", ownerId: U }, { kind: "personal", ownerId: U.toUpperCase() })).toBe(true);
    expect(sameFolderSpace({ kind: "personal", ownerId: U }, { kind: "shared", ownerId: U })).toBe(false);
    expect(sameFolderSpace({ kind: "personal", ownerId: U }, { kind: "personal", ownerId: G })).toBe(false);
    expect(sameFolderSpace({ kind: "group", groupId: G }, { kind: "group", groupId: G })).toBe(true);
    expect(sameFolderSpace({ kind: "group", groupId: G }, { kind: "group", groupId: U })).toBe(false);
  });
  it("newNoteFolderConsistent：群組資料夾要同一個 groupId（不分大小寫）；個人資料夾不帶 groupId；shared 一律不行（資料夾 PR-3d T7）", () => {
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, G)).toBe(true);
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, G.toUpperCase())).toBe(true);
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, U)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "group", groupId: G }, undefined)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "personal", ownerId: U }, undefined)).toBe(true);
    expect(newNoteFolderConsistent({ kind: "personal", ownerId: U }, G)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "shared", ownerId: U }, undefined)).toBe(false);
    expect(newNoteFolderConsistent({ kind: "shared", ownerId: U }, G)).toBe(false);
  });
  it("toFolderSpaceDto 不輸出 ownerId", () => {
    expect(toFolderSpaceDto({ kind: "personal", ownerId: U })).toEqual({ kind: "personal" });
    expect(toFolderSpaceDto({ kind: "shared", ownerId: U })).toEqual({ kind: "shared" });
    expect(toFolderSpaceDto({ kind: "group", groupId: G })).toEqual({ kind: "group", groupId: G });
  });
});
