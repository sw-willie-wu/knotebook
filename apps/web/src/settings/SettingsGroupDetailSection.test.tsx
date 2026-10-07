import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import type { GroupDto, GroupMemberDto, GroupRoleDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";

// `/settings/groups/:id`（#103 spec §8.4 後半；#175 spec §8.5／§8.6）：詳情頁——真 `AppRoutes`、
// `MemoryRouter`、fetch 分派 `/api/auth/me`／`/api/notes`／`/api/groups`／`…/members`／`…/roles`。
// 背景側欄的工作坊分段吃同一份 `useGroups()` 快取會渲染同樣的群組名字——一律 `within(dialog)`
// 才不誤命中背景層。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

function ok(body: unknown, status = 200): Response {
  return fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });
}

function fail(status: number, code: string): Response {
  return fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });
}

/** 記下每次成功 navigate 之後的 location（「導回 /settings/groups」與「保留 backgroundLocation」用）。 */
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

/** `GET …/roles` 的兩個內建角色（id 刻意不是 "admin"／"member"——送出的必須是角色 id，不是 builtin 名）。 */
const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
const ROLES: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE];

/** 我是唯一的管理員（`memberCount` 1）。 */
const GROUP_ADMIN: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha", createdAt: "2026-01-01T00:00:00.000Z" }, ADMIN_ROLE);
/** 我是兩位管理員之一。 */
const GROUP_CO_ADMIN: GroupDto = { ...GROUP_ADMIN, myRole: { ...ADMIN_ROLE, memberCount: 2 } };
const GROUP_MEMBER: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta", createdAt: "2026-01-02T00:00:00.000Z" }, MEMBER_ROLE);

function member(userId: string, email: string, displayName: string, role: GroupRoleDto): GroupMemberDto {
  return { userId, email, displayName, roleId: role.id, builtin: role.builtin };
}

type Handler = (url: string, method: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

/**
 * 標準 fetch mock：`/api/auth/me`、`/api/notes`、`GET /api/groups`（回 `[group]`）、`GET …/members`（回
 * `getMembers()` 當下的值）、`GET …/roles`（回 `ROLES`）；`extra` 先比對，其餘 throw（慣例）。
 */
function fetchFor(group: GroupDto, getMembers: () => GroupMemberDto[] | Promise<Response>, extra: Handler = () => null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(ok(ME));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(ok([]));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(ok([group]));
    if (url === `/api/groups/${group.id}/members` && method === "GET") {
      const members = getMembers();
      return members instanceof Promise ? members : Promise.resolve(ok(members));
    }
    if (url === `/api/groups/${group.id}/roles` && method === "GET") return Promise.resolve(ok(ROLES));
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, url: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method)
    .map(([, i]) => i as RequestInit);
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

/** 角色下拉的選項（value、顯示文字）。 */
function optionsOf(select: HTMLElement): Array<[string, string | null]> {
  return within(select)
    .getAllByRole("option")
    .map((option) => [(option as HTMLOptionElement).value, option.textContent]);
}

const ROLE_OPTIONS: Array<[string, string]> = [
  [ADMIN_ROLE.id, "Admin"],
  [MEMBER_ROLE.id, "Member"],
];

describe("SettingsGroupDetailSection（/settings/groups/:id，spec §8.5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("canManageMembers＋canManageGroup：名稱可改（PATCH）、成員表有 email（A8）、角色下拉（選項來自 GET …/roles）、移除鈕；加人表單；刪除群組", async () => {
    let group = { ...GROUP_ADMIN };
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const fetchMock = fetchFor(GROUP_ADMIN, () => members, (url, method) => {
      if (url === "/api/groups" && method === "GET") return ok([group]);
      if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "PATCH") {
        group = { ...group, name: "Team Alpha Renamed" };
        return ok(group);
      }
      return null;
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);

    const dialog = await screen.findByRole("dialog");
    // 本檔第一次載入群組詳情區塊 lazy chunk（dialog 外殼在首包、不用等）
    await waitFor(
      () => expect(within(dialog).getByRole("heading", { name: "Team Alpha" })).toBeInTheDocument(),
    );

    // 名稱可改：輸入框預填目前名稱、Save name 送 PATCH。
    const nameInput = within(dialog).getByLabelText("Group name");
    expect(nameInput).toHaveValue("Team Alpha");
    fireEvent.change(nameInput, { target: { value: "Team Alpha Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByText("Group renamed.")).toBeInTheDocument());

    // 成員表：email、角色下拉（值＝角色 id、選項＝GET …/roles 的全部角色、內建兩個走 i18n）、移除鈕。
    expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument();
    expect(within(dialog).getByText("me@example.com")).toBeInTheDocument();
    const bobSelect = within(dialog).getByLabelText("Role for bob@example.com");
    await waitFor(() => expect(optionsOf(bobSelect)).toEqual(ROLE_OPTIONS));
    expect(bobSelect).toHaveValue(MEMBER_ROLE.id);
    expect(within(dialog).getByLabelText("Role for me@example.com")).toHaveValue(ADMIN_ROLE.id);
    expect(within(dialog).getByRole("button", { name: "Remove bob@example.com" })).toBeInTheDocument();
    expect(callsTo(fetchMock, "GET", `/api/groups/${GROUP_ADMIN.id}/roles`).length).toBeGreaterThanOrEqual(1);

    // 加人表單：角色下拉同樣列 roles。
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();
    expect(optionsOf(within(dialog).getByLabelText("Role for new member"))).toEqual(ROLE_OPTIONS);
    expect(within(dialog).getByRole("button", { name: "Add" })).toBeInTheDocument();

    // 刪除群組。
    expect(within(dialog).getByRole("button", { name: "Delete group" })).toBeInTheDocument();
  });

  it("#183 長 email 版面守衛：名字／email 兩格 wrap-anywhere、操作欄 w-px 不換行、移除鈕是固定寬的圖示鈕且可見文字不含 email", async () => {
    // jsdom 不排版——量不到溢出，只能釘住決定溢出與否的 class token（真瀏覽器的量測見 PR）。
    // token 一律 `classList` 陣列比對，不用字串 includes（`min-w-px` 也含 `w-px`）。
    const LONG = "e2e-24c8c7dd-e54e-4237-9f72-a87df48a3fc2@e2e.local";
    renderDetailRoute(
      `/settings/groups/${GROUP_CO_ADMIN.id}`,
      fetchFor(GROUP_CO_ADMIN, () => [
        member(ME.id, ME.email, "Me", ADMIN_ROLE),
        member("u-long", LONG, "A-very-long-display-name-without-any-spaces-at-all", MEMBER_ROLE),
      ]),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText(LONG)).toBeInTheDocument());
    const tokens = (el: Element | null) => [...(el?.classList ?? [])];

    // email 與名字那兩格要能在任意處斷行（auto 表格的 min-content 才會跟著縮）。
    const emailCell = within(dialog).getByText(LONG).closest("td");
    expect(emailCell, "email 應該在一個 <td> 裡").not.toBeNull();
    expect(tokens(emailCell)).toContain("wrap-anywhere");
    const nameCell = within(dialog).getByText("A-very-long-display-name-without-any-spaces-at-all").closest("td");
    expect(tokens(nameCell)).toContain("wrap-anywhere");

    // 移除鈕：可見文字不帶 email（曾經是「Remove <email>」整串、不換行，自己就把欄撐爆），
    // 可及名稱仍帶 email（e2e 15／16／17 靠它）；固定 32px 寬、不參與 flex 擠壓。
    const removeButton = within(dialog).getByRole("button", { name: `Remove ${LONG}` });
    expect(removeButton.textContent ?? "").not.toContain(LONG);
    expect(removeButton.textContent ?? "").not.toContain("@");
    expect(tokens(removeButton)).toEqual(expect.arrayContaining(["w-8", "h-8", "shrink-0"]));

    // 操作欄（表頭與每一列的那一格）收到內容寬、不換行。
    const actionCell = removeButton.closest("td");
    expect(tokens(actionCell)).toEqual(expect.arrayContaining(["w-px", "whitespace-nowrap"]));
    const actionHeader = within(dialog).getByRole("columnheader", { name: "Actions" });
    expect(tokens(actionHeader)).toEqual(expect.arrayContaining(["w-px", "whitespace-nowrap"]));
    // 角色欄也不換行（下拉不能被擠成兩行高）。
    expect(tokens(within(dialog).getByLabelText(`Role for ${LONG}`).closest("td"))).toContain("whitespace-nowrap");
  });

  it("最後一位管理員的列（builtin admin 只有一人）：角色下拉與移除鈕 disabled 且 title=lastAdminHint、表格下方有可見提示；兩位管理員時不 disabled、無提示", async () => {
    const HINT = "The only admin can't be demoted or removed. Make someone else an admin first.";
    const phase1 = renderDetailRoute(
      `/settings/groups/${GROUP_ADMIN.id}`,
      fetchFor(GROUP_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)]),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());

    const meRoleSelect = within(dialog).getByLabelText("Role for me@example.com");
    expect(meRoleSelect).toBeDisabled();
    expect(meRoleSelect).toHaveAttribute("title", HINT);
    const meRemoveButton = within(dialog).getByRole("button", { name: "Remove me@example.com" });
    expect(meRemoveButton).toBeDisabled();
    expect(meRemoveButton).toHaveAttribute("title", HINT);
    expect(within(dialog).getByText(HINT)).toBeInTheDocument();
    // 一般成員那列不受影響
    expect(within(dialog).getByLabelText("Role for bob@example.com")).not.toBeDisabled();

    phase1.unmount();
    vi.unstubAllGlobals();

    renderDetailRoute(
      `/settings/groups/${GROUP_CO_ADMIN.id}`,
      fetchFor(GROUP_CO_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE)]),
    );
    const dialog2 = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog2).getByText("bob@example.com")).toBeInTheDocument());

    expect(within(dialog2).getByLabelText("Role for me@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByLabelText("Role for bob@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByRole("button", { name: "Remove me@example.com" })).not.toBeDisabled();
    expect(within(dialog2).getByRole("button", { name: "Remove bob@example.com" })).not.toBeDisabled();
    expect(within(dialog2).queryByText(HINT)).not.toBeInTheDocument();
  });

  it("加人：PUT {email, roleId}（下拉選管理員 → 管理員角色 id）→ 名單更新；送出後下拉回到內建一般成員的 id；409 already_member → 表單下 alert", async () => {
    let members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    const fetchMock = fetchFor(GROUP_ADMIN, () => members, (url, method, init) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") {
        const body = JSON.parse(String(init?.body)) as { email: string; roleId?: string };
        if (body.email === "dup@example.com") return fail(409, "already_member");
        const role = ROLES.find((r) => r.id === body.roleId) ?? MEMBER_ROLE;
        const added = member("u-carol", body.email, "Carol", role);
        members = [...members, added];
        return ok(added, 201);
      }
      return null;
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    const roleSelect = await within(dialog).findByLabelText("Role for new member");
    // 預設選內建一般成員那一個的 id
    await waitFor(() => expect(roleSelect).toHaveValue(MEMBER_ROLE.id));

    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com" } });
    fireEvent.change(roleSelect, { target: { value: ADMIN_ROLE.id } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const url = `/api/groups/${GROUP_ADMIN.id}/members`;
    await waitFor(() => expect(callsTo(fetchMock, "PUT", url)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[0].body))).toEqual({ email: "carol@example.com", roleId: ADMIN_ROLE.id });
    await waitFor(() => expect(within(dialog).getByText("carol@example.com")).toBeInTheDocument());
    expect(within(dialog).getByLabelText("Role for carol@example.com")).toHaveValue(ADMIN_ROLE.id);
    expect(roleSelect).toHaveValue(MEMBER_ROLE.id);

    // 409 already_member → 表單下 alert；這一發用的是重設後的預設角色。
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "dup@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("That person is already in this group.");
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[1].body))).toEqual({ email: "dup@example.com", roleId: MEMBER_ROLE.id });
  });

  it("加人：roles 還沒到時不送 roleId（body 只有 {email}，server 預設內建一般成員）", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    const fetchMock = fetchFor(GROUP_ADMIN, () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}/roles` && method === "GET") return new Promise<Response>(() => {});
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") return ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201);
      return null;
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument());
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));

    const url = `/api/groups/${GROUP_ADMIN.id}/members`;
    await waitFor(() => expect(callsTo(fetchMock, "PUT", url)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[0].body))).toEqual({ email: "carol@example.com" });
  });

  it("改角色：PATCH /members/:userId {roleId: 管理員角色 id}；移除：DELETE /members/:userId（無確認）", async () => {
    let members = [
      member(ME.id, ME.email, "Me", ADMIN_ROLE),
      member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE),
      member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE),
    ];
    const fetchMock = fetchFor(GROUP_CO_ADMIN, () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-carol` && method === "PATCH") {
        members = members.map((m) => (m.userId === "u-carol" ? { ...m, roleId: ADMIN_ROLE.id, builtin: "admin" } : m));
        return ok(members[2]);
      }
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob` && method === "DELETE") {
        members = members.filter((m) => m.userId !== "u-bob");
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });

    renderDetailRoute(`/settings/groups/${GROUP_CO_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    const carolSelect = await within(dialog).findByLabelText("Role for carol@example.com");
    await waitFor(() => expect(optionsOf(carolSelect)).toEqual(ROLE_OPTIONS));

    fireEvent.change(carolSelect, { target: { value: ADMIN_ROLE.id } });
    const patchUrl = `/api/groups/${GROUP_CO_ADMIN.id}/members/u-carol`;
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", patchUrl)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", patchUrl)[0].body))).toEqual({ roleId: ADMIN_ROLE.id });

    // 移除：無確認對話框，點了就直接 DELETE。
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove bob@example.com" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob`)).toHaveLength(1));
    await waitFor(() => expect(within(dialog).queryByText("bob@example.com")).not.toBeInTheDocument());
  });

  it("#175 gate r2 M-7：兩位管理員、沒有一般成員的群組，把其中一位降成一般成員 → PATCH body 是 {roleId: 一般成員角色 id}", async () => {
    let members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE)];
    const fetchMock = fetchFor(GROUP_CO_ADMIN, () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob` && method === "PATCH") {
        members = members.map((m) => (m.userId === "u-bob" ? { ...m, roleId: MEMBER_ROLE.id, builtin: "member" } : m));
        return ok(members[1]);
      }
      return null;
    });

    renderDetailRoute(`/settings/groups/${GROUP_CO_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    const bobSelect = await within(dialog).findByLabelText("Role for bob@example.com");
    // 名單裡沒有任何一般成員——一般成員角色的 id 只可能來自 GET …/roles
    await waitFor(() => expect(optionsOf(bobSelect)).toEqual(ROLE_OPTIONS));
    expect(bobSelect).not.toBeDisabled();

    fireEvent.change(bobSelect, { target: { value: MEMBER_ROLE.id } });
    const patchUrl = `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob`;
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", patchUrl)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", patchUrl)[0].body))).toEqual({ roleId: MEMBER_ROLE.id });
    // 降級後只剩我一位管理員：我的列鎖住
    await waitFor(() => expect(within(dialog).getByLabelText("Role for me@example.com")).toBeDisabled());
    expect(within(dialog).getByLabelText("Role for bob@example.com")).toHaveValue(MEMBER_ROLE.id);
  });

  it("刪除群組：兩模式對話框 → 選全部刪除、勾確認 → DELETE {mode:'delete'} → 導回 /settings/groups", async () => {
    let deleted = false;
    const fetchMock = fetchFor(GROUP_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) => {
      if (url === "/api/groups" && method === "GET") return ok(deleted ? [] : [GROUP_ADMIN]);
      if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE") {
        deleted = true;
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete group" })).toBeInTheDocument());
    expect(dialog).toHaveTextContent("Deleting the group either gives its notes to one of its admins or deletes them with it.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Delete group?" });
    expect(within(confirmDialog).getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(0);

    fireEvent.click(within(confirmDialog).getByRole("radio", { name: "Delete everything" }));
    expect(within(confirmDialog).getByRole("button", { name: "Delete group" })).toBeDisabled();
    fireEvent.click(within(confirmDialog).getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)[0].body))).toEqual({ mode: "delete" });
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/settings\/groups\|/));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group?" })).not.toBeInTheDocument());
  });

  it("刪除群組 → 409 not_admin → toast errors.not_admin、**確認對話框留著**、不導頁（spec §8.6）", async () => {
    const fetchMock = fetchFor(GROUP_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) =>
      url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE" ? fail(409, "not_admin") : null,
    );

    renderDetailRoute(`/settings/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Delete group" })).toBeInTheDocument());
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Delete group?" });
    await waitFor(() => expect(within(confirmDialog).getByLabelText("Admin who gets the notes")).toHaveValue(ME.id));
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Delete group" }));

    await waitFor(() => expect(screen.getByText("The notes can only be handed to one of the group's admins. Pick someone who is still an admin.", { exact: true })).toBeInTheDocument());
    expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1);
    expect(JSON.parse(String(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)[0].body))).toEqual({ mode: "transfer", transferTo: ME.id });
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    expect(screen.getByTestId("location").textContent).toMatch(new RegExp(`^/settings/groups/${GROUP_ADMIN.id}\\|`));
  });

  it("一般成員視角：名稱唯讀、成員表唯讀（角色名走 roles：內建 i18n、自訂用 name）、沒有加人表單；「退出群組」確認 → DELETE /members/<me> → 導回；409 last_admin → toast", async () => {
    const READER: GroupRoleDto = { ...MEMBER_ROLE, id: "33333333-3333-3333-3333-333333333333", builtin: null, name: "Reader" };
    const members = [
      member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE),
      member(ME.id, ME.email, "Me", MEMBER_ROLE),
      member("u-dan", "dan@example.com", "Dan", READER),
    ];
    function build(leaveOutcome: "success" | "last_admin") {
      return fetchFor(GROUP_MEMBER, () => members, (url, method) => {
        if (url === `/api/groups/${GROUP_MEMBER.id}/roles` && method === "GET") return ok([...ROLES, READER]);
        if (url === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && method === "DELETE") {
          return leaveOutcome === "last_admin" ? fail(409, "last_admin") : fakeResponse({ ok: true, status: 204 });
        }
        return null;
      });
    }

    // Phase 1：唯讀畫面形狀 + 退出成功 → 導回 /settings/groups。
    const successFetch = build("success");
    const phase1 = renderDetailRoute(`/settings/groups/${GROUP_MEMBER.id}`, successFetch);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());

    expect(within(dialog).getByRole("heading", { name: "Team Beta" })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Group name")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();

    // 成員表無控制項：沒有角色下拉、沒有移除鈕；角色以純文字顯示。
    expect(within(dialog).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    const roleCell = (email: string) => within(dialog).getByText(email).closest("tr")!.querySelectorAll("td")[2];
    expect(roleCell("admin2@example.com")).toHaveTextContent(/^Admin$/);
    expect(roleCell("me@example.com")).toHaveTextContent(/^Member$/);
    await waitFor(() => expect(roleCell("dan@example.com")).toHaveTextContent(/^Reader$/));
    expect(within(dialog).queryByText("[object Object]", { exact: false })).not.toBeInTheDocument();

    // 沒有加人表單、沒有刪除群組。
    expect(within(dialog).queryByLabelText("Email address")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete group" })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Leave group" }));
    const confirmDialog = await screen.findByRole("dialog", { name: "Leave group?" });
    expect(confirmDialog).toHaveTextContent('You will lose access to the notes in "Team Beta".');
    fireEvent.click(within(confirmDialog).getByRole("button", { name: "Leave group" }));

    await waitFor(() => expect(callsTo(successFetch, "DELETE", `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}`)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(/^\/settings\/groups\|/));

    phase1.unmount();
    vi.unstubAllGlobals();

    // Phase 2：409 last_admin（競態後備）→ toast，不導頁。
    renderDetailRoute(`/settings/groups/${GROUP_MEMBER.id}`, build("last_admin"));
    const dialog2 = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog2).getByRole("button", { name: "Leave group" })).toBeInTheDocument());

    fireEvent.click(within(dialog2).getByRole("button", { name: "Leave group" }));
    const confirmDialog2 = await screen.findByRole("dialog", { name: "Leave group?" });
    fireEvent.click(within(confirmDialog2).getByRole("button", { name: "Leave group" }));

    await waitFor(() => expect(screen.getByText("A group needs at least one admin. Make someone else an admin first.", { exact: true })).toBeInTheDocument());
    // 退出失敗（409）時確認對話框關閉——與刪群組（DeleteGroupDialog）的「留著」相反
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave group?" })).not.toBeInTheDocument());
    expect(screen.getByTestId("location").textContent).toMatch(new RegExp(`^/settings/groups/${GROUP_MEMBER.id}\\|`));
  });

  it("退出區（spec §8.2）：最後一位管理員看不到「退出群組」；兩位管理員之一看得到（與刪除群組並列）", async () => {
    const phase1 = renderDetailRoute(
      `/settings/groups/${GROUP_ADMIN.id}`,
      fetchFor(GROUP_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)]),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());
    expect(within(dialog).getByRole("button", { name: "Delete group" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();

    phase1.unmount();
    vi.unstubAllGlobals();

    renderDetailRoute(
      `/settings/groups/${GROUP_CO_ADMIN.id}`,
      fetchFor(GROUP_CO_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE)]),
    );
    const dialog2 = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog2).getByText("bob@example.com")).toBeInTheDocument());
    expect(within(dialog2).getByRole("button", { name: "Delete group" })).toBeInTheDocument();
    expect(within(dialog2).getByRole("button", { name: "Leave group" })).toBeInTheDocument();
  });

  it("退出區：成員名單還在載入時不渲染（名單到了才判得出是不是最後一位管理員）", async () => {
    const gate: { release?: () => void } = {};
    const members = [member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const fetchMock = fetchFor(
      GROUP_MEMBER,
      () =>
        new Promise<Response>((resolve) => {
          gate.release = () => resolve(ok(members));
        }),
    );

    renderDetailRoute(`/settings/groups/${GROUP_MEMBER.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "Team Beta" })).toBeInTheDocument());
    await waitFor(() => expect(gate.release).toBeDefined());
    expect(within(dialog).queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();

    gate.release?.();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Leave group" })).toBeInTheDocument());
  });

  it("兩個管理旗標分開看：只有 canManageMembers → 角色下拉／移除／加人，沒有改名與刪除；只有 canManageGroup → 改名與刪除，成員表唯讀", async () => {
    const members = [member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const membersOnly: GroupDto = { ...GROUP_MEMBER, canManageMembers: true, canManageGroup: false };
    const phase1 = renderDetailRoute(`/settings/groups/${membersOnly.id}`, fetchFor(membersOnly, () => members));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());
    expect(within(dialog).getByLabelText("Role for admin2@example.com")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove admin2@example.com" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();
    expect(within(dialog).queryByLabelText("Group name")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete group" })).not.toBeInTheDocument();

    phase1.unmount();
    vi.unstubAllGlobals();

    const groupOnly: GroupDto = { ...GROUP_MEMBER, canManageMembers: false, canManageGroup: true };
    renderDetailRoute(`/settings/groups/${groupOnly.id}`, fetchFor(groupOnly, () => members));
    const dialog2 = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog2).getByText("admin2@example.com")).toBeInTheDocument());
    expect(within(dialog2).getByLabelText("Group name")).toHaveValue("Team Beta");
    expect(within(dialog2).getByRole("button", { name: "Delete group" })).toBeInTheDocument();
    expect(within(dialog2).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog2).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(dialog2).queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("id 不是我的群組（或不合法）→ errors.not_found", async () => {
    renderDetailRoute("/settings/groups/not-a-real-id", fetchFor(GROUP_ADMIN, () => []));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("We couldn't find what you were looking for."));
  });

  it("頁首有「All groups」連結回 /settings/groups 並保留 backgroundLocation", async () => {
    const bgLocation = { pathname: "/n/me/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;
    renderDetailRoute(
      { pathname: `/settings/groups/${GROUP_ADMIN.id}`, state: { backgroundLocation: bgLocation } },
      fetchFor(GROUP_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]),
    );
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("heading", { name: "Team Alpha" })).toBeInTheDocument());
    const backLink = within(dialog).getByRole("link", { name: /All groups/ });
    expect(backLink).toHaveAttribute("href", "/settings/groups");

    fireEvent.click(backLink);

    // 點 All groups 會第一次冷載入 lazy 的 SettingsGroupsSection chunk。
    await waitFor(
      () => expect(screen.getByTestId("location").textContent).toMatch(/^\/settings\/groups\|/),
    );
    const [, stateJson] = screen.getByTestId("location").textContent!.split("|");
    expect(JSON.parse(stateJson)).toEqual({ backgroundLocation: bgLocation });
  });

  it("#175 PR3 分頁：成員頁也有「Group settings sections」nav，Members 是 aria-current；點 Roles → /settings/groups/:id/roles 並保留 backgroundLocation", async () => {
    const bgLocation = { pathname: "/n/me/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;
    renderDetailRoute(
      { pathname: `/settings/groups/${GROUP_ADMIN.id}`, state: { backgroundLocation: bgLocation } },
      fetchFor(GROUP_ADMIN, () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]),
    );
    const dialog = await screen.findByRole("dialog");
    const nav = await within(dialog).findByRole("navigation", { name: "Group settings sections" });
    const membersLink = within(nav).getByRole("link", { name: "Members" });
    const rolesLink = within(nav).getByRole("link", { name: "Roles" });
    expect(membersLink).toHaveAttribute("aria-current", "page");
    expect(rolesLink).not.toHaveAttribute("aria-current");
    expect(rolesLink).toHaveAttribute("href", `/settings/groups/${GROUP_ADMIN.id}/roles`);

    fireEvent.click(rolesLink);

    // 點 Roles 會第一次冷載入 lazy 的 SettingsGroupRolesSection chunk。
    await waitFor(
      () => expect(screen.getByTestId("location").textContent).toMatch(new RegExp(`^/settings/groups/${GROUP_ADMIN.id}/roles\\|`)),
    );
    const [, stateJson] = screen.getByTestId("location").textContent!.split("|");
    expect(JSON.parse(stateJson)).toEqual({ backgroundLocation: bgLocation });
  });
});
