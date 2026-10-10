import type { TokenScope } from "@knotebook/shared";

/**
 * #239：「編輯」「移動或複製到群組」兩個勾選框 ↔ 三種落庫形（spec §9.1）。
 * 同意頁與建立 token 對話框共用。
 */
export interface ScopeChecks {
  write: boolean;
  move: boolean;
}

/** 勾選 → 落庫形。搬移不搭編輯（`(false, true)`）→ 唯讀：fail-closed，與 shared `normalizeScope` 同向。 */
export function scopeFromChecks(write: boolean, move: boolean): TokenScope {
  if (!write) return "notes:read";
  return move ? "notes:read notes:write notes:move" : "notes:read notes:write";
}

/** 落庫形 → 勾選。 */
export function checksFromScope(scope: TokenScope): ScopeChecks {
  const parts = scope.split(" ");
  const write = parts.includes("notes:write");
  return { write, move: write && parts.includes("notes:move") };
}
