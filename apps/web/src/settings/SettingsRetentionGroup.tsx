import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

type T = (key: string, opts?: Record<string, unknown>) => string;

function errorMessage(t: T, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

interface RetentionQuery {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data?: { retentionDays: number | null };
}

interface RetentionUpdate {
  isPending: boolean;
  mutateAsync: (body: { retentionDays: number | null }) => Promise<unknown>;
}

export interface RetentionDaysGroupProps {
  /** Keys read: `<i18nPrefix>.{title,description,autoLabel,daysLabel,daysInvalid,save,saved}`. */
  i18nPrefix: string;
  autoId: string;
  daysId: string;
  min: number;
  max: number;
  defaultDays: number;
  query: RetentionQuery;
  update: RetentionUpdate;
}

/**
 * Edits stay local until Save: sending the default the moment the toggle opens could purge a batch of old rows
 * within the hour. Save sends the days when on, `null` when off. Local `null` shows the server value and is
 * reset to `null` after a successful save.
 */
function RetentionForm({ props, current }: { props: RetentionDaysGroupProps; current: number | null }) {
  const { t } = useTranslation();
  const { i18nPrefix: p, update } = props;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [days, setDays] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enabledShown = enabled ?? current !== null;
  const daysShown = days ?? String(current ?? props.defaultDays);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmed = daysShown.trim();
    const n = Number(trimmed);
    if (enabledShown && (!/^\d+$/.test(trimmed) || n < props.min || n > props.max)) {
      setError(t(`${p}.daysInvalid`));
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ retentionDays: enabledShown ? n : null });
      setEnabled(null);
      setDays(null);
      toast({ title: t(`${p}.saved`) });
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <>
      <form onSubmit={(event) => void handleSubmit(event)} className="space-y-3">
        <div className="flex items-center gap-3">
          <Switch
            id={props.autoId}
            checked={enabledShown}
            onCheckedChange={(value) => {
              setEnabled(value);
              setError(null);
            }}
          />
          <label htmlFor={props.autoId} className="text-sm font-medium">
            {t(`${p}.autoLabel`)}
          </label>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          {enabledShown && (
            <div className="space-y-1">
              <label htmlFor={props.daysId} className="text-sm font-medium">
                {t(`${p}.daysLabel`)}
              </label>
              <Input
                id={props.daysId}
                inputMode="numeric"
                value={daysShown}
                onChange={(event) => {
                  setDays(event.target.value);
                  setError(null);
                }}
                className="w-32"
              />
            </div>
          )}
          <Button type="submit" variant="outline" disabled={update.isPending}>
            {t(`${p}.save`)}
          </Button>
        </div>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** All three states render a region with the same title because the page has other Save buttons. */
export function RetentionDaysGroup(props: RetentionDaysGroupProps) {
  const { t } = useTranslation();
  const { query } = props;
  const title = t(`${props.i18nPrefix}.title`);
  if (query.isPending) {
    return (
      <SettingsGroup labelledByTitle title={title}>
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </SettingsGroup>
    );
  }
  if (query.isError || !query.data) {
    return (
      <SettingsGroup labelledByTitle title={title}>
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, query.error)}
        </p>
      </SettingsGroup>
    );
  }
  return (
    <SettingsGroup labelledByTitle title={title} description={t(`${props.i18nPrefix}.description`)}>
      <RetentionForm props={props} current={query.data.retentionDays} />
    </SettingsGroup>
  );
}
