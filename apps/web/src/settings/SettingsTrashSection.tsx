import { TRASH_RETENTION_DAYS_DEFAULT, TRASH_RETENTION_DAYS_MAX, TRASH_RETENTION_DAYS_MIN } from "@knotebook/shared";
import { useTrashSettings, useUpdateTrashSettings } from "@/api/trash";
import { RetentionDaysGroup } from "./SettingsRetentionGroup";
import "@/i18n/management-strings";

/**
 * Retention is 1–3650 days. Hint text (hourly, at most 2,000 per run) mirrors server `trash/purge.ts`:
 * `TRASH_PURGE_INTERVAL_MS` (60 min) and `TRASH_PURGE_BATCH × TRASH_PURGE_MAX_BATCHES` (100 × 20).
 */
export function SiteTrashGroup() {
  return (
    <RetentionDaysGroup
      i18nPrefix="admin.trash"
      autoId="trash-auto-purge"
      daysId="trash-retention-days"
      min={TRASH_RETENTION_DAYS_MIN}
      max={TRASH_RETENTION_DAYS_MAX}
      defaultDays={TRASH_RETENTION_DAYS_DEFAULT}
      query={useTrashSettings()}
      update={useUpdateTrashSettings()}
    />
  );
}
