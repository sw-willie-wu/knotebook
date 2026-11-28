import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lazy, Suspense, useState, type ReactNode } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppShellLayout } from "./AppShellLayout";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import {
  AppErrorBoundary,
  ChunkLoadBeacon,
  LazyRouteErrorBoundary,
  LazyRouteLoading,
  NoteRouteErrorBoundary,
} from "./ErrorBoundary";
import { NotePageFallback } from "./NotePageFallback";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Issue #66: criteria for the behaviour of NoteRouteErrorBoundary / AppErrorBoundary / ChunkLoadBeacon. The wiring cases (App.tsx really wraps them) are in
 * App.errorBoundary.test.tsx and App.appBoundary.test.tsx: a hand-assembled shape being right doesn't prove App.tsx is right, so both are needed.
 *
 * Discrimination:
 * - The B screen and NotePageFallback both render inside the layout route's AppShell, so asserting AppShell landmarks doesn't discriminate;
 *   assert the loading screen as loading text present AND both error texts absent, assert B by the branch text / retry button.
 * - For cases asserting flag state, set the start value explicitly to the opposite of the expected end (asserting "cleared" right after
 *   beforeEach cleared it is a tautology).
 * - A hand-built lazy's payload is that lazy object's permanent cache: create it inside each case, never share it.
 */

const FLAG_KEY = "knotebook:chunk-reload:notepage";
const CHUNK_MSG = "Failed to fetch dynamically imported module: https://x/assets/NotePage-abc.js";

const LOADING_TEXT = "Loading…";
const CHUNK_ERROR_TEXT = "Couldn't load this page — check your connection, or a new version may have been deployed.";
const CRASH_TEXT = "Something went wrong on this page.";
const RETRY_TEXT = "Try again";
const APP_CRASH_TITLE = "Something went wrong";
const RELOAD_TEXT = "Reload";
const OFFLINE_HINT = "You appear to be offline — this button will re-enable when the connection returns.";

const ADMIN_USER: UserDto = {
  id: "u1",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return {
    ok,
    status,
    json: json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

// The B screen and NotePageFallback render inside the layout route's AppShell, which needs Router + QueryClientProvider + useSession's fetch;
// the boundary doesn't catch errors thrown by its own fallback, so missing any of them blows up in a hard-to-diagnose way.
function Providers({ children }: { children: ReactNode }) {
  // Lazy useState init: cases that call rerender would rebuild the client on every render if it were created directly.
  const [queryClient] = useState(() => new QueryClient());
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/notes/n1"]}>
          <Routes>
            <Route element={<AppShellLayout />}>
              <Route path="*" element={children} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) }));
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      return Promise.resolve(fakeResponse({ ok: false, status: 404 }));
    }),
  );
}

function ChunkBomb(): ReactNode {
  throw new Error(CHUNK_MSG);
}

function PlainBomb(): ReactNode {
  throw new Error("boom");
}

function setOffline() {
  Object.defineProperty(window.navigator, "onLine", { value: false, configurable: true });
}

function restoreOnline() {
  // defineProperty sets an instance own property; deleting it falls back to the prototype getter.
  delete (window.navigator as unknown as Record<string, unknown>).onLine;
}

beforeEach(async () => {
  sessionStorage.clear();
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  restoreOnline();
  vi.restoreAllMocks();
});

function expectLoadingScreen() {
  expect(screen.getAllByText(LOADING_TEXT).length).toBeGreaterThanOrEqual(1);
  expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
  expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
}

describe("NoteRouteErrorBoundary", () => {
  it("chunk error (first time, online, flag unset) -> reload exactly once and the flag is set; meanwhile the screen is the loading style, not the error screen", async () => {
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
    // Discriminating assertion: loading text present and both error texts absent (B also contains AppShell, so asserting AppShell landmarks alone doesn't discriminate);
    // AppShell presence is pinned separately and must not be the only assertion.
    expectLoadingScreen();
    await waitFor(() => expect(screen.getByText("New note")).toBeInTheDocument());
  });

  it("chunk error (flag already set) -> no reload, B screen with the chunk branch text plus a retry button", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeInTheDocument();
    // #115: the B screen sits in the layout route's AppShell, so a narrow window needs an entry to open the drawer (NarrowTopBar).
    expect(screen.getByRole("button", { name: "Open sidebar" })).toBeInTheDocument();
    expect(screen.getByText(CHUNK_ERROR_TEXT).closest(".overflow-y-auto")).toHaveClass("rounded-xl", "border", "max-sm:rounded-none", "max-sm:border-0", "max-sm:pb-[env(safe-area-inset-bottom)]");
  });

  it("chunk error (offline) -> no reload, straight to B, and the flag isn't set (offline doesn't burn the allowance)", () => {
    setOffline();
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    // The offline short circuit must come before setting the flag: swapping the two turns this assertion red.
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
    // Retry is disabled offline: an offline reload swaps the SPA for the browser's network error page, and the text itself tells people to check their connection,
    // so it must not be a button that kills the app; a disabled element isn't focusable, so text must explain why it is greyed out.
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeDisabled();
    expect(screen.getByText(OFFLINE_HINT)).toBeInTheDocument();
  });

  it("after entering B offline, regaining connection (online event) -> the retry button is enabled again", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    setOffline();
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeDisabled();

    act(() => {
      restoreOnline();
      window.dispatchEvent(new Event("online"));
    });
    expect(screen.getByRole("button", { name: RETRY_TEXT })).toBeEnabled();
  });

  it("pressing retry -> the flag is cleared and reload happens", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    screen.getByRole("button", { name: RETRY_TEXT }).click();
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // Regression pin: the real bundle's failure messages aren't the three bare import() ones. The NotePage chunk has a CSS dependency and goes through
  // Vite's __vitePreload, so offline / CSS hash rotation rejects with Vite's own CSS message; a reverse-proxy try_files deployment gives a MIME-type message.
  // Both must be classed as chunk (flag set -> B's chunk branch text); if misclassed as non-chunk, CRASH_TEXT shows and the case goes red.
  it("Vite CSS preload failure message -> classed as a chunk error", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    function ViteCssBomb(): ReactNode {
      throw new Error("Unable to preload CSS for /assets/NotePage-CbKxQqM5.css");
    }
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ViteCssBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
  });

  it("MIME-type message (try_files proxy returns the 404 JS as text/html) -> classed as a chunk error", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    function MimeBomb(): ReactNode {
      throw new Error(
        'Failed to load module script: Expected a JavaScript module script but the server responded with a MIME type of "text/html".',
      );
    }
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <MimeBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CRASH_TEXT)).not.toBeInTheDocument();
  });

  it("non-chunk error -> no reload, B screen with the non-chunk branch text", () => {
    const reload = vi.fn();
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <PlainBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CRASH_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(CHUNK_ERROR_TEXT)).not.toBeInTheDocument();
  });

  // Uses a Storage.prototype spy: an instance-level spy is silently ineffective in jsdom 30 (with a pre-set flag it would be green and meaningless).
  // A prototype spy also throws for localStorage, which ThemeProvider's readStoredTheme goes through and would blow up outside the boundary first,
  // so throw only for the flag key and return null for the other keys; installed per case and restored at its end.
  // The flag isn't pre-set: if the spy were ineffective it would take the "first time" path (reload + loading screen) and the assertions below would go red.
  it("sessionStorage read throws -> no reload, no crash, B screen", () => {
    const reload = vi.fn();
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation((key: string) => {
      if (key === FLAG_KEY) throw new Error("denied");
      return null;
    });
    try {
      render(
        <Providers>
          <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
            <ChunkBomb />
          </NoteRouteErrorBoundary>
        </Providers>,
      );
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("sessionStorage write throws -> no reload, no crash, B screen", () => {
    const reload = vi.fn();
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key: string) => {
      if (key === FLAG_KEY) throw new Error("denied");
    });
    try {
      render(
        <Providers>
          <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
            <ChunkBomb />
          </NoteRouteErrorBoundary>
        </Providers>,
      );
      expect(reload).not.toHaveBeenCalled();
      expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("reload throws -> goes to B (doesn't stay in reloading) and the flag just set is cleared back", () => {
    const reload = vi.fn(() => {
      throw new Error("reload blocked");
    });
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    // The reload didn't actually happen; a leftover flag would steal the rescue allowance of the next real failure.
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
  });

  it("in error state a resetKey change (online) -> reload and the flag isn't cleared", () => {
    sessionStorage.setItem(FLAG_KEY, "1"); // pre-set: entering B plus "not cleared" must not be a tautology
    const reload = vi.fn();
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
  });

  it("in error state a resetKey change (offline) -> no reload, stays on B", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    setOffline();
    const reload = vi.fn();
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
  });

  it("navigation reload throws -> stays on B, doesn't bubble (componentDidUpdate's try/catch)", () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn(() => {
      throw new Error("reload blocked");
    });
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
  });

  it("in reloading state a resetKey change -> no further reload", () => {
    const reload = vi.fn();
    const { rerender } = render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expectLoadingScreen();

    rerender(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n2" reload={reload}>
          <ChunkBomb />
        </NoteRouteErrorBoundary>
      </Providers>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expectLoadingScreen();
  });

  it("reload cancelled by a leave-page prompt (the page stays alive) -> back to the error screen with the retry button enabled", () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      render(
        <Providers>
          <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
            <ChunkBomb />
          </NoteRouteErrorBoundary>
        </Providers>,
      );
      expect(reload).toHaveBeenCalledTimes(1);
      expectLoadingScreen();

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
      const retry = screen.getByRole("button", { name: RETRY_TEXT });
      expect(retry).toBeEnabled();
      // Left set: a reload that was only slow must not earn another automatic one.
      expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
      act(() => retry.click());
      expect(reload).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ChunkLoadBeacon (real suspend -> reject timeline)", () => {
  it("successful commit -> the flag is cleared (pre-set; starting empty would stay green with the beacon deleted, a tautology)", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    const Lazy = lazy(() => Promise.resolve({ default: () => <p>lazy-ok</p> }));
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <Suspense fallback={<NotePageFallback />}>
            <Lazy />
            <ChunkLoadBeacon />
          </Suspense>
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    await waitFor(() => expect(screen.getByText("lazy-ok")).toBeInTheDocument());
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("lazy rejects -> beacon doesn't run, flag remains -> judged as already reloaded -> no reload, goes to B (beacon placement invariant)", async () => {
    // Pre-set the flag. Started empty, both placements end the same (set the flag + reload), so a misplacement isn't caught.
    // Pre-set: correct placement = beacon doesn't run -> flag stays -> no reload + B; misplaced outside Suspense = beacon clears the flag while pending
    // -> judged first time -> reload + loading screen; the three observables diverge together.
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    const Lazy = lazy(() => Promise.reject(new Error(CHUNK_MSG)));
    render(
      <Providers>
        <NoteRouteErrorBoundary resetKey="n1" reload={reload}>
          <Suspense fallback={<NotePageFallback />}>
            <Lazy />
            <ChunkLoadBeacon />
          </Suspense>
        </NoteRouteErrorBoundary>
      </Providers>,
    );

    await waitFor(() => expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument());
    // The discriminating assertions are the ones above and below (misplacement = one reload + loading screen, both go red); "flag remains" also holds under
    // misplacement (after the beacon clears it componentDidCatch sets it back), so it is a supporting assertion and must not be the only one kept when trimming.
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(FLAG_KEY)).not.toBeNull();
  });
});

// #201: site admin, settings modal sections and the login flow pages are lazy too and share this boundary; they differ only in
// `chunk` (alias of the sessionStorage key for the auto-reload allowance) and `frame` (the outer frame).
describe("LazyRouteErrorBoundary chunk/frame (#201)", () => {
  const SETTINGS_FLAG_KEY = "knotebook:chunk-reload:settings";

  it("chunk=settings has its own allowance: auto-reloads even when the notepage flag is set, and sets only its own flag", () => {
    // Pre-set the notepage flag: if the key weren't split by chunk this would be judged "already reloaded" -> no reload.
    sessionStorage.setItem(FLAG_KEY, "1");
    const reload = vi.fn();
    render(
      <LazyRouteErrorBoundary resetKey="/settings/account" chunk="settings" frame="inline" reload={reload}>
        <ChunkBomb />
      </LazyRouteErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(SETTINGS_FLAG_KEY)).not.toBeNull();
    expect(sessionStorage.getItem(FLAG_KEY)).toBe("1");
  });

  it("ChunkLoadBeacon with chunk=settings clears only its own flag", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    sessionStorage.setItem(SETTINGS_FLAG_KEY, "1");
    const Lazy = lazy(() => Promise.resolve({ default: () => <p>lazy-ok</p> }));
    render(
      <LazyRouteErrorBoundary resetKey="/settings/account" chunk="settings" frame="inline" reload={vi.fn()}>
        <Suspense fallback={<LazyRouteLoading frame="inline" />}>
          <Lazy />
          <ChunkLoadBeacon chunk="settings" />
        </Suspense>
      </LazyRouteErrorBoundary>,
    );
    await waitFor(() => expect(screen.getByText("lazy-ok")).toBeInTheDocument());
    expect(sessionStorage.getItem(SETTINGS_FLAG_KEY)).toBeNull();
    expect(sessionStorage.getItem(FLAG_KEY)).toBe("1");
  });

  it("frame=page error screen doesn't wrap AppShell (login flow pages are reachable while logged out and must not call /api/auth/me)", () => {
    sessionStorage.setItem("knotebook:chunk-reload:register", "1");
    const reload = vi.fn();
    // Deliberately no Providers: AppShell needs Router + QueryClient, so misusing it would blow up right here.
    render(
      <LazyRouteErrorBoundary resetKey={undefined} chunk="register" frame="page" reload={reload}>
        <ChunkBomb />
      </LazyRouteErrorBoundary>,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByText(CHUNK_ERROR_TEXT)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    screen.getByRole("button", { name: RETRY_TEXT }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("frame=inline loading screen (reloading state) shows only the loading text and doesn't wrap AppShell", () => {
    const reload = vi.fn();
    render(
      <LazyRouteErrorBoundary resetKey="/settings/groups" chunk="settings" frame="inline" reload={reload}>
        <ChunkBomb />
      </LazyRouteErrorBoundary>,
    );
    expect(reload).toHaveBeenCalledTimes(1);
    expectLoadingScreen();
    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("version history: frame=inline with crashMessageKey/inlineErrorClassName: a non-chunk error shows that key's text wrapped in that class; without them it is identical to the default", () => {
    const { unmount } = render(
      <LazyRouteErrorBoundary
        resetKey={undefined}
        chunk="versions"
        frame="inline"
        reload={vi.fn()}
        crashMessageKey="versions.crash"
        inlineErrorClassName="kb-test-frame"
      >
        <PlainBomb />
      </LazyRouteErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Version history couldn't be shown.");
    expect(alert).not.toHaveTextContent(i18n.t("app.noteCrash"));
    expect(alert.parentElement).toHaveClass("kb-test-frame");
    unmount();
    const plain = render(
      <LazyRouteErrorBoundary resetKey={undefined} chunk="versions" frame="inline" reload={vi.fn()}>
        <PlainBomb />
      </LazyRouteErrorBoundary>,
    );
    const defaultAlert = screen.getByRole("alert");
    expect(defaultAlert).toHaveTextContent(i18n.t("app.noteCrash"));
    expect(plain.container.querySelector(".kb-test-frame")).toBeNull();
    expect(defaultAlert.parentElement).toBe(plain.container);
  });
});

describe("AppErrorBoundary", () => {
  it("child render throws -> app-level fallback (no white screen), the button triggers reload", () => {
    const reload = vi.fn();
    render(
      <AppErrorBoundary reload={reload}>
        <PlainBomb />
      </AppErrorBoundary>,
    );

    expect(screen.getByText(APP_CRASH_TITLE)).toBeInTheDocument();
    // #115 reverse assertion: the app-level fallback deliberately doesn't mount NarrowTopBar/SidebarDrawerButton. Its invariant is zero context dependency
    // (no AppShell; the error may come from auth/query), so mounting them would either throw a context error again inside the fallback or be a dead button.
    expect(screen.queryByRole("button", { name: "Open sidebar" })).not.toBeInTheDocument();
    screen.getByRole("button", { name: RELOAD_TEXT }).click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reload button is disabled offline (offline reload = browser network error page)", () => {
    setOffline();
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <PlainBomb />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: RELOAD_TEXT })).toBeDisabled();
    expect(screen.getByText(OFFLINE_HINT)).toBeInTheDocument();
  });
});
