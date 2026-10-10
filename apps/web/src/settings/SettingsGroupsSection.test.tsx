import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";

// `/settings/groups`（spec §8.4 前半，Task 7）：所有登入者的群組列表，掛在
// `SettingsModal` 底下的巢狀 route——render helper 照抄 `SettingsUsersSection.test.tsx`
// 的做法（真 `AppRoutes`、`MemoryRouter`、fetch 分派 `/api/auth/me`／`/api/notes`／
// `/api/groups`）。這裡不測 `backgroundLocation`／Esc 行為（那兩案在
// `SettingsModal.test.tsx`，因為只有那個檔有 `note-editor`／collab 替身）。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const ADMIN_USER: UserDto = {
  id: "u-admin",
  email: "admin@example.com",
  handle: "tester",
  displayName: "Admin",
  isAdmin: true,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

const ADMIN_GROUP: GroupDto = groupDto(
  { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
  adminRole(),
);

const MEMBER_GROUP: GroupDto = groupDto(
  { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta", createdAt: "2026-01-02T00:00:00.000Z" },
  memberRole(),
);

/** #175：自訂角色（`builtin: null`）——顯示名用它自己的 `name`，不走 i18n。 */
const CUSTOM_ROLE_GROUP: GroupDto = groupDto(
  { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "Team Gamma", createdAt: "2026-01-03T00:00:00.000Z" },
  memberRole({ id: "r-reader", builtin: null, name: "讀者" }),
);

/** 只回 `/api/groups` 的 fetch mock（其餘交給 baseFetchHandlers）。 */
function groupsFetch(groups: GroupDto[]) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const base = baseFetchHandlers()(url, method);
    if (base) return Promise.resolve(base);
    if (url === "/api/groups" && method === "GET") {
      return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

/** 基本 fetch mock：`/api/auth/me`（一律回 `ADMIN_USER`）、`/api/notes`（背景
 * `HomePage` 需要）。呼叫端疊加 `/api/groups` 與其餘端點。 */
function baseFetchHandlers(): (url: string, method: string) => Response | null {
  return (url: string, method: string): Response | null => {
    if (url === "/api/auth/me" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(ADMIN_USER) });
    }
    if (url === "/api/notes" && method === "GET") {
      return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) });
    }
    return null;
  };
}

function renderGroupsRoute(fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/settings/groups"]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
}

describe("SettingsGroupsSection（/settings/groups，spec §8.4：所有登入者的群組列表）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("列出我的群組：名稱是連到 /settings/groups/:id 的連結、我的角色、列內 ⋮", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([ADMIN_GROUP, MEMBER_GROUP]) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderGroupsRoute(fetchMock);

    // 背景頁（HomePage 的側欄工作坊分段）也吃同一份 `useGroups()` 快取，會用同樣的
    // 群組名字渲染另一份 DOM——一律 `within(dialog)` 才不會誤命中背景層。
    const dialog = await screen.findByRole("dialog");
    // 本檔第一次載入群組區塊 lazy chunk（dialog 外殼在首包、不用等）
    await waitFor(() => expect(within(dialog).getByText(ADMIN_GROUP.name)).toBeInTheDocument());
    expect(within(dialog).getByText(MEMBER_GROUP.name)).toBeInTheDocument();

    expect(within(dialog).getByRole("link", { name: ADMIN_GROUP.name })).toHaveAttribute(
      "href",
      `/settings/groups/${ADMIN_GROUP.id}`,
    );
    expect(within(dialog).getByRole("link", { name: MEMBER_GROUP.name })).toHaveAttribute(
      "href",
      `/settings/groups/${MEMBER_GROUP.id}`,
    );

    expect(within(dialog).getByText("Admin")).toBeInTheDocument();
    expect(within(dialog).getByText("Member")).toBeInTheDocument();

    expect(within(dialog).getAllByRole("button", { name: /Group actions for/ })).toHaveLength(2);
  });

  // #175 §2.11／§12.2（gate r4 N-1）：`myRole` 改成物件之後，`` t(`groups.role.${group.myRole}`) `` 會渲染出
  // `groups.role.[object Object]`——tsc 與 lint 都不擋（樣板字串吃任何型別），只有這種 DOM 斷言攔得住。
  it("#175 角色欄三形：內建管理員／內建一般成員走 i18n、自訂角色用自己的 name；整頁沒有 [object Object]", async () => {
    renderGroupsRoute(groupsFetch([ADMIN_GROUP, MEMBER_GROUP, CUSTOM_ROLE_GROUP]));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(CUSTOM_ROLE_GROUP.name)).toBeInTheDocument());
    const roleCell = (groupName: string) =>
      within(within(dialog).getByRole("link", { name: groupName }).closest("tr") as HTMLElement).getAllByRole("cell")[1];
    expect(roleCell(ADMIN_GROUP.name)).toHaveTextContent(/^Admin$/);
    expect(roleCell(MEMBER_GROUP.name)).toHaveTextContent(/^Member$/);
    expect(roleCell(CUSTOM_ROLE_GROUP.name)).toHaveTextContent(/^讀者$/);
    expect(document.body).not.toHaveTextContent("[object Object]");
    expect(document.body).not.toHaveTextContent("groups.role.");
  });

  it("#175 角色欄 zh-TW：內建兩個角色顯示「管理員」「一般成員」（§2.11 用詞）", async () => {
    await i18n.changeLanguage("zh-TW");
    try {
      renderGroupsRoute(groupsFetch([ADMIN_GROUP, MEMBER_GROUP]));
      const dialog = await screen.findByRole("dialog");
      await waitFor(() => expect(within(dialog).getByText(MEMBER_GROUP.name)).toBeInTheDocument());
      const roleCell = (groupName: string) =>
        within(within(dialog).getByRole("link", { name: groupName }).closest("tr") as HTMLElement).getAllByRole("cell")[1];
      expect(roleCell(ADMIN_GROUP.name)).toHaveTextContent(/^管理員$/);
      expect(roleCell(MEMBER_GROUP.name)).toHaveTextContent(/^一般成員$/);
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("#175：myRole 為 null 的群組（GET /api/groups 理論上不回，防禦）→ 不列", async () => {
    const noRole = groupDto({ id: "dddddddd-dddd-dddd-dddd-dddddddddddd", name: "Team Ghost" }, null);
    renderGroupsRoute(groupsFetch([ADMIN_GROUP, noRole]));

    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(ADMIN_GROUP.name)).toBeInTheDocument());
    expect(within(dialog).queryByRole("link", { name: "Team Ghost" })).toBeNull();
    expect(within(dialog).getAllByRole("button", { name: /Group actions for/ })).toHaveLength(1);
  });

  it("空清單 → groups.settings.empty 文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderGroupsRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("You're not in any group yet.")).toBeInTheDocument());
  });

  it("頁首「New group」是本頁唯一實心鈕（brandDeep）→ 開 GroupNameDialog；建立後列表出現新群組", async () => {
    let groups: GroupDto[] = [];
    const NEW_GROUP: GroupDto = groupDto(
      { id: "cccccccc-cccc-cccc-cccc-cccccccccccc", name: "New Workshop", createdAt: "2026-01-03T00:00:00.000Z" },
      adminRole(),
    );
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(groups) }));
      }
      if (url === "/api/groups" && method === "POST") {
        groups = [NEW_GROUP];
        return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(NEW_GROUP) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderGroupsRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument());

    const trigger = screen.getByRole("button", { name: "New group" });
    expect(trigger).toHaveClass("bg-brand-deep");
    // 本頁唯一實心鈕：整頁只有這一顆帶 `bg-brand-deep`。
    expect(document.querySelectorAll(".bg-brand-deep")).toHaveLength(1);

    fireEvent.click(trigger);

    const createDialog = await screen.findByRole("dialog");
    expect(within(createDialog).getByRole("heading", { name: "New group" })).toBeInTheDocument();

    fireEvent.change(within(createDialog).getByLabelText("Group name"), { target: { value: NEW_GROUP.name } });
    fireEvent.click(within(createDialog).getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        ([reqUrl, reqInit]) => String(reqUrl) === "/api/groups" && (reqInit as RequestInit | undefined)?.method === "POST",
      );
      expect(call).toBeDefined();
    });

    // create dialog 關閉後只剩 SettingsModal 自己的 dialog——背景側欄工作坊分段也吃同一份
    // `useGroups()` 快取而重複渲染同名字，一律 `within` 這個 dialog 才不誤命中背景層。
    const settingsDialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(settingsDialog).getByText(NEW_GROUP.name)).toBeInTheDocument());
    expect(within(settingsDialog).queryByRole("heading", { name: "New group" })).not.toBeInTheDocument();
  });

  it("導覽項「Groups」在「Account」之後（站台管理搬到 /admin/* 後，設定 modal 只剩這兩項）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const base = baseFetchHandlers()(url, method);
      if (base) return Promise.resolve(base);
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });

    renderGroupsRoute(fetchMock);

    await waitFor(() => expect(screen.getByRole("heading", { name: "Groups" })).toBeInTheDocument());

    const nav = within(screen.getByRole("navigation"));
    const labels = nav.getAllByRole("link").map((link) => link.textContent);
    expect(labels).toEqual(["Account", "Groups"]);
  });
});
