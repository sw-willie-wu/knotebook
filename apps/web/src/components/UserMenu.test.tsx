import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import { avatarUrl, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { ShortcutsDialogContext, type ShortcutsDialogApi } from "@/lib/shortcuts-dialog";
import { TourContext, type TourApi } from "@/lib/tour-context";
import { UserMenu } from "./UserMenu";
import { ICON_28_HIT } from "./ui/hit-area";
import { stubLayoutTier } from "@/test/layout-tier";
import { pressTrigger } from "@/test/menu-trigger";
import { getUploadItems, putUpload, resetUploadQueueForTest } from "@/uploads/upload-queue-store";
import { toast } from "@/components/ui/toast";

vi.mock("@/components/ui/toast", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...m, toast: vi.fn(m.toast) };
});

const ACCENT_STORAGE_KEY = "knotebook:accent";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER: UserDto = {
  id: "u1",
  email: "plain@example.com",
  handle: "tester",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

function stubFetch(user: UserDto = USER) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderMenu(shortcuts: ShortcutsDialogApi | null = null, tour: TourApi | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter>
          <ShortcutsDialogContext.Provider value={shortcuts}>
            <TourContext.Provider value={tour}>
              <UserMenu />
            </TourContext.Provider>
          </ShortcutsDialogContext.Provider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** `UserMenu`'s DropdownMenuTrigger only mounts `onPointerDown` (Radix), so a plain `fireEvent.click` cannot open it - see `openUserMenu` in SettingsModal.test.tsx. */
async function openMenu(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument());
  pressTrigger(screen.getByRole("button", { name: "Plain" }));
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
}

describe("UserMenu log out", () => {
  afterEach(() => {
    resetUploadQueueForTest();
    vi.unstubAllGlobals();
  });

  it("clears the upload queue: the next person in this tab sees none of these files", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        if (url === "/api/auth/logout" && init?.method === "POST") return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
    putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "salary.xlsx", size: 1, loaded: 0, expectedUrl: "", status: "failed" });
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    await waitFor(() => expect(getUploadItems()).toEqual([]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  function stubLogout() {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
      if (url === "/api/auth/logout" && init?.method === "POST") return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return () => fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/logout").length;
  }

  it.each(["uploading", "writing"] as const)("asks first while an upload is %s; Cancel keeps the session and the upload", async (status) => {
    await i18n.changeLanguage("en");
    const logouts = stubLogout();
    putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 10, loaded: 2, expectedUrl: "", status });
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

    const dialog = await screen.findByRole("dialog", { name: "Log out and stop uploads?" });
    expect(dialog).toHaveTextContent("Uploads still running stop when you log out");
    expect(logouts()).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(logouts()).toBe(0);
    expect(getUploadItems().map((i) => i.status)).toEqual([status]);
    expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument();
  });

  it("confirming logs out and clears the queue", async () => {
    await i18n.changeLanguage("en");
    const logouts = stubLogout();
    putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 10, loaded: 2, expectedUrl: "", status: "uploading" });
    renderMenu();
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    const dialog = await screen.findByRole("dialog", { name: "Log out and stop uploads?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Log out" }));
    await waitFor(() => expect(getUploadItems()).toEqual([]));
    expect(logouts()).toBe(1);
  });

  it("the phone's avatar menu asks the same way", async () => {
    await i18n.changeLanguage("en");
    const logouts = stubLogout();
    putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 10, loaded: 2, expectedUrl: "", status: "uploading" });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu variant="avatar" />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
    const dialog = await screen.findByRole("dialog", { name: "Log out and stop uploads?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(logouts()).toBe(0);
    expect(getUploadItems()).toHaveLength(1);
  });

  it.each([
    ["with no upload running", "failed"],
    ["from the prompt", "uploading"],
  ] as const)("a log-out the server refuses %s shows an error toast and keeps the session and the queue, with no unhandled rejection", async (_label, status) => {
    await i18n.changeLanguage("en");
    const unhandled = vi.fn();
    window.addEventListener("unhandledrejection", unhandled);
    process.on("unhandledRejection", unhandled);
    try {
      vi.mocked(toast).mockClear();
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL) => {
          const url = String(input);
          if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
          if (url === "/api/auth/logout") return Promise.resolve(fakeResponse({ ok: false, status: 503, json: () => Promise.resolve({ error: { code: "server_busy", message: "x" } }) }));
          throw new Error(`unexpected fetch: ${url}`);
        }),
      );
      putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 10, loaded: 2, expectedUrl: "", status });
      renderMenu();
      await openMenu();
      fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));
      if (status === "uploading") {
        const dialog = await screen.findByRole("dialog", { name: "Log out and stop uploads?" });
        fireEvent.click(within(dialog).getByRole("button", { name: "Log out" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      }
      await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ variant: "destructive" })));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(getUploadItems().map((i) => i.status)).toEqual([status]);
      expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("unhandledrejection", unhandled);
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("UserMenu accent picker", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-accent");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-accent");
  });

  it("renders six swatches: role=menuitemradio, aria-checked follows the current accent (default indigo)", async () => {
    renderMenu();
    await openMenu();

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(6);

    const indigo = screen.getByRole("menuitemradio", { name: "Indigo" });
    expect(indigo).toHaveAttribute("aria-checked", "true");
    // The title tooltip also uses the i18n color name (same translation key as aria-label/textValue).
    expect(indigo).toHaveAttribute("title", "Indigo");
    // The swatch color must come from --brand-swatch-indigo, not a hard-coded hex.
    expect(indigo.getAttribute("style")).toContain("var(--brand-swatch-indigo)");

    for (const name of ["Blue", "Teal", "Sage", "Rose", "Gold"]) {
      expect(screen.getByRole("menuitemradio", { name })).toHaveAttribute("aria-checked", "false");
    }
  });

  // The wrapper's outline-none removes the native focus ring, so keyboard movement between the six swatches needs
  // data-[highlighted]:ring-foreground as the visible cue. jsdom applies no CSS, so only the class literal is pinned;
  // that the ring really shows is left to visual verification.
  it("swatch class contains data-[highlighted]:ring-foreground (visible cue on keyboard movement, compensates outline-none)", async () => {
    renderMenu();
    await openMenu();

    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect(radio.className).toContain("data-[highlighted]:ring-2");
      expect(radio.className).toContain("data-[highlighted]:ring-foreground");
    }
  });

  // 16px visually; coarse pointer: 28px with an ::after widening the hit area to 44px, spacing widened to 44 center-to-center.
  it("swatches grow and enlarge the hit area on coarse pointers, with spacing widened to match", async () => {
    renderMenu();
    await openMenu();

    for (const radio of screen.getAllByRole("menuitemradio")) {
      for (const token of [
        "h-4",
        "w-4",
        "relative",
        "pointer-coarse:h-7",
        "pointer-coarse:w-7",
        "pointer-coarse:after:absolute",
        "pointer-coarse:after:-inset-2",
        "pointer-coarse:after:content-['']",
      ]) {
        expect(radio).toHaveClass(token);
      }
    }
    const group = screen.getAllByRole("menuitemradio")[0]!.parentElement!;
    expect(group).toHaveClass("gap-2", "pointer-coarse:gap-4");
  });

  it("clicking a swatch updates <html> data-accent and localStorage, and the menu stays open", async () => {
    renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Teal" }));

    await waitFor(() => expect(document.documentElement.getAttribute("data-accent")).toBe("teal"));
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Indigo" })).toHaveAttribute("aria-checked", "false");
  });

  // Only checks that document.activeElement really moves; whether the highlight is visible is the job of the
  // class-literal test above.
  it("keyboard ArrowDown moves focus in DOM order (swatches sit in a row visually, the keyboard still follows the menu's native up/down)", async () => {
    renderMenu();
    await openMenu();

    const radios = screen.getAllByRole("menuitemradio");

    // A menu opened by pointerDown does not move focus to the first item (Radix entry-focus only applies to keyboard opens), so
    // focus the first swatch directly to simulate having arrived by arrow keys; this isolates whether another ArrowDown moves focus.
    act(() => radios[0].focus());
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));

    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios[1]));

    fireEvent.keyDown(radios[1], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios[2]));
  });

  // #78: the selection is a check inside the swatch (Radix ItemIndicator, rendered only when checked); the focus ring
  // is unchanged - see the data-[highlighted]:ring-foreground test above.
  it("the selected swatch renders a Check (svg) whose class contains text-popover", async () => {
    renderMenu();
    await openMenu();

    const indigo = screen.getByRole("menuitemradio", { name: "Indigo" });
    const indigoSvg = indigo.querySelector("svg");
    expect(indigoSvg).not.toBeNull();
    expect(indigoSvg).toHaveClass("text-popover");
  });

  // ItemIndicator leaves no child element when unchecked; guards against a false pass where the check is drawn on every swatch.
  it("unselected swatches render no Check (svg is null)", async () => {
    renderMenu();
    await openMenu();

    const teal = screen.getByRole("menuitemradio", { name: "Teal" });
    expect(teal.querySelector("svg")).toBeNull();
  });

  it("after changing the selection the check moves to the newly selected swatch", async () => {
    renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Teal" }));
    await waitFor(() => expect(document.documentElement.getAttribute("data-accent")).toBe("teal"));

    expect(screen.getByRole("menuitemradio", { name: "Teal" }).querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("menuitemradio", { name: "Indigo" }).querySelector("svg")).toBeNull();
  });

  // Negative: no ring-ring (the low-contrast selection ring is gone); the centering classes (flex/items-center/justify-center)
  // must exist because centering is what makes the check visible.
  it("swatch class has no ring-ring (low-contrast selection ring removed in favour of the inner check) and has flex/items-center/justify-center for centering", async () => {
    renderMenu();
    await openMenu();

    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect(radio.className).not.toContain("ring-ring");
      expect(radio.className).toContain("flex");
      expect(radio.className).toContain("items-center");
      expect(radio.className).toContain("justify-center");
    }
  });

  it("places the bell 12px left of the gear, reserves its width in the trigger and keeps its hit area off the gear", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu bell={<span data-testid="bell-stub" />} />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const trigger = await screen.findByRole("button", { name: "Plain" });
    // 6px padding + 16px gear + 12px gap
    expect(screen.getByTestId("bell-stub").parentElement).toHaveClass("right-[34px]");
    // name margin 40 + flex gap 8 + gear 16 + padding 6 = 70 >= 34 + 28px bell box, leaving 8px of text clearance
    expect(trigger).toHaveClass("p-1.5", "gap-2");
    expect(trigger.querySelector("span.truncate")).toHaveClass("mr-10");
    // the arithmetic above assumes a 16px gear
    expect(trigger.querySelector("svg:last-of-type")).toHaveClass("h-4", "w-4");
    // the bell's hit extension (-inset-2 = 8px) must be smaller than the 12px gap
    expect(ICON_28_HIT).toMatch(/pointer-coarse:after:-inset-2(\s|$)/);
  });

  // #79: accessible name of the accent group - the RadioGroup's role=group must resolve t("userMenu.accent");
  // the assertion does not hard-code the English text.
  it("accent RadioGroup has an accessible name (aria-labelledby points at the accent Label)", async () => {
    renderMenu();
    await openMenu();

    expect(screen.getByRole("group", { name: i18n.t("userMenu.accent") })).toBeInTheDocument();
  });
});

// Site admin entry: only admins see it; it navigates to /admin/users with backgroundLocation in state
// (since #247 site admin is a modal and closing returns to the previous page).
describe("UserMenu site admin entry", () => {
  const ADMIN: UserDto = { ...USER, displayName: "Plain", isAdmin: true };

  function stubFetchAs(user: UserDto) {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
  }

  let lastLocation: Location | null = null;
  function LocationSpy() {
    lastLocation = useLocation();
    return <div data-testid="location">{lastLocation.pathname}</div>;
  }

  function renderMenuWithProbe() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/n/tester/some-note"]}>
            <UserMenu />
            <LocationSpy />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    lastLocation = null;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin sees \"Site admin\"; clicking navigates to /admin/users with backgroundLocation in state (#247: site admin is a modal)", async () => {
    stubFetchAs(ADMIN);
    renderMenuWithProbe();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Site admin" }));

    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/admin/users"));
    const state = lastLocation?.state as { backgroundLocation?: { pathname: string } } | null;
    expect(state?.backgroundLocation?.pathname).toBe("/n/tester/some-note");
  });

  it("non-admin does not see \"Site admin\" (\"Settings\" is still there)", async () => {
    stubFetchAs(USER);
    renderMenuWithProbe();
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Site admin" })).not.toBeInTheDocument();
  });

  it("zh-TW: the entry label is localized", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFetchAs(ADMIN);
    renderMenuWithProbe();
    await openMenu();

    expect(screen.getByRole("menuitem", { name: "站台管理" })).toBeInTheDocument();
  });
});

describe("UserMenu Help item", () => {
  const ADMIN_USER: UserDto = { ...USER, isAdmin: true };

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch(ADMIN_USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("comes after \"Settings\" and before \"Site admin\"", async () => {
    renderMenu({ open: vi.fn() });
    await openMenu();
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    const settings = names.findIndex((n) => n.startsWith("Settings"));
    const shortcuts = names.findIndex((n) => n.startsWith("Help"));
    const admin = names.findIndex((n) => n.startsWith("Site admin"));
    expect(settings).toBeGreaterThanOrEqual(0);
    expect(shortcuts).toBe(settings + 1);
    expect(admin).toBe(shortcuts + 1);
  });

  it("accessible name is Help (a string name in getByRole matches the whole string; the hint text is aria-hidden); the item shows Ctrl+/, on Mac the Command sign + /", async () => {
    renderMenu({ open: vi.fn() });
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Help" });
    expect(item).toHaveTextContent("Ctrl+/");
  });

  it("the menu has only \"Help\": no Keyboard shortcuts and no standalone Feature tour (also with a tour context)", async () => {
    renderMenu({ open: vi.fn() }, { start: vi.fn() });
    await openMenu();
    const names = screen.getAllByRole("menuitem").map((el) => el.textContent ?? "");
    expect(names.some((n) => n.startsWith("Help"))).toBe(true);
    expect(screen.queryByRole("menuitem", { name: "Keyboard shortcuts" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Feature tour/ })).toBeNull();
  });

  it("zh-TW: the item name is localized", async () => {
    await i18n.changeLanguage("zh-TW");
    renderMenu({ open: vi.fn() });
    await waitFor(() => expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument());
    fireEvent.pointerDown(screen.getByRole("button", { name: "Plain" }), { button: 0 });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "說明" })).toBeInTheDocument());
    expect(screen.queryByRole("menuitem", { name: "快捷鍵介紹" })).toBeNull();
  });

  it("MacIntel: the hint is the Command sign + /", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    renderMenu({ open: vi.fn() });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveTextContent("⌘/");
  });

  it("aria-keyshortcuts is Control+/ (Meta+/ on Mac)", async () => {
    const view = renderMenu({ open: vi.fn() });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveAttribute("aria-keyshortcuts", "Control+/");
    view.unmount();
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    renderMenu({ open: vi.fn() });
    await openMenu();
    expect(screen.getByRole("menuitem", { name: "Help" })).toHaveAttribute("aria-keyshortcuts", "Meta+/");
  });

  it("selecting the item calls open once with the trigger button as first argument; the menu closes", async () => {
    const open = vi.fn();
    renderMenu({ open });
    const trigger = await screen.findByRole("button", { name: "Plain" }); // grab the trigger first: it is aria-hidden while the menu is open
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![0]).toBe(trigger);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("with a tour context: the help dialog opens on the tour page", async () => {
    const open = vi.fn();
    renderMenu({ open }, { start: vi.fn() });
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![1]).toBe("tour");
  });

  it("without a tour context: the help dialog opens on the shortcuts global page", async () => {
    const open = vi.fn();
    renderMenu({ open });
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Help" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]![1]).toBe("global");
  });

  it("without a Provider (outside AppShell): no such item", async () => {
    renderMenu(null);
    await openMenu();
    expect(screen.queryByRole("menuitem", { name: "Help" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("UserMenu Settings item Ctrl+, hint (same path as AppShell's Ctrl+,)", () => {
  let lastLocation: Location | null = null;
  function Probe() {
    lastLocation = useLocation();
    return <div data-testid="location">{lastLocation.pathname}</div>;
  }

  function renderWithProbe(shortcuts: ShortcutsDialogApi | null) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/n/tester/some-note"]}>
            <ShortcutsDialogContext.Provider value={shortcuts}>
              <UserMenu />
            </ShortcutsDialogContext.Provider>
            <Probe />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    lastLocation = null;
    stubFetch(USER);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("inside AppShell: the Settings item's accessible name stays Settings, with Ctrl+, beside it (aria-hidden) and aria-keyshortcuts Control+,", async () => {
    renderWithProbe({ open: vi.fn() });
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Settings" });
    expect(item).toHaveTextContent("Ctrl+,");
    expect(item).toHaveAttribute("aria-keyshortcuts", "Control+,");
    const hint = Array.from(item.querySelectorAll("span")).find((el) => el.textContent === "Ctrl+,");
    expect(hint?.getAttribute("aria-hidden")).toBe("true");
  });

  it("MacIntel: Command sign + , and Meta+,", async () => {
    vi.stubGlobal("navigator", { ...navigator, platform: "MacIntel" });
    renderWithProbe({ open: vi.fn() });
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Settings" });
    expect(item).toHaveTextContent("⌘,");
    expect(item).toHaveAttribute("aria-keyshortcuts", "Meta+,");
  });

  it("outside AppShell (no context): the Settings item has no hint and no aria-keyshortcuts (that shortcut does nothing here)", async () => {
    renderWithProbe(null);
    await openMenu();
    const item = screen.getByRole("menuitem", { name: "Settings" });
    expect(item).not.toHaveTextContent("Ctrl+,");
    expect(item).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("clicking Settings navigates to /settings/account with backgroundLocation in state (same path as Ctrl+,)", async () => {
    renderWithProbe({ open: vi.fn() });
    await openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Settings" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    const state = lastLocation?.state as { backgroundLocation?: { pathname: string } } | null;
    expect(state?.backgroundLocation?.pathname).toBe("/n/tester/some-note");
  });
});

const AVATAR_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("UserMenu avatar form", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderAvatar() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu variant="avatar" />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  it("the trigger shows only the avatar: name stays displayName, hit area 44, visual 32, no name text or gear", async () => {
    renderAvatar();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    expect(trigger).toHaveClass("h-11", "w-11");
    expect(trigger.textContent).toBe("P");
    expect(trigger.querySelector("svg")).toBeNull();
    expect((trigger.querySelector("span") as HTMLElement).style.width).toBe("32px");
  });

  it("menu content is unchanged: it opens and has Settings and Log out", async () => {
    renderAvatar();
    pressTrigger(await screen.findByRole("button", { name: "Plain" }));
    await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
    expect(screen.getByRole("menuitem", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Log out" })).toBeInTheDocument();
  });

  it("default (row) form is unchanged: shows the name text", async () => {
    renderMenu();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    expect(trigger.textContent).toContain("Plain");
    expect(trigger).not.toHaveClass("w-11");
  });

  it("with an avatar: the trigger holds the shared avatar img (src is avatarUrl), name and 44 hit area unchanged", async () => {
    stubFetch({ ...USER, avatar: { id: AVATAR_ID, v: 4, pending: false } });
    renderAvatar();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    expect(trigger).toHaveClass("h-11", "w-11");
    const imgs = trigger.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe(avatarUrl(AVATAR_ID, 4));
    expect((imgs[0].parentElement as HTMLElement).style.width).toBe("32px");
  });

  it("a pending avatar also shows the img; without an avatar it shows the initial", async () => {
    stubFetch({ ...USER, avatar: { id: AVATAR_ID, v: 1, pending: true } });
    const view = renderAvatar();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    view.unmount();
    stubFetch({ ...USER, avatar: null });
    renderAvatar();
    const plain = await screen.findByRole("button", { name: "Plain" });
    expect(plain.querySelector("img")).toBeNull();
    expect(plain.textContent).toBe("P");
  });
});

describe("UserMenu account row avatar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderTrigger(user: UserDto): Promise<HTMLElement> {
    stubFetch(user);
    renderMenu();
    return screen.findByRole("button", { name: user.displayName });
  }

  it.each([false, true])("with an avatar (pending=%s): the trigger holds one img whose src is avatarUrl(id, v)", async pending => {
    const trigger = await renderTrigger({ ...USER, avatar: { id: AVATAR_ID, v: 4, pending } });
    const imgs = trigger.querySelectorAll("img");
    expect(imgs).toHaveLength(1);
    expect(imgs[0].getAttribute("src")).toBe(avatarUrl(AVATAR_ID, 4));
  });

  it("without an avatar: no img, shows the initial", async () => {
    const trigger = await renderTrigger({ ...USER, displayName: "alice", avatar: null });
    expect(trigger.querySelector("img")).toBeNull();
    expect(trigger).toHaveTextContent(/^A/);
  });

  it("img load failure falls back to the initial", async () => {
    const trigger = await renderTrigger({ ...USER, displayName: "alice", avatar: { id: AVATAR_ID, v: 1, pending: false } });
    fireEvent.error(trigger.querySelector("img")!);
    expect(trigger.querySelector("img")).toBeNull();
    const letter = Array.from(trigger.querySelectorAll("span")).find((el) => el.textContent === "A");
    expect(letter).toBeDefined();
  });

  it("the initial's inline font-size is 10px (24px avatar)", async () => {
    const trigger = await renderTrigger({ ...USER, displayName: "alice", avatar: null });
    const letter = Array.from(trigger.querySelectorAll("span")).find((el) => el.textContent === "A")!;
    expect(letter.style.fontSize).toBe("10px");
  });

  it("initial state uses bg-primary background and text-primary-foreground text, not overridden by bg-muted", async () => {
    const trigger = await renderTrigger({ ...USER, displayName: "alice", avatar: null });
    const letter = Array.from(trigger.querySelectorAll("span")).find((el) => el.textContent === "A")!;
    expect(letter).toHaveClass("bg-primary", "text-primary-foreground");
    expect(letter).not.toHaveClass("bg-muted");
    expect(letter).not.toHaveClass("text-foreground");
  });

  it("the trigger's accessible name stays displayName (also with an avatar)", async () => {
    stubFetch({ ...USER, displayName: "Alice Lin", avatar: { id: AVATAR_ID, v: 1, pending: false } });
    renderMenu();
    expect(await screen.findByRole("button", { name: "Alice Lin" })).toBeInTheDocument();
  });

  it.each([
    ["王小明", "王"],
    ["👩‍💻 dev", "👩‍💻"],
    ["éclair", "É"],
  ])("name %j shows the full first character %j", async (displayName, expected) => {
    const trigger = await renderTrigger({ ...USER, displayName, avatar: null });
    const letter = Array.from(trigger.querySelectorAll("span")).find((el) => el.textContent === expected);
    expect(letter).toBeDefined();
  });
});

describe("UserMenu phone sheet", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderAvatarMenu() {
    return render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter>
            <UserMenu variant="avatar" />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  }

  it("phone: bottom sheet, 48px rows with 16px text (swatches do not grow), the name stays on top (no extra title); selecting an item closes it and focus returns to the avatar", async () => {
    stubLayoutTier("phone");
    renderAvatarMenu();
    const trigger = await screen.findByRole("button", { name: "Plain" });
    pressTrigger(trigger);
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-menu-sheet");
    expect(menu).toHaveClass("kb-menu-sheet", "w-full");
    expect(menu).not.toHaveClass("min-w-56");
    expect(menu.firstElementChild).toHaveTextContent("Plain");
    expect(within(menu).getAllByText("Plain")).toHaveLength(1);
    for (const item of within(menu).getAllByRole("menuitem")) expect(item).toHaveClass("min-h-12", "text-base");
    for (const dot of within(menu).getAllByRole("menuitemradio")) expect(dot).not.toHaveClass("min-h-12");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Dark" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("640 and above: stays a small menu anchored to the trigger", async () => {
    stubLayoutTier("overlay");
    renderAvatarMenu();
    pressTrigger(await screen.findByRole("button", { name: "Plain" }));
    const menu = await screen.findByRole("menu");
    expect(menu).not.toHaveAttribute("data-menu-sheet");
    expect(menu).toHaveClass("min-w-56");
    expect(within(menu).getByRole("menuitem", { name: "Settings" })).not.toHaveClass("min-h-12");
  });
});
