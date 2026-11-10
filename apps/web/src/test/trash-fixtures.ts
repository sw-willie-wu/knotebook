import type { TrashItemDto, TrashListDto } from "@knotebook/shared";
import { DAY_MS } from "@/lib/trash-display";

/** 與各測試檔的 session fixture 對齊（只用來比 `deletedBy.handle`）。 */
export const TRASH_ME = { handle: "tester", displayName: "Tester" };

/**
 * 垃圾桶項目（#181）。purgeAt／deletedAt 以呼叫當下的 Date.now() 推算（不用假時鐘：react-query 的 waitFor 與假時鐘相衝）。
 * `daysLeft` 預設 3（整數：顯示時的 now 稍晚，3 天 − ε 取 ceil 恆為 3）；`null` → `purgeAt: null`。`deletedBy` 預設 `TRASH_ME`、`group` 預設 null。
 */
export function trashItem(
  overrides: Partial<TrashItemDto> & { id: string; title: string },
  opts: { daysLeft?: number | null; deletedDaysAgo?: number } = {},
): TrashItemDto {
  const now = Date.now();
  const daysLeft = opts.daysLeft === undefined ? 3 : opts.daysLeft;
  return {
    deletedAt: new Date(now - (opts.deletedDaysAgo ?? 0) * DAY_MS).toISOString(),
    purgeAt: daysLeft === null ? null : new Date(now + daysLeft * DAY_MS).toISOString(),
    deletedBy: TRASH_ME,
    group: null,
    folderPath: [],
    ...overrides,
  };
}

export function trashList(items: TrashItemDto[], opts: { retentionDays?: number | null; truncated?: boolean } = {}): TrashListDto {
  return {
    retentionDays: opts.retentionDays === undefined ? 7 : opts.retentionDays,
    items,
    truncated: opts.truncated ?? false,
  };
}
