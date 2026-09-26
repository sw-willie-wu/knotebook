import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import type { GroupDto, GroupMemberDto, GroupMemberRole, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";

// `/settings/groups/:id`（spec §8.4 後半，Task 8）：詳情頁——render helper 照抄
// `SettingsGroupsSection.test.tsx`（Task 7）的做法（真 `AppRoutes`、`MemoryRouter`、fetch
// 分派 `/api/auth/me`／`/api/notes`／`/api/groups`／`/api/groups/:id/members`）。背景側欄
// 的工作坊分段吃同一份 `useGroups()` 快取會渲染同樣的群組名字——一律 `within(dialog)`
// 才不誤命中背景層。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

/** 記下每次成功 navigate 之後的 location（給案 5／6／8 驗證「導回 /settings/groups」
 * 與「保留 backgroundLocation」用）——與 `MemoryRouter` 同一個 router context 下的
 * 一般 `useLocation()`，不必依賴 `AppRoutes` 內部結構。 */
function LocationProbe() {
  const location = useLocation();
  return (
    <div data-testid="location">
      {location.pathname}|{JSON.stringify(location.state)}
    </div>
  );
}

const ME: UserDto = {
  id: "u-me",
  email: "me@example.com",
  handle: "me",
  displayName: "Me",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

const GROUP_ADMIN: GroupDto = {
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  name: "Team Alpha",
  myRole: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const GROUP_MEMBER: GroupDto = {
  id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  name: "Team Beta",
  myRole: "member",
  createdAt: "2026-01-02T00:00:00.000Z",
};

function member(userId: string, email: string, displayName: string, role: GroupMemberRole): GroupMemberDto {
  return { userId, email, displayName, role };
}

/** 基本 fetch mock：`/api/auth/me`（一律回 `ME`）、`/api/notes`（背景 `HomePage` 需要）。
 * 呼叫端疊加 `/api/groups*`。 */
function baseFetchHandlers(): (url: string, method: string) => Response | null {
  return (url: string, method: string): Response | null => {
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ME) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

function renderDetailRoute(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <LocationProbe />
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("SettingsGroupDetailSection（/settings/groups/:id，spec §8.4 後半）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("admin 視角：名稱可改（PATCH）、成員表有 email（A8）、角色下拉、移除鈕；底部加人表單；danger 區刪除群組", async () => {
    let group = { ...GROUP_ADMIN };
    const members = [member(ME.id, ME.email, "Me", "admin"), member("u-bob", "bob@example.com", "Bob", "member")];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([group]) }));
      }
      if (url === `/api/groups/${group.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      if (url === `/api/groups/${group.id}` && method === "PATCH") {
        group = { ...group, name: "Team Alpha Renamed" };
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(group) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "Team Alpha" })).toBeInTheDocument());

    // 名稱可改：輸入框預填目前名稱、Save name 送 PATCH。
    const nameInput = within(dialog).getByLabelText("Group name");
    expect(nameInput).toHaveValue("Team Alpha");
    fireEvent.change(nameInput, { target: { value: "Team Alpha Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/groups/${GROUP_ADMIN.id}` && (i as RequestInit)?.method === "PATCH")).toBe(true),
    );
    await waitFor(() => expect(screen.getByText("Group renamed.")).toBeInTheDocument());

    // 成員表：email、角色下拉、移除鈕。
    expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("me@example.com")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Role for bob@example.com")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove bob@example.com" })).toBeInTheDocument();

    // 底部加人表單。
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Role for new member")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeInTheDocument();

    // danger 區：刪除群組。
    expect(within(dialog).getByRole("button", { name: "Delete group" })).toBeInTheDocument();
  });

  it("最後一位 admin 的列：角色下拉與移除鈕都 disabled 且 title=lastAdminHint，表格下方有同一句可見提示；兩位 admin 時不 disabled、無提示", async () => {
    const HINT = "The only admin can't be demoted or removed. Make someone else an admin first.";
    let members = [member(ME.id, ME.email, "Me", "admin"), member("u-bob", "bob@example.com", "Bob", "member")];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_ADMIN]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    const phase1 = renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());

    // 只有一位 admin（Me）：Me 的列 lock 住，Bob 的列（member）不受影響、不出現在斷言範圍。
    const meRoleSelect = within(dialog).getByLabelText("Role for me@example.com");
    expect(meRoleSelect).toBeDisabled();
    expect(meRoleSelect).toHaveAttribute("title", HINT);
    const meRemoveButton = within(dialog).getByRole("button", { name: "Remove me@example.com" });
    expect(meRemoveButton).toBeDisabled();
    expect(meRemoveButton).toHaveAttribute("title", HINT);
    expect(within(dialog).getByText(HINT)).toBeInTheDocument();

    phase1.unmount();
    vi.unstubAllGlobals();

    // 兩位 admin：都不 disabled、提示消失。改 fixture 後開獨立的第二次 render
    // （`unmount()` 前一份，避免兩份 dialog 共存互相干擾查詢）。
    members = [member(ME.id, ME.email, "Me", "admin"), member("u-bob", "bob@example.com", "Bob", "admin")];

    const fetchMock2 = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_ADMIN]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock2);
    const dialog2 = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog2).getByText("bob@example.com")).toBeInTheDocument());

    expect(within(dialog2).getByLabelText("Role for me@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByLabelText("Role for bob@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByRole("button", { name: "Remove me@example.com" })).not.toBeDisabled();
    expect(within(dialog2).getByRole("button", { name: "Remove bob@example.com" })).not.toBeDisabled();
    expect(within(dialog2).queryByText(HINT)).not.toBeInTheDocument();
  });

  it("加人：PUT {email, role}（下拉選 admin）→ 名單更新；409 already_member → 表單下 alert", async () => {
    let members = [member(ME.id, ME.email, "Me", "admin")];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_ADMIN]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { email: string; role?: string };
        if (body.email === "dup@example.com") {
          return Promise.resolve(
            fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "already_member", message: "x" } }) }),
          );
        }
        const added = member("u-carol", body.email, "Carol", (body.role as GroupMemberRole) ?? "member");
        members = [...members, added];
        return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(added) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument());

    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com" } });
    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: "admin" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === `/api/groups/${GROUP_ADMIN.id}/members` && (i as RequestInit)?.method === "PUT",
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ email: "carol@example.com", role: "admin" });
    });
    await waitFor(() => expect(within(dialog).getByText("carol@example.com")).toBeInTheDocument());

    // 409 already_member → 表單下 alert，名單不變。
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "dup@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("That person is already in this group.");
  });

  it("改角色：PATCH /members/:userId {role:'admin'}；移除：DELETE /members/:userId（無確認）", async () => {
    let members = [member(ME.id, ME.email, "Me", "admin"), member("u-bob", "bob@example.com", "Bob", "admin"), member("u-carol", "carol@example.com", "Carol", "member")];

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_ADMIN]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members/u-carol` && method === "PATCH") {
        members = members.map((m) => (m.userId === "u-carol" ? { ...m, role: "admin" } : m));
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members[2]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members/u-bob` && method === "DELETE") {
        members = members.filter((m) => m.userId !== "u-bob");
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("carol@example.com")).toBeInTheDocument());

    fireEvent.change(within(dialog).getByLabelText("Role for carol@example.com"), { target: { value: "admin" } });
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === `/api/groups/${GROUP_ADMIN.id}/members/u-carol` && (i as RequestInit)?.method === "PATCH",
      );
      expect(call).toBeDefined();
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ role: "admin" });
    });

    // 移除：無確認對話框，點了就直接 DELETE。
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove bob@example.com" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([u, i]) => String(u) === `/api/groups/${GROUP_ADMIN.id}/members/u-bob` && (i as RequestInit)?.method === "DELETE",
      );
      expect(call).toBeDefined();
    });
    await waitFor(() => expect(within(dialog).queryByText("bob@example.com")).not.toBeInTheDocument());
  });

  it("刪除群組：確認對話框（文案含群組名）→ DELETE /api/groups/:id → 導回 /settings/groups", async () => {
    const members = [member(ME.id, ME.email, "Me", "admin")];
    let deleted = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(deleted ? [] : [GROUP_ADMIN]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE") {
        deleted = true;
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete group" })).toBeInTheDocument());

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Delete group?" });
    expect(confirmDialog).toHaveTextContent('Notes in "Team Alpha" become personal notes. Current members keep their access at their current role.');
    expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/groups/${GROUP_ADMIN.id}` && (i as RequestInit)?.method === "DELETE")).toBe(false);

    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u) === `/api/groups/${GROUP_ADMIN.id}` && (i as RequestInit)?.method === "DELETE")).toBe(true),
    );

    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/settings\/groups\|/));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group?" })).not.toBeInTheDocument());
  });

  it("member 視角：名稱唯讀（沒有輸入框與 Save name）、成員表無控制項、沒有加人表單；「退出群組」確認 → DELETE /members/<me> → 導回 /settings/groups；409 last_admin → toast", async () => {
    const members = [member("u-admin2", "admin2@example.com", "Admin2", "admin"), member(ME.id, ME.email, "Me", "member")];

    // 分兩段各自 render／unmount：DELETE 的成功與 409 兩種結果不能共存於同一次
    // mock 回應，用兩次獨立 render 各驗一種結果，而不是把兩案拆成兩個 it（brief 把
    // 兩者寫在同一句案名裡）。
    function buildFetchMock(leaveOutcome: "success" | "last_admin") {
      return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        const base = baseFetchHandlers()(url, method);
        if (base) return Promise.resolve(base);
        if (url === "/api/groups" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_MEMBER]) }));
        }
        if (url === `/api/groups/${GROUP_MEMBER.id}/members` && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
        }
        if (url === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && method === "DELETE") {
          if (leaveOutcome === "last_admin") {
            return Promise.resolve(
              fakeResponse({ ok: false, status: 409, json: () => Promise.resolve({ error: { code: "last_admin", message: "x" } }) }),
            );
          }
          return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      });
    }

    // Phase 1：唯讀畫面形狀 + 退出成功 → 導回 /settings/groups。
    const successFetch = buildFetchMock("success");
    const phase1 = renderDetailRoute(`/settings/groups/${GROUP_MEMBER.id}`, successFetch);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());

    // 名稱唯讀：沒有輸入框、沒有 Save name 鈕（但頁首仍是群組名，走 heading）。
    expect(within(dialog).getByRole("heading", { name: "Team Beta" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Group name")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();

    // 成員表無控制項：沒有角色下拉、沒有移除鈕；角色以純文字顯示。
    expect(within(dialog).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(dialog).getByText("Admin")).toBeInTheDocument();

    // 沒有加人表單。
    expect(within(dialog).queryByLabelText("Email address")).not.toBeInTheDocument();

    // 退出群組（成功）：二次確認 → DELETE /members/<me> → 導回 /settings/groups。
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave group" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Leave group?" });
    expect(confirmDialog).toHaveTextContent('You will lose access to the notes in "Team Beta".');
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Leave group" }));

    await waitFor(() =>
      expect(
        successFetch.mock.calls.some(([u, i]) => String(u) === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && (i as RequestInit)?.method === "DELETE"),
      ).toBe(true),
    );
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/settings\/groups\|/));

    phase1.unmount();
    vi.unstubAllGlobals();

    // Phase 2：409 last_admin → toast，不導頁。
    const lastAdminFetch = buildFetchMock("last_admin");
    renderDetailRoute(`/settings/groups/${GROUP_MEMBER.id}`, lastAdminFetch);
    const dialog2 = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog2).getByRole("button", { name: "Leave group" })).toBeInTheDocument());

    fireEvent.click(within(dialog2).getByRole("button", { name: "Leave group" }));
    const confirmDialog2 = await screen.findByRole("dialog", { name: "Leave group?" });
    fireEvent.click(within(confirmDialog2).getByRole("button", { name: "Leave group" }));

    await waitFor(() =>
      expect(screen.getByText("A group needs at least one admin. Make someone else an admin first, or delete the group.")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("location").textContent).toMatch(new RegExp(`^/settings/groups/${GROUP_MEMBER.id}\\|`));
  });

  it("id 不是我的群組（或不合法）→ errors.not_found", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_ADMIN]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderDetailRoute("/settings/groups/not-a-real-id", fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("We couldn't find what you were looking for."));
  });

  it("頁首有「All groups」連結回 /settings/groups 並保留 backgroundLocation", async () => {
    const members = [member(ME.id, ME.email, "Me", "admin")];
    const bgLocation = { pathname: "/n/me/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([GROUP_ADMIN]) }));
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(members) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderDetailRoute({ pathname: `/settings/groups/${GROUP_ADMIN.id}`, state: { backgroundLocation: bgLocation } }, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "Team Alpha" })).toBeInTheDocument());
    const backLink = within(dialog).getByRole("link", { name: /All groups/ });
    expect(backLink).toHaveAttribute("href", "/settings/groups");

    fireEvent.click(backLink);

    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/settings\/groups\|/));
    const [, stateJson] = screen.getByTestId("location").textContent!.split("|");
    expect(JSON.parse(stateJson)).toEqual({ backgroundLocation: bgLocation });
  });
});
