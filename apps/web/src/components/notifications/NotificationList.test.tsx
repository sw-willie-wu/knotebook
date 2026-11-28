import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import i18n from "@/i18n";
import { NOTIFICATION_NOTE, jsonResponse, nid, notification, notificationPage, stubNotificationFetch, uploadNotification } from "@/test/notification-fixtures";
import { NotificationList } from "./NotificationList";

const LIST = "/api/notifications?limit=30";
const SEEN = "POST /api/notifications/seen";

function renderList(onNavigate = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <NotificationList userId="u-alice" onNavigate={onNavigate} layout="popover" />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, onNavigate };
}

describe("NotificationList", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("shows the empty state, and Clear all is disabled", async () => {
    stubNotificationFetch({ [LIST]: jsonResponse(notificationPage([])), [SEEN]: jsonResponse(null, 204) });
    renderList();
    expect(await screen.findByText("No notifications yet.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all" })).toBeDisabled();
  });

  it("shows an error with a retry that loads the list", async () => {
    let fail = true;
    stubNotificationFetch({
      [LIST]: () => (fail ? jsonResponse({ error: { code: "internal", message: "x" } }, 500) : jsonResponse(notificationPage([notification(1)]))),
      [SEEN]: jsonResponse(null, 204),
    });
    renderList();
    expect(await screen.findByText("Notifications couldn't be loaded.")).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("notification")).toBeInTheDocument();
  });

  it("a row without access shows the actor and kind but no title or text, and can't be opened", async () => {
    stubNotificationFetch({
      [LIST]: jsonResponse(notificationPage([notification(1, { canOpen: false, noteId: null, noteTitle: null, commentId: null, excerpt: null, kind: "reply" })])),
      [SEEN]: jsonResponse(null, 204),
    });
    const { onNavigate } = renderList();
    const row = await screen.findByTestId("notification");
    expect(within(row).getByText("Bob replied to your comment")).toBeInTheDocument();
    expect(within(row).getByTestId("notification-no-access")).toHaveTextContent("You can't open this note any more.");
    expect(within(row).queryByTestId("notification-note")).toBeNull();
    expect(within(row).queryByRole("button", { name: /replied to your comment/ })).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("an upload_finished row shows the upload icon instead of an avatar, the file and the note, and opens the note at the block", async () => {
    stubNotificationFetch({ [LIST]: jsonResponse(notificationPage([uploadNotification(1, { isNew: true })])), [SEEN]: jsonResponse(null, 204) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let at = "";
    function Where() {
      const loc = useLocation();
      at = `${loc.pathname}${loc.search}${loc.hash}`;
      return null;
    }
    const onNavigate = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <NotificationList userId="u-alice" onNavigate={onNavigate} layout="popover" />
          <Where />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const row = await screen.findByTestId("notification");
    expect(within(row).getByTestId("notification-upload-icon")).toBeInTheDocument();
    expect(row.querySelector("img")).toBeNull();
    expect(within(row).getByTestId("notification-new")).toBeInTheDocument();
    const button = within(row).getByRole("button", { name: /Upload finished/ });
    expect(button).toHaveTextContent("Upload finished: meeting-recording.mp4 was added to Weekly meeting");
    expect(within(row).queryByTestId("notification-no-access")).toBeNull();
    fireEvent.click(button);
    expect(at).toBe(`/notes/${NOTIFICATION_NOTE}#b-v1`);
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });

  it("an upload_finished row on a note that can't be read names only the file and can't be opened", async () => {
    stubNotificationFetch({
      [LIST]: jsonResponse(notificationPage([uploadNotification(1, { canOpen: false, noteId: null, noteTitle: null, blockId: null })])),
      [SEEN]: jsonResponse(null, 204),
    });
    const { onNavigate } = renderList();
    const row = await screen.findByTestId("notification");
    expect(row).toHaveTextContent("Upload finished: meeting-recording.mp4");
    expect(row).not.toHaveTextContent("was added to");
    expect(within(row).getByTestId("notification-no-access")).toHaveTextContent("You can't open this note any more.");
    expect(within(row).queryByRole("button", { name: /Upload finished/ })).toBeNull();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("an upload_finished row reads in zh-TW", async () => {
    await i18n.changeLanguage("zh-TW");
    stubNotificationFetch({ [LIST]: jsonResponse(notificationPage([uploadNotification(1)])), [SEEN]: jsonResponse(null, 204) });
    renderList();
    const row = await screen.findByTestId("notification");
    expect(row).toHaveTextContent("上傳完成：meeting-recording.mp4 已加入「Weekly meeting」");
  });

  it("labels a row addressed to the person's agent and names an agent actor as handle (label)", async () => {
    stubNotificationFetch({
      [LIST]: jsonResponse(
        notificationPage([
          notification(1, { agentLabel: "claude" }),
          notification(2, { actor: { userId: "u-bob", handle: "bob", displayName: "Bob", avatar: null, agentLabel: "helper" } }),
        ]),
      ),
      [SEEN]: jsonResponse(null, 204),
    });
    renderList();
    const rows = await screen.findAllByTestId("notification");
    const mine = rows.find((r) => r.getAttribute("data-notification-id") === nid(1))!;
    expect(within(mine).getByTestId("notification-agent")).toHaveTextContent("for your agent claude");
    const theirs = rows.find((r) => r.getAttribute("data-notification-id") === nid(2))!;
    expect(within(theirs).getByText("bob (helper) mentioned you")).toBeInTheDocument();
    expect(within(theirs).queryByTestId("notification-agent")).toBeNull();
  });

  it("deleting a row removes it and asks for the count again", async () => {
    const calls = stubNotificationFetch({
      [LIST]: jsonResponse(notificationPage([notification(2), notification(1)])),
      [SEEN]: jsonResponse(null, 204),
      [`DELETE /api/notifications/${nid(2)}`]: jsonResponse(null, 204),
      "/api/notifications/unread-count": jsonResponse({ count: 0 }),
    });
    renderList();
    const rows = await screen.findAllByTestId("notification");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "Delete this notification" }));
    await waitFor(() => expect(screen.getAllByTestId("notification")).toHaveLength(1));
    expect(screen.getByTestId("notification")).toHaveAttribute("data-notification-id", nid(1));
    expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/notifications/${nid(2)}`)).toBe(true);
  });

  it("a notification already gone on the server still leaves the list", async () => {
    stubNotificationFetch({
      [LIST]: jsonResponse(notificationPage([notification(1)])),
      [SEEN]: jsonResponse(null, 204),
      [`DELETE /api/notifications/${nid(1)}`]: jsonResponse({ error: { code: "notification_not_found", message: "gone" } }, 404),
      "/api/notifications/unread-count": jsonResponse({ count: 0 }),
    });
    renderList();
    fireEvent.click(within(await screen.findByTestId("notification")).getByRole("button", { name: "Delete this notification" }));
    await waitFor(() => expect(screen.queryByTestId("notification")).toBeNull());
  });

  it("Clear all asks first, Cancel changes nothing, and confirming empties the list", async () => {
    const calls = stubNotificationFetch({
      [LIST]: jsonResponse(notificationPage([notification(1)])),
      [SEEN]: jsonResponse(null, 204),
      "DELETE /api/notifications": jsonResponse(null, 204),
    });
    renderList();
    await screen.findByTestId("notification");
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    const confirm = screen.getByRole("group", { name: "Clear all notifications?" });
    expect(within(confirm).getByText("They are cleared for your agents too.")).toBeInTheDocument();
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Clear all notifications?" })).toBeNull();
    expect(screen.getByTestId("notification")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear all" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Clear all" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Clear all notifications?" })).getByRole("button", { name: "Clear" }));
    expect(await screen.findByText("No notifications yet.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("notification-list-root")).toHaveFocus());
    expect(calls.filter((c) => c.method === "DELETE")).toEqual([{ method: "DELETE", url: "/api/notifications" }]);
  });

  it("pages older notifications in with the cursor", async () => {
    const calls = stubNotificationFetch({
      [LIST]: jsonResponse(notificationPage([notification(2)], "cursor-1")),
      "/api/notifications?limit=30&before=cursor-1": jsonResponse(notificationPage([notification(1)])),
      [SEEN]: jsonResponse(null, 204),
    });
    renderList();
    await screen.findByTestId("notification");
    fireEvent.click(screen.getByRole("button", { name: "Show older notifications" }));
    await waitFor(() => expect(screen.getAllByTestId("notification")).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Show older notifications" })).toBeNull();
    expect(calls.filter((c) => c.url === LIST)).toHaveLength(1);
  });

  it("marks seen only after the list loaded, and keeps rows marked new when a refetch no longer flags them", async () => {
    let isNew = true;
    const calls = stubNotificationFetch({
      [LIST]: () => jsonResponse(notificationPage([notification(1, { isNew })])),
      [SEEN]: jsonResponse(null, 204),
    });
    const { queryClient } = renderList();
    await screen.findByTestId("notification-new");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/seen"))).toBe(true));
    expect(calls.findIndex((c) => c.url === LIST)).toBeLessThan(calls.findIndex((c) => c.url.endsWith("/seen")));
    isNew = false;
    await queryClient.invalidateQueries({ queryKey: ["notifications", "u-alice"] });
    await waitFor(() => expect(calls.filter((c) => c.url === LIST)).toHaveLength(2));
    expect(screen.getByTestId("notification-new")).toBeInTheDocument();
  });

  it("does not post seen again when a refetch brings no newer row", async () => {
    const calls = stubNotificationFetch({
      [LIST]: () => jsonResponse(notificationPage([notification(2), notification(1)])),
      [SEEN]: jsonResponse(null, 204),
    });
    const { queryClient } = renderList();
    await screen.findAllByTestId("notification");
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith("/seen"))).toHaveLength(1));
    await queryClient.invalidateQueries({ queryKey: ["notifications", "u-alice"] });
    await waitFor(() => expect(calls.filter((c) => c.url === LIST)).toHaveLength(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.url.endsWith("/seen"))).toHaveLength(1);
  });

  it("does not mark seen when the list failed to load", async () => {
    const calls = stubNotificationFetch({ [LIST]: jsonResponse({ error: { code: "internal", message: "x" } }, 500), [SEEN]: jsonResponse(null, 204) });
    renderList();
    await screen.findByText("Notifications couldn't be loaded.");
    expect(calls.some((c) => c.url.endsWith("/seen"))).toBe(false);
  });
});
