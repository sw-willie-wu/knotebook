import { useState } from "react";
import type { ProviderIconDto } from "@knotebook/shared";
import { GitLabLogo, GoogleLogo, SignInGeneric } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

/**
 * 登入服務圖示（spec 2026-10-07-provider-icon §6.1）。DTO 的 `icon` 已由 server 換算，這裡只渲染、不換算。
 * - 一律裝飾性：SVG `aria-hidden`＋`focusable="false"`、`<img alt="">`——不改所在按鈕／標題的可及名稱。
 * - `null`（管理員選「不顯示」）與 `undefined`（少欄位的舊 fixture）都不渲染任何節點。
 * - 上傳圖載入失敗 → 通用圖示。失敗以**網址**記：換圖後 `?v=` 變了就重試（RF4）。
 * - 根節點帶 `data-provider-icon`（測試以它區分；載入失敗退回時為 `generic`）。
 */
export function ProviderIcon({ icon, className }: { icon: ProviderIconDto | undefined; className?: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (icon == null) return null;
  const cls = cn("h-4 w-4 shrink-0", className);
  if (icon.type === "upload" && icon.url !== failedUrl) {
    const url = icon.url;
    return (
      <img
        src={url}
        alt=""
        aria-hidden="true"
        data-provider-icon="upload"
        className={cn(cls, "object-contain")}
        draggable={false}
        onError={() => setFailedUrl(url)}
      />
    );
  }
  const name = icon.type === "builtin" ? icon.name : "generic";
  if (name === "gitlab") return <GitLabLogo className={cls} aria-hidden="true" focusable="false" data-provider-icon="gitlab" />;
  if (name === "google") return <GoogleLogo className={cls} aria-hidden="true" focusable="false" data-provider-icon="google" />;
  return <SignInGeneric className={cls} aria-hidden="true" focusable="false" data-provider-icon="generic" />;
}
