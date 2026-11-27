import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { jsonResponse, stubNotificationFetch } from "@/test/notification-fixtures";
import type { NotificationSocketHandlers } from "./notification-socket";

const started: { handlers: NotificationSocketHandlers; stop: ReturnType<typeof vi.fn> }[] = [];
vi.mock("./notification-socket", () => ({
  startNotificationSocket: (handlers: NotificationSocketHandlers) => {
    const stop = vi.fn();
    started.push({ handlers, stop });
    return stop;
  },
}));

import { useNotificationLive } from "./notification-live";

function setup(userId: string | undefined) {
  const queryClient = new QueryClient();
  const invalidate = vi.spyOn(queryClient, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  const hook = renderHook(({ id }: { id: string | undefined }) => useNotificationLive(id), { wrapper, initialProps: { id: userId } });
  return { invalidate, ...hook };
}

describe("useNotificationLive", () => {
  beforeEach(() => {
    started.length = 0;
  });
  afterEach(() => vi.unstubAllGlobals());

  it("starts nothing while signed out", () => {
    setup(undefined);
    expect(started).toHaveLength(0);
  });

  it("a message, a connect and a window focus each invalidate this user's notification queries", () => {
    const { invalidate } = setup("u-alice");
    expect(started).toHaveLength(1);
    const { handlers } = started[0]!;
    handlers.onMessage();
    handlers.onConnected();
    handlers.onFocus();
    expect(invalidate).toHaveBeenCalledTimes(3);
    for (const call of invalidate.mock.calls) expect(call[0]).toEqual({ queryKey: ["notifications", "u-alice"] });
  });

  it("stops the socket on unmount and restarts it for another user", () => {
    const { rerender, unmount } = setup("u-alice");
    rerender({ id: "u-bob" });
    expect(started).toHaveLength(2);
    expect(started[0]!.stop).toHaveBeenCalledTimes(1);
    unmount();
    expect(started[1]!.stop).toHaveBeenCalledTimes(1);
  });

  it("probe: 200 is authenticated, 401 is unauthorized, anything else is unreachable", async () => {
    setup("u-alice");
    const { probe } = started[0]!.handlers;
    stubNotificationFetch({ "/api/notifications/unread-count": jsonResponse({ count: 0 }) });
    await expect(probe()).resolves.toBe("authenticated");
    stubNotificationFetch({ "/api/notifications/unread-count": jsonResponse({ error: { code: "unauthorized", message: "no" } }, 401) });
    await expect(probe()).resolves.toBe("unauthorized");
    stubNotificationFetch({ "/api/notifications/unread-count": jsonResponse({ error: { code: "internal", message: "x" } }, 500) });
    await expect(probe()).resolves.toBe("unreachable");
    stubNotificationFetch({});
    await expect(probe()).resolves.toBe("unreachable");
  });
});
