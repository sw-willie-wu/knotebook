import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupDto, GroupRoleDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppRoutes } from "@/App";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 群組 modal「角色」（`/groups/:id/roles`，#247 §6.3）：真 `AppRoutes`、`MemoryRouter`、fetch 分派。
// W28：switch 按下即送 PATCH（六鍵）；一張卡同時只有一發，pending 涵蓋 `onSettled` 的 refetch；沒有「套用」。

function fakeResponse({ ok: okFlag, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok: okFlag, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}
function ok(body: unknown, status = 200): Response {
  return fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });
}
function fail(status: number, code: string): Response {
  return fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });
}

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true };
const ADMIN_ROLE = adminRole({ id: "11111111-1111-1111-1111-111111111111" });
const MEMBER_ROLE = memberRole({ id: "22222222-2222-2222-2222-222222222222" });
/** 自訂角色：六個可設旗標全關（`customRole` 預設）、兩人掛著。 */
const READER = customRole({ id: "33333333-3333-3333-3333-333333333333", memberCount: 2 });
const ROLES: GroupRoleDto[] = [ADMIN_ROLE, MEMBER_ROLE, READER];
const GROUP_ADMIN: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, ADMIN_ROLE);
const GROUP_MEMBER: GroupDto = groupDto({ id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Team Beta" }, MEMBER_ROLE);

const ALL_OFF = { create: false, edit: false, delete: false, managePublicLink: false, manageMembers: false, manageGroup: false };
const FLAG_LABELS = ["Create", "Edit", "Delete", "Manage public links", "Manage members", "Manage roles & group"];
const READ_ALWAYS = "Every role can read the group's notes, their backlinks and their AI edit history.";
const ADMIN_LOCKED = "The built-in Admin role always has every permission and can't be changed.";

type Handler = (url: string, method: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

function fetchFor(getGroups: () => GroupDto[], getRoles: () => GroupRoleDto[], extra: Handler = () => null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const custom = extra(url, method, init);
    if (custom) return Promise.resolve(custom);
    if (url === "/api/auth/me" && method === "GET") return Promise.resolve(ok(ME));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
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
function bodyOf(init: RequestInit): unknown {
  return JSON.parse(String(init.body));
}

const roleUrl = (group: GroupDto, role: GroupRoleDto) => `/api/groups/${group.id}/roles/${role.id}`;
const rolesListUrl = (group: GroupDto) => `/api/groups/${group.id}/roles`;

async function openRoles(group: GroupDto, fetchMock: ReturnType<typeof vi.fn>, waitFor_ = "Admin") {
  vi.stubGlobal("fetch", fetchMock);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/groups/${group.id}/roles`]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  const dialog = await screen.findByRole("dialog", { name: group.name });
  // 本檔第一次會冷載入 GroupSections lazy chunk；等待上限靠 test/setup.ts 的全域 asyncUtilTimeout。
  await within(dialog).findByRole("region", { name: waitFor_ });
  return dialog;
}

const region = (dialog: HTMLElement, name: string) => within(dialog).getByRole("region", { name });
const flagSwitch = (scope: HTMLElement, flag: string, role: string) => within(scope).getByRole("switch", { name: `${flag} for ${role}` });
const SOLID_BG = /(^|\s)bg-(primary|destructive|brand|brand-deep)(\s|$)/;
const solidButtons = (scope: HTMLElement) => within(scope).queryAllByRole("button").filter((b) => SOLID_BG.test(b.className));
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("SettingsGroupRolesSection（/groups/:id/roles，#247 §6.3）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("R1 管理者視角：三張卡；閱讀恆真一句；管理員卡鎖定（disabled＋說明，無任何鈕）；一般成員卡無鉛筆／垃圾桶；自訂角色卡有鉛筆與紅垃圾桶；沒有任何「Apply」；New role 是 outline、整頁無實心鈕", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES), "Reader");
    expect(within(dialog).getByRole("heading", { level: 1, name: "Roles" })).toBeInTheDocument();
    expect(within(dialog).getAllByText(READ_ALWAYS)).toHaveLength(1);
    expect(within(dialog).queryAllByRole("button", { name: /^Apply/ })).toHaveLength(0);

    const admin = region(dialog, "Admin");
    for (const label of FLAG_LABELS) {
      expect(flagSwitch(admin, label, "Admin")).toBeChecked();
      expect(flagSwitch(admin, label, "Admin")).toBeDisabled();
    }
    expect(within(admin).queryAllByRole("button")).toHaveLength(0);
    const hint = within(admin).getByText(ADMIN_LOCKED);
    for (const sw of within(admin).getAllByRole("switch")) expect(sw).toHaveAttribute("aria-describedby", hint.id);

    const memberCard = region(dialog, "Member");
    for (const label of FLAG_LABELS) expect(flagSwitch(memberCard, label, "Member")).not.toBeDisabled();
    expect(within(memberCard).queryByRole("button", { name: /^(Rename|Delete) / })).not.toBeInTheDocument();

    const reader = region(dialog, "Reader");
    expect(within(reader).getByRole("heading", { level: 3, name: "Reader" })).toBeInTheDocument();
    const rename = within(reader).getByRole("button", { name: "Rename Reader" });
    const del = within(reader).getByRole("button", { name: "Delete Reader" });
    expect(rename).toHaveAttribute("title", "Rename Reader");
    expect(del).toBeInTheDocument();

    expect(within(dialog).getByRole("button", { name: "New role" })).toBeInTheDocument();
    expect(solidButtons(dialog)).toEqual([]);
  });

  it("R2 按下即送：PATCH body 是六鍵、只有目標鍵翻轉（不連動、不帶 read／name）；被按的那顆在回應前就顯示新值", async () => {
    let release: (r: Response) => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, MEMBER_ROLE) && method === "PATCH" ? new Promise<Response>((resolve) => (release = resolve)) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Member");
    const memberCard = region(dialog, "Member");
    fireEvent.click(flagSwitch(memberCard, "Delete", "Member"));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, MEMBER_ROLE))).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, MEMBER_ROLE))[0])).toEqual({
      permissions: { ...ALL_OFF, create: true, edit: true, delete: true },
    });
    expect(flagSwitch(memberCard, "Delete", "Member")).toBeChecked();
    expect(flagSwitch(memberCard, "Create", "Member")).toBeChecked();
    expect(flagSwitch(memberCard, "Manage members", "Member")).not.toBeChecked();
    release(ok({ ...MEMBER_ROLE, permissions: { ...MEMBER_ROLE.permissions, delete: true } }));
  });

  it("R3 pending 期間整張卡停用：按 Create、PATCH 懸著 → 六個 switch aria-disabled；再按 Edit → 沒有第二發、Edit 仍是關", async () => {
    let roles = ROLES;
    let release: (r: Response) => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? new Promise<Response>((resolve) => (release = resolve)) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const patches = () => callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER));

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    for (const label of FLAG_LABELS) expect(flagSwitch(reader, label, "Reader")).toHaveAttribute("aria-disabled", "true");
    // 不用原生 disabled：按下那顆的焦點不能掉到 body
    expect(flagSwitch(reader, "Create", "Reader")).not.toBeDisabled();

    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await tick();
    expect(patches()).toHaveLength(1);
    expect(flagSwitch(reader, "Edit", "Reader")).not.toBeChecked();

    const updated = { ...READER, permissions: { ...READER.permissions, create: true } };
    roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
    release(ok(updated));
    await waitFor(() => expect(flagSwitch(reader, "Create", "Reader")).not.toHaveAttribute("aria-disabled"));
    expect(flagSwitch(reader, "Create", "Reader")).toBeChecked();
  });

  it("R4 settle 後的下一發帶上一發的值：PATCH 200、roles GET 延遲 → GET 回來前卡仍停用、按 Edit 不送；GET 回來後按 Edit → 六鍵含 Create 的新值", async () => {
    let roles = ROLES;
    let holdNextRolesGet = false;
    let releaseGet: () => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method, init) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH") {
        const body = bodyOf(init!) as { permissions: typeof ALL_OFF };
        const updated = { ...READER, permissions: { read: true, ...body.permissions } };
        roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
        holdNextRolesGet = true;
        return ok(updated);
      }
      if (url === rolesListUrl(GROUP_ADMIN) && method === "GET" && holdNextRolesGet) {
        holdNextRolesGet = false;
        return new Promise<Response>((resolve) => (releaseGet = () => resolve(ok(roles))));
      }
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const patches = () => callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER));
    const rolesGets = () => callsTo(fetchMock, "GET", rolesListUrl(GROUP_ADMIN)).length;
    const getsBefore = rolesGets();

    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(rolesGets()).toBe(getsBefore + 1));
    // PATCH 已 200、refetch 的 GET 懸著：卡仍停用（pending 涵蓋 onSettled 回傳的 promise）
    expect(flagSwitch(reader, "Edit", "Reader")).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await tick();
    expect(patches()).toHaveLength(1);

    releaseGet();
    await waitFor(() => expect(flagSwitch(reader, "Edit", "Reader")).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(bodyOf(patches()[1])).toEqual({ permissions: { ...ALL_OFF, create: true, edit: true } });
  });

  it("R5（Review Focus 1）PATCH 200、roles GET 500 之後：卡片仍在（不換成錯誤字），按 Edit 送出的六鍵仍含 Create 的新值（onSuccess 寫回）", async () => {
    let failRolesGet = false;
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method, init) => {
      if (url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH") {
        const body = bodyOf(init!) as { permissions: typeof ALL_OFF };
        failRolesGet = true;
        return ok({ ...READER, permissions: { read: true, ...body.permissions } });
      }
      if (url === rolesListUrl(GROUP_ADMIN) && method === "GET" && failRolesGet) return fail(500, "internal");
      return null;
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const patches = () => callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER));

    fireEvent.click(flagSwitch(region(dialog, "Reader"), "Create", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(1));
    await waitFor(() => expect(flagSwitch(region(dialog, "Reader"), "Edit", "Reader")).not.toHaveAttribute("aria-disabled"));
    expect(flagSwitch(region(dialog, "Reader"), "Create", "Reader")).toBeChecked();

    fireEvent.click(flagSwitch(region(dialog, "Reader"), "Edit", "Reader"));
    await waitFor(() => expect(patches()).toHaveLength(2));
    expect(bodyOf(patches()[1])).toEqual({ permissions: { ...ALL_OFF, create: true, edit: true } });
  });

  it("R6 失敗：PATCH 403 → 卡內 role=alert、refetch 後 switch 回到 server 值；下一次按下清掉 alert", async () => {
    let outcome: "fail" | "ok" = "fail";
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) => {
      if (url !== roleUrl(GROUP_ADMIN, READER) || method !== "PATCH") return null;
      return outcome === "fail" ? fail(403, "forbidden") : ok({ ...READER, permissions: { ...READER.permissions, edit: true } });
    });
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(flagSwitch(reader, "Create", "Reader"));
    const alert = await within(reader).findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("errors.forbidden", { defaultValue: i18n.t("errors.fallback") }));
    await waitFor(() => expect(flagSwitch(reader, "Create", "Reader")).not.toBeChecked());

    outcome = "ok";
    await waitFor(() => expect(flagSwitch(reader, "Edit", "Reader")).not.toHaveAttribute("aria-disabled"));
    fireEvent.click(flagSwitch(reader, "Edit", "Reader"));
    await waitFor(() => expect(within(reader).queryByRole("alert")).not.toBeInTheDocument());
  });

  it("R7 改名：鉛筆 → 名稱輸入框（預填、Name of Reader）→ Save 送 {name}（trim）；409 → 卡內 alert；400 invalid_name → 角色名稱那句；清空 → Save disabled；Cancel 不送", async () => {
    const outcomes = [fail(409, "role_name_taken"), fail(400, "invalid_name")];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? (outcomes.shift() ?? null) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    const url = roleUrl(GROUP_ADMIN, READER);

    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    const input = within(reader).getByRole("textbox", { name: "Name of Reader" });
    expect(input).toHaveValue("Reader");
    fireEvent.click(within(reader).getByRole("button", { name: "Cancel" }));
    expect(within(reader).queryByRole("textbox")).not.toBeInTheDocument();
    expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(0);

    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "  Writers " } });
    fireEvent.click(within(reader).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "PATCH", url)[0])).toEqual({ name: "Writers" });
    expect(await within(reader).findByRole("alert")).toHaveTextContent(i18n.t("errors.role_name_taken"));

    fireEvent.click(within(reader).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", url)).toHaveLength(2));
    await waitFor(() => expect(within(reader).getByRole("alert")).toHaveTextContent("Role names must be 1–40 characters."));

    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "   " } });
    expect(within(reader).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("R7b 改名表單的存檔／取消是 icon 鈕（無可見文字，可及名稱 Save／Cancel），存檔是 submit、兩顆在輸入框之後（表單最右；spec 2026-10-13 settings-table §2.6、§3 角色卡）", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES), "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    const input = within(reader).getByRole("textbox", { name: "Name of Reader" });
    const save = within(reader).getByRole("button", { name: "Save" });
    const cancel = within(reader).getByRole("button", { name: "Cancel" });
    expect(save.textContent).toBe("");
    expect(cancel.textContent).toBe("");
    expect(save).toHaveAttribute("type", "submit");
    expect(input.compareDocumentPosition(save) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(save.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("R8 改名那一發 pending 時：六個 switch 也停用（variables.permissions 缺席時取快取值，不翻值）", async () => {
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === roleUrl(GROUP_ADMIN, READER) && method === "PATCH" ? new Promise<Response>(() => {}) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Reader");
    const reader = region(dialog, "Reader");
    fireEvent.click(within(reader).getByRole("button", { name: "Rename Reader" }));
    fireEvent.change(within(reader).getByRole("textbox", { name: "Name of Reader" }), { target: { value: "Writers" } });
    fireEvent.click(within(reader).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    for (const label of FLAG_LABELS) {
      expect(flagSwitch(reader, label, "Reader")).toHaveAttribute("aria-disabled", "true");
      expect(flagSwitch(reader, label, "Reader")).not.toBeChecked();
    }
  });

  it("R9 刪除：紅垃圾桶開確認框（人數說明、destructive 確認）→ DELETE → 重抓後卡片消失；沒人掛的角色說明是 descriptionEmpty", async () => {
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
    fireEvent.click(confirmButton);
    await waitFor(() => expect(callsTo(fetchMock, "DELETE", roleUrl(GROUP_ADMIN, READER))).toHaveLength(1));
    await waitFor(() => expect(within(dialog).queryByRole("region", { name: "Reader" })).not.toBeInTheDocument());
  });

  it("R10 新增角色對話框：點外面不關；六個 switch 全關、沒有 Read；名稱空白 Create disabled；對話框內送出鈕仍是 brandDeep；成功 POST {name, 六鍵} 並關閉", async () => {
    const outcomes = [fail(409, "role_name_taken"), ok(customRole({ id: "55555555-5555-5555-5555-555555555555", name: "Reviewers" }), 201)];
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => ROLES, (url, method) =>
      url === rolesListUrl(GROUP_ADMIN) && method === "POST" ? (outcomes.shift() ?? null) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "New role" }));
    const newDialog = await screen.findByRole("dialog", { name: "New role" });
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "Keep" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "New role" })).toBeInTheDocument();

    const switches = within(newDialog).getAllByRole("switch");
    expect(switches).toHaveLength(6);
    for (const sw of switches) expect(sw).not.toBeChecked();
    const submit = within(newDialog).getByRole("button", { name: "Create" });
    expect(submit.className).toContain("bg-brand-deep");
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "  " } });
    expect(submit).toBeDisabled();
    fireEvent.change(within(newDialog).getByRole("textbox", { name: "Role name" }), { target: { value: "Reviewers" } });
    fireEvent.click(within(newDialog).getByRole("switch", { name: "Create" }));
    expect(within(newDialog).getByRole("switch", { name: "Edit" })).not.toBeChecked();

    const expected = { name: "Reviewers", permissions: { ...ALL_OFF, create: true } };
    fireEvent.click(submit);
    await waitFor(() => expect(callsTo(fetchMock, "POST", rolesListUrl(GROUP_ADMIN))).toHaveLength(1));
    expect(bodyOf(callsTo(fetchMock, "POST", rolesListUrl(GROUP_ADMIN))[0])).toEqual(expected);
    expect(await within(newDialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.role_name_taken"));
    fireEvent.click(submit);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New role" })).not.toBeInTheDocument());
  });

  it("R11 唯讀視角（沒有 canManageGroup）：沒有 New role、沒有鉛筆／垃圾桶；18 個 switch 全原生 disabled；說明是 descriptionView；不顯示管理員鎖定說明", async () => {
    const dialog = await openRoles(GROUP_MEMBER, fetchFor(() => [GROUP_MEMBER], () => ROLES), "Reader");
    expect(within(dialog).queryByRole("button", { name: "New role" })).not.toBeInTheDocument();
    expect(within(dialog).queryAllByRole("button", { name: /^(Rename|Delete) / })).toHaveLength(0);
    const switches = within(dialog).getAllByRole("switch");
    expect(switches).toHaveLength(18);
    for (const sw of switches) expect(sw).toBeDisabled();
    expect(
      within(dialog).getByText("Each member has one role, and the role decides what they can do. Only people whose role can manage roles and the group can change these."),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(ADMIN_LOCKED)).not.toBeInTheDocument();
  });

  it("R12 RF4：我的自訂角色 Leads 關掉 Manage roles & group → GET /api/groups 回 canManageGroup false → 頁面立刻變唯讀", async () => {
    const LEADS = customRole({ id: "66666666-6666-6666-6666-666666666666", name: "Leads", memberCount: 1, permissions: { read: true, ...ALL_OFF, manageGroup: true } });
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
    fireEvent.click(flagSwitch(region(dialog, "Leads"), "Manage roles & group", "Leads"));
    await waitFor(() => expect(within(dialog).queryByRole("button", { name: "New role" })).not.toBeInTheDocument());
    for (const sw of within(dialog).getAllByRole("switch")) expect(sw).toBeDisabled();
    expect(bodyOf(callsTo(fetchMock, "PATCH", `/api/groups/${group.id}/roles/${LEADS.id}`)[0])).toEqual({ permissions: ALL_OFF });
  });
});

// #181 PR-2b T7：「刪除」旗標的新說明（§6.5 末條）與「能刪不能編輯」提示（§6.10.7 末條：只提示、不阻擋）。
const DELETE_DESCRIPTION = "Move the group's notes to the trash. With Edit as well, also restore them from the trash or delete them permanently.";
const DELETE_HINT = "Without Edit, notes deleted with this role can't be restored from the trash by its holders.";
const DELETER = customRole({ id: "66666666-6666-6666-6666-666666666666", name: "Deleter", permissions: { ...READER.permissions, delete: true } });
const EDIT_DELETER = customRole({ id: "77777777-7777-7777-7777-777777777777", name: "Curators", permissions: { ...READER.permissions, edit: true, delete: true } });
/** 不會出現的資料（內建管理員恆有全部旗標），只用來釘住 `!isAdmin`：管理員卡永遠不顯示提示。 */
const ODD_ADMIN = adminRole({ id: ADMIN_ROLE.id, permissions: { ...ADMIN_ROLE.permissions, edit: false } });

describe("SettingsGroupRolesSection：垃圾桶相關說明與提示（#181 §6.5、§6.10.7）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("GR-T1 說明區的 Delete 說明是新字（移到垃圾桶；同時有 Edit 才能還原／永久刪除）", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES), "Reader");
    const legend = within(dialog).getByRole("heading", { level: 2, name: "What each permission allows" }).closest("section");
    expect(legend).not.toBeNull();
    const term = within(legend as HTMLElement).getByText("Delete", { selector: "dt" });
    expect(term.nextElementSibling).toHaveTextContent(DELETE_DESCRIPTION);
  });

  it("GR-T2 delete 且無 edit 的自訂角色卡有提示；edit＋delete 沒有；內建管理員（即使資料是 delete 無 edit）沒有；只有 Edit 的 Member 沒有", async () => {
    const roles = [ODD_ADMIN, MEMBER_ROLE, DELETER, EDIT_DELETER];
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => roles), "Curators");
    expect(within(region(dialog, "Deleter")).getByText(DELETE_HINT, { exact: true })).toHaveClass("text-xs", "text-muted-foreground");
    expect(within(region(dialog, "Curators")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    expect(within(region(dialog, "Admin")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    expect(within(region(dialog, "Member")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    expect(within(dialog).getAllByText(DELETE_HINT)).toHaveLength(1);
    // 只提示、不阻擋：Deleter 的旗標照常可切
    expect(flagSwitch(region(dialog, "Deleter"), "Edit", "Deleter")).not.toBeDisabled();
  });

  it("GR-T2b 唯讀視角（沒有 canManageGroup）：Deleter 卡仍有提示（刻意：掛這個角色的成員自己會被這個後果影響）", async () => {
    const roles = [ADMIN_ROLE, MEMBER_ROLE, DELETER];
    const dialog = await openRoles(GROUP_MEMBER, fetchFor(() => [GROUP_MEMBER], () => roles), "Deleter");
    expect(flagSwitch(region(dialog, "Deleter"), "Delete", "Deleter")).toBeDisabled();
    expect(within(region(dialog, "Deleter")).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
  });

  it("GR-T3 pending 時以送出的值判斷：Curators 關掉 Edit、PATCH 懸著 → 提示立刻出現；settle 後照 server 值", async () => {
    let roles = [ADMIN_ROLE, MEMBER_ROLE, EDIT_DELETER];
    let release: (r: Response) => void = () => {};
    const fetchMock = fetchFor(() => [GROUP_ADMIN], () => roles, (url, method) =>
      url === roleUrl(GROUP_ADMIN, EDIT_DELETER) && method === "PATCH" ? new Promise<Response>((resolve) => (release = resolve)) : null,
    );
    const dialog = await openRoles(GROUP_ADMIN, fetchMock, "Curators");
    expect(within(region(dialog, "Curators")).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    fireEvent.click(flagSwitch(region(dialog, "Curators"), "Edit", "Curators"));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", roleUrl(GROUP_ADMIN, EDIT_DELETER))).toHaveLength(1));
    expect(within(region(dialog, "Curators")).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
    const updated = { ...EDIT_DELETER, permissions: { ...EDIT_DELETER.permissions, edit: false } };
    roles = [ADMIN_ROLE, MEMBER_ROLE, updated];
    release(ok(updated));
    await waitFor(() => expect(flagSwitch(region(dialog, "Curators"), "Edit", "Curators")).not.toHaveAttribute("aria-disabled"));
    expect(within(region(dialog, "Curators")).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
  });

  it("GR-T4 新增角色對話框：開 Delete → 提示出現；再開 Edit → 消失", async () => {
    const dialog = await openRoles(GROUP_ADMIN, fetchFor(() => [GROUP_ADMIN], () => ROLES));
    fireEvent.click(within(dialog).getByRole("button", { name: "New role" }));
    const newDialog = await screen.findByRole("dialog", { name: "New role" });
    expect(within(newDialog).queryByText(DELETE_HINT)).not.toBeInTheDocument();
    fireEvent.click(within(newDialog).getByRole("switch", { name: "Delete" }));
    expect(within(newDialog).getByText(DELETE_HINT, { exact: true })).toBeInTheDocument();
    fireEvent.click(within(newDialog).getByRole("switch", { name: "Edit" }));
    expect(within(newDialog).queryByText(DELETE_HINT)).not.toBeInTheDocument();
  });
});
