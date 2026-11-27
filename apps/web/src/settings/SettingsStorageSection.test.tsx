import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { StoragePlanDto, StoragePlansResponse, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { chooseOption, selectedValue } from "@/test/ui-select";

// /admin/storage. Runs through the real AppRoutes (site admin modal + the AdminSections lazy chunk).

function res(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}
const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null };
const T = "2026-01-01T00:00:00.000Z";
const plan = (p: Partial<StoragePlanDto> & Pick<StoragePlanDto, "id" | "name">): StoragePlanDto => ({
  quotaBytes: null, userCount: 0, groupCount: 0, overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false, createdAt: T, updatedAt: T, ...p,
});
const BASIC = plan({ id: "11111111-1111-4111-8111-111111111111", name: "Basic", quotaBytes: 2147483648, userCount: 3, groupCount: 1, isDefaultForUsers: true });
const BIG = plan({ id: "22222222-2222-4222-8222-222222222222", name: "Big", quotaBytes: null, userCount: 1 });
const SPARE = plan({ id: "33333333-3333-4333-8333-333333333333", name: "Spare", quotaBytes: 1048576 });
const TIGHT = plan({ id: "44444444-4444-4444-8444-444444444444", name: "Tight", quotaBytes: 1004, userCount: 2, overQuotaCount: 1 }); // 1004 -> "0.000957 MB" -> 1003: the conversion doesn't round-trip
/** Undeletable only because it is the default (nobody uses it) - the delete button's second condition needs its own case. */
const STARTER = plan({ id: "66666666-6666-4666-8666-666666666666", name: "Starter", quotaBytes: 1048576, isDefaultForGroups: true });
const LIST: StoragePlansResponse = { plans: [BASIC, BIG, SPARE, STARTER, TIGHT], defaults: { userPlanId: BASIC.id, groupPlanId: STARTER.id } };

type Handler = (url: string, method: string, init?: RequestInit) => Response | null;
function renderStorage(extra: Handler = () => null, client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(res(200, ADMIN));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/groups" || url === "/api/notes") return Promise.resolve(res(200, []));
    if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(res(200, LIST));
    if (url === "/api/admin/versions/settings" && method === "GET") return Promise.resolve(res(200, { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 }));
    if (url === "/api/admin/trash/settings" && method === "GET") return Promise.resolve(res(200, { retentionDays: 7 }));
    if (url === "/api/admin/notifications/settings" && method === "GET") return Promise.resolve(res(200, { retentionDays: 30 }));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={client}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/storage"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetchMock;
}
const callsTo = (m: ReturnType<typeof vi.fn>, method: string, url: string) =>
  m.mock.calls.filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method).map(([, i]) => i as RequestInit);
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body));
const row = (name: string) => screen.getByRole("row", { name });

describe("/admin/storage (storage plans page)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trash settings come after version retention; each of the two regions has exactly one Save", async () => {
    renderStorage();
    const trash = await screen.findByRole("region", { name: "Trash" });
    await within(trash).findByRole("switch", { name: "Delete automatically" });
    const notifications = await screen.findByRole("region", { name: "Notifications" });
    await within(notifications).findByRole("switch", { name: "Delete old notifications automatically" });
    expect(trash.compareDocumentPosition(notifications) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(notifications).getAllByRole("button", { name: "Save" })).toHaveLength(1);
    const versions = await screen.findByRole("region", { name: "Keeping automatic versions" });
    expect(versions.compareDocumentPosition(trash) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(trash).getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(within(versions).getAllByRole("button", { name: "Save" })).toHaveLength(1);
    expect(within(trash).getByRole("switch", { name: "Delete automatically" })).toHaveAttribute("aria-checked", "true");
  });

  it("the notifications switch and days field each have an accessible name no other control on the page shares", async () => {
    renderStorage();
    const notifications = await screen.findByRole("region", { name: "Notifications" });
    await within(notifications).findByRole("switch", { name: "Delete old notifications automatically" });
    expect(screen.getAllByRole("switch", { name: "Delete old notifications automatically" })).toHaveLength(1);
    expect(screen.getAllByRole("switch", { name: "Delete automatically" })).toHaveLength(1);
    expect(screen.getAllByLabelText("Days to keep notifications")).toHaveLength(1);
    expect(screen.getAllByLabelText("Days to keep")).toHaveLength(1);
  });

  it("plan table: limit (formatBytes / No limit), user count, group count, over-limit count, default marker; delete buttons are disabled by two conditions plus visible reasons", async () => {
    renderStorage();
    expect(await screen.findByRole("heading", { level: 1, name: "Storage plans" })).toBeInTheDocument();
    await waitFor(() => expect(row("Basic")).toBeInTheDocument());
    expect(within(row("Basic")).getByText("2 GB")).toBeInTheDocument();
    expect(within(row("Basic")).getByText("Default for new users")).toBeInTheDocument();
    expect(within(row("Starter")).getByText("Default for new groups")).toBeInTheDocument();
    expect(within(row("Starter")).getByText("1 MB")).toBeInTheDocument();
    expect(within(row("Big")).getByText("No limit")).toBeInTheDocument();
    expect(within(row("Tight")).getByText("1004 B")).toBeInTheDocument();
    for (const text of ["2", "0", "1"]) expect(within(row("Tight")).getByRole("cell", { name: text })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Basic" })).toHaveAttribute("aria-disabled", "true"); // default (also in use)
    expect(screen.getByRole("button", { name: "Delete Tight" })).toHaveAttribute("aria-disabled", "true"); // only because in use
    expect(screen.getByRole("button", { name: "Delete Big" })).toHaveAttribute("aria-disabled", "true"); // only because in use (1 user)
    expect(screen.getByRole("button", { name: "Delete Starter" })).toHaveAttribute("aria-disabled", "true"); // only because it's the default (nobody uses it)
    expect(screen.getByRole("button", { name: "Delete Spare" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("A plan that is a default, or that any user or group is on, can't be deleted.")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Storage plans" })).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Name",
      "Limit",
      "Users",
      "Groups",
      "Spaces over limit",
      "Actions",
    ]);
    // An over-limit space count > 0 uses the danger tone (#7 keeps red); 0 isn't red (the Basic row's "0" can be found unambiguously: users 3, groups 1)
    expect(within(row("Tight")).getByText("1")).toHaveClass("text-destructive");
    expect(within(row("Basic")).getByText("0")).not.toHaveClass("text-destructive");
  });

  it("plan row Edit / Delete are icon buttons (no visible text, with title); the title of an undeletable one is the reason; \"New plan\" isn't a solid button", async () => {
    renderStorage();
    const edit = await screen.findByRole("button", { name: "Edit Basic" });
    const del = screen.getByRole("button", { name: "Delete Basic" });
    expect(edit.textContent).toBe("");
    expect(edit).toHaveAttribute("title", "Edit Basic");
    expect(del.textContent).toBe("");
    expect(del).toHaveAttribute("title", "A plan that is a default, or that any user or group is on, can't be deleted.");
    expect(screen.getByRole("button", { name: "New plan" }).className).not.toMatch(/(^|\s)bg-(primary|brand|brand-deep)(\s|$)/);
  });

  it("add: name trimmed, 1.5 GB -> POST {name, quotaBytes: 1610612736}; on success the dialog closes and the list is refetched", async () => {
    const fetchMock = renderStorage((url, method) => (url === "/api/admin/storage-plans" && method === "POST" ? res(201, plan({ id: "55555555-5555-4555-8555-555555555555", name: "Team" })) : null));
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const dialog = await screen.findByRole("dialog", { name: "New storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "  Team  " } });
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1.5" } });
    await chooseOption(within(dialog).getByLabelText("Unit"), "GB");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(callsTo(fetchMock, "POST", "/api/admin/storage-plans")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "POST", "/api/admin/storage-plans")[0])).toEqual({ name: "Team", quotaBytes: 1610612736 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New storage plan" })).not.toBeInTheDocument());
    await waitFor(() => expect(callsTo(fetchMock, "GET", "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
  });

  it("add \"no limit\": the number field is disabled, POST quotaBytes: null", async () => {
    const fetchMock = renderStorage((url, method) => (url === "/api/admin/storage-plans" && method === "POST" ? res(201, plan({ id: "55555555-5555-4555-8555-555555555555", name: "Free" })) : null));
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const dialog = await screen.findByRole("dialog", { name: "New storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "Free" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "No limit" }));
    expect(within(dialog).getByLabelText("Limit", { exact: true })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(callsTo(fetchMock, "POST", "/api/admin/storage-plans")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "POST", "/api/admin/storage-plans")[0])).toEqual({ name: "Free", quotaBytes: null });
  });

  it("front-end pre-check: a 41-char name or a limit of 1e3 -> inline error, no request", async () => {
    const fetchMock = renderStorage();
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const dialog = await screen.findByRole("dialog", { name: "New storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "x".repeat(41) } });
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Plan names must be 1–40 characters.");
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "OK" } });
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1e3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Enter a size from 0 up to 1048576 GB."));
    expect(callsTo(fetchMock, "POST", "/api/admin/storage-plans")).toHaveLength(0);
  });

  it("409 storage_plan_name_taken -> inline \"A plan with this name already exists\"; the server's invalid_name -> the plan-specific text (not the group one, 1-80)", async () => {
    let n = 0;
    renderStorage((url, method) => {
      if (url !== "/api/admin/storage-plans" || method !== "POST") return null;
      n++;
      return n === 1
        ? res(409, { error: { code: "storage_plan_name_taken", message: "x" } })
        : res(400, { error: { code: "invalid_name", message: "x" } });
    });
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const dialog = await screen.findByRole("dialog", { name: "New storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "basic" } });
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("A plan with this name already exists");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("Plan names must be 1–40 characters."));
  });

  it("edit Basic: initial 2 GB; lowering to 1 GB -> the lowering note appears; PATCH sends only quotaBytes", async () => {
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${BASIC.id}` && method === "PATCH" ? res(200, BASIC) : null));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Basic" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    expect(within(dialog).getByLabelText("Name", { exact: true })).toHaveValue("Basic");
    expect(within(dialog).getByLabelText("Limit", { exact: true })).toHaveValue("2");
    expect(selectedValue(within(dialog).getByLabelText("Unit"))).toBe("GB");
    expect(within(dialog).queryByText(/Lowering the limit doesn't delete any files/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "3" } });
    expect(within(dialog).queryByText(/Lowering the limit doesn't delete any files/)).not.toBeInTheDocument(); // raising doesn't show it
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1" } });
    expect(within(dialog).getByText(/Lowering the limit doesn't delete any files/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${BASIC.id}`)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${BASIC.id}`)[0])).toEqual({ quotaBytes: 1073741824 });
  });

  it("editing the unlimited Big to a finite value (5 GB) -> the lowering note appears", async () => {
    renderStorage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Big" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    expect(within(dialog).queryByText(/Lowering the limit doesn't delete any files/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "No limit" }));
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "5" } });
    expect(within(dialog).getByText(/Lowering the limit doesn't delete any files/)).toBeInTheDocument();
  });

  it("editing Tight and pressing Save with nothing changed -> no request, closes directly", async () => {
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${TIGHT.id}` && method === "PATCH" ? res(200, TIGHT) : null));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Tight" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit storage plan" })).not.toBeInTheDocument());
    expect(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${TIGHT.id}`)).toHaveLength(0);
  });

  it("editing Tight (1004 bytes) changing only the name -> PATCH sends only name, not the converted-back quotaBytes", async () => {
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${TIGHT.id}` && method === "PATCH" ? res(200, TIGHT) : null));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Tight" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "Tight 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${TIGHT.id}`)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${TIGHT.id}`)[0])).toEqual({ name: "Tight 2" });
  });

  it("delete Spare: confirm dialog -> DELETE; assigned by someone else concurrently -> 409 storage_plan_in_use shown as a toast", async () => {
    const fetchMock = renderStorage((url, method) =>
      url === `/api/admin/storage-plans/${SPARE.id}` && method === "DELETE" ? res(409, { error: { code: "storage_plan_in_use", message: "x" } }) : null);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Spare" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/admin/storage-plans/${SPARE.id}`)).toHaveLength(1));
    expect(await screen.findByText("This plan is assigned to users or groups. Move them to another plan first.")).toBeInTheDocument();
  });

  it("delete success (204): all four keys are invalidated (plans, users, groups, own usage), the list is refetched", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const spy = vi.spyOn(client, "invalidateQueries");
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${SPARE.id}` && method === "DELETE" ? res(204) : null), client);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Spare" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/admin/storage-plans/${SPARE.id}`)).toHaveLength(1));
    await waitFor(() => expect(callsTo(fetchMock, "GET", "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
    const keys = spy.mock.calls.map(([f]) => JSON.stringify((f as { queryKey: unknown }).queryKey));
    for (const k of [["admin", "storage-plans"], ["admin", "users"], ["admin", "groups"], ["storage"]]) expect(keys).toContain(JSON.stringify(k));
  });

  it("delete failure (409 in_use): the list is still refetched (the list on screen is stale)", async () => {
    const fetchMock = renderStorage((url, method) =>
      url === `/api/admin/storage-plans/${SPARE.id}` && method === "DELETE" ? res(409, { error: { code: "storage_plan_in_use", message: "x" } }) : null);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Spare" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/admin/storage-plans/${SPARE.id}`)).toHaveLength(1));
    await waitFor(() => expect(callsTo(fetchMock, "GET", "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
  });

  it("two defaults: changing \"New users\" to Big -> save sends only userPlanId; success toast", async () => {
    const fetchMock = renderStorage((url, method) =>
      url === "/api/admin/storage-plans/defaults" && method === "PATCH" ? res(200, { userPlanId: BIG.id, groupPlanId: STARTER.id }) : null);
    const userSelect = await screen.findByLabelText("New users");
    expect(selectedValue(userSelect)).toBe(BASIC.id);
    expect(screen.getByRole("button", { name: "Save defaults" })).toBeDisabled(); // not changed yet
    await chooseOption(userSelect, "Big");
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", "/api/admin/storage-plans/defaults")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", "/api/admin/storage-plans/defaults")[0])).toEqual({ userPlanId: BIG.id });
    expect(await screen.findByText("Defaults saved.")).toBeInTheDocument();
  });
});
