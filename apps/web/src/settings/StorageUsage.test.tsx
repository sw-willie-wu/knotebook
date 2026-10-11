import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";

// W3（spec §11.5）：個人設定「儲存空間」頁的用量。群組用量 #247 起搬到群組 modal 的 `/groups/:id/storage`，測試跟著該頁走（`components/groups/`）。走真的 AppRoutes（同 SettingsAccountSection.test.tsx 慣例）。

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };

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
    // 儲存空間頁的版本歷史開關要打（#247 §5.4；回應形同 SettingsAccountSection.test.tsx 的 baseFetchHandlers）
    if (url === "/api/auth/config") return Promise.resolve(fakeResponse(200, { providers: [], registration: { enabled: false }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
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

const usage = (u: Partial<StorageUsageDto>): StorageUsageDto => ({ usedBytes: 1048576, quotaBytes: 2147483648, planName: "Basic", byKind: { image: 1048576, audio: 0, video: 0, document: 0, other: 0 }, ...u });

describe("W3 帳號頁的儲存空間", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("有上限：「1 MB of 2 GB (Basic)」，沒有警示", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({})) : null));
    expect(await screen.findByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Basic)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("無上限：「5 MB used (unlimited, Big)」，沒有警示", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 5 * 1048576, quotaBytes: null, planName: "Big" })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("5 MB used (unlimited, Big)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });

  it("已超過：警示色＋「Limit reached…」", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576, planName: "Tight" })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("3 MB of 2 MB (Tight)"));
    expect(screen.getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(screen.getByText("Limit reached — no new attachments can be added")).toHaveClass("text-destructive");
  });

  it("恰好等於上限：也警示（Willie 2026-10-08，起草裁定 4）", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 1048576, quotaBytes: 1048576 })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 1 MB (Basic)"));
    expect(screen.getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(screen.getByText("Limit reached — no new attachments can be added")).toHaveClass("text-destructive");
  });

  it("差 1 byte 未達上限：不警示（>= 的邊界另一側）", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({ usedBytes: 1048575, quotaBytes: 1048576 })) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 1 MB (Basic)"));
    expect(screen.getByTestId("storage-usage")).not.toHaveClass("text-destructive");
    expect(screen.queryByText("Limit reached — no new attachments can be added")).not.toBeInTheDocument();
  });
});
