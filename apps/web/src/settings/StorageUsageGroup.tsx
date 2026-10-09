import { useTranslation } from "react-i18next";
import type { UseQueryResult } from "@tanstack/react-query";
import { formatBytes, type StorageUsageDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { isQuotaReached } from "@/lib/storage-usage";
import { cn } from "@/lib/utils";
import { SettingsGroup } from "./SettingsLayout";

/** 逐檔複製的既有慣例（見 SettingsUsersSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 設定裡的「儲存空間」群組（spec §9.2）：個人（帳號頁）與群組（群組詳情、manageGroup）共用。三態：
 * 有上限「已使用 X／Y（方案）」、無上限「已使用 X（無上限，方案）」、已達上限（用量 >= 上限：警示色＋「已達上限，無法再新增附件」）。
 * 只顯示、不能改方案（D3）。
 */
export function StorageUsageGroup({ title, query }: { title: string; query: UseQueryResult<StorageUsageDto> }) {
  const { t } = useTranslation();
  let body;
  if (query.isPending) {
    body = <p className="text-sm text-muted-foreground">{t("app.loading")}</p>;
  } else if (query.isError) {
    body = <p role="alert" className="text-sm text-destructive">{errorMessage(t, query.error)}</p>;
  } else {
    const u = query.data;
    const over = isQuotaReached(u);
    const text =
      u.quotaBytes === null
        ? t("storage.usageUnlimited", { used: formatBytes(u.usedBytes), plan: u.planName })
        : t("storage.usage", { used: formatBytes(u.usedBytes), quota: formatBytes(u.quotaBytes), plan: u.planName });
    body = (
      <div className="space-y-1">
        <p data-testid="storage-usage" className={cn("text-sm", over && "text-destructive")}>{text}</p>
        {over && <p className="text-sm text-destructive">{t("storage.overQuota")}</p>}
      </div>
    );
  }
  return <SettingsGroup title={title}>{body}</SettingsGroup>;
}
