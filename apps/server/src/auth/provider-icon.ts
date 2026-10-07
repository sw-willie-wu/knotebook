import { resolveProviderIcon, type AuthProviderPublicDto } from "@knotebook/shared";
import { authProviders } from "../db/schema.js";

// 登入服務圖示（spec 2026-10-07-provider-icon §5.3）：公開 provider DTO 的 select 片段與組形。
// **刻意不含 icon_data、icon_mime**——清單回應不得帶圖檔本體；圖檔只由 `GET /api/auth/providers/:id/icon` 出線。

/** 換算 `icon` 需要的三欄。每次現造（drizzle select 形不重用）。 */
export function providerIconColumns() {
  return { template: authProviders.template, iconKind: authProviders.iconKind, iconVersion: authProviders.iconVersion };
}

/** 公開形（id、顯示名、已換算的圖示）；不出線 template／iconKind／iconVersion。 */
export function toPublicProvider(row: { id: string; displayName: string; template: string; iconKind: string; iconVersion: number }): AuthProviderPublicDto {
  return { id: row.id, displayName: row.displayName, icon: resolveProviderIcon(row) };
}
