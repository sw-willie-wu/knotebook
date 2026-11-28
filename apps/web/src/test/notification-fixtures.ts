import { vi } from "vitest";
import type { CommentNotificationDto, NotificationDto, NotificationListDto, UploadFinishedNotificationDto, UserDto } from "@knotebook/shared";

export const NOTIFICATION_USER: UserDto = {
  id: "u-alice",
  email: "alice@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

export const NOTIFICATION_NOTE = "11111111-1111-4111-8111-111111111111";

export function nid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function notification(n: number, over: Partial<CommentNotificationDto> = {}): CommentNotificationDto {
  return {
    id: nid(n),
    kind: "mention",
    agentLabel: null,
    actor: { userId: "u-bob", handle: "bob", displayName: "Bob", avatar: null, agentLabel: null },
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    canOpen: true,
    noteId: NOTIFICATION_NOTE,
    noteTitle: `Note ${n}`,
    commentId: nid(100 + n),
    excerpt: `excerpt ${n}`,
    isNew: false,
    ...over,
  };
}

export function uploadNotification(n: number, over: Partial<UploadFinishedNotificationDto> = {}): UploadFinishedNotificationDto {
  return {
    id: nid(n),
    kind: "upload_finished",
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    canOpen: true,
    noteId: NOTIFICATION_NOTE,
    noteTitle: "Weekly meeting",
    blockId: "v1",
    fileName: "meeting-recording.mp4",
    isNew: false,
    ...over,
  };
}

export function notificationPage(ns: NotificationDto[], nextCursor: string | null = null): NotificationListDto {
  return { notifications: ns, nextCursor };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** `routes` maps "METHOD url" (or a bare url for GET) to a response or a function returning one; anything else rejects like an unreachable server. */
export function stubNotificationFetch(routes: Record<string, Response | ((init?: RequestInit) => Response)>) {
  const calls: { method: string; url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      const hit = routes[`${method} ${url}`] ?? (method === "GET" ? routes[url] : undefined);
      if (hit === undefined) return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
      const res = typeof hit === "function" ? hit(init) : hit;
      return Promise.resolve(res.clone());
    }),
  );
  return calls;
}
