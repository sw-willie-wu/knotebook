import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import type { GroupDto, GroupRoleDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";

// `/settings/groups/:id/roles`（#175 spec §8.5；PR3）：角色頁——真 `AppRoutes`、`MemoryRouter`、fetch 分派。
// 骨架照 `SettingsGroupDetailSection.test.tsx`；背景側欄吃同一份 `useGroups()` 快取，一律 `within(dialog)`。
// Willie 2026-10-01 裁決：閱讀恆真（沒有閱讀開關、送出的 permissions 沒有 `read`）；六個旗標彼此不連動；
// switch 只改本地，按區塊的「套用」才 PATCH。

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

const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
/** 自訂角色：六個可設旗標全關（`customRole` 預設）、兩人掛著。 */
const READER = customRole({ id: "33333333-3333-3333-3333-333333333333", memberCount: 2 });
const ROLES: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE, READER];

const GROUP_ADMIN: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, ADMIN_ROLE);
const GROUP_MEMBER: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, MEMBER_ROLE);

const ALL_OFF = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
const FLAG_LABELS = ["Create", "Edit", "Delete", "Manage public links", "Manage members", "Manage roles & group"];
const FLAG_DESCRIPTIONS = [
  "Create notes in the group, or move or copy a personal note into it. Without Edit, a note you create, move or copy there is read-only for you too.",
  "Change the content and title of the group's notes.",
  "Delete any note in the group, including ones other people created.",
  "Turn the anonymous public link of the group's notes on and off, and change a note's URL name through the API.",
  "Add and remove people and change their roles — including making anyone, themselves included, an Admin. A group always keeps at least one Admin.",
  "Rename or delete the group, and create, change and delete its roles.",
];
const READ_ALWAYS = "Every role can read the group's notes, their backlinks and their AI edit history.";

type Handler = (url: string, method: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

/**
 * 標準 fetch mock：`/api/auth/me`、`/api/notes`、`GET /api/groups`（回 `getGroups()`）、`GET …/members`（`[]`，
 * 分頁切到成員頁時用）、`GET …/roles`（回 `getRoles()` 當下的值）；`extra` 先比對，其餘 throw（慣例）。
 */
function fetchFor(getGroups: () => GroupDto[], getRoles: () => GroupRoleDto[], extra: Handler = () => null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(ok(ME));
    if (url === "/api/notes" && method === "GET") return Promise.resolve(ok([]));
    if (url === "/api/groups" && method === "GET") return Promise.resolve(ok(getGroups()));
    for (const group of getGroups()) {
      if (url === `/api/groups/${group.id}/members` && method === "GET") return Promise.resolve(ok([]));
      if (url === `/api/groups/${group.id}/roles` && method === "GET") return Promise.resolve(ok(getRoles()));
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function callsTo(fetchMock: ReturnType<typeof vi.fn>, method: string, url: string): RequestInit[] {
  return fetchMock.mock.calls
    .filter(([u, i]) => String(u) === url && ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method)
    .map(([, i]) => i as RequestInit);
}

function methodCount(fetchMock: ReturnType<typeof vi.fn>, method: string): number {
  return fetchMock.mock.calls.filter(([, i]) => ((i as RequestInit | undefined)?.method ?? "GET").toUpperCase() === method).length;
}

function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
}

function renderRoute(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof vi.fn>) {
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

const rolesPath = (group: GroupDto) => `/settings/groups/${group.id}/roles`;
const roleUrl = (group: GroupDto, role: GroupRoleDto) => `/api/groups/${group.id}/roles/${role.id}`;

/** 開設定 modal、等角色區塊出來（`name` 是第一個要等到的區塊）。 */
async function openRoles(group: GroupDto, fetchMock: ReturnType<typeof vi.fn>, waitFor_ = "Admin") {
  renderRoute(rolesPath(group), fetchMock);
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("region", { name: waitFor_ });
  return dialog;
}

function region(dialog: HTMLElement, name: string): HTMLElement {
  return within(dialog).getByRole("region", { name });
}

/** `button.tsx` 的實心變體（default／destructive／brandSolid／brandDeep）的底色 class；`brand` 是淡底、`outline`／`ghost` 無底，不算。 */
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;

function solidButtons(scope: HTMLElement): HTMLElement[] {
  return within(scope)
    .queryAllByRole("button")
    .filter((b) => SOLID_BG.test(b.className));
}

function flagSwitch(scope: HTMLElement, flag: string, role: string): HTMLElement {
  return within(scope).getByRole("switch", { name: `${flag} for ${role}` });
}

describe("SettingsGroupRolesSection（/settings/groups/:id/roles，spec §8.5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("1 管理者視角：三個角色區塊；閱讀恆真一句、沒有任何 Read 開關；管理員整塊鎖住；一般成員可改旗標不可改名刪除；自訂角色可改名刪除；唯一實心鈕是 New role；說明清單", async () => {
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES);
    const dialog = await openRoles(GROUP_ADMIN, fetchMock);
    await within(dialog).findByRole("region", { name: "Reader" });

    expect(within(dialog).getAllByRole("region").filter((r) => ["Admin", "Member", "Reader"].includes(r.getAttribute("aria-label") ?? ""))).toHaveLength(3);
    expect(within(dialog).getAllByText(READ_ALWAYS)).toHaveLength(1);
    expect(within(dialog).queryAllByRole("switch", { name: /^Read/ })).toHaveLength(0);
    expect(screen.queryAllByRole("switch", { name: /\bRead\b/ })).toHaveLength(0);
    expect(within(dialog).getByText("Each member has one role, and the role decides what they can do. The built-in Admin role can't be changed; the built-in Member role is what new members get, and it can't be renamed or deleted.")).toBeInTheDocument();

    // 內建管理員：六個全開、disabled；沒有名稱輸入框、沒有任何按鈕；有可見的鎖定說明。
    const admin = region(dialog, "Admin");
    const adminSwitches = within(admin).getAllByRole("switch");
    expect(adminSwitches).toHaveLength(6);
    for (const label of FLAG_LABELS) {
      const sw = flagSwitch(admin, label, "Admin");
      expect(sw).toBeChecked();
      expect(sw).toBeDisabled();
    }
    expect(within(admin).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(admin).queryAllByRole("button")).toHaveLength(0);
    const lockedHint = within(admin).getByText("The built-in Admin role always has every permission and can't be changed.");
    // 說明要關聯到每一顆 disabled switch（螢幕閱讀器 Tab／表單模式才聽得到為什麼不能按）。
    expect(lockedHint.id).not.toBe("");
    for (const sw of adminSwitches) expect(sw).toHaveAttribute("aria-describedby", lockedHint.id);

    // 內建一般成員：名稱是文字、旗標可按、套用 disabled（未改動）、沒有刪除。
    const memberRegion = region(dialog, "Member");
    expect(within(memberRegion).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(memberRegion).getByRole("heading", { name: "Member" })).toBeInTheDocument();
    for (const label of FLAG_LABELS) expect(flagSwitch(memberRegion, label, "Member")).not.toBeDisabled();
    expect(flagSwitch(memberRegion, "Create", "Member")).toBeChecked();
    expect(flagSwitch(memberRegion, "Edit", "Member")).toBeChecked();
    expect(flagSwitch(memberRegion, "Delete", "Member")).not.toBeChecked();
    expect(within(memberRegion).getByRole("button", { name: "Apply changes to Member" })).toBeDisabled();
    expect(within(memberRegion).queryByRole("button", { name: /^Delete/ })).not.toBeInTheDocument();

    // 自訂角色：名稱輸入框、套用 disabled、刪除。
    const reader = region(dialog, "Reader");
    expect(within(reader).getByRole("textbox", { name: "Name of Reader" })).toHaveValue("Reader");
    // 標題跳讀：三種區塊都有 h3（頁面 h1＝群組名、SettingsGroup h2；自訂角色那格是輸入框，靠 sr-only h3）。
    for (const name of ["Admin", "Member", "Reader"]) expect(within(region(dialog, name)).getByRole("heading", { level: 3, name })).toBeInTheDocument();
    for (const label of FLAG_LABELS) expect(flagSwitch(reader, label, "Reader")).not.toBeChecked();
    expect(within(reader).getByRole("button", { name: "Apply changes to Reader" })).toBeDisabled();
    expect(within(reader).getByRole("button", { name: "Delete Reader" })).toBeInTheDocument();

    // 頁首 New role；整個畫面唯一一顆實心鈕。
    const newRole = within(dialog).getByRole("button", { name: "New role" });
    expect(solidButtons(dialog)).toEqual([newRole]);
    // 套用＝outline、刪除＝ghost（不塗紅）。
    expect(within(reader).getByRole("button", { name: "Apply changes to Reader" }).className).toContain("border-input");
    expect(within(reader).getByRole("button", { name: "Delete Reader" }).className).not.toContain("bg-destructive");

    // 說明清單：六個旗標的 label 與 description，沒有閱讀那一項。
    const dl = dialog.querySelector("dl")!;
    expect(dl).not.toBeNull();
    for (const label of FLAG_LABELS) expect(within(dl).getByText(label)).toBeInTheDocument();
    for (const description of FLAG_DESCRIPTIONS) expect(within(dl).getByText(description)).toBeInTheDocument();
    expect(dl.querySelectorAll("dt")).toHaveLength(6);
  });

  it("2 不連動＋變動可見＋只送改了的鍵：開 Create 不動 Edit；改回 server 值套用鈕回 disabled；套用 PATCH 只帶六鍵 permissions（沒有 read／name）", async () => {
    let roles = ROLES;
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method, init) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH") {
        const body = bodyOf(init!) as { permissions: typeof ALL_OFF };
        const updated = { ...READER, permissions: { read: true, ...body.permissions } };
        roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
        return ok(updated);
      }
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const apply = within(reader).getByRole("button", { name: "Apply changes to Reader" });

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    expect(flagSwitch(reader, "Create", "Reader")).toBeChecked();
    expect(flagSwitch(reader, "Edit", "Reader")).not.toBeChecked();
    expect(apply).not.toBeDisabled();

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    expect(flagSwitch(reader, "Create", "Reader")).not.toBeChecked();
    expect(apply).toBeDisabled();

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    expect(methodCount(fetchMock, "PATCH")).toBe(0);
    fireEvent.click(apply);

    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER))[0])).toEqual({ permissions: { ...ALL_OFF, create: true } });
    expect(await screen.findByText("Changes applied.")).toBeInTheDocument();
  });

  it("3 關編輯不動新建：開 Create、開 Edit、關 Edit → Create 仍開，其餘四個不變", async () => {
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES);
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    expect(flagSwitch(reader, "Edit", "Reader")).toBeChecked();
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));

    expect(flagSwitch(reader, "Create", "Reader")).toBeChecked();
    expect(flagSwitch(reader, "Edit", "Reader")).not.toBeChecked();
    for (const label of FLAG_LABELS.slice(2)) expect(flagSwitch(reader, label, "Reader")).not.toBeChecked();
  });

  it("4 改名：body 恰為 {name}；409 role_name_taken → 區塊內 alert；400 invalid_name → 角色名稱那句（不是群組名稱那句）；名稱清空 → 套用 disabled", async () => {
    const outcomes = [fail(409, "role_name_taken"), fail(400, "invalid_name")];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? (outcomes.shift() ?? null) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const apply = within(reader).getByRole("button", { name: "Apply changes to Reader" });

    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "  Writers " } });
    expect(apply).not.toBeDisabled();
    fireEvent.click(apply);

    const url = roleUrl(GROUP_ADMIN, READER);
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", url)[0])).toEqual({ name: "Writers" });
    const alert = await within(reader).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("errors.role_name_taken"));

    fireEvent.click(apply);
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(2));
    expect(bodyOf(callsTo(fetchMock, "PATCH", url)[1])).toEqual({ name: "Writers" });
    await waitFor(() => expect(within(reader).getByRole("alert")).toHaveTextContent("Role names must be 1–40 characters."));
    expect(within(reader).getByRole("alert")).not.toHaveTextContent(i18n.t("errors.invalid_name"));

    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "   " } });
    expect(apply).toBeDisabled();

    // `handleApply` 自己的防呆（縱深防禦；套用鈕 disabled 擋不住直接 submit）：名稱空白、沒有變動都送 0 次。
    const form = reader.querySelector("form")!;
    fireEvent.submit(form);
    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "Reader" } });
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(2);
  });

  it("4b 連續 submit 兩次（第一發還在飛）只送 1 次 PATCH", async () => {
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? (pending as unknown as Response) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    const form = reader.querySelector("form")!;
    fireEvent.submit(form);
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1);
    release(fail(409, "role_name_taken"));
    await within(reader).findByRole("alert");
  });

  it("5 內建一般成員改旗標（Q10）：關 Create → 套用 → body 恰為六鍵 permissions（create 關、edit 開）", async () => {
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, MEMBER_ROLE) && method === "PATCH" ? ok(MEMBER_ROLE) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Member");
    const memberRegion = region(dialog, "Member");

    fireEvent.click(flagSwitch(memberRegion, "Create", "Member"));
    expect(flagSwitch(memberRegion, "Edit", "Member")).toBeChecked();
    fireEvent.click(within(memberRegion).getByRole("button", { name: "Apply changes to Member" }));

    const url = roleUrl(GROUP_ADMIN, MEMBER_ROLE);
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", url)[0])).toEqual({ permissions: { ...ALL_OFF, edit: true } });
  });

  it("6 刪除：ghost 鈕開確認對話框（人數說明、destructive 確認）→ DELETE → 重抓後只剩兩個區塊；沒人掛的角色說明是 descriptionEmpty", async () => {
    const EMPTY = customRole({ id: "44444444-4444-4444-4444-444444444444", name: "Empty", memberCount: 0 });
    let roles: GroupRoleDto[] = [...ROLES, EMPTY];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "DELETE") {
        roles = roles.filter((r) => r.id !== READER.id);
        return fakeResponse({ ok: true, status: 204 });
      }
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Empty");

    // memberCount 0 → descriptionEmpty；取消不送任何東西。
    fireEvent.click(within(region(dialog, "Empty")).getByRole("button", { name: "Delete Empty" }));
    const emptyConfirm = await screen.findByRole("dialog", { name: "Delete role?" });
    expect(emptyConfirm).toHaveTextContent("Nobody has this role.");
    fireEvent.click(within(emptyConfirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete role?" })).not.toBeInTheDocument());

    fireEvent.click(within(region(dialog, "Reader")).getByRole("button", { name: "Delete Reader" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete role?" });
    expect(confirm).toHaveTextContent("2 members who have this role will become Members.");
    const confirmButton = within(confirm).getByRole("button", { name: "Delete role" });
    expect(confirmButton.className).toContain("bg-destructive");
    expect(callsTo(fetchMock, "DELETE", roleUrl(GROUP_ADMIN, READER))).toHaveLength(0);

    fireEvent.click(confirmButton);
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    expect(callsTo(fetchMock, "DELETE", roleUrl(GROUP_ADMIN, READER))[0].body).toBeUndefined();
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "Reader" })).not.toBeInTheDocument());
    expect(region(dialog, "Admin")).toBeInTheDocument();
    expect(region(dialog, "Member")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete role?" })).not.toBeInTheDocument());
  });

  it("新增角色對話框：點對話框外面不關閉、已填角色名仍在（表單型守衛）", async () => {
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES);
    const dialog = await openRoles(GROUP_ADMIN, fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "New role" }));
    const newDialog = await screen.findByRole("dialog", { name: "New role" });
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "Keep" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();
    expect(within(newDialog).getByRole("textbox", { name: "Role name" })).toHaveValue("Keep");
  });

  it("7 新增角色對話框：六個 switch 全關、沒有 Read；名稱空白 Create disabled；7a 開 Create 不動 Edit；7b 開關 Edit 不動 Create；409 留著；成功 POST body 恰為 {name, 六鍵 permissions} 並關閉", async () => {
    const outcomes = [fail(409, "role_name_taken"), ok(customRole({ id: "55555555-5555-5555-5555-555555555555", name: "Reviewers" }), 201)];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === `/api/groups/${GROUP_ADMIN.id}/roles` && method === "POST" ? (outcomes.shift() ?? null) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock);

    fireEvent.click(within(dialog).getByRole("button", { name: "New role" }));
    const newDialog = await screen.findByRole("dialog", { name: "New role" });
    const switches = within(newDialog).getAllByRole("switch");
    expect(switches).toHaveLength(6);
    for (const sw of switches) expect(sw).not.toBeChecked();
    expect(within(newDialog).queryAllByRole("switch", { name: /Read/ })).toHaveLength(0);
    const sw = (label: string) => within(newDialog).getByRole("switch", { name: label });
    const submit = within(newDialog).getByRole("button", { name: "Create" });
    expect(submit).toBeDisabled();
    expect(submit.className).toContain("bg-brand-deep");

    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "Reviewers" } });
    expect(submit).not.toBeDisabled();

    // 7a
    fireEvent.click(sw("Create"));
    expect(sw("Create")).toBeChecked();
    expect(sw("Edit")).not.toBeChecked();
    // 7b
    fireEvent.click(sw("Edit"));
    expect(sw("Edit")).toBeChecked();
    fireEvent.click(sw("Edit"));
    expect(sw("Edit")).not.toBeChecked();
    expect(sw("Create")).toBeChecked();
    // 7c
    fireEvent.click(sw("Delete"));

    const url = `/api/groups/${GROUP_ADMIN.id}/roles`;
    const expected = { name: "Reviewers", permissions: { ...ALL_OFF, create: true, delete: true } };
    fireEvent.click(submit);
    await waitFor(() => expect(callsTo(fetchMock, "POST", url)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "POST", url)[0])).toEqual(expected);
    expect(await within(newDialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.role_name_taken"));
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();

    fireEvent.click(submit);
    await waitFor(() => expect(callsTo(fetchMock, "POST", url)).toHaveLength(2));
    expect(bodyOf(callsTo(fetchMock, "POST", url)[1])).toEqual(expected);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New role" })).not.toBeInTheDocument());
  });

  it("8 唯讀視角（沒有 canManageGroup）：沒有 New role、switch 全 disabled、沒有名稱輸入框、沒有套用與刪除、說明是 descriptionView", async () => {
    const fetchMock = fetchFor(() => [GROUP_MEMBER], () => ROLES);
    const dialog = await openRoles(GROUP_MEMBER, fetchMock, "Reader");

    expect(within(dialog).queryByRole("button", { name: "New role" })).not.toBeInTheDocument();
    expect(solidButtons(dialog)).toHaveLength(0);
    const switches = within(dialog).getAllByRole("switch");
    expect(switches).toHaveLength(18);
    for (const sw of switches) expect(sw).toBeDisabled();
    expect(within(dialog).queryByRole("textbox", { name: /^Name of/ })).not.toBeInTheDocument();
    expect(within(dialog).queryAllByRole("button", { name: /^Apply/ })).toHaveLength(0);
    expect(within(dialog).queryAllByRole("button", { name: /^Delete (Admin|Member|Reader)$/ })).toHaveLength(0);
    expect(within(dialog).getByText("Each member has one role, and the role decides what they can do. Only people whose role can manage roles and the group can change these.")).toBeInTheDocument();
    expect(within(dialog).getByText(READ_ALWAYS)).toBeInTheDocument();
    // 管理員的鎖定說明只給管理者看（唯讀視角整頁都鎖，不必單獨解釋）。
    expect(within(dialog).queryByText("The built-in Admin role always has every permission and can't be changed.")).not.toBeInTheDocument();
  });

  it("9 RF4：我的自訂角色 Leads 拿掉 Manage roles & group 並套用 → GET /api/groups 回 canManageGroup false → 頁面立刻變唯讀", async () => {
    const LEADS = customRole({
      id: "66666666-6666-6666-6666-666666666666",
      name: "Leads",
      memberCount: 1,
      permissions: { read: true, ...ALL_OFF, manageGroup: true },
    });
    let group: GroupDto = groupDto({ id: GROUP_ADMIN.id, name: "Team Alpha" }, LEADS);
    let roles: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE, LEADS];
    const fetchMock = fetchFor(() => [group], () => roles, (url, method) => {
      if (url === `/api/groups/${group.id}/roles/${LEADS.id}` && method === "PATCH") {
        const demoted = { ...LEADS, permissions: { ...LEADS.permissions, manageGroup: false } };
        roles = [ADMIN_ROLE, MEMBER_ROLE, demoted];
        group = groupDto({ id: GROUP_ADMIN.id, name: "Team Alpha" }, demoted);
        return ok(demoted);
      }
      return null;
    });
    const dialog = await openRoles(group, fetchMock, "Leads");
    const leads = region(dialog, "Leads");
    expect(within(dialog).getByRole("button", { name: "New role" })).toBeInTheDocument();

    // 降權前先在 Member 留一個「沒套用」的草稿（關 Create；server 值是開）。
    fireEvent.click(flagSwitch(region(dialog, "Member"), "Create", "Member"));
    expect(flagSwitch(region(dialog, "Member"), "Create", "Member")).not.toBeChecked();

    fireEvent.click(flagSwitch(leads, "Manage roles & group", "Leads"));
    fireEvent.click(within(leads).getByRole("button", { name: "Apply changes to Leads" }));

    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "New role" })).not.toBeInTheDocument());
    expect(within(dialog).queryAllByRole("button", { name: /^Apply/ })).toHaveLength(0);
    for (const sw of within(dialog).getAllByRole("switch")) expect(sw).toBeDisabled();
    // 唯讀視角只顯示 server 值，不留沒套用的草稿假值。
    expect(flagSwitch(region(dialog, "Member"), "Create", "Member")).toBeChecked();
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/groups/${group.id}/roles/${LEADS.id}`)[0])).toEqual({ permissions: ALL_OFF });
  });

  it("10 分頁：nav 兩個連結、目前頁 aria-current；點 Members → /settings/groups/:id 並保留 backgroundLocation", async () => {
    const bgLocation = { pathname: "/n/me/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;
    renderRoute({ pathname: rolesPath(GROUP_ADMIN), state: { backgroundLocation: bgLocation } }, fetchFor(() => [GROUP_ADMIN], () => ROLES));
    const dialog = await screen.findByRole("dialog");
    const nav = await within(dialog).findByRole("navigation", { name: "Group settings sections" });
    const members = within(nav).getByRole("link", { name: "Members" });
    const roles = within(nav).getByRole("link", { name: "Roles" });
    expect(roles).toHaveAttribute("aria-current", "page");
    expect(members).not.toHaveAttribute("aria-current");
    expect(members).toHaveAttribute("href", `/settings/groups/${GROUP_ADMIN.id}`);

    fireEvent.click(members);

    await waitFor(() => expect(screen.getByTestId("location").textContent).toMatch(new RegExp(`^/settings/groups/${GROUP_ADMIN.id}\\|`)));
    const [, stateJson] = screen.getByTestId("location").textContent!.split("|");
    expect(JSON.parse(stateJson)).toEqual({ backgroundLocation: bgLocation });
  });

  it("11 不是我的群組（或不合法 id）→ errors.not_found", async () => {
    renderRoute("/settings/groups/not-a-real-id/roles", fetchFor(() => [GROUP_ADMIN], () => ROLES));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent("We couldn't find what you were looking for."));
  });

  it("12 套用後 server 回的旗標與草稿不同（別人同時改過）→ 區塊顯示 server 值，不留舊草稿", async () => {
    let roles = ROLES;
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH") {
        const stored = { ...READER, permissions: { ...READER.permissions, create: true, delete: true } };
        roles = [ADMIN_ROLE, MEMBER_ROLE, stored];
        return ok(stored);
      }
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    fireEvent.click(flagSwitch(region(dialog, "Reader"), "Create", "Reader"));
    fireEvent.click(within(region(dialog, "Reader")).getByRole("button", { name: "Apply changes to Reader" }));

    await waitFor(() => expect(flagSwitch(region(dialog, "Reader"), "Delete", "Reader")).toBeChecked());
    expect(flagSwitch(region(dialog, "Reader"), "Create", "Reader")).toBeChecked();
    expect(within(region(dialog, "Reader")).getByRole("button", { name: "Apply changes to Reader" })).toBeDisabled();
  });
});
