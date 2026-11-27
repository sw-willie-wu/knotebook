/**
 * Same render-helper shape as SettingsAccountSection.test.tsx: real AppRoutes, stubbed fetch, retry: false, Toaster mounted.
 * The fetch stub throws on any unexpected URL so a component calling an unknown API fails the test; don't change it to return 404.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { OAUTH_APP_IDLE_DAYS, type ApiTokenDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { chooseOption } from "@/test/ui-select";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

const SSO_ONLY_USER: UserDto = {
  id: "u-sso",
  email: "sso@example.com",
  handle: "sso",
  displayName: "S",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: false,
  autoVersions: true,
  avatar: null,
};
const PASSWORD_USER: UserDto = { ...SSO_ONLY_USER, id: "u-pw", handle: "pw", hasPassword: true };

const PAT_ROW: ApiTokenDto = {
  id: "t-1",
  kind: "pat",
  name: "Script",
  agentLabel: "script",
  scope: "notes:read notes:write",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: null,
  expiresAt: null,
  clientId: null,
};
const OAUTH_ROW: ApiTokenDto = {
  id: "t-2",
  kind: "oauth",
  name: "Claude Code",
  agentLabel: "claude",
  scope: "notes:read notes:write",
  createdAt: "2026-09-01T00:00:00.000Z",
  lastUsedAt: "2026-09-02T00:00:00.000Z",
  expiresAt: "2026-09-03T00:00:00.000Z",
  clientId: "c-1",
};

function fakeResponse(init: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: init.json ?? (() => Promise.reject(new Error("no body"))),
  } as unknown as Response;
}

type Call = { url: string; method: string; body?: unknown };

function renderSettings(
  user: UserDto,
  tokens: ApiTokenDto[],
  extra?: (url: string, method: string, init?: RequestInit) => Response | null
) {
  const calls: Call[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ url, method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const custom = extra?.(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/groups") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(user) }));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes") return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
    if (url === "/api/auth/tokens" && method === "GET")
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens }) }));
    if (url === "/api/storage" && method === "GET")
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ usedBytes: 0, quotaBytes: 2147483648, planName: "Basic", byKind: { image: 0, audio: 0, video: 0, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 } }) }));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/authorization"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>
  );
  return { calls };
}

describe("ApiTokensSection", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("create form: clicking outside the dialog doesn't close it and the typed name remains; Esc still closes (the form guard only blocks outside clicks)", async () => {
    renderSettings(PASSWORD_USER, []);
    // First load of the account section lazy chunk in this file
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }),
    );
    const nameLabel = i18n.t("settings.account.apiTokensNameLabel");
    fireEvent.change(screen.getByLabelText(nameLabel), { target: { value: "Keep" } });
    await clickOutside();
    expect(screen.getByLabelText(nameLabel)).toHaveValue("Keep");
    fireEvent.keyDown(screen.getByLabelText(nameLabel), { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(nameLabel)).toBeNull());
  });

  it("plaintext screen: clicking outside the dialog and Esc both leave it open (the existing issued guard and dismissOnOutside still hold together)", async () => {
    const created = { ...PAT_ROW, id: "t-g", name: "G", token: "knb_" + "z".repeat(43) };
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "G" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    const valueLabel = i18n.t("settings.account.apiTokensValueLabel");
    await screen.findByLabelText(valueLabel);
    await clickOutside();
    expect(screen.getByLabelText(valueLabel)).toBeInTheDocument();
    fireEvent.keyDown(screen.getByLabelText(valueLabel), { key: "Escape" });
    await clickOutside();
    expect(screen.getByLabelText(valueLabel)).toBeInTheDocument();
  });

  it("empty state", async () => {
    renderSettings(PASSWORD_USER, []);
    expect(await screen.findByText(i18n.t("settings.account.apiTokensEmpty"))).toBeInTheDocument();
  });

  it("no empty state while loading (it appears only after an empty list is confirmed)", async () => {
    // The empty-state case's findByText already matches while loading, so a reversed condition (show when data is undefined) would still pass.
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "GET"
        ? fakeResponse({ ok: true, status: 200, json: () => new Promise(() => {}) })
        : null
    );
    await screen.findByRole("heading", { name: i18n.t("settings.account.apiTokensTitle") });
    expect(screen.queryByText(i18n.t("settings.account.apiTokensEmpty"))).not.toBeInTheDocument();
  });

  it("submitting with only a name -> scope defaults to read, expiresInDays defaults to null (PATs don't expire by default)", async () => {
    // The create-success case sets both selects explicitly, so it doesn't exercise these defaults.
    const created = { ...PAT_ROW, id: "t-d", name: "D", token: "knb_" + "y".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    // #239': both toggles default to off and both are in the "Access" group (#247: the create dialog uses toggles).
    const access = screen.getByRole("group", { name: i18n.t("settings.account.apiTokensScopeLabel") });
    expect(within(access).getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") })).not.toBeChecked();
    expect(within(access).getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") })).not.toBeChecked();
    expect(within(access).getByText(i18n.t("settings.account.apiTokensScopeReadFixed"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "D" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "D", scope: "notes:read", expiresInDays: null });
  });

  it("SSO-only accounts also see this section (it sits outside the hasPassword ternary)", async () => {
    renderSettings(SSO_ONLY_USER, []);
    expect(
      await screen.findByRole("heading", { name: i18n.t("settings.account.apiTokensTitle") })
    ).toBeInTheDocument();
  });

  it("list: oauth rows are labelled unverified and the name container has dir=ltr; pat rows have no side note", async () => {
    renderSettings(PASSWORD_USER, [PAT_ROW, OAUTH_ROW]);
    expect(await screen.findByText("Claude Code")).toBeInTheDocument();
    const oauthName = screen.getByText("Claude Code");
    expect(oauthName).toHaveAttribute("dir", "ltr");
    expect(oauthName).toHaveClass("[unicode-bidi:isolate]"); // both dir and the isolate style are required
    // The pat row's name also needs bidi isolation: names are user input, so oauth rows aren't the only ones holding external strings
    expect(screen.getByText("Script")).toHaveAttribute("dir", "ltr");
    expect(screen.getByText("Script")).toHaveClass("[unicode-bidi:isolate]");
    expect(screen.getAllByText(i18n.t("settings.account.apiTokensUnverifiedName"))).toHaveLength(1);
  });

  it("list: expired rows are labelled Expired (danger tone, #9 keeps the expired red), non-expiring rows are labelled No expiry", async () => {
    const expiredRow: ApiTokenDto = { ...PAT_ROW, id: "t-exp", name: "Old", expiresAt: "2020-01-01T00:00:00.000Z" };
    renderSettings(PASSWORD_USER, [PAT_ROW, expiredRow]);
    expect(await screen.findByText(i18n.t("settings.account.apiTokensExpired"))).toHaveClass("text-destructive");
    expect(screen.getByText(i18n.t("settings.account.apiTokensNoExpiry"))).not.toHaveClass("text-destructive");
  });

  describe("expiry column (#298)", () => {
    const DAY = 86_400_000;
    const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
    const ahead = (ms: number): string => new Date(Date.now() + ms).toISOString();
    const idle = (iso: string): string => new Date(Date.parse(iso) + OAUTH_APP_IDLE_DAYS * DAY).toLocaleDateString("en");
    const oauth = (over: Partial<ApiTokenDto>): ApiTokenDto => ({ ...OAUTH_ROW, name: "App", ...over });

    it("oauth row's access token expired but last used + N days not reached -> shows the date, not marked expired, not danger", async () => {
      const lastUsedAt = ago(1 * DAY);
      renderSettings(PASSWORD_USER, [oauth({ createdAt: ago(10 * DAY), lastUsedAt, expiresAt: ago(12 * 3_600_000) })]);
      const row = within(await screen.findByRole("row", { name: "App" }));
      const cell = row.getByText(idle(lastUsedAt));
      expect(cell).not.toHaveClass("text-destructive");
      expect(row.queryByText(i18n.t("settings.account.apiTokensExpired"))).toBeNull();
    });

    it("oauth row idle for more than N days -> expired (danger) even when expiresAt hasn't arrived", async () => {
      renderSettings(PASSWORD_USER, [
        oauth({ createdAt: ago((OAUTH_APP_IDLE_DAYS + 5) * DAY), lastUsedAt: ago((OAUTH_APP_IDLE_DAYS + 1) * DAY), expiresAt: ahead(12 * 3_600_000) }),
      ]);
      const row = within(await screen.findByRole("row", { name: "App" }));
      expect(row.getByText(i18n.t("settings.account.apiTokensExpired"))).toHaveClass("text-destructive");
    });

    it("oauth row never used -> counted N days from creation", async () => {
      const createdAt = ago(2 * DAY);
      renderSettings(PASSWORD_USER, [oauth({ createdAt, lastUsedAt: null, expiresAt: ahead(12 * 3_600_000) })]);
      const row = within(await screen.findByRole("row", { name: "App" }));
      expect(row.getByText(idle(createdAt))).toBeInTheDocument();
      expect(row.getByText(i18n.t("settings.account.apiTokensNeverUsed"))).toBeInTheDocument();
    });

    it("pat row still shows its own expiresAt, no idle formula", async () => {
      const expiresAt = ahead(10 * DAY);
      const lastUsedAt = ago(1 * DAY);
      renderSettings(PASSWORD_USER, [{ ...PAT_ROW, name: "Pat", createdAt: ago(3 * DAY), lastUsedAt, expiresAt }]);
      const row = within(await screen.findByRole("row", { name: "Pat" }));
      expect(row.getByText(new Date(expiresAt).toLocaleDateString("en"))).toBeInTheDocument();
      expect(row.queryByText(idle(lastUsedAt))).toBeNull();
    });

    it("the three footer notes below the table are, in order, footnote, oauthExpiryNote, cleanup hint", async () => {
      renderSettings(PASSWORD_USER, []);
      const foot = await screen.findByText(i18n.t("settings.authorization.tokens.footnote"));
      const note = foot.nextElementSibling;
      expect(note?.textContent).toBe(i18n.t("settings.authorization.tokens.oauthExpiryNote", { days: OAUTH_APP_IDLE_DAYS }));
      expect(note?.nextElementSibling?.textContent).toBe(i18n.t("settings.account.apiTokensCleanupHint"));
    });
  });

  it("table name API tokens; column names Name / Label / Permissions / Last used / Expires / Actions; row name = token name", async () => {
    renderSettings(PASSWORD_USER, [PAT_ROW, OAUTH_ROW]);
    const table = await screen.findByRole("table", { name: "API tokens" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Name",
      "Label",
      "Permissions",
      "Last used",
      "Expires",
      "Actions",
    ]);
    expect(within(table).getByRole("row", { name: "Script" })).toBeInTheDocument();
    expect(within(table).getByRole("row", { name: "Claude Code" })).toBeInTheDocument();
  });

  it("create success -> one-time plaintext shown in place and the list API is refetched; the submitted body has the right shape", async () => {
    const created = { ...PAT_ROW, id: "t-new", name: "New", token: "knb_" + "x".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") }));
    await chooseOption(
      screen.getByLabelText(i18n.t("settings.account.apiTokensExpiryLabel")),
      i18n.t("settings.account.apiTokensExpiryDays", { days: 90 }),
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));

    const field = await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    expect(field).toHaveValue(created.token);
    expect(screen.getByText(i18n.t("settings.account.apiTokensOnceWarning"))).toBeInTheDocument();
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "New", scope: "notes:read notes:write", expiresInDays: 90 });
    await waitFor(() => {
      expect(calls.filter(c => c.url === "/api/auth/tokens" && c.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("create: tick, close the dialog and reopen -> both boxes back to unticked (reset covers them, #239)", async () => {
    renderSettings(PASSWORD_USER, []);
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") }));
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") }));
    const nameLabel = i18n.t("settings.account.apiTokensNameLabel");
    fireEvent.keyDown(screen.getByLabelText(nameLabel), { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText(nameLabel)).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    expect(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") })).not.toBeChecked();
    expect(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") })).not.toBeChecked();
  });

  it("create: tick edit and move -> sends the third shape (#239)", async () => {
    const created = { ...PAT_ROW, id: "t-m", name: "M", token: "knb_" + "m".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "M" } });
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") }));
    fireEvent.click(screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") }));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "M", scope: "notes:read notes:write notes:move", expiresInDays: null });
  });

  it("create: tick edit -> tick move -> untick edit -> move is disabled and cleared, sends notes:read (#239)", async () => {
    const created = { ...PAT_ROW, id: "t-u", name: "U", token: "knb_" + "u".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "U" } });
    const edit = screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeEdit") });
    const move = screen.getByRole("switch",{ name: i18n.t("settings.account.apiTokensScopeMove") });
    fireEvent.click(edit);
    fireEvent.click(move);
    expect(move).toBeChecked();
    fireEvent.click(edit);
    expect(move).toBeDisabled();
    expect(move).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find(c => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "U", scope: "notes:read", expiresInDays: null });
  });

  it("create failure (409 token_limit) -> stays on the form and toasts the error, no plaintext field", async () => {
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { code: "token_limit", message: "limit" } }),
          })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByText(i18n.t("errors.token_limit"));
    expect(screen.queryByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel"))).toBeInTheDocument();
  });

  it("revoke: DELETE is sent only after confirming", async () => {
    const { calls } = renderSettings(PASSWORD_USER, [PAT_ROW], (url, method) =>
      url === `/api/auth/tokens/${PAT_ROW.id}` && method === "DELETE" ? fakeResponse({ ok: true, status: 204 }) : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensRevoke") }));
    // Wait for the confirm dialog to actually appear before asserting "DELETE not sent yet": a synchronous assertion proves nothing,
    // since even if the implementation sent on trigger click, fetch needs one microtask to reach calls.
    const confirm = await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensRevokeConfirm") });
    expect(calls.some(c => c.method === "DELETE")).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(calls.some(c => c.method === "DELETE" && c.url === `/api/auth/tokens/${PAT_ROW.id}`)).toBe(true)
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: i18n.t("settings.account.apiTokensRevokeConfirm") })).not.toBeInTheDocument()
    );
    await waitFor(() => {
      expect(calls.filter(c => c.url === "/api/auth/tokens" && c.method === "GET").length).toBeGreaterThan(1);
    });
  });

  it("Esc on the plaintext screen doesn't close it (a stray key press would waste the token); after Done closes, reopening shows a clean form", async () => {
    const created = { ...PAT_ROW, id: "t-new", name: "New", token: "knb_" + "z".repeat(43) };
    renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.change(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    const field = await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));

    fireEvent.keyDown(field, { key: "Escape" });
    expect(screen.getByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensDone") }));
    await waitFor(() =>
      expect(screen.queryByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).not.toBeInTheDocument()
    );
    fireEvent.click(screen.getByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    expect(screen.queryByLabelText(i18n.t("settings.account.apiTokensValueLabel"))).not.toBeInTheDocument();
    expect(screen.getByLabelText(i18n.t("settings.account.apiTokensNameLabel"))).toHaveValue("");
  });
});

describe("ApiTokensSection table and inline edit (#247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  const OVERRIDE: ApiTokenDto = {
    ...PAT_ROW, id: "t-o", name: "Claude Code laptop", agentLabel: "claude-laptop", scope: "notes:read notes:write notes:move",
  };
  const DERIVED: ApiTokenDto = { ...PAT_ROW, id: "t-d", name: "Claude Desktop", agentLabel: "claude", scope: "notes:read" };
  const WRITER: ApiTokenDto = { ...PAT_ROW, id: "t-w", name: "n8n bot", agentLabel: "n8n", scope: "notes:read notes:write" };
  const ROWS = [OVERRIDE, DERIVED, WRITER];

  const rowOf = (name: string) => screen.getByRole("row", { name });
  const pills = (row: HTMLElement) => Array.from(row.querySelectorAll("[data-pill]")).map((p) => p.textContent);

  function withPatch(respond: (id: string, body: Record<string, unknown>) => Response) {
    const bodies: Array<{ id: string; body: Record<string, unknown> }> = [];
    const r = renderSettings(PASSWORD_USER, ROWS, (url, method, init) => {
      const m = /^\/api\/auth\/tokens\/([^/]+)$/.exec(url);
      if (m && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push({ id: decodeURIComponent(m[1]!), body });
        return respond(m[1]!, body);
      }
      return null;
    });
    return { ...r, bodies };
  }
  const ok = (id: string, body: Record<string, unknown>) =>
    fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...ROWS.find((t) => t.id === id)!, ...body }) });

  it("permission pill, three combinations: read / read + edit / read + edit + move (move is a destructive light background)", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    expect(pills(rowOf("Claude Desktop"))).toEqual(["Read"]);
    expect(pills(rowOf("n8n bot"))).toEqual(["Read", "Edit"]);
    expect(pills(rowOf("Claude Code laptop"))).toEqual(["Read", "Edit", "Move to groups"]);
    expect(within(rowOf("Claude Code laptop")).getByText("Move to groups")).toHaveClass("text-destructive");
  });

  it("label is gray text when it equals deriveAgentLabel(name), normal text otherwise", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    expect(within(rowOf("Claude Desktop")).getByText("claude")).toHaveClass("text-muted-foreground");
    expect(within(rowOf("Claude Code laptop")).getByText("claude-laptop")).not.toHaveClass("text-muted-foreground");
  });

  it("pencil -> edit state: primary column kept, remaining columns merged into one form cell, the label is the only input (name can't be changed); save / cancel are icon buttons (no visible text) at the form's far right; other rows' pencils are softDisabled with a reason", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    // An editing row is still named by the token name: the primary column is nameColumn and aria-labelledby points at the primary column name that still exists (the name is lost only when the primary column isn't nameColumn).
    // Find the row via the one containing the input, then assert the name; don't find the row by name (otherwise a lost name fails at row lookup instead of at this assertion).
    const editingRow = screen.getAllByRole("row").find((candidate) => within(candidate).queryByRole("textbox") !== null);
    expect(editingRow).toHaveAccessibleName("Claude Desktop");
    const row = rowOf("Claude Desktop");
    expect(within(row).getAllByRole("cell")).toHaveLength(2);
    expect(within(row).getAllByRole("textbox")).toHaveLength(1);
    const input = within(row).getByRole("textbox", { name: "Label" });
    expect(input).toHaveValue("claude");
    expect(input).toHaveFocus(); // autoFocus belongs to TokenEditForm itself (SettingsTable doesn't manage focus, keeping the existing keyboard behavior)
    expect(within(row).getByText("1–32 letters, digits, . _ or -. Leave empty to go back to “claude”, derived from the name.")).toBeInTheDocument();
    const save = within(row).getByRole("button", { name: "Save" });
    const cancel = within(row).getByRole("button", { name: "Cancel" });
    expect(save.textContent).toBe("");
    expect(cancel.textContent).toBe("");
    expect(input.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const other = within(rowOf("n8n bot")).getByRole("button", { name: "Edit" });
    expect(other).toHaveAttribute("aria-disabled", "true");
    expect(other).toHaveAttribute("title", "Finish editing the other token first.");
    expect(other).not.toHaveAttribute("tabindex");
  });

  it("locked pencil: focusable; pressing it (keyboard Enter / Space also trigger click) doesn't enter edit and doesn't steal the row being edited", async () => {
    withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    const other = within(rowOf("n8n bot")).getByRole("button", { name: "Edit" });
    other.focus();
    expect(other).toHaveFocus();
    fireEvent.click(other);
    expect(within(rowOf("n8n bot")).queryByRole("textbox")).toBeNull();
    expect(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" })).toBeInTheDocument();
  });

  it("cancel sends no request, returns to display state", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" }), { target: { value: "x" } });
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Cancel" }));
    expect(within(rowOf("Claude Desktop")).queryByRole("textbox")).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it("changing only the label -> body has only agentLabel", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" }), { target: { value: "desk" } });
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-d", body: { agentLabel: "desk" } }]));
    await waitFor(() => expect(within(rowOf("Claude Desktop")).queryByRole("textbox")).toBeNull());
  });

  it("the row being edited disappears after a refetch (revoked elsewhere) -> no longer blocks other rows' pencils", async () => {
    let rows: ApiTokenDto[] = ROWS;
    renderSettings(PASSWORD_USER, [], (url, method) => {
      if (url === "/api/auth/tokens" && method === "GET")
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ tokens: rows.map(r => ({ ...r })) }) });
      if (url === "/api/auth/tokens/t-w" && method === "DELETE") return fakeResponse({ ok: true, status: 204 });
      return null;
    });
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    expect(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" })).toHaveAttribute("aria-disabled", "true");
    // Revoking another row triggers a refetch; by the time it returns, the "Claude Desktop" row being edited has also been revoked elsewhere.
    rows = [OVERRIDE];
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(screen.queryByText("Claude Desktop")).toBeNull());
    expect(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" })).not.toHaveAttribute("aria-disabled");
  });

  it("changing only permissions -> body has only scope (the stored form of scopeFromChecks)", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("switch", { name: "Create and edit notes" }));
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-d", body: { scope: "notes:read notes:write" } }]));
  });

  it("clearing the label (it was an override) -> sends agentLabel: null; Enter = save", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Code laptop");
    fireEvent.click(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" }));
    const input = within(rowOf("Claude Code laptop")).getByRole("textbox", { name: "Label" });
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(bodies).toEqual([{ id: "t-o", body: { agentLabel: null } }]));
  });

  it("while the save request is in flight: input and save / cancel buttons are natively disabled (temporary unavailability); after the response it returns to display state", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { bodies } = withPatch((id, body) =>
      fakeResponse({ ok: true, status: 200, json: () => gate.then(() => ({ ...ROWS.find((t) => t.id === id)!, ...body })) })
    );
    await screen.findByText("Claude Desktop");
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" }), { target: { value: "desk" } });
    fireEvent.click(within(rowOf("Claude Desktop")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(rowOf("Claude Desktop")).getByRole("button", { name: "Save" })).toBeDisabled());
    expect(within(rowOf("Claude Desktop")).getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(within(rowOf("Claude Desktop")).getByRole("textbox", { name: "Label" })).toBeDisabled();
    expect(bodies).toEqual([{ id: "t-d", body: { agentLabel: "desk" } }]);
    release();
    await waitFor(() => expect(within(rowOf("Claude Desktop")).queryByRole("textbox")).toBeNull());
  });

  it("pressing save with nothing changed -> no request, back to display state", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(within(rowOf("n8n bot")).queryByRole("textbox")).toBeNull());
    expect(bodies).toHaveLength(0);
  });

  it("invalid label format -> red text in the row, no request", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" }), { target: { value: "has space" } });
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    expect(await within(rowOf("n8n bot")).findByRole("alert")).toHaveTextContent("A label can only use 1–32 letters, digits, . _ or -.");
    expect(bodies).toHaveLength(0);
  });

  it("turning off \"Edit\" -> \"Move\" is disabled and cleared to off; saving sends notes:read", async () => {
    const { bodies } = withPatch(ok);
    await screen.findByText("Claude Code laptop");
    fireEvent.click(within(rowOf("Claude Code laptop")).getByRole("button", { name: "Edit" }));
    const row = within(rowOf("Claude Code laptop"));
    expect(row.getByRole("switch", { name: "Move to groups (can't be undone)" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row.getByRole("switch", { name: "Create and edit notes" }));
    const move = row.getByRole("switch", { name: "Move to groups (can't be undone)" });
    expect(move).toHaveAttribute("aria-checked", "false");
    expect(move).toBeDisabled();
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-o", body: { scope: "notes:read" } }]));
  });

  it("inline edit: the full move hint shows while \"Move\" is on, absent when off", async () => {
    withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    const hint = i18n.t("settings.account.apiTokensScopeMoveHint");
    expect(within(rowOf("n8n bot")).queryByText(hint)).toBeNull();
    fireEvent.click(within(rowOf("n8n bot")).getByRole("switch", { name: "Move to groups (can't be undone)" }));
    expect(within(rowOf("n8n bot")).getByText(hint)).toBeInTheDocument();
  });

  it("PATCH failure -> stays in edit state, alert in the row", async () => {
    withPatch(() => fakeResponse({ ok: false, status: 400, json: () => Promise.resolve({ error: { code: "invalid_body", message: "x" } }) }));
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.change(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" }), { target: { value: "bot2" } });
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    expect(await within(rowOf("n8n bot")).findByRole("alert")).toHaveTextContent("The request was malformed.");
    expect(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" })).toBeInTheDocument();
  });

  it("no Esc cancel: Esc in the label input closes the whole settings panel (Radix handles Escape in the capture phase)", async () => {
    withPatch(ok);
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    fireEvent.keyDown(within(rowOf("n8n bot")).getByRole("textbox", { name: "Label" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("revoke is the Revoke button at the row's end, confirm dialog unchanged (appearance is covered by RowIconButton's own test)", async () => {
    withPatch(ok);
    await screen.findByText("n8n bot");
    const trash = within(rowOf("n8n bot")).getByRole("button", { name: "Revoke" });
    expect(trash.textContent).toBe("");
    fireEvent.click(trash);
    expect(await screen.findByRole("dialog", { name: "Revoke this token?" })).toBeInTheDocument();
  });

  it("create dialog: both toggles default to off; the full move hint shows while \"Move\" is on, absent when off", async () => {
    withPatch(ok);
    fireEvent.click(await screen.findByRole("button", { name: "Create API token" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Create API token" }));
    const edit = dialog.getByRole("switch", { name: "Create and edit notes" });
    const move = dialog.getByRole("switch", { name: "Move to groups (can't be undone)" });
    expect(edit).toHaveAttribute("aria-checked", "false");
    expect(move).toHaveAttribute("aria-checked", "false");
    const hint = i18n.t("settings.account.apiTokensScopeMoveHint");
    expect(dialog.getByText(i18n.t("settings.account.apiTokensScopeMoveDesc"))).toBeInTheDocument();
    expect(dialog.getByText(i18n.t("settings.account.apiTokensScopeDeleteDesc"))).toBeInTheDocument();
    expect(dialog.queryByText(hint)).toBeNull();
    fireEvent.click(edit);
    fireEvent.click(move);
    expect(dialog.getByText(hint)).toBeInTheDocument();
    fireEvent.click(move);
    expect(dialog.queryByText(hint)).toBeNull();
  });
});

describe("ApiTokensSection #181 delete toggle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  const R = "notes:read";
  const RW = "notes:read notes:write";
  const RWD = "notes:read notes:write notes:delete";
  const RWMD = "notes:read notes:write notes:move notes:delete";
  const EDIT = "Create and edit notes";
  const DELETE = "Move to trash (can be restored)";
  const DELETE_HINT_EN =
    "Can't delete notes permanently, but notes left in the trash can still be deleted permanently later, by the site's trash setting or by someone in the web app. Requires \"Create and edit notes\".";
  const DELETE_HINT_ZH =
    "不能永久刪除筆記；但留在垃圾桶的筆記之後仍可能被永久刪除（依站台的垃圾桶設定，或有人在網頁上刪除）。需同時勾選「建立與修改筆記」。";
  const ALL: ApiTokenDto = { ...PAT_ROW, id: "t-all", name: "All bot", agentLabel: "all-bot", scope: RWMD };
  const DEL: ApiTokenDto = { ...PAT_ROW, id: "t-del", name: "Trash bot", agentLabel: "trash-bot", scope: RWD };
  const WRITER: ApiTokenDto = { ...PAT_ROW, id: "t-w", name: "n8n bot", agentLabel: "n8n", scope: RW };
  const ROWS = [ALL, DEL, WRITER];
  const rowOf = (name: string) => screen.getByRole("row", { name });
  const pills = (row: HTMLElement) => Array.from(row.querySelectorAll("[data-pill]")).map((p) => p.textContent);

  function withPatch() {
    const bodies: Array<{ id: string; body: Record<string, unknown> }> = [];
    renderSettings(PASSWORD_USER, ROWS, (url, method, init) => {
      const m = /^\/api\/auth\/tokens\/([^/]+)$/.exec(url);
      if (m && method === "PATCH") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push({ id: decodeURIComponent(m[1]!), body });
        return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...ROWS.find((t) => t.id === m[1])!, ...body }) });
      }
      return null;
    });
    return bodies;
  }

  it("create dialog: \"Delete\" is off by default and disabled while edit is off; turning on edit + delete submits scope RWD", async () => {
    const created = { ...PAT_ROW, id: "t-n", name: "D", token: "knb_" + "d".repeat(43) };
    const { calls } = renderSettings(PASSWORD_USER, [], (url, method) =>
      url === "/api/auth/tokens" && method === "POST"
        ? fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(created) })
        : null
    );
    fireEvent.click(await screen.findByRole("button", { name: "Create API token" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Create API token" }));
    fireEvent.change(dialog.getByLabelText(i18n.t("settings.account.apiTokensNameLabel")), { target: { value: "D" } });
    const edit = dialog.getByRole("switch", { name: EDIT });
    const del = dialog.getByRole("switch", { name: DELETE });
    expect(del).toHaveAttribute("aria-checked", "false");
    expect(del).toBeDisabled();
    fireEvent.click(edit);
    expect(del).toBeEnabled();
    fireEvent.click(del);
    expect(del).toHaveAttribute("aria-checked", "true");
    fireEvent.click(dialog.getByRole("button", { name: i18n.t("settings.account.apiTokensSubmit") }));
    await screen.findByLabelText(i18n.t("settings.account.apiTokensValueLabel"));
    const post = calls.find((c) => c.url === "/api/auth/tokens" && c.method === "POST");
    expect(post?.body).toEqual({ name: "D", scope: RWD, expiresInDays: null });
  });

  it("create dialog: when \"Delete\" is on the description shows and is attached via aria-describedby, absent when off", async () => {
    renderSettings(PASSWORD_USER, []);
    fireEvent.click(await screen.findByRole("button", { name: "Create API token" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Create API token" }));
    const hint = DELETE_HINT_EN;
    const del = dialog.getByRole("switch", { name: DELETE });
    fireEvent.click(dialog.getByRole("switch", { name: EDIT }));
    expect(dialog.queryByText(hint)).toBeNull();
    fireEvent.click(del);
    expect(dialog.getByText(hint)).toBeInTheDocument();
    expect(del).toHaveAccessibleDescription(hint);
    fireEvent.click(del);
    expect(dialog.queryByText(hint)).toBeNull();
  });

  it("create dialog (zh-TW): when \"Delete\" is on its description ends with the sentence requiring \"Create and edit notes\" to be ticked, and is the switch's accessible description", async () => {
    await i18n.changeLanguage("zh-TW");
    renderSettings(PASSWORD_USER, []);
    fireEvent.click(await screen.findByRole("button", { name: i18n.t("settings.account.apiTokensCreate") }));
    const dialog = within(await screen.findByRole("dialog", { name: i18n.t("settings.account.apiTokensCreate") }));
    fireEvent.click(dialog.getByRole("switch", { name: "建立與修改筆記" }));
    const del = dialog.getByRole("switch", { name: "移到垃圾桶（可還原）" });
    fireEvent.click(del);
    expect(dialog.getByText(DELETE_HINT_ZH)).toBeInTheDocument();
    expect(del).toHaveAccessibleDescription(DELETE_HINT_ZH);
  });

  it("pill: RWMD reads Read, Edit, Move to groups, Move to trash in order (Move to trash has the default tone); RWD has no Move to groups", async () => {
    withPatch();
    await screen.findByText("All bot");
    expect(pills(rowOf("All bot"))).toEqual(["Read", "Edit", "Move to groups", "Move to trash"]);
    expect(pills(rowOf("Trash bot"))).toEqual(["Read", "Edit", "Move to trash"]);
    expect(pills(rowOf("n8n bot"))).toEqual(["Read", "Edit"]);
    expect(within(rowOf("Trash bot")).getByText("Move to trash")).not.toHaveClass("text-destructive");
  });

  it("inline edit: turning on \"Delete\" -> PATCH { scope: RWD }", async () => {
    const bodies = withPatch();
    await screen.findByText("n8n bot");
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Edit" }));
    const del = within(rowOf("n8n bot")).getByRole("switch", { name: DELETE });
    expect(del).toHaveAttribute("aria-checked", "false");
    fireEvent.click(del);
    fireEvent.click(within(rowOf("n8n bot")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-w", body: { scope: RWD } }]));
  });

  it("inline edit: turning off \"Edit\" -> \"Delete\" is disabled and cleared to off; saving sends notes:read", async () => {
    const bodies = withPatch();
    await screen.findByText("Trash bot");
    fireEvent.click(within(rowOf("Trash bot")).getByRole("button", { name: "Edit" }));
    const row = within(rowOf("Trash bot"));
    expect(row.getByRole("switch", { name: DELETE })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(row.getByRole("switch", { name: EDIT }));
    const del = row.getByRole("switch", { name: DELETE });
    expect(del).toHaveAttribute("aria-checked", "false");
    expect(del).toBeDisabled();
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "t-del", body: { scope: R } }]));
  });
});
