import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupStorageUsageDto, StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// W3（spec §11.5）：個人設定「儲存空間」頁與群組 modal「儲存空間」頁（`/groups/:id/storage`，#247 §6.4）的用量。
// 群組頁的依成員／版本開關細節在 `components/groups/GroupStorageSection.test.tsx`。走真的 AppRoutes（同 SettingsAccountSection.test.tsx 慣例）。

function fakeResponse(status: number, body: unknown): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const TRASH_NOTE = "Notes in the trash count toward usage too, until they're permanently deleted.";

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };

function renderAt(path: string, handlers: (url: string, method: string) => Response | Promise<Response> | null) {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = handlers(url, method);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse(200, ME));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes") return Promise.resolve(fakeResponse(200, []));
    if (url === "/api/auth/identities") return Promise.resolve(fakeResponse(200, { identities: [], linkable: [], hasPassword: true, passwordLoginEnabled: true }));
    if (url === "/api/auth/tokens") return Promise.resolve(fakeResponse(200, { tokens: [] }));
    // 儲存空間頁的版本歷史開關要打（#247 §5.4；回應形同 SettingsAccountSection.test.tsx 的 baseFetchHandlers）
    if (url === "/api/auth/config") return Promise.resolve(fakeResponse(200, { providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
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

  it("SU-T1（#181 D-W4）成功態末尾有垃圾桶計入用量的說明；載入中與錯誤態沒有", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(200, usage({})) : null));
    await waitFor(() => expect(screen.getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Basic)"));
    const note = screen.getByText(TRASH_NOTE, { exact: true });
    expect(note).toHaveClass("text-xs", "text-muted-foreground");
    expect(screen.getByTestId("storage-usage").compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("SU-T1b 載入中（/api/storage 懸著）→ 沒有垃圾桶說明", async () => {
    renderAt("/settings/storage", (url) => (url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? new Promise<Response>(() => {}) : null));
    expect(await screen.findByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    await screen.findByRole("switch");
    expect(screen.getAllByText("Loading…").length).toBeGreaterThan(0);
    expect(screen.queryByText(TRASH_NOTE)).not.toBeInTheDocument();
  });

  it("SU-T1c 錯誤態（/api/storage 500）→ 沒有垃圾桶說明", async () => {
    renderAt("/settings/storage", (url) =>
      url === "/api/groups" ? fakeResponse(200, []) : url === "/api/storage" ? fakeResponse(500, { error: { code: "boom", message: "x" } }) : null,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(i18n.t("errors.fallback"));
    expect(screen.queryByText(TRASH_NOTE)).not.toBeInTheDocument();
  });
});

const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
const groupUsage = (u: Partial<GroupStorageUsageDto>): GroupStorageUsageDto => ({ ...usage({}), byMember: [{ userId: "u-me", handle: "me", displayName: "Me", bytes: 1048576 }], ...u });

describe("W3 群組儲存空間頁（/groups/:id/storage，#247 §6.4）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("canManageGroup：打 GET /api/groups/:id/storage 並顯示「1 MB of 2 GB (Team plan)」", async () => {
    const g = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, ADMIN_ROLE);
    const fetchMock = renderAt(`/groups/${g.id}/storage`, (url) => {
      if (url === "/api/groups") return fakeResponse(200, [g]);
      if (url === `/api/groups/${g.id}/storage`) return fakeResponse(200, groupUsage({ planName: "Team plan" }));
      return null;
    });
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Storage" })).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toHaveTextContent("1 MB of 2 GB (Team plan)"));
    expect(within(dialog).getByText(TRASH_NOTE, { exact: true })).toBeInTheDocument(); // SU-T1 群組面板同一句（共用 StorageUsageGroup）
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/groups/${g.id}/storage`)).toBe(true);
  });

  it("不是群組管理者：§9.2 放寬後照樣渲染、照樣打 storage 端點（#247 前是不渲染、不打）", async () => {
    const g = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, MEMBER_ROLE);
    const fetchMock = renderAt(`/groups/${g.id}/storage`, (url) => {
      if (url === "/api/groups") return fakeResponse(200, [g]);
      if (url === `/api/groups/${g.id}/storage`) return fakeResponse(200, groupUsage({ usedBytes: 3 * 1048576, quotaBytes: 2 * 1048576, planName: "Tight" }));
      return null;
    });
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    await within(dialog).findByRole("heading", { level: 1, name: "Storage" });
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toHaveTextContent("3 MB of 2 MB (Tight)"));
    expect(within(dialog).getByTestId("storage-usage")).toHaveClass("text-destructive");
    expect(fetchMock.mock.calls.some(([u]) => String(u) === `/api/groups/${g.id}/storage`)).toBe(true);
  });
});
