import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import type { NotificationListDto } from "@knotebook/shared";
import { api, ApiFail } from "./client";
import { notificationCountKey, notificationListKey } from "./notifications";

// Lazy side of the bell: only the notification list chunk may import this file (the entry keeps the count in `./notifications`).
export const NOTIFICATIONS_PAGE_SIZE = 30;

type Pages = InfiniteData<NotificationListDto, string | null>;

export function useNotificationList(userId: string) {
  return useInfiniteQuery({
    queryKey: notificationListKey(userId),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: String(NOTIFICATIONS_PAGE_SIZE) });
      if (pageParam !== null) params.set("before", pageParam);
      return api<NotificationListDto>(`/api/notifications?${params.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Rows carry `isNew` relative to the last "seen" mark, so a list kept after closing would show last time's marks on the next open.
    gcTime: 0,
  });
}

export function markNotificationsSeen(): Promise<void> {
  return api<void>("/api/notifications/seen", { method: "POST" });
}

export function setUnreadCountToZero(queryClient: QueryClient, userId: string): void {
  queryClient.setQueryData(notificationCountKey(userId), { count: 0 });
}

export function useDeleteNotification(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      try {
        await api<void>(`/api/notifications/${encodeURIComponent(id)}`, { method: "DELETE" });
      } catch (err) {
        // Already gone (cleared in another tab, or expired): the row should go either way.
        if (!(err instanceof ApiFail && err.status === 404)) throw err;
      }
    },
    onSuccess: (_void, id) => {
      queryClient.setQueryData<Pages>(notificationListKey(userId), (data) =>
        data === undefined ? data : { ...data, pages: data.pages.map((p) => ({ ...p, notifications: p.notifications.filter((n) => n.id !== id) })) },
      );
      void queryClient.invalidateQueries({ queryKey: notificationCountKey(userId) });
    },
  });
}

export function useClearNotifications(userId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>("/api/notifications", { method: "DELETE" }),
    onSuccess: () => {
      queryClient.setQueryData<Pages>(notificationListKey(userId), { pages: [{ notifications: [], nextCursor: null }], pageParams: [null] });
      setUnreadCountToZero(queryClient, userId);
    },
  });
}
