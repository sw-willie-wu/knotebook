import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import i18n from "@/i18n";
import { stubLayoutTier } from "@/test/layout-tier";
import {
  NOTIFICATION_NOTE,
  NOTIFICATION_USER,
  jsonResponse,
  nid,
  notification,
  notificationPage,
  stubNotificationFetch,
  uploadNotification,
} from "@/test/notification-fixtures";
import { ThemeProvider } from "@/theme";
import { NotificationBell } from "./NotificationBell";
import { UserMenu } from "./UserMenu";
import { pressTrigger } from "@/test/menu-trigger";
import { PANEL_PLACEMENT, PANEL_ROW_WIDTH, PANEL_SURFACE, SIDEBAR_PANEL_ANCHOR_ATTR } from "./ui/panel-shell";
import { ICON_28_HIT } from "./ui/hit-area";

const COUNT = "/api/notifications/unread-count";
const LIST = "/api/notifications?limit=30";

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{`${loc.pathname}${loc.search}${loc.hash}`}</span>;
}

function renderBell(placement: "sidebar" | "topBar" = "sidebar") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationBell placement={placement} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

const base = { "/api/auth/me": jsonResponse(NOTIFICATION_USER) };

describe("NotificationBell", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubLayoutTier("docked");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the unread count on the badge, 9+ above nine, nothing at zero", async () => {
    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 3 }) });
    const first = renderBell();
    expect(await screen.findByTestId("notification-badge")).toHaveTextContent("3");
    expect(screen.getByRole("button", { name: "Notifications, 3 unread" })).toBeInTheDocument();
    first.unmount();

    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 25 }) });
    renderBell();
    expect(await screen.findByTestId("notification-badge")).toHaveTextContent("9+");
  });

  it("has no badge and a plain name when nothing is unread", async () => {
    const calls = stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 0 }) });
    renderBell();
    await waitFor(() => expect(calls.some((c) => c.url === COUNT)).toBe(true));
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.queryByTestId("notification-badge")).toBeNull();
  });

  it("renders nothing while signed out", async () => {
    stubNotificationFetch({ "/api/auth/me": jsonResponse({ error: { code: "unauthorized", message: "no" } }, 401) });
    const { container } = renderBell();
    await waitFor(() => expect(container.querySelector("button")).toBeNull());
  });

  it("opening loads the list first, then marks seen; the badge clears while open and the count is asked again on close", async () => {
    let unread = 2;
    const calls = stubNotificationFetch({
      ...base,
      [COUNT]: () => jsonResponse({ count: unread }),
      [LIST]: jsonResponse(notificationPage([notification(2, { isNew: true }), notification(1, { isNew: true })])),
      "POST /api/notifications/seen": () => {
        unread = 0;
        return jsonResponse(null, 204);
      },
    });
    renderBell();
    expect(await screen.findByTestId("notification-badge")).toHaveTextContent("2");

    fireEvent.click(screen.getByTestId("notification-bell"));
    const panel = await screen.findByTestId("notifications-popover");
    expect(await within(panel).findAllByTestId("notification")).toHaveLength(2);
    await waitFor(() => expect(calls.some((c) => c.method === "POST" && c.url === "/api/notifications/seen")).toBe(true));
    const order = calls.filter((c) => c.url === LIST || c.url.endsWith("/seen")).map((c) => c.url);
    expect(order[0]).toBe(LIST);
    expect(order).toContain("/api/notifications/seen");
    expect(screen.queryByTestId("notification-badge")).toBeNull();
    expect(within(panel).getAllByTestId("notification-new")).toHaveLength(2);

    const countsBeforeClose = calls.filter((c) => c.url === COUNT).length;
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("notifications-popover")).toBeNull());
    await waitFor(() => expect(calls.filter((c) => c.url === COUNT).length).toBeGreaterThan(countsBeforeClose));
    expect(screen.queryByTestId("notification-badge")).toBeNull();
  });

  it("the account menu and the notifications panel share surface, row width and alignment", async () => {
    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 0 }), [LIST]: jsonResponse(notificationPage([])), "POST /api/notifications/seen": jsonResponse(null, 204) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu bell={<NotificationBell placement="sidebar" />} />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const bell = await screen.findByTestId("notification-bell");
    pressTrigger(await screen.findByRole("button", { name: NOTIFICATION_USER.displayName }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(bell);
    const panel = await screen.findByTestId("notifications-popover");
    for (const el of [menu, panel]) {
      for (const token of [...PANEL_SURFACE.split(" "), PANEL_ROW_WIDTH]) expect(el).toHaveClass(token);
      expect(el).toHaveAttribute("data-align", PANEL_PLACEMENT.align);
    }
  });

  it("the panel opens above and takes its width from the sidebar row, not the bell", async () => {
    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 0 }), [LIST]: jsonResponse(notificationPage([])), "POST /api/notifications/seen": jsonResponse(null, 204) });
    const rect = (width: number) => ({ x: 0, y: 500, top: 500, left: 0, right: width, bottom: 540, width, height: 40, toJSON: () => ({}) }) as DOMRect;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute(SIDEBAR_PANEL_ANCHOR_ATTR)) return rect(300);
      if (this.dataset.testid === "notification-bell") return rect(28);
      return original.call(this);
    });
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter>
              <UserMenu bell={<NotificationBell placement="sidebar" />} />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
      fireEvent.click(await screen.findByTestId("notification-bell"));
      const panel = await screen.findByTestId("notifications-popover");
      expect(panel).toHaveAttribute("data-side", "top");
      await waitFor(() => expect(panel.parentElement?.style.getPropertyValue("--radix-popper-anchor-width")).toBe("300px"));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("the sidebar bell widens its touch area to 44x44 on coarse pointers", async () => {
    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 0 }) });
    renderBell("sidebar");
    const bell = await screen.findByTestId("notification-bell");
    for (const token of ICON_28_HIT.split(" ")) expect(bell).toHaveClass(token);
  });

  it("clicking the bell again closes the panel", async () => {
    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 0 }), [LIST]: jsonResponse(notificationPage([])), "POST /api/notifications/seen": jsonResponse(null, 204) });
    renderBell();
    const bell = await screen.findByTestId("notification-bell");
    fireEvent.click(bell);
    expect(await screen.findByTestId("notifications-popover")).toBeInTheDocument();
    expect(bell).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(bell);
    await waitFor(() => expect(screen.queryByTestId("notifications-popover")).toBeNull());
  });

  it("a row opens the note at its comment and closes the panel", async () => {
    stubNotificationFetch({
      ...base,
      [COUNT]: jsonResponse({ count: 0 }),
      [LIST]: jsonResponse(notificationPage([notification(1)])),
      "POST /api/notifications/seen": jsonResponse(null, 204),
    });
    renderBell();
    fireEvent.click(await screen.findByTestId("notification-bell"));
    const row = await screen.findByTestId("notification");
    fireEvent.click(within(row).getByRole("button", { name: /Bob mentioned you/ }));
    expect(screen.getByTestId("where")).toHaveTextContent(`/notes/${NOTIFICATION_NOTE}?comment=${nid(101)}`);
    await waitFor(() => expect(screen.queryByTestId("notifications-popover")).toBeNull());
  });

  it("counts an upload_finished notification, and its row opens the note at the block", async () => {
    stubNotificationFetch({
      ...base,
      [COUNT]: jsonResponse({ count: 1 }),
      [LIST]: jsonResponse(notificationPage([uploadNotification(1, { isNew: true })])),
      "POST /api/notifications/seen": jsonResponse(null, 204),
    });
    renderBell();
    expect(await screen.findByTestId("notification-badge")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("notification-bell"));
    const row = await screen.findByTestId("notification");
    fireEvent.click(within(row).getByRole("button", { name: /Upload finished: meeting-recording\.mp4 was added to Weekly meeting/ }));
    expect(screen.getByTestId("where")).toHaveTextContent(`/notes/${NOTIFICATION_NOTE}#b-v1`);
    await waitFor(() => expect(screen.queryByTestId("notifications-popover")).toBeNull());
  });

  it("phones open a full-page sheet with a back button", async () => {
    stubLayoutTier("phone");
    stubNotificationFetch({ ...base, [COUNT]: jsonResponse({ count: 0 }), [LIST]: jsonResponse(notificationPage([notification(1)])), "POST /api/notifications/seen": jsonResponse(null, 204) });
    renderBell("topBar");
    fireEvent.click(await screen.findByTestId("notification-bell"));
    const sheet = await screen.findByTestId("notifications-sheet");
    expect(screen.getByRole("dialog", { name: "Notifications" })).toBe(sheet);
    expect(await within(sheet).findByTestId("notification")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByTestId("notifications-sheet")).toBeNull());
  });
});
