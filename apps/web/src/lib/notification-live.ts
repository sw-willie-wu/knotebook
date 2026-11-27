import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiFail } from "@/api/client";
import { fetchNotificationCount, notificationsKey } from "@/api/notifications";
import { startNotificationSocket, type SessionProbe } from "./notification-socket";

async function probeSession(): Promise<SessionProbe> {
  try {
    await fetchNotificationCount();
    return "authenticated";
  } catch (err) {
    return err instanceof ApiFail && err.status === 401 ? "unauthorized" : "unreachable";
  }
}

/**
 * Mount once per signed-in shell: every bell reads the cache this keeps fresh. A message, a (re)connect and a window focus all just invalidate
 * the user's notification queries, so the badge refetches and an open list reloads.
 */
export function useNotificationLive(userId: string | undefined): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (userId === undefined || typeof WebSocket === "undefined") return;
    const refetch = () => {
      void queryClient.invalidateQueries({ queryKey: notificationsKey(userId) });
    };
    return startNotificationSocket({ onMessage: refetch, onConnected: refetch, onFocus: refetch, probe: probeSession });
  }, [userId, queryClient]);
}
