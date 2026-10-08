import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { StoragePlanDto, StoragePlansResponse, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// W4（spec §11.5）：/admin/storage。走真的 AppRoutes（AdminPage lazy chunk＋descendant route）。

function res(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}
const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true };
const T = "2026-01-01T00:00:00.000Z";
const plan = (p: Partial<StoragePlanDto> & Pick<StoragePlanDto, "id" | "name">): StoragePlanDto => ({
  quotaBytes: null, userCount: 0, groupCount: 0, overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false, createdAt: T, updatedAt: T, ...p,
});
const BASIC = plan({ id: "11111111-1111-4111-8111-111111111111", name: "Basic", quotaBytes: 2147483648, userCount: 3, groupCount: 1, isDefaultForUsers: true });
const BIG = plan({ id: "22222222-2222-4222-8222-222222222222", name: "Big", quotaBytes: null, userCount: 1 });
const SPARE = plan({ id: "33333333-3333-4333-8333-333333333333", name: "Spare", quotaBytes: 1048576 });
const TIGHT = plan({ id: "44444444-4444-4444-8444-444444444444", name: "Tight", quotaBytes: 1004, userCount: 2, overQuotaCount: 1 }); // 1004 → 「0.000957 MB」→ 1003：換算回不來（RF2 承重值，起草者以 node 實算）
/** 只因「是預設」而不能刪（沒人在用）——刪除鈕的第二個條件要有自己的案（review I1）。 */
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
    if (url === "/api/groups" || url === "/api/notes") return Promise.resolve(res(200, []));
    if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(res(200, LIST));
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
const row = (name: string) => screen.getByText(name, { selector: "td" }).closest("tr") as HTMLElement; // 列的可及名在 jsdom 算不出以方案名開頭（計畫預告的退路）：改從名稱格往上找 <tr>

describe("/admin/storage（儲存方案頁）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("方案表：上限（formatBytes／No limit）、使用者數、群組數、超過上限數、預設標記；刪除鈕依兩條件 disabled＋看得見的說明", async () => {
    renderStorage();
    expect(await screen.findByRole("heading", { level: 1, name: "Storage plans" })).toBeInTheDocument();
    await waitFor(() => expect(row("Basic")).toBeInTheDocument());
    expect(within(row("Basic")).getByText("2 GB")).toBeInTheDocument();
    expect(within(row("Basic")).getByText("Default for new users")).toBeInTheDocument();
    expect(within(row("Starter")).getByText("Default for new groups")).toBeInTheDocument();
    expect(within(row("Starter")).getByText("1 MB")).toBeInTheDocument();
    expect(within(row("Big")).getByText("No limit")).toBeInTheDocument();
    expect(within(row("Tight")).getByText("1004 B")).toBeInTheDocument();
    const tightCells = within(row("Tight")).getAllByRole("cell").map((c) => c.textContent);
    expect(tightCells.slice(2, 5)).toEqual(["2", "0", "1"]); // 使用者、群組、超過上限
    expect(screen.getByRole("button", { name: "Delete Basic" })).toBeDisabled(); // 預設（也在用）
    expect(screen.getByRole("button", { name: "Delete Tight" })).toBeDisabled(); // 只因在用
    expect(screen.getByRole("button", { name: "Delete Big" })).toBeDisabled(); // 只因在用（1 位使用者）
    expect(screen.getByRole("button", { name: "Delete Starter" })).toBeDisabled(); // 只因是預設（沒人在用）——M7b 守
    expect(screen.getByRole("button", { name: "Delete Spare" })).toBeEnabled();
    expect(screen.getByText("A plan that is a default, or that any user or group is on, can't be deleted.")).toBeInTheDocument();
  });

  it("新增：名稱 trim、1.5 GB → POST {name, quotaBytes: 1610612736}；成功關窗並重抓清單", async () => {
    const fetchMock = renderStorage((url, method) => (url === "/api/admin/storage-plans" && method === "POST" ? res(201, plan({ id: "55555555-5555-4555-8555-555555555555", name: "Team" })) : null));
    fireEvent.click(await screen.findByRole("button", { name: "New plan" }));
    const dialog = await screen.findByRole("dialog", { name: "New storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "  Team  " } });
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1.5" } });
    fireEvent.change(within(dialog).getByLabelText("Unit"), { target: { value: "GB" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create" }));
    await waitFor(() => expect(callsTo(fetchMock, "POST", "/api/admin/storage-plans")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "POST", "/api/admin/storage-plans")[0])).toEqual({ name: "Team", quotaBytes: 1610612736 });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(callsTo(fetchMock, "GET", "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
  });

  it("新增「無上限」：數字欄停用，POST quotaBytes: null", async () => {
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

  it("前端預檢：41 字名稱、或上限 1e3 → 行內錯誤、不發請求", async () => {
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

  it("409 storage_plan_name_taken → 行內「A plan with this name already exists」；server 的 invalid_name → 方案版文案（不是群組的 1–80）", async () => {
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

  it("編輯 Basic：初值 2 GB；調成 1 GB → 出現調低說明；PATCH 只送 quotaBytes", async () => {
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${BASIC.id}` && method === "PATCH" ? res(200, BASIC) : null));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Basic" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    expect(within(dialog).getByLabelText("Name", { exact: true })).toHaveValue("Basic");
    expect(within(dialog).getByLabelText("Limit", { exact: true })).toHaveValue("2");
    expect(within(dialog).getByLabelText("Unit")).toHaveValue("GB");
    expect(within(dialog).queryByText(/Lowering the limit doesn't delete any files/)).not.toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "3" } });
    expect(within(dialog).queryByText(/Lowering the limit doesn't delete any files/)).not.toBeInTheDocument(); // 調高不顯示
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "1" } });
    expect(within(dialog).getByText(/Lowering the limit doesn't delete any files/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${BASIC.id}`)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${BASIC.id}`)[0])).toEqual({ quotaBytes: 1073741824 });
  });

  it("編輯無上限的 Big 改成有限（5 GB）→ 出現調低說明", async () => {
    renderStorage();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Big" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    expect(within(dialog).queryByText(/Lowering the limit doesn't delete any files/)).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "No limit" }));
    fireEvent.change(within(dialog).getByLabelText("Limit", { exact: true }), { target: { value: "5" } });
    expect(within(dialog).getByText(/Lowering the limit doesn't delete any files/)).toBeInTheDocument();
  });

  it("RF2a：編輯 Tight 什麼都沒改就按 Save → 不發請求、直接關（M5 的目標）", async () => {
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${TIGHT.id}` && method === "PATCH" ? res(200, TIGHT) : null));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Tight" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${TIGHT.id}`)).toHaveLength(0);
  });

  it("RF2b：編輯 Tight（1004 bytes）只改名 → PATCH 只送 name，不送換算回來的 quotaBytes（M4 的目標）", async () => {
    const fetchMock = renderStorage((url, method) => (url === `/api/admin/storage-plans/${TIGHT.id}` && method === "PATCH" ? res(200, TIGHT) : null));
    fireEvent.click(await screen.findByRole("button", { name: "Edit Tight" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit storage plan" });
    fireEvent.change(within(dialog).getByLabelText("Name", { exact: true }), { target: { value: "Tight 2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${TIGHT.id}`)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/admin/storage-plans/${TIGHT.id}`)[0])).toEqual({ name: "Tight 2" });
  });

  it("刪除 Spare：確認框 → DELETE；並發中被別人指派 → 409 storage_plan_in_use 以 toast 顯示", async () => {
    const fetchMock = renderStorage((url, method) =>
      url === `/api/admin/storage-plans/${SPARE.id}` && method === "DELETE" ? res(409, { error: { code: "storage_plan_in_use", message: "x" } }) : null);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Spare" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/admin/storage-plans/${SPARE.id}`)).toHaveLength(1));
    expect(await screen.findByText("This plan is assigned to users or groups. Move them to another plan first.")).toBeInTheDocument();
  });

  it("刪除成功（204）：四把 key 都被失效（方案、使用者、群組、自己的用量），清單重抓（m2）", async () => {
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

  it("刪除失敗（409 in_use）：清單仍重抓（畫面上的清單已過時，m3）", async () => {
    const fetchMock = renderStorage((url, method) =>
      url === `/api/admin/storage-plans/${SPARE.id}` && method === "DELETE" ? res(409, { error: { code: "storage_plan_in_use", message: "x" } }) : null);
    fireEvent.click(await screen.findByRole("button", { name: "Delete Spare" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete this plan?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/admin/storage-plans/${SPARE.id}`)).toHaveLength(1));
    await waitFor(() => expect(callsTo(fetchMock, "GET", "/api/admin/storage-plans").length).toBeGreaterThanOrEqual(2));
  });

  it("兩個預設：改「New users」為 Big → 儲存只送 userPlanId；成功 toast", async () => {
    const fetchMock = renderStorage((url, method) =>
      url === "/api/admin/storage-plans/defaults" && method === "PATCH" ? res(200, { userPlanId: BIG.id, groupPlanId: STARTER.id }) : null);
    const userSelect = await screen.findByLabelText("New users");
    expect(userSelect).toHaveValue(BASIC.id);
    expect(screen.getByRole("button", { name: "Save defaults" })).toBeDisabled(); // 沒改過
    fireEvent.change(userSelect, { target: { value: BIG.id } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", "/api/admin/storage-plans/defaults")).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", "/api/admin/storage-plans/defaults")[0])).toEqual({ userPlanId: BIG.id });
    expect(await screen.findByText("Defaults saved.")).toBeInTheDocument();
  });
});
