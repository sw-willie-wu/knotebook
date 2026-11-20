/**
 * Aggregate lazy module: all four `lazy()` imports in `App.tsx` hit this one so Rollup emits a single chunk.
 * Components re-exported here must not be statically imported by first-bundle modules, or they merge back into the entry
 * (same rule as `AdminSections.tsx`). The `GroupModal` shell is in the first bundle.
 */
export { GroupMembersSection } from "./GroupMembersSection";
export { SettingsGroupRolesSection as GroupRolesSection } from "@/settings/SettingsGroupRolesSection";
export { GroupTagsSection } from "@/settings/TagsSection";
export { GroupStorageSection } from "./GroupStorageSection";
export { GroupAboutSection } from "./GroupAboutSection";
