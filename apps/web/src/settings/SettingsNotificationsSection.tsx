import {
  NOTIFICATION_RETENTION_DAYS_DEFAULT,
  NOTIFICATION_RETENTION_DAYS_MAX,
  NOTIFICATION_RETENTION_DAYS_MIN,
} from "@knotebook/shared";
import { useNotificationSettings, useUpdateNotificationSettings } from "@/api/admin-notifications";
import { RetentionDaysGroup } from "./SettingsRetentionGroup";
import "@/i18n/management-strings";

export function SiteNotificationsGroup() {
  return (
    <RetentionDaysGroup
      i18nPrefix="admin.notifications"
      autoId="notifications-auto-delete"
      daysId="notifications-retention-days"
      min={NOTIFICATION_RETENTION_DAYS_MIN}
      max={NOTIFICATION_RETENTION_DAYS_MAX}
      defaultDays={NOTIFICATION_RETENTION_DAYS_DEFAULT}
      query={useNotificationSettings()}
      update={useUpdateNotificationSettings()}
    />
  );
}
