import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

/** The user id is in the key because logout doesn't clear the cache and another account must not see this one's count or list. */
export function notificationsKey(userId: string | null) {
  return ["notifications", userId] as const;
}

export function notificationCountKey(userId: string | null) {
  return [...notificationsKey(userId), "count"] as const;
}

export function notificationListKey(userId: string | null) {
  return [...notificationsKey(userId), "list"] as const;
}

export function fetchNotificationCount(): Promise<{ count: number }> {
  return api<{ count: number }>("/api/notifications/unread-count");
}

// No window-focus refetch of its own: `useNotificationLive` refetches on focus and on every (re)connect.
export function useNotificationCount(userId: string | null) {
  return useQuery({
    queryKey: notificationCountKey(userId),
    queryFn: fetchNotificationCount,
    enabled: userId !== null,
    refetchOnWindowFocus: false,
  });
}
