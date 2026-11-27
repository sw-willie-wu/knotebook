import { useMutation, useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from "@tanstack/react-query";
import type { NotificationSettingsDto } from "@knotebook/shared";
import { api } from "./client";

export const NOTIFICATION_SETTINGS_QUERY_KEY = ["admin", "notification-settings"] as const;

export function useNotificationSettings(): UseQueryResult<NotificationSettingsDto> {
  return useQuery({
    queryKey: NOTIFICATION_SETTINGS_QUERY_KEY,
    queryFn: () => api<NotificationSettingsDto>("/api/admin/notifications/settings"),
  });
}

export function useUpdateNotificationSettings(): UseMutationResult<NotificationSettingsDto, unknown, NotificationSettingsDto> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: NotificationSettingsDto) =>
      api<NotificationSettingsDto>("/api/admin/notifications/settings", { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: (updated) => queryClient.setQueryData(NOTIFICATION_SETTINGS_QUERY_KEY, updated),
  });
}
