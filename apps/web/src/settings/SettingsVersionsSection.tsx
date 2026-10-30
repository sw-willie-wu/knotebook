import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { VERSION_AUTO_WAIT_MINUTES_MAX, VERSION_AUTO_WAIT_MINUTES_MIN, VERSION_DAYS_MAX, type VersionSettingsDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateVersionSettings, useVersionSettings } from "@/api/versionSettings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

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
    <SettingsGroup title={t("admin.versions.title")}>
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
        <p className="text-sm text-muted-foreground">{t("admin.versions.autoDescription")}</p>
        <p className="text-xs text-muted-foreground">{t("versions.takesEffectNote")}</p>
      </div>
    </SettingsGroup>
  );
}

/**
 * 自動存版等待＋保留天數（#272 §8）：三個整數欄共用一顆「儲存」。輸入框 `null`＝顯示 server 值（同 `HandleSection`）。
 * 驗證先等待、再天數，只顯示第一個不合格者。等待的說明句帶 server 值，放在表單下方（放在單一欄下會讓三欄輸入框對不齊）。
 */
function RetentionGroup({ data }: { data: VersionSettingsDto }) {
  const { t } = useTranslation();
  const update = useUpdateVersionSettings();
  const [wait, setWait] = useState<string | null>(null);
  const [keepAll, setKeepAll] = useState<string | null>(null);
  const [dailyUntil, setDailyUntil] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waitShown = wait ?? String(data.autoWaitMinutes);
  const keepAllShown = keepAll ?? String(data.keepAllDays);
  const dailyUntilShown = dailyUntil ?? String(data.dailyUntilDays);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const waitText = waitShown.trim();
    const minutes = Number(waitText);
    if (!/^\d+$/.test(waitText) || minutes < VERSION_AUTO_WAIT_MINUTES_MIN || minutes > VERSION_AUTO_WAIT_MINUTES_MAX) {
      setError(t("admin.versions.waitInvalid"));
      return;
    }
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
      await update.mutateAsync({ autoWaitMinutes: minutes, keepAllDays: first, dailyUntilDays: second });
      setWait(null);
      setKeepAll(null);
      setDailyUntil(null);
      toast({ title: t("admin.versions.saved") });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <SettingsGroup
      labelledByTitle
      title={t("admin.versions.retentionTitle")}
      description={t("admin.versions.retentionDescription", { keepAll: data.keepAllDays, dailyUntil: data.dailyUntilDays })}
    >
      <form onSubmit={(event) => void handleSubmit(event)} className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <label htmlFor="versions-auto-wait" className="text-sm font-medium">
            {t("admin.versions.waitLabel")}
          </label>
          <Input
            id="versions-auto-wait"
            inputMode="numeric"
            aria-describedby="versions-auto-wait-help"
            value={waitShown}
            onChange={(event) => {
              setWait(event.target.value);
              setError(null);
            }}
            className="w-32"
          />
        </div>
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
      <p id="versions-auto-wait-help" className="mt-2 text-xs text-muted-foreground">
        {t("admin.versions.waitHelp", { minutes: data.autoWaitMinutes })}
      </p>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </SettingsGroup>
  );
}

/**
 * 站台版本設定（spec §6.7、§8.5）：「版本歷史」（站台自動開關，立即生效）＋「保留政策」。#247 §7.0 起嵌在站台管理的
 * 「儲存方案」頁（`SettingsStorageSection` 的 `SettingsPage` 裡、方案表之後），不再有自己的頁首——整段嵌進去會疊出兩個頁首。
 * 載入中／錯誤各以一個 `SettingsGroup` 呈現。
 */
export function SiteVersionsGroups() {
  const { t } = useTranslation();
  const query = useVersionSettings();
  if (query.isPending) {
    return (
      <SettingsGroup title={t("admin.versions.title")}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  if (query.isError) {
    return (
      <SettingsGroup title={t("admin.versions.title")}>
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, query.error)}
        </p>
      </SettingsGroup>
    );
  }
  return (
    <>
      <SiteSwitchGroup data={query.data} />
      <RetentionGroup data={query.data} />
    </>
  );
}
