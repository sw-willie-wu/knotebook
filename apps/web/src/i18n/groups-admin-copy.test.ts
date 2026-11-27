import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import "@/i18n/groups-admin-strings";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import groupsAdminEn from "./groups-admin.en.json";
import groupsAdminZhTW from "./groups-admin.zh-TW.json";

const MOVED = ["roles", "delete", "bulk", "detail", "removeMember", "storage", "autoVersions", "about"];
// menu, nav, leave and role are rendered by entry-chunk components, so they must stay in the main files; dialog was simply left out of the move.
const KEPT = ["menu", "nav", "leave", "dialog", "role"];

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

// Raw text: after registration the imported main JSON object has been deep-merged with the lazy bundle.
const mainGroups = (raw: string) => Object.keys((JSON.parse(raw) as { groups: object }).groups);

describe("groups-admin lazy bundle", () => {
  it("has the same key set in both locales", () => {
    expect(flattenKeys(groupsAdminZhTW).sort()).toEqual(flattenKeys(groupsAdminEn).sort());
  });

  it("holds exactly the moved subtrees and does not overlap the main files", () => {
    expect(Object.keys(groupsAdminEn.groups).sort()).toEqual([...MOVED].sort());
    for (const raw of [enRaw, zhTWRaw]) expect(mainGroups(raw).sort()).toEqual([...KEPT].sort());
  });

  it("resolves after registration without overriding the main files", () => {
    expect(i18n.t("groups.storage.byMember", { lng: "en" })).toBe("By member");
    expect(i18n.t("groups.roles.flags.delete.label", { lng: "zh-TW" })).not.toBe("groups.roles.flags.delete.label");
    expect(i18n.t("groups.nav.members", { lng: "en" })).not.toBe("groups.nav.members");
  });

  it("is imported by every file that renders a lazy groups key", () => {
    for (const path of [
      "src/components/groups/BulkAddDialog.tsx",
      "src/components/groups/DeleteGroupDialog.tsx",
      "src/components/groups/GroupAboutSection.tsx",
      "src/components/groups/GroupMembersSection.tsx",
      "src/components/groups/GroupStorageSection.tsx",
      "src/settings/SettingsGroupRolesSection.tsx",
      "src/settings/SettingsGroupsOverview.tsx",
    ]) {
      expect(readFileSync(`${process.cwd()}/${path}`, "utf8"), path).toMatch(/import\s+["']@\/i18n\/groups-admin-strings["']/);
    }
  });
});
