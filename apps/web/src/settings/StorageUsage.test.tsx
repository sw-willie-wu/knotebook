import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";

// W3（spec §11.5）：帳號頁與群組詳情頁的「儲存空間」群組。走真的 AppRoutes（同 SettingsAccountSection.test.tsx 慣例）。

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true };

const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });

function renderAt(path: string, handlers: (url: string, method: string) => Response | null) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = handlers(url, method);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse(200, ME));
    if (url === "/api/notes") return Promise.resolve(fakeResponse(200, []));
    if (url === "/api/auth/identities") return Promise.resolve(fakeResponse(200, { identities: [], linkable: [], hasPassword: true, passwordLoginEnabled: true }));
    if (url === "/api/auth/tokens") return Promise.resolve(fakeResponse(200, { tokens: [] }));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  return fetchMock;
}

const usage = (u: Partial<StorageUsageDto>): StorageUsageDto => ({ usedBytes: 1048576, quotaBytes: 2147483648, planName: "Basic", ...u });

describe("W3 帳號頁的儲存空間", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("有上限：「1 MB of 2 GB (Basic)」，沒有警示", async () => {
    renderAt("/settings/account", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({})) : null));
    expect(await screen.findByRole("heading", { name: "Storage" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Basic)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("無上限：「5 MB used (unlimited, Big)」，沒有警示", async () => {
    renderAt("/settings/account", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 5 * 1048576, quotaBytes: null, planName: "Big" })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("5 MB used (unlimited, Big)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("已超過：警示色＋「Limit reached…」", async () => {
    renderAt("/settings/account", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576, planName: "Tight" })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("3 MB of 2 MB (Tight)"));
    expect(screen.getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(screen.getByText("Limit reached — no new attachments can be added")).toHaveClass("text-destructive");
  });

  it("恰好等於上限：也警示（Willie 2026-10-08，起草裁定 4）", async () => {
    renderAt("/settings/account", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 1048576, quotaBytes: 1048576 })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 1 MB (Basic)"));
    expect(screen.getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(screen.getByText("Limit reached — no new attachments can be added")).toHaveClass("text-destructive");
  });

  it("差 1 byte 未達上限：不警示（>= 的邊界另一側）", async () => {
    renderAt("/settings/account", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 1048575, quotaBytes: 1048576 })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 1 MB (Basic)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });
});

describe("W3 群組詳情頁的儲存空間", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("canManageGroup：打 GET /api/groups/:id/storage 並顯示", async () => {
    const g = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, ADMIN_ROLE);
    renderAt(`/settings/groups/${g.id}`, (url) => {
      if (url === "/api/groups") return fakeResponse(200, [g]);
      if (url === `/api/groups/${g.id}/members`) return fakeResponse(200, []);
      if (url === `/api/groups/${g.id}/roles`) return fakeResponse(200, [ADMIN_ROLE, MEMBER_ROLE]);
      if (url === `/api/groups/${g.id}/storage`) return fakeResponse(200, usage({ planName: "Team plan" }));
      return null;
    });
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Team plan)"));
    expect(screen.getByRole("heading", { name: "Storage" })).toBeInTheDocument();
  });

  it("不是群組管理者：不渲染、也不打 storage 端點", async () => {
    const g = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, MEMBER_ROLE);
    const fetchMock = renderAt(`/settings/groups/${g.id}`, (url) => {
      if (url === "/api/groups") return fakeResponse(200, [g]);
      if (url === `/api/groups/${g.id}/members`) return fakeResponse(200, []);
      if (url === `/api/groups/${g.id}/roles`) return fakeResponse(200, [ADMIN_ROLE, MEMBER_ROLE]);
      return null;
    });
    // 等待點：成員區已渲染（storage 若會掛載，此刻一定已掛上——它與成員區同一次 render）
    expect(await screen.findByRole("heading", { name: "Members" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Storage" })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([u]) => String(u).endsWith("/storage"))).toBe(false);
  });
});
