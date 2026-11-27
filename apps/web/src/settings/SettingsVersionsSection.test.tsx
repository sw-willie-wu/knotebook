import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto, VersionSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// Site version settings (since #247 embedded in the `/admin/storage` plans page, after the plan table): runs through the real AppRoutes (site admin modal + the AdminSections lazy chunk),
// shaped like SettingsStorageSection.test.tsx.

function res(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const AUTH_CONFIG = { providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true };

interface Call {
  method: string;
  url: string;
  body: unknown;
}

function stubAdmin({ settings, patchStatus }: { settings: VersionSettingsDto; patchStatus?: number }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
      calls.push({ method, url, body });
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(res(200, ADMIN));
      if (url === "/api/auth/config" && method === "GET") return Promise.resolve(res(200, AUTH_CONFIG));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(res(200, []));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(res(200, []));
      if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(res(200, { plans: [], defaults: { userPlanId: "", groupPlanId: "" } }));
      if (url === "/api/admin/versions/settings" && method === "GET") return Promise.resolve(res(200, settings));
      // The trash settings on the same page (#181): without this it would enter an error state and add a role=alert
      if (url === "/api/admin/trash/settings" && method === "GET") return Promise.resolve(res(200, { retentionDays: 7 }));
      if (url === "/api/admin/notifications/settings" && method === "GET") return Promise.resolve(res(200, { retentionDays: 30 }));
      if (url === "/api/admin/versions/settings" && method === "PATCH") {
        if (patchStatus !== undefined && patchStatus >= 400) {
          return Promise.resolve(res(patchStatus, { error: { code: "invalid_body", message: "x" } }));
        }
        return Promise.resolve(res(patchStatus ?? 200, { ...settings, ...(body as Partial<VersionSettingsDto>) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return calls;
}

function renderAt(path: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const renderResult = render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { ...renderResult, queryClient };
}

const SETTINGS: VersionSettingsDto = { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 7 };
/** The trash settings on the same page also have a Save, so scope to the version retention region. */
const versionsSave = () => within(screen.getByRole("region", { name: "Keeping automatic versions" })).getByRole("button", { name: "Save" });

describe("site version settings (inside /admin/storage, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the header belongs only to the plans page (h1 Storage plans); version settings are an h2 \"Version history\" block after the plan table; no \"How notes keep their versions on this site.\"; the description mentions that versions don't count toward the quota", async () => {
    stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    await screen.findByRole("switch", { name: "Automatic versions" });
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual(["Storage plans"]);
    const versions = screen.getByRole("heading", { level: 2, name: "Version history" });
    expect(versions.compareDocumentPosition(screen.getByRole("heading", { level: 1, name: "Storage plans" })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(screen.queryByText("How notes keep their versions on this site.")).not.toBeInTheDocument();
    expect(screen.getByText(/Versions and note text don't count toward the storage limit/)).toBeInTheDocument();
  });

  it("load: master switch, wait and the two day counts follow the GET; the wait description carries the server value", async () => {
    stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByLabelText("Wait before saving automatically (minutes)")).toHaveValue("7");
    expect(screen.getByText("After editing, if there is no new change for 7 minutes, a version is saved automatically.")).toBeInTheDocument();
    expect(screen.getByLabelText("Keep all for (days)")).toHaveValue("7");
    expect(screen.getByLabelText("One a day until (days)")).toHaveValue("30");
    expect(screen.getByText(/All automatic versions from the last 7 days are kept; up to 30 days, one a day/)).toBeInTheDocument();
  });

  it("master switch off -> switch aria-checked=false (distinguishes from the load case)", async () => {
    stubAdmin({ settings: { ...SETTINGS, autoVersionsEnabled: false } });
    renderAt("/admin/storage");
    expect(await screen.findByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false");
  });

  it("toggling the master switch -> PATCH carries only { autoVersionsEnabled:false } and invalidates ['auth-config']", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    const { queryClient } = renderAt("/admin/storage");
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    // No component on /admin/storage subscribes to ['auth-config'], so invalidate only marks it stale and sends no request -
    // can't wait for GET /api/auth/config. Seed a cache entry first, then assert it was marked invalidated.
    queryClient.setQueryData(["auth-config"], AUTH_CONFIG);
    expect(queryClient.getQueryState(["auth-config"])?.isInvalidated).toBe(false);
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ autoVersionsEnabled: false }));
    await waitFor(() => expect(queryClient.getQueryState(["auth-config"])?.isInvalidated).toBe(true));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false"));
  });

  it("invalid day counts (first > second, non-integer, 0, 3651, empty) -> no request, inline error (each group shows its own)", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    const keepAll = await screen.findByLabelText("Keep all for (days)");
    const daily = screen.getByLabelText("One a day until (days)");
    for (const [a, b] of [["40", "30"], ["1.5", "30"], ["0", "30"], ["7", "3651"], ["", "30"]]) {
      fireEvent.change(keepAll, { target: { value: a } });
      fireEvent.change(daily, { target: { value: b } });
      // Changing a field clears the previous group's error - so the alert below only appears when this group is submitted
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(versionsSave());
      expect(await screen.findByRole("alert")).toHaveTextContent("Use whole numbers with 1 ≤ first ≤ second ≤ 3650.");
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("valid day counts (F = D also allowed) -> PATCH { keepAllDays, dailyUntilDays }, toast", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Keep all for (days)"), { target: { value: "14" } });
    fireEvent.change(screen.getByLabelText("One a day until (days)"), { target: { value: "14" } });
    fireEvent.click(versionsSave());
    expect(await screen.findByText("Version settings saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ autoWaitMinutes: 7, keepAllDays: 14, dailyUntilDays: 14 });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("server returns 400 invalid_body -> inline errors.invalid_body", async () => {
    stubAdmin({ settings: SETTINGS, patchStatus: 400 });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Keep all for (days)"), { target: { value: "8" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(versionsSave());
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.invalid_body"));
  });

  it("#272 invalid wait (0, 61, abc, 1.5, empty) -> no request, inline waitInvalid (each group shows its own)", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    const wait = await screen.findByLabelText("Wait before saving automatically (minutes)");
    for (const value of ["0", "61", "abc", "1.5", ""]) {
      fireEvent.change(wait, { target: { value } });
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(versionsSave());
      expect(await screen.findByRole("alert")).toHaveTextContent("Use a whole number of minutes from 1 to 60.");
    }
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("#272 wait and day counts both invalid -> only the wait sentence shows (wait is validated first)", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Wait before saving automatically (minutes)"), { target: { value: "0" } });
    fireEvent.change(screen.getByLabelText("Keep all for (days)"), { target: { value: "40" } });
    fireEvent.click(versionsSave());
    expect(await screen.findByRole("alert")).toHaveTextContent("Use a whole number of minutes from 1 to 60.");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Use whole numbers with 1 ≤ first ≤ second ≤ 3650.")).not.toBeInTheDocument();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("#272 valid wait -> PATCH carries { autoWaitMinutes, keepAllDays, dailyUntilDays }, toast", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    fireEvent.change(await screen.findByLabelText("Wait before saving automatically (minutes)"), { target: { value: "12" } });
    fireEvent.click(versionsSave());
    expect(await screen.findByText("Version settings saved")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ autoWaitMinutes: 12, keepAllDays: 7, dailyUntilDays: 30 });
  });

  it("leading / trailing whitespace and leading zeros are accepted (\" 9 \" -> 9, \"05\" -> 5); a full-width digit -> waitInvalid, not sent", async () => {
    const calls = stubAdmin({ settings: SETTINGS });
    renderAt("/admin/storage");
    const wait = await screen.findByLabelText("Wait before saving automatically (minutes)");
    fireEvent.change(wait, { target: { value: "５" } });
    fireEvent.click(versionsSave());
    expect(await screen.findByRole("alert")).toHaveTextContent("Use a whole number of minutes from 1 to 60.");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    fireEvent.change(wait, { target: { value: " 9 " } });
    fireEvent.click(versionsSave());
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([{ autoWaitMinutes: 9, keepAllDays: 7, dailyUntilDays: 30 }]));
    fireEvent.change(screen.getByLabelText("Wait before saving automatically (minutes)"), { target: { value: "05" } });
    fireEvent.click(versionsSave());
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH").map((c) => (c.body as { autoWaitMinutes: number }).autoWaitMinutes)).toEqual([9, 5]));
  });
});
