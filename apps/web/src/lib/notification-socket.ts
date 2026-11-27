import { NOTIFICATIONS_CLOSE_TOO_MANY, NOTIFICATIONS_CLOSE_UNAUTHORIZED, NOTIFICATIONS_SOCKET_PATH } from "@knotebook/shared";

export const NOTIFICATION_BACKOFF_MIN_MS = 1_000;
export const NOTIFICATION_BACKOFF_MAX_MS = 60_000;
/** A connection that stayed open this long starts the backoff over; one that is closed right after opening (a revoked session, a proxy) keeps growing it. */
export const NOTIFICATION_STABLE_MS = 10_000;

export type SessionProbe = "authenticated" | "unauthorized" | "unreachable";

export interface NotificationSocketHandlers {
  onMessage: () => void;
  onConnected: () => void;
  onFocus: () => void;
  /** One cheap authenticated REST call, made after a 4401 to tell "re-login replaced the session" from "signed out". */
  probe: () => Promise<SessionProbe>;
}

export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close: () => void;
}

export interface NotificationSocketOptions {
  createSocket?: (url: string) => SocketLike;
  now?: () => number;
  random?: () => number;
}

function socketUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol === "https:" ? "wss:" : "ws:"}//${host}${NOTIFICATIONS_SOCKET_PATH}`;
}

/** Keeps one notification socket alive until the returned function is called. The socket carries no content, only "something changed". */
export function startNotificationSocket(handlers: NotificationSocketHandlers, options: NotificationSocketOptions = {}): () => void {
  const create = options.createSocket ?? ((url: string) => new WebSocket(url) as unknown as SocketLike);
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  let socket: SocketLike | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let attempt = 0;
  let openedAt: number | null = null;
  let waitingForFocus = false;

  function scheduleReconnect(): void {
    // ±20%: after a server restart every tab would otherwise reconnect, and refetch its count, on the same schedule.
    const delay = Math.min(NOTIFICATION_BACKOFF_MIN_MS * 2 ** attempt, NOTIFICATION_BACKOFF_MAX_MS) * (0.8 + 0.4 * random());
    attempt += 1;
    timer = setTimeout(connect, delay);
  }

  function connect(): void {
    timer = undefined;
    waitingForFocus = false;
    if (stopped) return;
    const ws = create(socketUrl());
    socket = ws;
    ws.onopen = () => {
      openedAt = now();
      handlers.onConnected();
    };
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: unknown };
        if (message.type === "notification") handlers.onMessage();
      } catch {
        // The server only ever sends the one message; anything else is ignored.
      }
    };
    ws.onerror = () => {};
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      const lived = openedAt === null ? 0 : now() - openedAt;
      openedAt = null;
      if (stopped) return;
      if (lived >= NOTIFICATION_STABLE_MS) attempt = 0;
      if (event.code === NOTIFICATIONS_CLOSE_TOO_MANY) {
        // Retrying right away would only spin against the cap; this window regaining focus is the signal to try again.
        waitingForFocus = true;
        return;
      }
      if (event.code === NOTIFICATIONS_CLOSE_UNAUTHORIZED) {
        void handlers.probe().then((result) => {
          if (stopped) return;
          // Signed out here, but the same user can sign back in from another tab without this one remounting, so keep listening for focus.
          if (result === "unauthorized") waitingForFocus = true;
          else scheduleReconnect();
        });
        return;
      }
      scheduleReconnect();
    };
  }

  function onWindowFocus(): void {
    if (stopped) return;
    handlers.onFocus();
    if (waitingForFocus) connect();
  }

  function stop(): void {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    window.removeEventListener("focus", onWindowFocus);
    const ws = socket;
    socket = null;
    if (ws !== null) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    }
  }

  window.addEventListener("focus", onWindowFocus);
  connect();
  return stop;
}
