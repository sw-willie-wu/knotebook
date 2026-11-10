import type { TokenScope } from "@knotebook/shared";

/**
 * #239／#181：「編輯」「移動或複製到群組」「移到垃圾桶與還原」三個開關 ↔ 五種落庫形。
 * OAuth 同意頁（勾選框，`ScopeChecksField`）與建立 token 對話框、token 列內編輯（toggle，
 * `ScopeTogglesField`，#247）共用。
 */
export interface ScopeChecks {
  write: boolean;
  move: boolean;
  delete: boolean;
}

/** 勾選 → 落庫形。搬移、刪除不搭編輯 → 唯讀（fail-closed，與 shared `normalizeScope` 同向）。固定順序 read、write、move、delete。 */
export function scopeFromChecks(write: boolean, move: boolean, del: boolean): TokenScope {
  if (!write) return "notes:read";
  const parts = ["notes:read", "notes:write", ...(move ? ["notes:move"] : []), ...(del ? ["notes:delete"] : [])];
  return parts.join(" ") as TokenScope;
}

/** 落庫形 → 勾選。搬移、刪除只在同時有編輯時算數。 */
export function checksFromScope(scope: TokenScope): ScopeChecks {
  const parts = scope.split(" ");
  const write = parts.includes("notes:write");
  return { write, move: write && parts.includes("notes:move"), delete: write && parts.includes("notes:delete") };
}
