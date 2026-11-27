import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Three password forms (#187; since #247 on the sign-in page `/settings/login` = `SettingsLoginSection`): `hasPassword === false`
// -> `ChangePasswordForm` isn't rendered; when password sign-in is effectively on, an "add a password" form renders instead, when off only the explanation.
// The account info page (`SettingsAccountSection`) has only three blocks: avatar, display name and URL name.
// Runs through the real `AppRoutes` (same convention as SettingsModal.test.tsx / SettingsUsersSection.test.tsx,
// not rebuilding an equivalent tree) - it verifies the wiring. The fetch stub follows `SettingsUsersSection.test.tsx`.

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PASSWORD_USER: UserDto = {
  id: "u-password",
  email: "alice@example.com",
  handle: "tester",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

const SSO_ONLY_USER: UserDto = {
  id: "u-sso",
  email: "bob@example.com",
  handle: "tester",
  displayName: "Bob",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: false,
  autoVersions: true,
  avatar: null,
};

function baseFetchHandlers(user: UserDto, passwordLoginEnabled = true, siteOn = true) {
  return (url: string, method: string): Response | null => {
    if (url === "/api/auth/config" && method === "GET") {
      return fakeResponse({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: siteOn }),
      });
    }
    if (url === "/api/groups" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) });
    }
    if (url === "/api/folders") return new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } });
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    if (url === "/api/auth/identities" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ identities: [], linkable: [], hasPassword: user.hasPassword, passwordLoginEnabled }) });
    }
    if (url === "/api/auth/tokens" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) });
    }
    if (url === "/api/storage" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ usedBytes: 0, quotaBytes: 2147483648, planName: "Basic", byKind: { image: 0, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 } }) });
    }
    if (url === "/api/auth/avatars" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ candidates: [], auto: false, refreshable: [] }) });
    }
    return null;
  };
}

function renderLoginSettings(user: UserDto, passwordLoginEnabled = true) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const res = baseFetchHandlers(user, passwordLoginEnabled)(url, method);
    if (res) return Promise.resolve(res);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/login"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

describe("SettingsLoginSection (hasPassword / effective password sign-in, three shapes)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("hasPassword:true -> renders ChangePasswordForm", async () => {
    const queryClient = renderLoginSettings(PASSWORD_USER);

    // First load of the sign-in page lazy chunk in this file
    await waitFor(
      () => expect(screen.getByRole("heading", { name: "Change your password" })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Current password")).toBeInTheDocument();
    // Wait point for the "absent" assertion: identities have landed (effective value on) - otherwise the off-explanation simply isn't there yet and the assertion is vacuous.
    await waitFor(() => expect(queryClient.getQueryData(["identities"])).toBeDefined());
    expect(screen.queryByText(/This site only allows signing in through a sign-in service right now/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
  });

  it("hasPassword:false + effective on -> the \"Add a password\" form replaces the old SSO-only text; no change-password form", async () => {
    renderLoginSettings(SSO_ONLY_USER);
    expect(await screen.findByRole("heading", { name: "Add a password" })).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toBeInTheDocument();
    expect(screen.queryByLabelText("Current password")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Change your password" })).not.toBeInTheDocument();
  });

  it("hasPassword:false + effective off -> only the explanation, no form", async () => {
    renderLoginSettings(SSO_ONLY_USER, false);
    expect(await screen.findByText("This site only allows signing in through a sign-in service right now.")).toBeInTheDocument();
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
  });

  it("hasPassword:true + effective off -> the change-password form stays plus the explanation", async () => {
    renderLoginSettings(PASSWORD_USER, false);
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    // The explanation appears only after identities land (the change-password form first renders with the default "on"), so wait with findBy.
    expect(await screen.findByText("This site only allows signing in through a sign-in service right now; your password is only used to prove it's you when linking an account.")).toBeInTheDocument();
  });
});

/**
 * #122: the user name (handle) field in the account section.
 * - Both branches (with password / SSO-only) must render: OIDC users, whose handle derives from preferred_username, are the most likely to want a rename.
 * - After success invalidateQueries clears everything (the handle is denormalized into future NoteDtos; renames are rare, so clearing all is safest).
 * - The warning mentions the /n/ and /p/ URL forms on purpose, ahead of those features, so the text is written once (not drift).
 */
describe("SettingsAccountSection - URL name field (#122)", () => {
  const HANDLE_WARNING =
    "The name used in your public links (/p/<handle>/…). It appears in every /n/ and /p/ link you share (token links don't include it). After a rename those links stop working immediately, and the old name is freed: anyone, including you, can take it. If someone else takes it, an old link that matches one of their notes leads to their note.";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderWithProfilePatch(user: UserDto, patchResponse: () => Response) {
    // Mutable me stub: /api/auth/me reads userRef.current - the success case flips it to the new value, so the claim
    // "after the clear-all refetch the screen shows the new handle" can be asserted; with a fixed stub that claim would be false.
    const userRef = { current: user };
    const patchBodies: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/profile" && method === "PATCH") {
        patchBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(patchResponse());
      }
      const res = baseFetchHandlers(userRef.current)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/settings/account"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    return { fetchMock, patchBodies, invalidateSpy, userRef };
  }

  it("shows the current handle and the warning (including the /n/ and /p/ URL forms - the full text on purpose ahead of those features)", async () => {
    renderWithProfilePatch(PASSWORD_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = (await screen.findByLabelText("URL name")) as HTMLInputElement;
    expect(input.value).toBe("tester");
    expect(screen.getByText(HANDLE_WARNING)).toBeInTheDocument();
  });

  it("SSO-only (hasPassword=false) also sees it and can edit it", async () => {
    renderWithProfilePatch(SSO_ONLY_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = (await screen.findByLabelText("URL name")) as HTMLInputElement;
    expect(input.value).toBe("tester");
    expect(input).not.toBeDisabled();
  });

  it("account info page has three blocks in order: avatar, display name, URL name (password, sign-in methods, tokens and usage moved elsewhere, #247)", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const res = baseFetchHandlers(PASSWORD_USER)(String(input), (init?.method ?? "GET").toUpperCase());
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${String(input)}`);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/settings/account"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    const h1 = await screen.findByRole("heading", { level: 1, name: "Account info" });
    // Scope to the page itself (SettingsPage root = the parent of the header with the h1): Radix DialogTitle is also an h2, and scanning the whole page would pick it up.
    const page = h1.closest("header")!.parentElement!;
    expect(within(page).getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(["Profile picture", "Display name", "URL name"]);
  });

  it("rename success: PATCH body sent normalized, invalidateQueries clears **everything** (no filter), after the clear-all refetch the screen shows the new value plus a success toast", async () => {
    const updated: UserDto = { ...PASSWORD_USER, handle: "new-me" };
    const { patchBodies, invalidateSpy, userRef } = renderWithProfilePatch(PASSWORD_USER, () => {
      userRef.current = updated; // PATCH landing means the server has changed; later /me calls return the new value
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) });
    });
    const input = (await screen.findByLabelText("URL name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New-Me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save URL name" }));
    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ handle: "new-me" }); // sent normalized (lowercase)
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(invalidateSpy.mock.calls.some((args) => args.length === 0 || args[0] === undefined)).toBe(true);
    // Showing the new value relies on setValue(null) returning to "show current value" plus the new session written by setQueryData;
    // without setValue(null) the field stays on the raw "New-Me" and the case goes red.
    await waitFor(() => expect(input.value).toBe("new-me"));
    await screen.findByText("URL name saved.");
  });

  it("PATCH landing immediately updates the session via setQueryData: the new value also shows while the /me refetch has **not responded yet** (no flash back to the old name for one RTT)", async () => {
    const updated: UserDto = { ...PASSWORD_USER, handle: "new-me" };
    let meCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/config" && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }) }),
        );
      }
      if (url === "/api/auth/profile" && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) }));
      }
      if (url === "/api/auth/me" && method === "GET") {
        meCalls += 1;
        if (meCalls === 1) {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(PASSWORD_USER) }));
        }
        return new Promise<Response>(() => {}); // Later refetches never respond: the new value can only come from setQueryData
      }
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/tokens" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: [] }) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/settings/account"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    const input = (await screen.findByLabelText("URL name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "New-Me" } });
    fireEvent.click(screen.getByRole("button", { name: "Save URL name" }));
    await waitFor(() => expect(input.value).toBe("new-me")); // refetch is hanging: the value comes from setQueryData
    await screen.findByText("URL name saved.");
  });

  it("unchanged value (including a case-only change) -> Save is disabled (a no-op rename doesn't hit the endpoint; the quota counts only successes, so the frontend should block it)", async () => {
    renderWithProfilePatch(PASSWORD_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = await screen.findByLabelText("URL name");
    expect(screen.getByRole("button", { name: "Save URL name" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "TESTER" } }); // same value after normalization
    expect(screen.getByRole("button", { name: "Save URL name" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "different" } });
    expect(screen.getByRole("button", { name: "Save URL name" })).not.toBeDisabled();
  });

  it("409 handle_taken -> shows the matching text", async () => {
    renderWithProfilePatch(PASSWORD_USER, () =>
      fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "handle_taken", message: "x" } }) }),
    );
    const input = await screen.findByLabelText("URL name");
    fireEvent.change(input, { target: { value: "occupied" } });
    fireEvent.click(screen.getByRole("button", { name: "Save URL name" }));
    await waitFor(() => expect(screen.getByText("That URL name is already taken.")).toBeInTheDocument());
  });

  it("429 too_many_requests -> shows the matching text", async () => {
    renderWithProfilePatch(PASSWORD_USER, () =>
      fakeResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "too_many_requests", message: "x" } }) }),
    );
    const input = await screen.findByLabelText("URL name");
    fireEvent.change(input, { target: { value: "again" } });
    fireEvent.click(screen.getByRole("button", { name: "Save URL name" }));
    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
  });

  it("invalid format: shown inline by the frontend, no API call", async () => {
    const { fetchMock } = renderWithProfilePatch(PASSWORD_USER, () => fakeResponse({ ok: true, status: 200 }));
    const input = await screen.findByLabelText("URL name");
    fireEvent.change(input, { target: { value: "Bad Name!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save URL name" }));
    await waitFor(() =>
      expect(
        screen.getByText("1–32 characters: lowercase letters, numbers and hyphens; hyphens can't lead, trail, or repeat."),
      ).toBeInTheDocument(),
    );
    expect(fetchMock.mock.calls.some(([, init]) => (init?.method ?? "GET").toUpperCase() === "PATCH")).toBe(false);
  });
});

describe("SetPasswordForm (#187)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  it("submit -> POST /api/auth/password/set {newPassword}, success toast; mismatch -> inline error, not sent; 409 -> matching text", async () => {
    const posts: unknown[] = [];
    let status = 204;
    const handlers = baseFetchHandlers(SSO_ONLY_USER);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/password/set" && method === "POST") {
        posts.push(JSON.parse(String(init!.body)));
        return Promise.resolve(status === 204 ? fakeResponse({ ok: true, status: 204 }) : fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code: "password_already_set", message: "x" } }) }));
      }
      const r = handlers(url, method);
      if (r) return Promise.resolve(r);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><MemoryRouter initialEntries={["/settings/login"]}><AppRoutes /></MemoryRouter></ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "brand-new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "different-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("The new password and confirmation don't match.")).toBeInTheDocument();
    expect(posts).toEqual([]);
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "brand-new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("Password added.")).toBeInTheDocument();
    expect(posts).toEqual([{ newPassword: "brand-new-password-1" }]);
    status = 409;
    fireEvent.change(screen.getByLabelText("New password"), { target: { value: "brand-new-password-2" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "brand-new-password-2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("This account already has a password. Use Change password instead.")).toBeInTheDocument();
  });

  it("new password too short -> blocked on the client, no API call", async () => {
    const posts: unknown[] = [];
    const handlers = baseFetchHandlers(SSO_ONLY_USER);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/password/set" && method === "POST") {
        posts.push(JSON.parse(String(init!.body)));
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      const r = handlers(url, method);
      if (r) return Promise.resolve(r);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }));
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><MemoryRouter initialEntries={["/settings/login"]}><AppRoutes /></MemoryRouter></ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "short" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
    expect(await screen.findByText("Password is too short.")).toBeInTheDocument();
    expect(posts).toEqual([]);
  });
});

describe("SetPasswordForm - state switch after submit (#187)", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  /** /me reads the mutable userRef (like renderWithProfilePatch): POST landing = the server has a password, later /me returns hasPassword:true. */
  function renderSetPassword(postStatus: number) {
    const userRef = { current: SSO_ONLY_USER };
    const handlers = (url: string, method: string) => baseFetchHandlers(userRef.current)(url, method);
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/password/set" && method === "POST") {
        userRef.current = { ...SSO_ONLY_USER, hasPassword: true };
        return Promise.resolve(postStatus === 204
          ? fakeResponse({ ok: true, status: 204 })
          : fakeResponse({ ok: false, status: postStatus, json: () => Promise.resolve({ error: { code: "password_already_set", message: "x" } }) }));
      }
      const r = handlers(url, method);
      if (r) return Promise.resolve(r);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider><MemoryRouter initialEntries={["/settings/login"]}><AppRoutes /></MemoryRouter></ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    const identityGets = () => fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/auth/identities" && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET").length;
    return { identityGets };
  }

  async function submit(): Promise<void> {
    fireEvent.change(await screen.findByLabelText("New password"), { target: { value: "brand-new-password-1" } });
    fireEvent.change(screen.getByLabelText("Confirm new password"), { target: { value: "brand-new-password-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add password" }));
  }

  it("success -> session and identities are refetched: \"Add a password\" disappears and the change-password form appears", async () => {
    const { identityGets } = renderSetPassword(204);
    await waitFor(() => expect(identityGets()).toBe(1));
    await submit();
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
    await waitFor(() => expect(identityGets()).toBe(2));
  });

  it("409 password_already_set -> besides the error text, the session is also refetched: the screen switches to the change-password form", async () => {
    const { identityGets } = renderSetPassword(409);
    await waitFor(() => expect(identityGets()).toBe(1));
    await submit();
    expect(await screen.findByLabelText("Current password")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Add a password" })).not.toBeInTheDocument();
    await waitFor(() => expect(identityGets()).toBe(2));
  });
});

interface AccountCall {
  method: string;
  url: string;
  body: unknown;
}

/** Account page x auto-save versions: `/me` always returns `user`, PATCH /api/auth/profile returns `profileReply` - the switch can only flip via setQueryData (there is no refetch path). */
function renderAutoVersions({ user, siteOn, profileReply }: { user: UserDto; siteOn: boolean; profileReply?: UserDto }): AccountCall[] {
  const calls: AccountCall[] = [];
  const handlers = baseFetchHandlers(user, true, siteOn);
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url === "/api/auth/profile" && method === "PATCH" && profileReply) {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(profileReply) }));
      }
      const res = handlers(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/storage"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return calls;
}

describe("account page x auto-save versions", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the switch reflects user.autoVersions; toggling -> the PATCH /api/auth/profile body is exactly { autoVersions:false } (doesn't trigger the rename flow)", async () => {
    const calls = renderAutoVersions({ user: { ...PASSWORD_USER, autoVersions: true }, siteOn: true, profileReply: { ...PASSWORD_USER, autoVersions: false } });
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(sw).toBeEnabled()); // toBeEnabled already holds before config arrives (siteOff defaults to on); this only confirms it is clickable, whether config loaded is covered by the "site off" case
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH" && c.url === "/api/auth/profile")?.body).toEqual({ autoVersions: false }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false"));
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    expect(calls.some((c) => c.method === "PATCH" && JSON.stringify(c.body).includes("handle"))).toBe(false);
  });

  it("user.autoVersions=false -> the switch has aria-checked=false (distinguishes from the previous case)", async () => {
    renderAutoVersions({ user: { ...PASSWORD_USER, autoVersions: false }, siteOn: true });
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false");
  });

  it("site master switch off (/api/auth/config autoVersionsEnabled:false) -> the switch is disabled plus a visible \"auto-save is turned off for the site\" note", async () => {
    renderAutoVersions({ user: { ...PASSWORD_USER, autoVersions: true }, siteOn: false });
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.getByText("Automatic saving is turned off for the whole site")).toBeInTheDocument();
  });

  it("site master switch on -> the switch is enabled and there is no \"site turned it off\" note", async () => {
    const calls = renderAutoVersions({ user: { ...PASSWORD_USER, autoVersions: true }, siteOn: true });
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    // toBeEnabled already holds before config arrives: first wait for the /api/auth/config request to go out, then let the response and the react-query notification land, before asserting there's no "site turned it off" note
    await waitFor(() => expect(calls.some((c) => c.method === "GET" && c.url === "/api/auth/config")).toBe(true));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(sw).toBeEnabled();
    expect(screen.queryByText("Automatic saving is turned off for the whole site")).not.toBeInTheDocument();
    expect(screen.getByText("Notes that are open right now pick up the change after everyone has closed them.")).toBeInTheDocument();
  });
});

describe("SettingsAccountSection - display name (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * Mutable me stub (like the `userRef` in this file's handle describe): the success case flips userRef to the new value when the PATCH lands,
   * and later /me calls return the new value - with a fixed stub the claim "after the clear-all refetch the screen shows the new name" would be false.
   * `hangMeAfterFirst`: /me never responds from the second call on - the new value on screen can then only come from `setQueryData`.
   */
  function renderWithDisplayNamePatch(
    patchResponse: (body: { displayName: string }, userRef: { current: UserDto }) => Response,
    opts: { hangMeAfterFirst?: boolean } = {},
  ) {
    const userRef = { current: PASSWORD_USER };
    const patchBodies: Array<{ displayName: string }> = [];
    let meCalls = 0;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/profile" && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as { displayName: string };
        patchBodies.push(body);
        return Promise.resolve(patchResponse(body, userRef));
      }
      if (url === "/api/auth/me" && method === "GET") {
        meCalls += 1;
        if (opts.hangMeAfterFirst === true && meCalls > 1) return new Promise<Response>(() => {});
      }
      const res = baseFetchHandlers(userRef.current)(url, method);
      if (res) return Promise.resolve(res);
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/settings/account"]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
        <Toaster />
      </QueryClientProvider>,
    );
    return { patchBodies, queryClient, userRef };
  }

  it("the header is \"Account info\", and the display name block comes before the URL name block", async () => {
    renderWithDisplayNamePatch(() => fakeResponse({ ok: true, status: 200 }));
    expect(await screen.findByRole("heading", { level: 1, name: "Account info" })).toBeInTheDocument();
    const h2 = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(h2.indexOf("Display name")).toBeGreaterThanOrEqual(0);
    expect(h2.indexOf("Display name")).toBeLessThan(h2.indexOf("URL name"));
  });

  it("success: PATCH {displayName} (trimmed) -> session cache has the new name, success toast, after the clear-all refetch the field shows the new value", async () => {
    const { patchBodies, queryClient } = renderWithDisplayNamePatch((body, userRef) => {
      userRef.current = { ...PASSWORD_USER, displayName: body.displayName }; // PATCH landing means the server has changed
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(userRef.current) });
    });
    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    expect(input.value).toBe("Alice");
    fireEvent.change(input, { target: { value: "  Alice W  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await waitFor(() => expect(patchBodies).toEqual([{ displayName: "Alice W" }]));
    await screen.findByText("Display name updated.");
    expect((queryClient.getQueryData(["me"]) as UserDto).displayName).toBe("Alice W");
    await waitFor(() => expect(input.value).toBe("Alice W"));
  });

  it("/me refetch never responds and the new value still shows (it can only come from setQueryData)", async () => {
    renderWithDisplayNamePatch(
      (body, userRef) => {
        userRef.current = { ...PASSWORD_USER, displayName: body.displayName };
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(userRef.current) });
      },
      { hangMeAfterFirst: true },
    );
    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Alice W" } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await screen.findByText("Display name updated.");
    await waitFor(() => expect(input.value).toBe("Alice W"));
  });

  it("failure: server 400 invalid_body -> inline alert, no success toast", async () => {
    renderWithDisplayNamePatch(() =>
      fakeResponse({ ok: false, status: 400, json: () => Promise.resolve({ error: { code: "invalid_body", message: "x" } }) }),
    );
    const input = await screen.findByLabelText("Display name");
    fireEvent.change(input, { target: { value: "Bob" } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The request was malformed.");
    expect(screen.queryByText("Display name updated.")).not.toBeInTheDocument();
  });

  it("length counts code points: 100 emoji (200 UTF-16 units) can be saved; 101 are blocked inline with no API call", async () => {
    const { patchBodies } = renderWithDisplayNamePatch((body) =>
      fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...PASSWORD_USER, displayName: body.displayName }) }),
    );
    const input = await screen.findByLabelText("Display name");
    fireEvent.change(input, { target: { value: "😀".repeat(101) } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Display names must be 1–100 characters.");
    expect(patchBodies).toHaveLength(0);
    fireEvent.change(input, { target: { value: "😀".repeat(100) } });
    fireEvent.click(screen.getByRole("button", { name: "Save display name" }));
    await waitFor(() => expect(patchBodies).toEqual([{ displayName: "😀".repeat(100) }]));
  });

  it("unchanged or all-blank value -> save button disabled", async () => {
    renderWithDisplayNamePatch(() => fakeResponse({ ok: true, status: 200 }));
    const input = await screen.findByLabelText("Display name");
    expect(screen.getByRole("button", { name: "Save display name" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Save display name" })).toBeDisabled();
  });
});
