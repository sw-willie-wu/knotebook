import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupDto, GroupRoleDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { ADMIN_ROLE, GROUP_ADMIN, GROUP_CO_ADMIN, GROUP_MEMBER, ME, MEMBER_ROLE, ROLES, callsTo, fail, fakeResponse, groupFetch, member, ok, renderGroupRoute } from "./group-test-utils";

// 群組 modal「成員」（`/groups/:id`，#247 §6.2）：案子逐案搬自 main 版 `settings/SettingsGroupDetailSection.test.tsx`
// （#103 spec §8.4；#175 spec §8.5）。背景側欄的群組分段吃同一份 `useGroups()` 快取會渲染同樣的群組名字——
// 一律 `within(dialog)` 才不誤命中背景層。

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

describe("GroupMembersSection（/groups/:id，#247 §6.2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("欄寬：名稱欄與 email 欄按 1 : 1.5 分配（真實掛載）", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN], () => members));
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const table = await within(dialog).findByRole("table", { name: "Members" });
    expect(table.style.getPropertyValue("--kb-table-cols")).toBe("minmax(14ch,1fr) minmax(14ch,1.5fr) max-content 2.75rem");
  });

  it("canManageMembers：成員表有 email（A8）、角色下拉（選項來自 GET …/roles）、移除鈕；加人表單", async () => {
    const group = { ...GROUP_ADMIN };
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method) => {
      if (url === "/api/groups" && method === "GET") return ok([group]);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);

    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    // 本檔第一次載入群組區塊 lazy chunk（dialog 外殼在首包、不用等）
    await within(dialog).findByRole("heading", { level: 1, name: "Members" });
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());

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
  });

  it("#183 長 email：列名＝email（spec 2026-10-13 settings-table §3 #8）、移除鈕的可見文字不含 email（可及名稱帶 email）；表名 Members、欄名 Name／Email／Role／Actions", async () => {
    // 欄寬（wrap-anywhere、14ch 下限、框內橫向捲動）由 SettingsTable.test.tsx 與 e2e 26-settings-tables 守（spec §5.1、§5.3）。
    const LONG = "e2e-24c8c7dd-e54e-4237-9f72-a87df48a3fc2@e2e.local";
    renderGroupRoute(
      `/groups/${GROUP_CO_ADMIN.id}`,
      groupFetch(() => [GROUP_CO_ADMIN], () => [
        member(ME.id, ME.email, "Me", ADMIN_ROLE),
        member("u-long", LONG, "A-very-long-display-name-without-any-spaces-at-all", MEMBER_ROLE),
      ]),
    );
    const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
    const row = await within(dialog).findByRole("row", { name: LONG });
    expect(within(row).getByRole("cell", { name: "A-very-long-display-name-without-any-spaces-at-all" })).toBeInTheDocument();
    const removeButton = within(row).getByRole("button", { name: `Remove ${LONG}` });
    expect(removeButton.textContent ?? "").not.toContain(LONG);
    expect(removeButton.textContent ?? "").not.toContain("@");
    const table = within(dialog).getByRole("table", { name: "Members" });
    expect(within(table).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["Name", "Email", "Role", "Actions"]);
  });

  it("最後一位管理員的列（builtin admin 只有一人）：角色下拉 disabled、移除鈕 aria-disabled，兩者 title=lastAdminHint、表格下方有可見提示；兩位管理員時不 disabled、無提示", async () => {
    const HINT = "The only admin can't be demoted or removed. Make someone else an admin first.";
    const phase1 = renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)]),
    );
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    await waitFor(() => expect(within(dialog).getByText("bob@example.com")).toBeInTheDocument());

    const meRoleSelect = within(dialog).getByLabelText("Role for me@example.com");
    expect(meRoleSelect).toBeDisabled();
    expect(meRoleSelect).toHaveAttribute("title", HINT);
    const meRemoveButton = within(dialog).getByRole("button", { name: "Remove me@example.com" });
    expect(meRemoveButton).toHaveAttribute("aria-disabled", "true");
    expect(meRemoveButton).toHaveAttribute("title", HINT);
    expect(within(dialog).getByText(HINT)).toBeInTheDocument();
    // 一般成員那列不受影響
    expect(within(dialog).getByLabelText("Role for bob@example.com")).not.toBeDisabled();

    phase1.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_CO_ADMIN.id}`,
      groupFetch(() => [GROUP_CO_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", ADMIN_ROLE)]),
    );
    const dialog2 = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
    await waitFor(() => expect(within(dialog2).getByText("bob@example.com")).toBeInTheDocument());

    expect(within(dialog2).getByLabelText("Role for me@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByLabelText("Role for bob@example.com")).not.toBeDisabled();
    expect(within(dialog2).getByRole("button", { name: "Remove me@example.com" })).not.toHaveAttribute("aria-disabled");
    expect(within(dialog2).getByRole("button", { name: "Remove bob@example.com" })).not.toHaveAttribute("aria-disabled");
    expect(within(dialog2).queryByText(HINT)).not.toBeInTheDocument();
  });

  it("加人：PUT {email, roleId}（下拉選管理員 → 管理員角色 id）→ 名單更新；送出後下拉回到內建一般成員的 id；409 already_member → 表單下 alert", async () => {
    let members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method, init) => {
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

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
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

  it("加人：輸入幾個字 → 建議清單（已是成員者不列）→ 選取填入 email（多地址框：補上「, 」）→ 送出 PUT 帶選到的 email", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob Example", MEMBER_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method) => {
      if (url === "/api/users/suggest?q=ex" && method === "GET") {
        return ok({
          users: [
            { userId: "u-bob", email: "bob@example.com", displayName: "Bob Example" },
            { userId: "u-carol", email: "carol@example.com", displayName: "Carol Example" },
          ],
        });
      }
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") return ok(member("u-carol", "carol@example.com", "Carol Example", MEMBER_ROLE), 201);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const roleSelect = await within(dialog).findByLabelText("Role for new member");
    await waitFor(() => expect(roleSelect).toHaveValue(MEMBER_ROLE.id));
    const box = within(dialog).getByRole("combobox", { name: "Email address" });
    // #331 收多個地址：text＋inputMode email、#331 的 placeholder 與說明
    expect(box).toHaveAttribute("type", "text");
    expect(box).toHaveAttribute("inputmode", "email");
    expect(box).toHaveAttribute("placeholder", "Email addresses (separate several with commas)");
    expect(box).toHaveAccessibleDescription(/You can enter several addresses at once/);
    fireEvent.change(box, { target: { value: "ex" } });
    const list = await within(dialog).findByRole("listbox", { name: "People you know" });
    expect(within(list).getAllByRole("option").map((o) => o.textContent)).toEqual(["Carol Examplecarol@example.com"]);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(box).toHaveValue("carol@example.com, ");
    expect(callsTo(fetchMock, "PUT", `/api/groups/${GROUP_ADMIN.id}/members`)).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    const url = `/api/groups/${GROUP_ADMIN.id}/members`;
    await waitFor(() => expect(callsTo(fetchMock, "PUT", url)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PUT", url)[0].body))).toEqual({ email: "carol@example.com", roleId: MEMBER_ROLE.id });
  });

  it("加人：roles 還沒到時不送 roleId（body 只有 {email}，server 預設內建一般成員）", async () => {
    const members = [member(ME.id, ME.email, "Me", ADMIN_ROLE)];
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}/roles` && method === "GET") return new Promise<Response>(() => {});
      if (url === `/api/groups/${GROUP_ADMIN.id}/members` && method === "PUT") return ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
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
    const fetchMock = groupFetch(() => [GROUP_CO_ADMIN], () => members, (url, method) => {
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

    renderGroupRoute(`/groups/${GROUP_CO_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
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
    const fetchMock = groupFetch(() => [GROUP_CO_ADMIN], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_CO_ADMIN.id}/members/u-bob` && method === "PATCH") {
        members = members.map((m) => (m.userId === "u-bob" ? { ...m, roleId: MEMBER_ROLE.id, builtin: "member" } : m));
        return ok(members[1]);
      }
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_CO_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_CO_ADMIN.name });
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

  it("一般成員視角：成員表唯讀（角色名走 roles：內建 i18n、自訂用 name）、沒有加人表單", async () => {
    const READER: GroupRoleDto = { ...MEMBER_ROLE, id: "33333333-3333-3333-3333-333333333333", builtin: null, name: "Reader" };
    const members = [
      member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE),
      member(ME.id, ME.email, "Me", MEMBER_ROLE),
      member("u-dan", "dan@example.com", "Dan", READER),
    ];
    const fetchMock = groupFetch(() => [GROUP_MEMBER], () => members, (url, method) => {
      if (url === `/api/groups/${GROUP_MEMBER.id}/roles` && method === "GET") return ok([...ROLES, READER]);
      return null;
    });

    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_MEMBER.name });
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());

    // 成員表無控制項：沒有角色下拉、沒有移除鈕；角色以純文字顯示。
    expect(within(dialog).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    // 無管理權：角色欄是純文字（spec §3 #8 的 fixed），以列名（email）取列、以格的可及名稱找角色。
    const rowOf = (email: string) => within(within(dialog).getByRole("row", { name: email }));
    expect(rowOf("admin2@example.com").getByRole("cell", { name: "Admin" })).toBeInTheDocument();
    expect(rowOf("me@example.com").getByRole("cell", { name: "Member" })).toBeInTheDocument();
    await waitFor(() => expect(rowOf("dan@example.com").getByRole("cell", { name: "Reader" })).toBeInTheDocument());
    expect(within(within(dialog).getByRole("table", { name: "Members" })).getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual([
      "Name",
      "Email",
      "Role",
    ]);
    expect(within(dialog).queryByText("[object Object]", { exact: false })).not.toBeInTheDocument();

    // 沒有加人表單。
    expect(within(dialog).queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("兩個管理旗標分開看：只有 canManageMembers → 角色下拉／移除／加人；只有 canManageGroup → 成員表唯讀、沒有加人", async () => {
    const members = [member("u-admin2", "admin2@example.com", "Admin2", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const membersOnly: GroupDto = { ...GROUP_MEMBER, canManageMembers: true, canManageGroup: false };
    const phase1 = renderGroupRoute(`/groups/${membersOnly.id}`, groupFetch(() => [membersOnly], () => members));
    const dialog = await screen.findByRole("dialog", { name: membersOnly.name });
    await waitFor(() => expect(within(dialog).getByText("admin2@example.com")).toBeInTheDocument());
    expect(within(dialog).getByLabelText("Role for admin2@example.com")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Remove admin2@example.com" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Email address")).toBeInTheDocument();

    phase1.unmount();
    vi.unstubAllGlobals();

    const groupOnly: GroupDto = { ...GROUP_MEMBER, canManageMembers: false, canManageGroup: true };
    renderGroupRoute(`/groups/${groupOnly.id}`, groupFetch(() => [groupOnly], () => members));
    const dialog2 = await screen.findByRole("dialog", { name: groupOnly.name });
    await waitFor(() => expect(within(dialog2).getByText("admin2@example.com")).toBeInTheDocument());
    expect(within(dialog2).queryByLabelText(/Role for/)).not.toBeInTheDocument();
    expect(within(dialog2).queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
    expect(within(dialog2).queryByLabelText("Email address")).not.toBeInTheDocument();
  });

  it("M8 最後一位管理員的移除鈕：點了不送 DELETE（aria-disabled 擋下）", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)]);
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    const me = await within(dialog).findByRole("button", { name: "Remove me@example.com" });
    fireEvent.click(me);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}/members/${ME.id}`)).toHaveLength(0);
  });
});
