/**
 * No imports: the help dialog chunk reads this file and must not pull other chunks in.
 * A PR adding a feature adds an item (`id`) with bilingual strings at `helpGuide.whatsNew.items.<id>.title`/`.desc`
 * in `i18n/shortcuts.*.json`; if `version` is still the last released one, bump it to the next and remove the
 * previous items. Remove an item's i18n strings together with it (`release-highlights.guard.test.ts` requires both languages and flags leftover strings).
 * Admin-only features set `adminOnly: true` and are filtered out for other users by `visibleHighlightItems`.
 * On release, check `version` equals the release and drop unwanted items; with none, empty `items` and the page
 * says there are no highlighted features.
 * `version` titles the page instead of the app version: between releases the app version is still
 * the previous one, which would label unreleased features as old. The same guard rejects a `version` below `apps/web/package.json`.
 */
export interface HighlightItem {
  id: string;
  adminOnly?: boolean;
}

export interface ReleaseHighlights {
  version: string;
  items: readonly HighlightItem[];
}

export const RELEASE_HIGHLIGHTS: ReleaseHighlights = {
  version: "0.18.0",
  items: [{ id: "tags" }],
};

export function visibleHighlightItems(items: readonly HighlightItem[], isSiteAdmin: boolean): HighlightItem[] {
  return items.filter((item) => isSiteAdmin || item.adminOnly !== true);
}
