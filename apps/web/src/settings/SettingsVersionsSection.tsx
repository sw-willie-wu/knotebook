import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { VERSION_DAYS_MAX, type VersionSettingsDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateVersionSettings, useVersionSettings } from "@/api/versionSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsGroup, SettingsPage } from "./SettingsLayout";

/** 逐檔複製的既有慣例（見 SettingsUsersSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 站台總開關：立即生效（`ui/switch`），失敗 toast。 */
function SiteSwitchGroup({ data }: { data: VersionSettingsDto }) {
  const { t } = useTranslation();
  const update = useUpdateVersionSettings();
  return (
    <SettingsGroup>
      <div className="space-y-1">
        <div className="flex items-center gap-3">
          <Switch
            id="site-auto-versions"
            checked={data.autoVersionsEnabled}
            disabled={update.isPending}
            onCheckedChange={(value) =>
              update.mutate({ autoVersionsEnabled: value }, { onError: (err) => toast({ title: errorMessage(t, err), variant: "destructive" }) })
            }
          />
          <label htmlFor="site-auto-versions" className="text-sm font-medium">
            {t("admin.versions.autoTitle")}
          </label>
        </div>
        <p className="max-w-prose text-sm text-muted-foreground">{t("admin.versions.autoDescription")}</p>
        <p className="text-xs text-muted-foreground">{t("versions.takesEffectNote")}</p>
      </div>
    </SettingsGroup>
  );
}

/** 自動版本的保留天數：兩個整數欄＋「儲存」。輸入框 `null`＝顯示 server 值（同 `HandleSection`）。 */
function RetentionGroup({ data }: { data: VersionSettingsDto }) {
  const { t } = useTranslation();
  const update = useUpdateVersionSettings();
  const [keepAll, setKeepAll] = useState<string | null>(null);
  const [dailyUntil, setDailyUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keepAllShown = keepAll ?? String(data.keepAllDays);
  const dailyUntilShown = dailyUntil ?? String(data.dailyUntilDays);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const keepAllText = keepAllShown.trim();
    const dailyUntilText = dailyUntilShown.trim();
    const first = Number(keepAllText);
    const second = Number(dailyUntilText);
    if (!/^\d+$/.test(keepAllText) || !/^\d+$/.test(dailyUntilText) || first < 1 || first > second || second > VERSION_DAYS_MAX) {
      setError(t("admin.versions.daysInvalid"));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ keepAllDays: first, dailyUntilDays: second });
      setKeepAll(null);
      setDailyUntil(null);
      toast({ title: t("admin.versions.saved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      title={t("admin.versions.retentionTitle")}
      description={t("admin.versions.retentionDescription", { keepAll: data.keepAllDays, dailyUntil: data.dailyUntilDays })}
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="versions-keep-all" className="text-sm font-medium">
            {t("admin.versions.keepAllLabel")}
          </label>
          <Input
            id="versions-keep-all"
            inputMode="numeric"
            value={keepAllShown}
            onChange={(event) => {
              setKeepAll(event.target.value);
              setError(null);
            }}
            className="w-32"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="versions-daily-until" className="text-sm font-medium">
            {t("admin.versions.dailyUntilLabel")}
          </label>
          <Input
            id="versions-daily-until"
            inputMode="numeric"
            value={dailyUntilShown}
            onChange={(event) => {
              setDailyUntil(event.target.value);
              setError(null);
            }}
            className="w-32"
          />
        </div>
        <Button type="submit" variant="outline" disabled={update.isPending}>
          {t("admin.versions.save")}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/**
 * `/admin/versions`（站台管理頁，spec §6.7、§8.5）：自動儲存總開關（立即生效）＋自動版本的保留天數。
 * 只被 `AdminPage.tsx` 靜態 import（#201：與本頁同一個 chunk，不逐區 lazy）。
 */
export function SettingsVersionsSection() {
  const { t } = useTranslation();
  const query = useVersionSettings();
  return (
    <SettingsPage title={t("admin.versions.title")} description={t("admin.versions.description")}>
      {query.isPending ? (
        <SettingsGroup>
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        </SettingsGroup>
      ) : query.isError ? (
        <SettingsGroup>
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, query.error)}
          </p>
        </SettingsGroup>
      ) : (
        <>
          <SiteSwitchGroup data={query.data} />
          <RetentionGroup data={query.data} />
        </>
      )}
    </SettingsPage>
  );
}
