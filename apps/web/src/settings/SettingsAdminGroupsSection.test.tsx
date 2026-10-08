import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import type { AdminGroupDto, StoragePlanDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { useAssignGroupPlan } from "@/api/adminStorage";
import { ADMIN_GROUPS_QUERY_KEY, ADMIN_STORAGE_PLANS_QUERY_KEY, STORAGE_USAGE_QUERY_KEY, groupStorageKey } from "@/api/storage";

// W5／W6（spec §11.5）：/admin/groups。群組名一律純文字（Willie 2026-10-08：站台管理員管方案、不看群組成員與詳情）。

function res(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}
const ADMIN: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true };
const T = "2026-01-01T00:00:00.000Z";
const BASIC_ID = "11111111-1111-4111-8111-111111111111";
const TIGHT_ID = "44444444-4444-4444-8444-444444444444";
const planDto = (id: string, name: string, quotaBytes: number | null): StoragePlanDto => ({
  id, name, quotaBytes, userCount: 0, groupCount: 1, overQuotaCount: 0, isDefaultForUsers: false, isDefaultForGroups: false, createdAt: T, updatedAt: T,
});
const PLANS = { plans: [planDto(BASIC_ID, "Basic", 2147483648), planDto(TIGHT_ID, "Tight", 2 * 1048576)], defaults: { userPlanId: BASIC_ID, groupPlanId: BASIC_ID } };
const ALPHA: AdminGroupDto = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Alpha", createdAt: T, memberCount: 3, storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 1048576, quotaBytes: 2147483648 } };
const BETA: AdminGroupDto = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Beta", createdAt: T, memberCount: 1, storage: { planId: TIGHT_ID, planName: "Tight", usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576 } };

type Handler = (url: string, method: string, init?: RequestInit) => Response | Promise<Response> | null;
function renderGroups(rows: AdminGroupDto[], extra: Handler = () => null) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(res(200, ADMIN));
    if (url === "/api/notes") return Promise.resolve(res(200, []));
    if (url === "/api/admin/groups" && method === "GET") return Promise.resolve(res(200, rows));
    if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(res(200, PLANS));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/admin/groups"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return fetchMock;
}
/** 以該列的方案下拉定位列（等到下拉出現才回傳）；名稱格的包法（連結或 span）不影響定位。 */
const rowByDropdown = async (name: string) => (await screen.findByRole("combobox", { name: `Storage plan for ${name}` })).closest("tr")!;
/** 沒有下拉的情況（方案清單失敗）：以第一格的文字找列。 */
const rowByName = (name: string) => screen.getAllByRole("row").find((r) => within(r).queryAllByRole("cell")[0]?.textContent === name)!;
const requested = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.map(([u, i]) => `${((i as RequestInit | undefined)?.method ?? "GET").toUpperCase()} ${String(u)}`);
const PLANS_URL = "/api/admin/storage-plans";
const plansGets = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([u, i]) => String(u) === PLANS_URL && (((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === "GET")).length;
const patchUrl = (g: AdminGroupDto) => `/api/admin/groups/${g.id}/storage-plan`;
/** 讓還在路上的 promise／react-query 通知落地（負向斷言前用）。 */
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe("W5 /admin/groups", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("每列：名稱、成員數、建立時間、用量（已超過警示色）、方案下拉", async () => {
    renderGroups([ALPHA, BETA]);
    expect(await screen.findByRole("heading", { level: 1, name: "Groups" })).toBeInTheDocument();
    const beta = await rowByDropdown("Beta");
    const cells = within(beta).getAllByRole("cell");
    expect(cells.map((c) => c.textContent).slice(0, 4)).toEqual(["Beta", "1", new Date(T).toLocaleDateString("en"), "3 MB of 2 MB"]);
    expect(within(beta).getByText("3 MB of 2 MB")).toHaveClass("text-destructive");
    expect(within(beta).getByRole("combobox", { name: "Storage plan for Beta" })).toHaveValue(TIGHT_ID);
    expect(within(await rowByDropdown("Alpha")).getByText("1 MB of 2 GB")).not.toHaveClass("text-destructive");
  });

  it("群組名一律純文字、不打任何成員／角色／群組用量端點（Willie 2026-10-08）", async () => {
    const fetchMock = renderGroups([ALPHA, BETA]);
    for (const g of [ALPHA, BETA]) {
      // 以下拉定位列：下拉出現＝方案清單已到，本頁 query 都已落地；若名稱格會變成連結，此刻一定已是
      const row = await rowByDropdown(g.name);
      const nameCell = within(row).getAllByRole("cell")[0]!;
      expect(nameCell).toHaveTextContent(g.name);
      expect(within(nameCell).queryByRole("link")).toBeNull();
    }
    await flush();
    // 本頁只載入這三支（/api/auth/me 守衛會打不只一次，所以去重比對）；沒載入「我的群組」，所以沒有任何群組有理由變成連結
    expect([...new Set(requested(fetchMock))].sort()).toEqual(["GET /api/admin/groups", "GET /api/admin/storage-plans", "GET /api/auth/me"]);
  });

  it("同名群組：各列下拉用 aria-describedby 指到該列的建立時間格（id 依群組 id），描述可區分", async () => {
    const OLDER: AdminGroupDto = { ...ALPHA, id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", createdAt: "2025-03-04T12:00:00.000Z" };
    renderGroups([ALPHA, OLDER]);
    const selects = await screen.findAllByRole("combobox", { name: "Storage plan for Alpha" });
    expect(selects).toHaveLength(2);
    expect(selects[0]).toHaveAccessibleDescription(new Date(T).toLocaleDateString("en"));
    expect(selects[1]).toHaveAccessibleDescription(new Date(OLDER.createdAt).toLocaleDateString("en"));
    expect(selects[0]!.getAttribute("aria-describedby")).not.toBe(selects[1]!.getAttribute("aria-describedby"));
  });

  it("改方案：PATCH {planId}；成功後下拉與用量格換成新方案，方案清單（人數）重抓，不碰個人用量 /api/storage", async () => {
    const updated: AdminGroupDto = { ...BETA, storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 3 * 1048576, quotaBytes: 2147483648 } };
    const fetchMock = renderGroups([BETA], (url, method) => (url === patchUrl(BETA) && method === "PATCH" ? res(200, updated) : null));
    const select = await screen.findByRole("combobox", { name: "Storage plan for Beta" });
    fireEvent.change(select, { target: { value: BASIC_ID } });
    await waitFor(() => expect(select).toHaveValue(BASIC_ID));
    const patch = fetchMock.mock.calls.find(([u, i]) => String(u) === patchUrl(BETA) && (i as RequestInit).method === "PATCH");
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ planId: BASIC_ID });
    expect(screen.getByText("3 MB of 2 GB")).not.toHaveClass("text-destructive");
    // 成功後方案清單（人數）重抓：PATCH 之後 GET storage-plans 又發了一次——同時是下面兩條負向斷言的等待點
    await waitFor(() => expect(plansGets(fetchMock)).toBeGreaterThanOrEqual(2));
    await flush();
    expect(fetchMock.mock.calls.some(([u]) => String(u) === "/api/storage")).toBe(false);
    // 群組列表本身不重抓（setQueryData 已換列）：只有一次 GET /api/admin/groups
    expect(fetchMock.mock.calls.filter(([u, i]) => String(u) === "/api/admin/groups" && (((i as RequestInit | undefined)?.method ?? "GET") === "GET")).length).toBe(1);
  });

  it("儲存中（PATCH 未回）：下拉 disabled 且顯示剛選的方案，不彈回舊方案", async () => {
    renderGroups([BETA], (url, method) => (url === patchUrl(BETA) && method === "PATCH" ? (new Promise(() => undefined) as unknown as Promise<Response>) : null));
    const select = await screen.findByRole("combobox", { name: "Storage plan for Beta" });
    fireEvent.change(select, { target: { value: BASIC_ID } });
    await waitFor(() => expect(select).toBeDisabled());
    expect(select).toHaveValue(BASIC_ID);
  });

  it("改方案失敗（404 group_not_found，群組剛被刪）→ toast，下拉留在原方案，方案清單重抓", async () => {
    const fetchMock = renderGroups([BETA], (url, method) =>
      url === patchUrl(BETA) && method === "PATCH" ? res(404, { error: { code: "group_not_found", message: "x" } }) : null);
    const select = await screen.findByRole("combobox", { name: "Storage plan for Beta" });
    fireEvent.change(select, { target: { value: BASIC_ID } });
    expect(await screen.findByText("We couldn't find that group.")).toBeInTheDocument();
    await waitFor(() => expect(select).toHaveValue(TIGHT_ID));
    expect(select).not.toBeDisabled();
    // 失敗也重抓方案清單（方案可能剛被刪）
    await waitFor(() => expect(plansGets(fetchMock)).toBeGreaterThanOrEqual(2));
  });

  it("RF4：列上的方案不在清單裡 → 下拉仍顯示該方案（補一個 option），不是清單第一個", async () => {
    const NEWPLAN_ID = "99999999-9999-4999-8999-999999999999";
    const row: AdminGroupDto = { ...ALPHA, storage: { planId: NEWPLAN_ID, planName: "Brand new", usedBytes: 0, quotaBytes: 1048576 } };
    renderGroups([row]);
    const select = await screen.findByRole("combobox", { name: "Storage plan for Alpha" });
    await waitFor(() => expect(select).toHaveValue(NEWPLAN_ID));
    expect(within(select).getByRole("option", { name: "Brand new" })).toBeInTheDocument();
  });

  it("方案清單失敗：方案欄只顯示方案名、沒有下拉", async () => {
    const fetchMock = renderGroups([ALPHA], (url, method) => (url === PLANS_URL && method === "GET" ? res(500, { error: { code: "internal", message: "x" } }) : null));
    expect(await screen.findByRole("cell", { name: "Alpha" })).toBeInTheDocument();
    // 等待點：清單 pending 時 plans 也是 undefined、「沒有下拉」恆真——先等請求真的發出，再讓失敗結果落地
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => String(u) === PLANS_URL)).toBe(true));
    await flush();
    expect(screen.queryByRole("combobox", { name: "Storage plan for Alpha" })).not.toBeInTheDocument();
    expect(within(rowByName("Alpha")).getByText("Basic")).toBeInTheDocument();
  });

  it("群組列表載入失敗 → 錯誤列（role=alert），沒有表格", async () => {
    renderGroups([], (url, method) => (url === "/api/admin/groups" && method === "GET" ? res(500, { error: { code: "internal", message: "x" } }) : null));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("沒有群組 → 「No groups yet.」", async () => {
    renderGroups([]);
    expect(await screen.findByText("No groups yet.")).toBeInTheDocument();
  });
});

describe("useAssignGroupPlan 的快取失效", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup(patchResponse: () => Response) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(patchResponse())));
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
    client.setQueryData(ADMIN_GROUPS_QUERY_KEY, [ALPHA, BETA]);
    client.setQueryData(ADMIN_STORAGE_PLANS_QUERY_KEY, PLANS);
    client.setQueryData(STORAGE_USAGE_QUERY_KEY, { sentinel: true });
    client.setQueryData(groupStorageKey(BETA.id), { sentinel: true });
    client.setQueryData(groupStorageKey(ALPHA.id), { sentinel: true });
    return { client, ...renderHook(() => useAssignGroupPlan(), { wrapper }) };
  }
  const invalidated = (client: QueryClient, key: readonly unknown[]) => client.getQueryState(key)!.isInvalidated;

  it("成功：換掉那一列、失效方案清單與該群組的用量 key；不失效個人用量、別的群組、群組列表", async () => {
    const updated: AdminGroupDto = { ...BETA, storage: { planId: BASIC_ID, planName: "Basic", usedBytes: 3 * 1048576, quotaBytes: 2147483648 } };
    const { client, result } = setup(() => res(200, updated));
    await act(async () => { await result.current.mutateAsync({ groupId: BETA.id, planId: BASIC_ID }); });
    expect(client.getQueryData<AdminGroupDto[]>(ADMIN_GROUPS_QUERY_KEY)).toEqual([ALPHA, updated]);
    expect(invalidated(client, ADMIN_STORAGE_PLANS_QUERY_KEY)).toBe(true);
    expect(invalidated(client, groupStorageKey(BETA.id))).toBe(true);
    expect(invalidated(client, STORAGE_USAGE_QUERY_KEY)).toBe(false);
    expect(invalidated(client, groupStorageKey(ALPHA.id))).toBe(false);
    expect(invalidated(client, ADMIN_GROUPS_QUERY_KEY)).toBe(false);
  });

  it("失敗：列不動、只失效方案清單", async () => {
    const { client, result } = setup(() => res(404, { error: { code: "storage_plan_not_found", message: "x" } }));
    await act(async () => { await result.current.mutateAsync({ groupId: BETA.id, planId: BASIC_ID }).catch(() => undefined); });
    expect(client.getQueryData<AdminGroupDto[]>(ADMIN_GROUPS_QUERY_KEY)).toEqual([ALPHA, BETA]);
    expect(invalidated(client, ADMIN_STORAGE_PLANS_QUERY_KEY)).toBe(true);
    expect(invalidated(client, groupStorageKey(BETA.id))).toBe(false);
    expect(invalidated(client, STORAGE_USAGE_QUERY_KEY)).toBe(false);
  });
});
