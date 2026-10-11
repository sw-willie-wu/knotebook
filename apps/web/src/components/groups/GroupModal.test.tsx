import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import type { Location } from "react-router";
import { dismissAllToasts } from "@/components/ui/toast";
import {
  BG_NOTE,
  GROUP_ADMIN,
  GROUP_CO_ADMIN,
  GROUP_MEMBER,
  ME,
  ADMIN_ROLE,
  MEMBER_ROLE,
  callsTo,
  fail,
  fakeResponse,
  groupFetch,
  locationText,
  member,
  ok,
  renderGroupRoute,
} from "./group-test-utils";

const NOT_FOUND = "We couldn't find what you were looking for.";

describe("GroupModal（/groups/:id/*，#247 §6.0、§6.1）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("G1 四項導覽（nav 的可及名稱＝群組名，§8）：Members／Roles／Storage／About，href 依序；在 /groups/:id 時 Members 是 aria-current", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Members", `/groups/${GROUP_ADMIN.id}`],
      ["Roles", `/groups/${GROUP_ADMIN.id}/roles`],
      ["Storage", `/groups/${GROUP_ADMIN.id}/storage`],
      ["About", `/groups/${GROUP_ADMIN.id}/about`],
    ]);
    expect(within(nav).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  });

  it("G2 Members 帶 end：在 /groups/:id/roles 時 Members 不是 aria-current（Roles 才是）", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}/roles`, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    // 先等角色頁的 h1：證明 roles route 已掛上（沒有它會被 splat 轉回成員頁；轉址前那一瞬 aria-current 也會暫時對）。
    await within(dialog).findByRole("heading", { level: 1, name: "Roles" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    expect(within(nav).getByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("G3 標題＝群組名、副文字＝我的角色（roleLabel：內建一般成員顯示 Member）；成員頁 h1 是 Members", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, groupFetch(() => [GROUP_MEMBER]));
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    expect(within(dialog).getByText("Member", { selector: "span, p, div" })).toBeInTheDocument();
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });

  it("G4 找不到（非成員／不存在／id 不合法同形，S4）：右卡 errors.not_found、標題是備用字「Group」、無副文字；外殼與導覽照常", async () => {
    for (const path of [`/groups/${GROUP_MEMBER.id}`, "/groups/not-a-real-id"]) {
      const view = renderGroupRoute(path, groupFetch(() => [GROUP_ADMIN]));
      const dialog = await screen.findByRole("dialog", { name: "Group" });
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(NOT_FOUND));
      expect(within(dialog).getByRole("navigation", { name: "Group" })).toBeInTheDocument();
      expect(within(dialog).queryByText("Admin")).not.toBeInTheDocument();
      expect(dialog.querySelector("[data-management-content]")).toContainElement(within(dialog).getByRole("alert"));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("G5 群組清單載入中：右卡「Loading…」、標題「Group」；載入失敗（首次就 500）：右卡錯誤字、標題「Group」", async () => {
    const view = renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [], (url, method) => (url === "/api/groups" && method === "GET" ? new Promise<Response>(() => {}) : null)),
    );
    const loading = await screen.findByRole("dialog", { name: "Group" });
    expect(within(loading).getByText("Loading…")).toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [], (url, method) => (url === "/api/groups" && method === "GET" ? fail(500, "internal") : null)),
    );
    const errored = await screen.findByRole("dialog", { name: "Group" });
    await waitFor(() => expect(within(errored).getByRole("alert")).toBeInTheDocument());
    expect(within(errored).queryByRole("heading", { level: 1, name: "Members" })).not.toBeInTheDocument();
  });

  it("G6 /groups/:id 渲染成員頁、網址不變（不是轉址迴圈）；/groups/:id/xyz → /groups/:id 並轉傳 backgroundLocation", async () => {
    const view = renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
    expect(locationText()).toBe(`/groups/${GROUP_ADMIN.id}|null`);
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}/xyz`, state: { backgroundLocation: BG_NOTE } }, groupFetch(() => [GROUP_ADMIN]));
    await waitFor(() => expect(locationText().startsWith(`/groups/${GROUP_ADMIN.id}|`)).toBe(true));
    expect(JSON.parse(locationText().split("|")[1])).toEqual({ backgroundLocation: BG_NOTE });
  });

  it("G7 Esc 與 ✕ 關閉 → navigate(backgroundLocation)；深連結（無 state）→ /", async () => {
    const view = renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}`, state: { backgroundLocation: BG_NOTE } }, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(locationText().startsWith(`${BG_NOTE.pathname}|`)).toBe(true));
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN]));
    const deep = await screen.findByRole("dialog", { name: "Team Alpha" });
    fireEvent.click(within(deep).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(locationText().startsWith("/|")).toBe(true));
  });

  it("G8（Review Focus 2）網址的群組 id 是大寫 → 仍解析到同一個群組（不分大小寫比對）", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id.toUpperCase()}`, groupFetch(() => [GROUP_ADMIN]));
    expect(await screen.findByRole("dialog", { name: "Team Alpha" })).toBeInTheDocument();
  });

  it("G9（Review Focus 1）已顯示群組後 ['groups'] refetch 失敗 → 右卡內容留著（不換成錯誤字）", async () => {
    let failGroups = false;
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) =>
      url === "/api/groups" && method === "GET" && failGroups ? fail(500, "internal") : null,
    );
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    await within(dialog).findByRole("heading", { level: 1, name: "Members" });
    failGroups = true;
    // 加人觸發 ['groups'] 失效重抓（useAddMember → invalidate）
    fetchMock.mockImplementationOnce(() => Promise.resolve(ok(member("u-x", "x@example.com", "X", ADMIN_ROLE), 201)));
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "x@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/groups").length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("dialog", { name: "Team Alpha" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });
});

describe("GroupAboutSection（/groups/:id/about，#247 §6.5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const BG_GROUP_NOTE = (id: string) => ({ pathname: `/g/${id}/some-note`, search: "", hash: "", state: null, key: "bg2" }) as Location;

  async function openAbout(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof groupFetch>, name: string) {
    renderGroupRoute(entry, fetchMock);
    const dialog = await screen.findByRole("dialog", { name });
    await within(dialog).findByRole("heading", { level: 1, name: "About" });
    return dialog;
  }

  it("A1 canManageGroup：名稱可改（PATCH、toast）；資訊區有建立時間與成員數；有「Delete group」outline 鈕（不塗紅）", async () => {
    let group = { ...GROUP_ADMIN };
    const fetchMock = groupFetch(() => [group], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)], (url, method) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "PATCH") {
        group = { ...group, name: "Team Alpha Renamed" };
        return ok(group);
      }
      return null;
    });
    const dialog = await openAbout(`/groups/${GROUP_ADMIN.id}/about`, fetchMock, "Team Alpha");
    const nameInput = within(dialog).getByLabelText("Group name");
    fireEvent.change(nameInput, { target: { value: "Team Alpha Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
    expect(await screen.findByText("Group renamed.")).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("2 members")).toBeInTheDocument());
    expect(within(dialog).getByText(new Date("2026-01-01T00:00:00.000Z").toLocaleDateString("en"))).toBeInTheDocument();
    const del = within(dialog).getByRole("button", { name: "Delete group" });
    expect(del.className).not.toMatch(/(^|\s)(bg-destructive|text-destructive)(\s|$)/);
  });

  it("A2 沒有 canManageGroup：名稱唯讀（純文字、無輸入框、無 Save name）；沒有 Delete group；項次四個照舊（W13 不隱藏）", async () => {
    const dialog = await openAbout(
      `/groups/${GROUP_MEMBER.id}/about`,
      groupFetch(() => [GROUP_MEMBER], () => [member("u-a", "a@example.com", "A", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)]),
      "Team Beta",
    );
    expect(within(dialog).queryByLabelText("Group name")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Save name" })).not.toBeInTheDocument();
    // `:not(.sr-only)`：外殼的 sr-only DialogDescription 預設＝標題，也是一個內容為群組名的 <p>（ManagementShell）
    expect(within(dialog).getByText("Team Beta", { selector: "p:not(.sr-only)" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Delete group" })).not.toBeInTheDocument();
    expect(within(within(dialog).getByRole("navigation", { name: "Team Beta" })).getAllByRole("link")).toHaveLength(4);
  });

  it("A3 退出後的去處（三案＋Review Focus 3）：背景是別頁 → 回背景；背景是本群組筆記（含大寫 id）→ /；無背景 → /；從不導到 /settings/*", async () => {
    const members = [member("u-a", "a@example.com", "A", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const cases: Array<[unknown, string]> = [
      [{ backgroundLocation: BG_NOTE }, BG_NOTE.pathname],
      [{ backgroundLocation: BG_GROUP_NOTE(GROUP_MEMBER.id) }, "/"],
      [{ backgroundLocation: BG_GROUP_NOTE(GROUP_MEMBER.id.toUpperCase()) }, "/"],
      [undefined, "/"],
    ];
    for (const [state, expected] of cases) {
      const fetchMock = groupFetch(() => [GROUP_MEMBER], () => members, (url, method) =>
        url === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && method === "DELETE" ? fakeResponse({ ok: true, status: 204 }) : null,
      );
      const view = renderGroupRoute({ pathname: `/groups/${GROUP_MEMBER.id}/about`, state }, fetchMock);
      const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Leave group" }));
      const confirm = await screen.findByRole("dialog", { name: "Leave group?" });
      fireEvent.click(within(confirm).getByRole("button", { name: "Leave group" }));
      await waitFor(() => expect(locationText().split("|")[0]).toBe(expected));
      expect(locationText()).not.toMatch(/^\/settings\//);
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("A4 刪除群組後的去處：背景是本群組筆記 → /；背景是別頁 → 回背景（DELETE {mode:'delete'}）", async () => {
    for (const [bg, expected] of [
      [BG_GROUP_NOTE(GROUP_ADMIN.id), "/"],
      [BG_NOTE, BG_NOTE.pathname],
    ] as const) {
      let deleted = false;
      const fetchMock = groupFetch(() => (deleted ? [] : [GROUP_ADMIN]), () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) => {
        if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE") {
          deleted = true;
          return fakeResponse({ ok: true, status: 204 });
        }
        return null;
      });
      const view = renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}/about`, state: { backgroundLocation: bg } }, fetchMock);
      const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
      fireEvent.click(await within(dialog).findByRole("button", { name: "Delete group" }));
      const confirm = await screen.findByRole("dialog", { name: "Delete group?" });
      fireEvent.click(within(confirm).getByRole("radio", { name: "Delete everything" }));
      fireEvent.click(within(confirm).getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
      fireEvent.click(within(confirm).getByRole("button", { name: "Delete group" }));
      await waitFor(() => expect(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
      expect(JSON.parse(String(callsTo(fetchMock, "DELETE", `/api/groups/${GROUP_ADMIN.id}`)[0].body))).toEqual({ mode: "delete" });
      await waitFor(() => expect(locationText().split("|")[0]).toBe(expected));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("A5 刪除 409 not_admin → toast、確認框留著、不導頁（自 main 版 SettingsGroupDetailSection.test.tsx:413 搬來）", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) =>
      url === `/api/groups/${GROUP_ADMIN.id}` && method === "DELETE" ? fail(409, "not_admin") : null,
    );
    const dialog = await openAbout(`/groups/${GROUP_ADMIN.id}/about`, fetchMock, "Team Alpha");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    const confirm = await screen.findByRole("dialog", { name: "Delete group?" });
    await waitFor(() => expect(within(confirm).getByLabelText("Admin who gets the notes")).toHaveValue(ME.id));
    fireEvent.click(within(confirm).getByRole("button", { name: "Delete group" }));
    expect(
      await screen.findByText("The notes can only be handed to one of the group's admins. Pick someone who is still an admin.", { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    expect(locationText().startsWith(`/groups/${GROUP_ADMIN.id}/about|`)).toBe(true);
  });

  it("A6 退出區：最後一位管理員看不到；兩位管理員之一看得到；成員名單載入中不渲染；409 last_admin → toast、不導頁（自 main 版 :433 後半、:499、:522 搬來）", async () => {
    const lone = renderGroupRoute(`/groups/${GROUP_ADMIN.id}/about`, groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]));
    let dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    await within(dialog).findByRole("button", { name: "Delete group" });
    // 等成員名單落地（退出區要名單到了才判得出是不是最後一位管理員），否則「看不到 Leave group」恆真
    await within(dialog).findByText("1 member");
    expect(within(dialog).queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
    lone.unmount();
    vi.unstubAllGlobals();

    const co = renderGroupRoute(`/groups/${GROUP_CO_ADMIN.id}/about`, groupFetch(() => [GROUP_CO_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE), member("u-b", "b@example.com", "B", ADMIN_ROLE)]));
    dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("button", { name: "Leave group" })).toBeInTheDocument();
    co.unmount();
    vi.unstubAllGlobals();

    const gate: { release?: () => void } = {};
    const members = [member("u-a", "a@example.com", "A", ADMIN_ROLE), member(ME.id, ME.email, "Me", MEMBER_ROLE)];
    const pendingView = renderGroupRoute(
      `/groups/${GROUP_MEMBER.id}/about`,
      groupFetch(() => [GROUP_MEMBER], () => new Promise<Response>((resolve) => (gate.release = () => resolve(ok(members))))),
    );
    dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    await within(dialog).findByRole("heading", { level: 1, name: "About" });
    await waitFor(() => expect(gate.release).toBeDefined());
    expect(within(dialog).queryByRole("button", { name: "Leave group" })).not.toBeInTheDocument();
    gate.release?.();
    expect(await within(dialog).findByRole("button", { name: "Leave group" })).toBeInTheDocument();
    pendingView.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_MEMBER.id}/about`,
      groupFetch(() => [GROUP_MEMBER], () => members, (url, method) =>
        url === `/api/groups/${GROUP_MEMBER.id}/members/${ME.id}` && method === "DELETE" ? fail(409, "last_admin") : null,
      ),
    );
    dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Leave group" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Leave group?" })).getByRole("button", { name: "Leave group" }));
    expect(await screen.findByText("A group needs at least one admin. Make someone else an admin first.", { exact: true })).toBeInTheDocument();
    expect(locationText().startsWith(`/groups/${GROUP_MEMBER.id}/about|`)).toBe(true);
  });
});
