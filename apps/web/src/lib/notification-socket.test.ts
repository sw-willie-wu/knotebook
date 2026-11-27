import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTIFICATIONS_CLOSE_TOO_MANY, NOTIFICATIONS_CLOSE_UNAUTHORIZED, NOTIFICATIONS_SOCKET_PATH } from "@knotebook/shared";
import {
  NOTIFICATION_BACKOFF_MAX_MS,
  NOTIFICATION_STABLE_MS,
  startNotificationSocket,
  type NotificationSocketHandlers,
  type SessionProbe,
  type SocketLike,
} from "./notification-socket";

class FakeSocket implements SocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.({});
  }
  message(data: unknown) {
    this.onmessage?.({ data });
  }
  serverClose(code: number) {
    this.onclose?.({ code });
  }
}

describe("startNotificationSocket", () => {
  let sockets: FakeSocket[];
  let clock: number;
  let probeResult: SessionProbe;
  let handlers: NotificationSocketHandlers & { onMessage: ReturnType<typeof vi.fn>; onConnected: ReturnType<typeof vi.fn>; onFocus: ReturnType<typeof vi.fn>; probe: ReturnType<typeof vi.fn> };
  let stop: () => void;
  let random: () => number;

  function start() {
    stop = startNotificationSocket(handlers, {
      createSocket: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      now: () => clock,
      random: () => random(),
    });
  }
  const last = () => sockets[sockets.length - 1]!;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    clock = 0;
    random = () => 0.5;
    probeResult = "authenticated";
    handlers = { onMessage: vi.fn(), onConnected: vi.fn(), onFocus: vi.fn(), probe: vi.fn(() => Promise.resolve(probeResult)) };
  });
  afterEach(() => {
    stop?.();
    vi.useRealTimers();
  });

  it("connects to the notification path on this origin and reports connect and message", () => {
    start();
    expect(sockets).toHaveLength(1);
    expect(last().url).toBe(`ws://${window.location.host}${NOTIFICATIONS_SOCKET_PATH}`);
    last().open();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    last().message(JSON.stringify({ type: "notification" }));
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
    last().message("not json");
    last().message(JSON.stringify({ type: "other" }));
    expect(handlers.onMessage).toHaveBeenCalledTimes(1);
  });

  it("reconnects with a doubling delay that is capped at 60 s", () => {
    start();
    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const before = sockets.length;
      last().serverClose(1006);
      let waited = 0;
      while (sockets.length === before) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
    expect(Math.max(...delays)).toBe(NOTIFICATION_BACKOFF_MAX_MS);
  });

  it("spreads the reconnect delay by up to 20% either way", () => {
    start();
    random = () => 0;
    last().serverClose(1006);
    vi.advanceTimersByTime(799);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    random = () => 0.9;
    last().serverClose(1006);
    vi.advanceTimersByTime(2319);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
  });

  it("starts the backoff over after a connection that stayed open", () => {
    start();
    last().serverClose(1006);
    vi.advanceTimersByTime(1000);
    last().serverClose(1006);
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(3);
    last().open();
    clock += NOTIFICATION_STABLE_MS;
    last().serverClose(1006);
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it("probes after 4401 and reconnects when the session is still valid", async () => {
    start();
    last().open();
    last().serverClose(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    expect(handlers.probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it("waits for focus instead of a timer when the probe says the session is gone, and recovers after a re-login", async () => {
    probeResult = "unauthorized";
    start();
    last().serverClose(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(1);

    // Still signed out: focus costs one attempt, which ends in another 4401 and a probe, and no loop.
    window.dispatchEvent(new Event("focus"));
    expect(sockets).toHaveLength(2);
    last().serverClose(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets).toHaveLength(2);
    expect(handlers.probe).toHaveBeenCalledTimes(2);

    probeResult = "authenticated";
    window.dispatchEvent(new Event("focus"));
    expect(sockets).toHaveLength(3);
    last().open();
    expect(handlers.onConnected).toHaveBeenCalledTimes(1);
    last().serverClose(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sockets).toHaveLength(4);
  });

  it("keeps trying when the probe itself fails", async () => {
    probeResult = "unreachable";
    start();
    last().serverClose(NOTIFICATIONS_CLOSE_UNAUTHORIZED);
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(2);
  });

  it("waits for window focus after 4429 and never retries on a timer", async () => {
    start();
    last().serverClose(NOTIFICATIONS_CLOSE_TOO_MANY);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(sockets).toHaveLength(1);
    window.dispatchEvent(new Event("focus"));
    expect(sockets).toHaveLength(2);
  });

  it("reports window focus, and focus does not open a second socket while connected", () => {
    start();
    last().open();
    window.dispatchEvent(new Event("focus"));
    expect(handlers.onFocus).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(1);
  });

  it("stop closes the socket, cancels a pending reconnect and removes the focus listener", () => {
    start();
    const first = last();
    first.serverClose(1006);
    stop();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    window.dispatchEvent(new Event("focus"));
    expect(handlers.onFocus).not.toHaveBeenCalled();

    const again = startNotificationSocket(handlers, { createSocket: (url) => (sockets[sockets.length] = new FakeSocket(url)) });
    const live = last();
    again();
    expect(live.closed).toBe(true);
    live.serverClose(1006);
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(2);
  });
});
