/**
 * 登入服務圖示（spec `docs/superpowers/specs/2026-10-07-provider-icon-design.md` §4.1、§5.1、§5.2）。
 * server 產每一個 provider DTO（公開形與 admin 形）都以 `resolveProviderIcon` 換算；web 只在圖示對話框的「依範本」預覽呼叫它。
 */

/** `auth_providers.icon_kind` 的值域（DB CHECK `auth_providers_icon_kind_chk`）。 */
export type ProviderIconKind = "template" | "gitlab" | "google" | "upload" | "none";

export type ProviderIconBuiltinName = "gitlab" | "google" | "generic";

/** DTO 上的已換算圖示：內建 SVG、上傳圖網址，或 `null`（管理員選「不顯示」）。 */
export type ProviderIconDto = { type: "builtin"; name: ProviderIconBuiltinName } | { type: "upload"; url: string } | null;

/** server 收的上傳圖上限（位元組）。DB CHECK `auth_providers_icon_size_chk` 寫的是同一個字面 262144。 */
export const MAX_PROVIDER_ICON_BYTES = 262144;
/** web 選檔上限（縮圖前的原檔，D7）。 */
export const MAX_PROVIDER_ICON_SOURCE_BYTES = 5 * 1024 * 1024;
/** 瀏覽器端縮圖的最長邊（px，D7）。 */
export const PROVIDER_ICON_SIZE = 128;

/** 公開讀圖網址；`v` 是 `icon_version`——換圖後網址就變，舊網址的 `immutable` 快取不會蓋到新圖（spec §4.4、§7.3）。 */
export function providerIconUrl(id: string, version: number): string {
  return `/api/auth/providers/${id}/icon?v=${version}`;
}

function templateIcon(template: string): ProviderIconDto {
  if (template === "gitlab") return { type: "builtin", name: "gitlab" };
  if (template === "google") return { type: "builtin", name: "google" };
  return { type: "builtin", name: "generic" };
}

/**
 * spec §5.2 對照表。`iconKind` 收 `string`（DB 欄是 text，CHECK 保證值域）；未知值當 `template`（【作者補】）。
 * `template` 分支不讀 `iconVersion`。
 */
export function resolveProviderIcon(p: { id: string; template: string; iconKind: string; iconVersion: number }): ProviderIconDto {
  switch (p.iconKind) {
    case "gitlab":
      return { type: "builtin", name: "gitlab" };
    case "google":
      return { type: "builtin", name: "google" };
    case "upload":
      return { type: "upload", url: providerIconUrl(p.id, p.iconVersion) };
    case "none":
      return null;
    default:
      return templateIcon(p.template);
  }
}
