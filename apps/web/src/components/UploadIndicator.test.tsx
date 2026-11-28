import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { stubLayoutTier } from "@/test/layout-tier";
import { NOTIFICATION_USER, jsonResponse, notificationPage, stubNotificationFetch } from "@/test/notification-fixtures";
import { pressTrigger } from "@/test/menu-trigger";
import { ThemeProvider } from "@/theme";
import { putUpload, resetUploadQueueForTest, removeUpload, getUploadItems, type UploadItem } from "@/uploads/upload-queue-store";
import { NotificationBell } from "./NotificationBell";
import { UploadIndicator } from "./UploadIndicator";
import { UserMenu } from "./UserMenu";
import { PANEL_PLACEMENT, PANEL_ROW_WIDTH, PANEL_SURFACE, SIDEBAR_PANEL_ANCHOR_ATTR } from "./ui/panel-shell";

const runner = vi.hoisted(() => ({ retryUpload: vi.fn<(id: string) => Promise<void>>(async () => {}) }));
vi.mock("@/uploads/upload-runner", () => runner);

const NOTE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NOTE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const upload = (id: string, over: Partial<UploadItem> = {}): UploadItem => ({
  id,
  noteId: NOTE_A,
  blockId: `b-${id}`,
  fileName: `${id}.mp4`,
  size: 100,
  loaded: 0,
  expectedUrl: "",
  status: "uploading",
  ...over,
});

const noteOf = (id: string, title: string) => ({ id, title }) as NoteDto;

function Where() {
  const loc = useLocation();
  return <span data-testid="where">{loc.pathname}</span>;
}

function renderIndicator(placement: "sidebar" | "topBar" = "sidebar", seed?: (qc: QueryClient) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(queryClient);
  const view = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <UploadIndicator placement={placement} />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { queryClient, ...view };
}

async function openList() {
  fireEvent.click(pill());
  return screen.findByTestId("uploads-popover");
}

const pill = () => {
  const el = document.querySelector<HTMLElement>("[data-upload-indicator]");
  if (el === null) throw new Error("no upload indicator");
  return el;
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
  stubLayoutTier("docked");
  runner.retryUpload.mockClear();
});

afterEach(() => {
  act(() => resetUploadQueueForTest());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("UploadIndicator: when and what it shows", () => {
  it("renders nothing with an empty queue, appears with an upload and goes away when the queue empties", () => {
    const { container } = renderIndicator();
    expect(container.querySelector("[data-upload-indicator]")).toBeNull();
    act(() => putUpload(upload("a", { loaded: 50 })));
    expect(pill()).toBeInTheDocument();
    act(() => removeUpload("a"));
    expect(container.querySelector("[data-upload-indicator]")).toBeNull();
  });

  it("wide: the pill reads 'count · overall %' and the button is named with both", () => {
    putUpload(upload("a", { size: 100, loaded: 50 }));
    putUpload(upload("b", { size: 300, status: "writing" }));
    renderIndicator("sidebar");
    const pill = screen.getByRole("button", { name: "2 uploads in progress, 87%" });
    expect(pill).toHaveTextContent("2 · 87%");
    expect(pill).toHaveAttribute("aria-haspopup", "dialog");
    expect(pill).toHaveAttribute("aria-expanded", "false");
  });

  it("the ring shows the overall percentage", () => {
    putUpload(upload("a", { size: 100, loaded: 25 }));
    renderIndicator();
    const ring = pill().querySelectorAll("svg circle")[1]!;
    const dash = Number(ring.getAttribute("stroke-dasharray"));
    expect(Number(ring.getAttribute("stroke-dashoffset"))).toBeCloseTo(dash * 0.75, 5);
  });

  it("phone top bar: ring and count only, the percentage stays in the name", () => {
    stubLayoutTier("phone");
    putUpload(upload("a", { size: 100, loaded: 50 }));
    putUpload(upload("b", { size: 100, loaded: 50 }));
    renderIndicator("topBar");
    const pill = screen.getByRole("button", { name: "2 uploads in progress, 50%" });
    expect(pill).toHaveTextContent(/^2$/);
  });

  it("stays while a failed or unplaced item is not dismissed, named by how many need attention", () => {
    putUpload(upload("f", { status: "failed", error: new ApiFail(0, "upload_interrupted", "x") }));
    putUpload(upload("u", { status: "unplaced" }));
    renderIndicator();
    const pill = screen.getByRole("button", { name: "2 uploads need attention" });
    expect(pill).toHaveTextContent(/^2$/);
    expect(pill.querySelector("[data-upload-attention-dot]")).toBeNull();
  });

  it("running and failed together: both in the name, and a dot on the pill", () => {
    putUpload(upload("a", { size: 100, loaded: 10 }));
    putUpload(upload("f", { status: "failed", error: new ApiFail(0, "upload_interrupted", "x") }));
    renderIndicator();
    const pill = screen.getByRole("button", { name: "1 upload in progress, 10%; 1 upload needs attention" });
    expect(pill).toHaveTextContent("1 · 10%");
    const dot = pill.querySelector("[data-upload-attention-dot]");
    expect(dot).not.toBeNull();
    // On the visible pill, not on the taller button around it.
    expect(dot!.parentElement).not.toBe(pill);
    expect(dot!.parentElement).toHaveClass("relative", "h-6", "rounded-full");
  });

  it("uses Taiwan Chinese copy", async () => {
    await i18n.changeLanguage("zh-TW");
    putUpload(upload("a", { size: 100, loaded: 63 }));
    renderIndicator();
    expect(screen.getByRole("button", { name: "上傳中 1 個，63%" })).toBeInTheDocument();
  });
});

describe("UploadIndicator: the list", () => {
  it("opens in the shared sidebar panel; clicking the pill again closes it", async () => {
    putUpload(upload("a", { loaded: 40 }));
    renderIndicator();
    const panel = await openList();
    for (const token of [...PANEL_SURFACE.split(" "), PANEL_ROW_WIDTH]) expect(panel).toHaveClass(token);
    expect(panel).toHaveAttribute("data-align", PANEL_PLACEMENT.align);
    expect(panel).toHaveAttribute("data-side", "top");
    expect(pill()).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(pill());
    await waitFor(() => expect(screen.queryByTestId("uploads-popover")).toBeNull());
  });

  it("is a list: each row has the file name, a progress bar with its value and the note it goes into", async () => {
    putUpload(upload("a", { fileName: "meeting.mp4", size: 200, loaded: 92 }));
    putUpload(upload("b", { fileName: "interview.m4a", noteId: NOTE_B, size: 100, status: "writing" }));
    renderIndicator("sidebar", (qc) => {
      qc.setQueryData(["notes"], [noteOf(NOTE_A, "Weekly sync")]);
      qc.setQueryData(["note", "some-slug"], noteOf(NOTE_B, "Interviews"));
    });
    const panel = await openList();
    expect(within(panel).getByRole("heading", { name: "2 uploading" })).toBeInTheDocument();
    const rows = within(within(panel).getByRole("list")).getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    expect(rows[0]).toHaveTextContent("meeting.mp4");
    const bar = within(rows[0]!).getByRole("progressbar", { name: "Uploading meeting.mp4" });
    expect(bar).toHaveAttribute("aria-valuenow", "46");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    expect(rows[0]).toHaveTextContent("46%");
    expect(within(rows[0]!).getByRole("link", { name: "Weekly sync" })).toHaveAttribute("href", `/notes/${NOTE_A}`);

    expect(within(rows[1]!).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
    expect(rows[1]).toHaveTextContent("Saving to the note…");
    expect(within(rows[1]!).getByRole("link", { name: "Interviews" })).toHaveAttribute("href", `/notes/${NOTE_B}`);
  });

  it("titles come from the notes cache only: no request; an empty title reads Untitled; an unknown note reads 'a note'", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    putUpload(upload("a", { noteId: NOTE_A }));
    putUpload(upload("b", { noteId: NOTE_B }));
    renderIndicator("sidebar", (qc) => qc.setQueryData(["note", NOTE_A], noteOf(NOTE_A, "  ")));
    const panel = await openList();
    expect(within(panel).getByRole("link", { name: "Untitled" })).toHaveAttribute("href", `/notes/${NOTE_A}`);
    expect(within(panel).getByRole("link", { name: "a note" })).toHaveAttribute("href", `/notes/${NOTE_B}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("following a note link goes to the note and closes the panel", async () => {
    putUpload(upload("a"));
    renderIndicator("sidebar", (qc) => qc.setQueryData(["notes"], [noteOf(NOTE_A, "Weekly sync")]));
    const panel = await openList();
    fireEvent.click(within(panel).getByRole("link", { name: "Weekly sync" }));
    expect(screen.getByTestId("where")).toHaveTextContent(`/notes/${NOTE_A}`);
    await waitFor(() => expect(screen.queryByTestId("uploads-popover")).toBeNull());
  });

  it("after following a note link, focus stays where the note view put it, not on the pill", async () => {
    putUpload(upload("a"));
    const queryClient = new QueryClient();
    queryClient.setQueryData(["notes"], [noteOf(NOTE_A, "Weekly sync")]);
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <UploadIndicator placement="sidebar" />
          <Routes>
            <Route path="/notes/:id" element={<input aria-label="Note title" autoFocus />} />
            <Route path="*" element={null} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const panel = await openList();
    fireEvent.click(within(panel).getByRole("link", { name: "Weekly sync" }));
    await waitFor(() => expect(screen.queryByTestId("uploads-popover")).toBeNull());
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Note title" }));
  });

  it("a failed row shows the reason; a retryable one has Retry, which runs the runner's retry for that item", async () => {
    putUpload(upload("f", { fileName: "quote.pdf", status: "failed", error: new ApiFail(0, "upload_interrupted", "x") }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByRole("heading", { name: "Uploads" })).toBeInTheDocument();
    const row = within(panel).getByRole("listitem");
    expect(within(row).getByText(i18n.t("errors.upload_interrupted"))).toHaveClass("text-destructive");
    expect(within(row).queryByRole("progressbar")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: "Retry quote.pdf" }));
    await waitFor(() => expect(runner.retryUpload).toHaveBeenCalledWith("f"));
  });

  it("a failure a retry can't get past (signed out, refused type) has no Retry", async () => {
    putUpload(upload("s", { status: "failed", error: new ApiFail(401, "unauthorized", "x") }));
    putUpload(upload("t", { status: "failed", error: new ApiFail(415, "unsupported_media_type", "x") }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByText(i18n.t("errors.unauthorized"))).toBeInTheDocument();
    expect(within(panel).getByText(i18n.t("errors.unsupported_media_type"))).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Retry/ })).toBeNull();
  });

  it("a pre-check refusal shows its own message (sizes formatted) and no Retry", async () => {
    putUpload(upload("p", { fileName: "day.mp4", size: 240 * 1024 * 1024, status: "failed", precheck: { ok: false, reason: "noRoom", roomBytes: 180 * 1024 * 1024 } }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByText("This file is 240 MB; this space has 180 MB left.")).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /^Retry/ })).toBeNull();
  });

  it("an unplaced row says the file was stored but its place is gone; failed and unplaced rows can be closed", async () => {
    putUpload(upload("u", { fileName: "clip.mp4", status: "unplaced", stored: true }));
    putUpload(upload("f", { fileName: "quote.pdf", status: "failed", error: new ApiFail(415, "unsupported_media_type", "x") }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByText("Uploaded, but its place in the note is gone.")).toBeInTheDocument();
    expect(within(panel).queryByText("Not uploaded: its place in the note is gone.")).toBeNull();
    fireEvent.click(within(panel).getByRole("button", { name: "Close clip.mp4" }));
    expect(getUploadItems().map((i) => i.id)).toEqual(["f"]);
    expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(within(panel).getByRole("button", { name: "Close quote.pdf" }));
    expect(getUploadItems()).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId("uploads-popover")).toBeNull());
    expect(document.querySelector("[data-upload-indicator]")).toBeNull();
  });

  it("an unplaced row whose file was never sent (a retry found its block gone) says so", async () => {
    putUpload(upload("u", { fileName: "clip.mp4", status: "unplaced" }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByText("Not uploaded: its place in the note is gone.")).toBeInTheDocument();
    expect(within(panel).queryByText("Uploaded, but its place in the note is gone.")).toBeNull();
  });

  it("after the last item is closed, the next upload brings the pill back closed, not the old panel", async () => {
    putUpload(upload("f", { fileName: "quote.pdf", status: "failed", error: new ApiFail(415, "unsupported_media_type", "x") }));
    renderIndicator();
    const panel = await openList();
    fireEvent.click(within(panel).getByRole("button", { name: "Close quote.pdf" }));
    await waitFor(() => expect(screen.queryByTestId("uploads-popover")).toBeNull());
    await act(async () => {
      putUpload(upload("a"));
    });
    expect(pill()).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("uploads-popover")).toBeNull();
  });

  it("while a retry checks the account, size and room, its button is disabled and says so", async () => {
    putUpload(upload("r", { fileName: "clip.mp4", status: "failed", error: new ApiFail(0, "upload_interrupted", "x"), retrying: true }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByRole("button", { name: "Checking…" })).toBeDisabled();
    expect(within(panel).queryByRole("button", { name: "Retry clip.mp4" })).toBeNull();
  });

  it("an account that couldn't be confirmed reads as such, with Retry", async () => {
    putUpload(upload("r", { fileName: "clip.mp4", status: "failed", error: new ApiFail(0, "upload_session_unconfirmed", "x") }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).getByText("Couldn't confirm you're signed in. Try again.")).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: "Retry clip.mp4" })).toBeEnabled();
  });

  it("the countdown rounds a part second up, so it never reads 0 s", async () => {
    await import("@/components/uploads/UploadsLazy");
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    putUpload(upload("r", { fileName: "clip.mp4", status: "failed", error: new ApiFail(429, "too_many_requests", "x"), retryAt: 1_001_800 }));
    renderIndicator();
    await act(async () => {
      fireEvent.click(pill());
      await vi.advanceTimersByTimeAsync(500);
    });
    const panel = screen.getByTestId("uploads-popover");
    expect(within(panel).getByRole("button", { name: "Retry in 2 s" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(800);
    });
    expect(within(panel).getByRole("button", { name: "Retry in 1 s" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(within(panel).getByRole("button", { name: "Retry clip.mp4" })).toBeEnabled();
  });

  it("a running row has no Close", async () => {
    putUpload(upload("a", { fileName: "clip.mp4" }));
    renderIndicator();
    const panel = await openList();
    expect(within(panel).queryByRole("button", { name: "Close clip.mp4" })).toBeNull();
  });

  it("after a 429 that says when to try again, Retry is disabled with a countdown and comes back when the time is up", async () => {
    await import("@/components/uploads/UploadsLazy");
    vi.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
    putUpload(upload("r", { fileName: "clip.mp4", status: "failed", error: new ApiFail(429, "too_many_requests", "x"), retryAt: 1_012_500 }));
    renderIndicator();
    await act(async () => {
      fireEvent.click(pill());
      await vi.advanceTimersByTimeAsync(500);
    });
    const panel = screen.getByTestId("uploads-popover");
    expect(within(panel).getByRole("button", { name: "Retry in 12 s" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(within(panel).getByRole("button", { name: "Retry in 11 s" })).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11_000);
    });
    expect(within(panel).getByRole("button", { name: "Retry clip.mp4" })).toBeEnabled();
  });

  it("the account menu, the notifications panel and the uploads panel share surface, row width and alignment; the uploads pill sits left of the bell in the row", async () => {
    stubNotificationFetch({
      "/api/auth/me": jsonResponse(NOTIFICATION_USER),
      "/api/notifications/unread-count": jsonResponse({ count: 0 }),
      "/api/notifications?limit=30": jsonResponse(notificationPage([])),
      "POST /api/notifications/seen": jsonResponse(null, 204),
    });
    putUpload(upload("a", { loaded: 30 }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu uploads={<UploadIndicator placement="sidebar" />} bell={<NotificationBell placement="sidebar" />} />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const bell = await screen.findByTestId("notification-bell");
    const chip = pill();
    const row = chip.closest(`[${SIDEBAR_PANEL_ANCHOR_ATTR}]`);
    expect(row).not.toBeNull();
    expect(row!.contains(bell)).toBe(true);
    expect(chip.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    pressTrigger(await screen.findByRole("button", { name: NOTIFICATION_USER.displayName }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(bell);
    const notifications = await screen.findByTestId("notifications-popover");
    fireEvent.keyDown(notifications, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("notifications-popover")).toBeNull());
    fireEvent.click(chip);
    const uploads = await screen.findByTestId("uploads-popover");
    for (const el of [menu, notifications, uploads]) {
      for (const token of [...PANEL_SURFACE.split(" "), PANEL_ROW_WIDTH]) expect(el).toHaveClass(token);
      expect(el).toHaveAttribute("data-align", PANEL_PLACEMENT.align);
    }
  });

  it("the panel takes its width from the sidebar row, not the pill", async () => {
    stubNotificationFetch({ "/api/auth/me": jsonResponse(NOTIFICATION_USER), "/api/notifications/unread-count": jsonResponse({ count: 0 }) });
    putUpload(upload("a"));
    const rect = (width: number) => ({ x: 0, y: 500, top: 500, left: 0, right: width, bottom: 540, width, height: 40, toJSON: () => ({}) }) as DOMRect;
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute(SIDEBAR_PANEL_ANCHOR_ATTR)) return rect(300);
      if (this.hasAttribute("data-upload-indicator")) return rect(80);
      return original.call(this);
    });
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <ThemeProvider>
            <MemoryRouter>
              <UserMenu uploads={<UploadIndicator placement="sidebar" />} bell={<NotificationBell placement="sidebar" />} />
            </MemoryRouter>
          </ThemeProvider>
        </QueryClientProvider>,
      );
      await screen.findByTestId("notification-bell");
      fireEvent.click(pill());
      const panel = await screen.findByTestId("uploads-popover");
      expect(panel).toHaveAttribute("data-side", "top");
      await waitFor(() => expect(panel.parentElement?.style.getPropertyValue("--radix-popper-anchor-width")).toBe("300px"));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("phones open the same list in a full-page sheet with a back button", async () => {
    stubLayoutTier("phone");
    putUpload(upload("a", { fileName: "clip.mp4", loaded: 10 }));
    renderIndicator("topBar");
    fireEvent.click(pill());
    const sheet = await screen.findByTestId("uploads-sheet");
    expect(screen.getByRole("dialog", { name: "1 uploading" })).toBe(sheet);
    expect(within(within(sheet).getByRole("list")).getByRole("listitem")).toHaveTextContent("clip.mp4");
    expect(screen.queryByTestId("uploads-popover")).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByTestId("uploads-sheet")).toBeNull());
  });
});

describe("UploadIndicator: focus when it goes away", () => {
  function renderRow(bell: ReactNode) {
    stubNotificationFetch({ "/api/auth/me": jsonResponse(NOTIFICATION_USER), "/api/notifications/unread-count": jsonResponse({ count: 0 }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu uploads={<UploadIndicator placement="sidebar" />} bell={bell} />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

  it("sidebar: closing the last item in the list moves focus to the bell", async () => {
    putUpload(upload("f", { fileName: "quote.pdf", status: "failed", error: new ApiFail(415, "unsupported_media_type", "x") }));
    renderRow(<NotificationBell placement="sidebar" />);
    const bell = await screen.findByTestId("notification-bell");
    const panel = await openList();
    const close = within(panel).getByRole("button", { name: "Close quote.pdf" });
    close.focus();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByTestId("uploads-popover")).toBeNull());
    await settle();
    expect(document.activeElement).toBe(bell);
  });

  it("sidebar: the last upload finishing while the list is open moves focus to the bell", async () => {
    putUpload(upload("a"));
    renderRow(<NotificationBell placement="sidebar" />);
    const bell = await screen.findByTestId("notification-bell");
    const panel = await openList();
    expect(panel.contains(document.activeElement)).toBe(true);
    act(() => removeUpload("a"));
    await settle();
    expect(document.activeElement).toBe(bell);
  });

  it("sidebar: focus on the pill itself also moves to the bell", async () => {
    putUpload(upload("a"));
    renderRow(<NotificationBell placement="sidebar" />);
    const bell = await screen.findByTestId("notification-bell");
    pill().focus();
    act(() => removeUpload("a"));
    await settle();
    expect(document.activeElement).toBe(bell);
  });

  it("sidebar without a bell: focus moves to the account menu's trigger", async () => {
    putUpload(upload("a"));
    renderRow(null);
    const account = await screen.findByRole("button", { name: NOTIFICATION_USER.displayName });
    await openList();
    act(() => removeUpload("a"));
    await settle();
    expect(document.activeElement).toBe(account);
  });

  it("phone: closing the last item in the sheet moves focus to the bell beside the pill", async () => {
    stubLayoutTier("phone");
    stubNotificationFetch({ "/api/auth/me": jsonResponse(NOTIFICATION_USER), "/api/notifications/unread-count": jsonResponse({ count: 0 }) });
    putUpload(upload("u", { fileName: "clip.mp4", status: "unplaced" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <div>
            <UploadIndicator placement="topBar" />
            <NotificationBell placement="topBar" />
          </div>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const bell = await screen.findByTestId("notification-bell");
    fireEvent.click(pill());
    const sheet = await screen.findByTestId("uploads-sheet");
    fireEvent.click(within(sheet).getByRole("button", { name: "Close clip.mp4" }));
    await waitFor(() => expect(screen.queryByTestId("uploads-sheet")).toBeNull());
    await settle();
    expect(document.activeElement).toBe(bell);
  });

  it("the target is used once: after a hand-off, a later emptying with focus elsewhere leaves focus alone", async () => {
    putUpload(upload("a"));
    renderRow(<NotificationBell placement="sidebar" />);
    const bell = await screen.findByTestId("notification-bell");
    pill().focus();
    act(() => removeUpload("a"));
    await settle();
    expect(document.activeElement).toBe(bell);

    act(() => putUpload(upload("b")));
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    act(() => removeUpload("b"));
    await settle();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("an item going away while focus is elsewhere leaves focus alone", async () => {
    putUpload(upload("a"));
    renderRow(<NotificationBell placement="sidebar" />);
    await screen.findByTestId("notification-bell");
    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    act(() => removeUpload("a"));
    await settle();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

describe("UploadIndicator: what stays out of the entry", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const staticRunner = /^\s*import\s[^;]*from\s+["'][^"']*upload-runner["']/m;

  it("reaches the runner only through a lazy import(), and the list only through UploadsLazy", () => {
    const indicator = read("src/components/UploadIndicator.tsx");
    expect(indicator).not.toMatch(staticRunner);
    expect(indicator).toMatch(/lazy\(\s*\(\)\s*=>\s*import\(\s*["']@\/components\/uploads\/UploadsLazy["']\s*\)/);
    expect(indicator).not.toMatch(/from\s+["']@\/components\/uploads\/Upload(List|sPanel|sLazy)["']/);
    const dir = join(process.cwd(), "src/components/uploads");
    const modules = readdirSync(dir).filter((n) => /\.tsx?$/.test(n) && !n.includes(".test."));
    for (const name of modules) expect(readFileSync(join(dir, name), "utf8"), name).not.toMatch(staticRunner);
    expect(modules.some((name) => /import\(\s*["']@\/uploads\/upload-runner["']\s*\)/.test(readFileSync(join(dir, name), "utf8")))).toBe(true);
  });
});
