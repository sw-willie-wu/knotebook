import type { TFunction } from "i18next";
import type { ReleaseHighlights } from "./release-highlights";
import type { StopDef, StopId } from "./stops";

/** 至少一站：最後一站固定是完整導覽的最後一站，「這一版新增」插在它前面。 */
export type NonEmptyStops = readonly [StopId, ...StopId[]];

export interface SequenceEntry {
  id: StopId;
  /** 「這一版新增」那段的站帶登記檔的版本（卡片標題加前綴）；完整導覽的站是 null。 */
  newInVersion: string | null;
}

/**
 * 組出一次導覽要走的站：完整導覽、「這一版新增」插在最後一站之前（最後一站要留給「忘了去哪裡找」）。
 * 同一站只走一次，留在先出現的位置：「這一版新增」列到完整導覽本來就有的站時，那站照完整導覽的位置走、不加前綴。
 * `highlights.stops` 為空時這一段不出現。
 */
export function buildSequence(full: NonEmptyStops, highlights: ReleaseHighlights): SequenceEntry[] {
  const fullEntries = full.map((id): SequenceEntry => ({ id, newInVersion: null }));
  const seen = new Set<StopId>(full);
  const added: SequenceEntry[] = [];
  for (const id of highlights.stops) {
    if (seen.has(id)) continue;
    seen.add(id);
    added.push({ id, newInVersion: highlights.version });
  }
  return [...fullEntries.slice(0, -1), ...added, fullEntries[fullEntries.length - 1]!];
}

export function stopTitle(t: TFunction, stop: StopDef, newInVersion: string | null): string {
  const title = t(stop.titleKey);
  return newInVersion === null ? title : t("tourGuide.newInVersion", { version: newInVersion, title });
}
